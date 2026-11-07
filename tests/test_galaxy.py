"""Tests for galaxy.py. Run: python3 -m unittest discover -s tests   (standard library only)."""
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import galaxy  # noqa: E402

HERE = Path(__file__).resolve().parent
FAKE = [sys.executable, str(HERE / "fake_hermes.py")]


def fake_cli(home: Path) -> "galaxy.HermesCLI":
    return galaxy.HermesCLI(FAKE, home=home)


class Normalize(unittest.TestCase):
    def setUp(self):
        self.raw = json.loads((HERE / "sample-journey.json").read_text(encoding="utf-8"))

    def test_hides_memory_text_by_default(self):
        g = galaxy.normalize_graph(self.raw)
        labels = [n["label"] for n in g["nodes"] if n["kind"] == "memory"]
        self.assertEqual(labels, ["Memory note 01", "Profile note 01"])
        self.assertNotIn("SECRET", json.dumps(g))

    def test_can_show_memory_text_when_asked(self):
        g = galaxy.normalize_graph(self.raw, show_memory_text=True)
        self.assertIn("SECRET TEXT that must not render", json.dumps(g))

    def test_drops_archived_dangling_and_duplicate_edges(self):
        g = galaxy.normalize_graph(self.raw)
        ids = {n["id"] for n in g["nodes"]}
        self.assertNotIn("old-skill", ids)
        self.assertEqual(len(g["edges"]), 2)  # the A->B / B->A pair collapses, ghost + archived edges drop
        for e in g["edges"]:
            self.assertIn(e["source"], ids)
            self.assertIn(e["target"], ids)

    def test_timestamps_become_milliseconds(self):
        g = galaxy.normalize_graph(self.raw)
        self.assertTrue(all(n["timestamp"] > 1e12 for n in g["nodes"]))
        iso = galaxy.normalize_graph({"nodes": [{"id": "a", "kind": "skill", "timestamp": "2026-05-01T00:00:00Z"}]})
        self.assertEqual(iso["nodes"][0]["timestamp"], 1777593600000.0)

    def test_multi_profile_export_merges_into_one_person(self):
        doc = {"format": "hermes-journey-multi-profile", "profiles": [
            {"nodes": [{"id": "a", "kind": "skill", "timestamp": 100, "useCount": 3}], "edges": []},
            {"nodes": [{"id": "a", "kind": "skill", "timestamp": 50, "useCount": 9}, {"id": "b", "kind": "skill", "timestamp": 70}],
             "edges": [{"source": "a", "target": "b"}]}]}
        out = galaxy.journeys_from_document(doc, "SAM", "sam.json", "file", False)
        self.assertEqual(len(out), 1)
        nodes = {n["id"]: n for n in out[0]["graph"]["nodes"]}
        self.assertEqual(nodes["a"]["timestamp"], 50000.0)
        self.assertEqual(nodes["a"]["use_count"], 9)
        self.assertEqual(len(out[0]["graph"]["edges"]), 1)

    def test_galaxy_file_round_trips(self):
        g = galaxy.normalize_graph(self.raw)
        doc = {"format": "hermes-journey-galaxy", "profiles": [{"name": "Ana", "graph": g}, {"name": "Ben", "graph": g}]}
        out = galaxy.journeys_from_document(doc, "x", "team.json", "file", False)
        self.assertEqual([j["name"] for j in out], ["ANA", "BEN"])
        self.assertEqual(len(out[0]["graph"]["nodes"]), len(g["nodes"]))

    def test_names_from_filenames(self):
        cases = {"Alex-journey": "ALEX", "robin -journey": "ROBIN", "Sam-journey.redacted": "SAM",
                 "kai-journey_combined": "KAI", "Mary Jo-journey": "MARY JO", "lee_2": "LEE 2"}
        for stem, want in cases.items():
            self.assertEqual(galaxy.name_from_file(stem), want, stem)

    def test_json_after_preamble(self):
        self.assertEqual(galaxy.parse_json_output('warning: hi\n{"nodes": []}\n'), {"nodes": []})


class Detection(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        for p in ("work", "empty"):
            (self.home / "profiles" / p).mkdir(parents=True)
            (self.home / "profiles" / p / "config.yaml").write_text("x: 1\n")
        (self.home / "profiles" / "not-a-profile").mkdir()  # no config.yaml: ignored

    def tearDown(self):
        self.tmp.cleanup()

    def test_version_and_profiles(self):
        cli = fake_cli(self.home)
        self.assertEqual(cli.version(), "9.9.9")
        self.assertEqual(cli.profiles(), ["default", "empty", "work"])

    def test_summaries_count_active_nodes(self):
        rows = {r["name"]: r for r in galaxy.summarize_profiles(fake_cli(self.home))["profiles"]}
        self.assertEqual((rows["default"]["skills"], rows["default"]["memories"]), (2, 2))
        self.assertEqual((rows["empty"]["skills"], rows["empty"]["memories"]), (0, 0))

    def test_broken_profile_is_reported_not_fatal(self):
        (self.home / "profiles" / "broken").mkdir()
        (self.home / "profiles" / "broken" / "config.yaml").write_text("x: 1\n")
        rows = {r["name"]: r for r in galaxy.summarize_profiles(fake_cli(self.home))["profiles"]}
        self.assertTrue(rows["broken"]["error"])
        self.assertIsNone(rows["default"]["error"])

    def test_missing_install_is_not_found(self):
        d = galaxy.detect(str(self.home / "nope" / "hermes"))
        self.assertFalse(d["found"])

    def test_non_hermes_binary_is_rejected(self):
        cli = galaxy.HermesCLI([sys.executable, "-c", "print('Python 3.12.0')"], home=self.home)
        with self.assertRaises(RuntimeError):
            cli.version()

    def test_hermes_home_respects_env(self):
        old = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = str(self.home)
        try:
            self.assertEqual(galaxy.hermes_home(), self.home)
        finally:
            if old is None:
                os.environ.pop("HERMES_HOME", None)
            else:
                os.environ["HERMES_HOME"] = old


class Server(unittest.TestCase):
    """End to end over HTTP, with the fake Hermes standing in for the real one."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        base = Path(cls.tmp.name)
        cls.journeys = base / "journeys"
        cls.journeys.mkdir()
        galaxy.STATE_DIR = base / ".galaxy"
        galaxy.SETTINGS_FILE = galaxy.STATE_DIR / "settings.json"
        (base / "profiles" / "empty").mkdir(parents=True)
        (base / "profiles" / "empty" / "config.yaml").write_text("x: 1\n")
        cls.app = galaxy.Galaxy(cls.journeys, None, False)
        cli = fake_cli(base)
        cls.app.detection = {"found": True, "path": "fake", "version": "9.9.9", "cli": cli, **galaxy.summarize_profiles(cli)}
        cls.app._detect_done.set()
        cls.srv = galaxy.LocalServer(("127.0.0.1", 0), galaxy.make_handler(cls.app))
        cls.url = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def get(self, path, headers=None):
        req = urllib.request.Request(self.url + path, headers=headers or {})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())

    def post(self, path, body=b"", headers=None):
        req = urllib.request.Request(self.url + path, data=body, method="POST", headers={"X-Galaxy": "1", **(headers or {})})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())

    def test_1_first_run_shows_demo_and_offers_hermes(self):
        st = self.get("/api/state")
        self.assertTrue(st["hermes"]["found"])
        self.assertEqual(st["settings"]["hermes"], "unset")
        self.assertNotIn("exports", st["hermes"])
        j = self.get("/api/journeys")
        self.assertTrue(j["demo"])
        self.assertGreaterEqual(len(j["journeys"]), 3)

    def test_2_accepting_hermes_renders_the_journey(self):
        self.post("/api/settings", json.dumps({"hermes": "on", "name": "Dana"}).encode())
        j = self.get("/api/journeys")
        self.assertFalse(j["demo"])
        self.assertEqual([x["name"] for x in j["journeys"]], ["DANA"])
        self.assertNotIn("SECRET", json.dumps(j))
        self.assertTrue(any("no skills or memories" in w for w in j["warnings"]))

    def test_3_import_adds_a_system(self):
        body = (HERE / "sample-journey.json").read_bytes()
        saved = self.post("/api/import?name=Pat%20Lee-journey.json", body)["saved"]
        self.assertTrue((self.journeys / saved).exists())
        names = [x["name"] for x in self.get("/api/journeys")["journeys"]]
        self.assertIn("PAT LEE", names)

    def test_4_import_rejects_non_journeys(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.post("/api/import?name=x.json", b'{"hello": "world"}')
        self.assertEqual(e.exception.code, 400)
        e.exception.close()

    def test_5_posts_need_the_header(self):
        req = urllib.request.Request(self.url + "/api/settings", data=b"{}", method="POST")
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(req, timeout=10)
        self.assertEqual(e.exception.code, 403)
        e.exception.close()

    def test_6_other_hosts_are_refused(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.get("/api/state", headers={"Host": "evil.example"})
        self.assertEqual(e.exception.code, 403)
        e.exception.close()

    def test_8_second_server_cannot_share_the_port(self):
        with self.assertRaises(OSError):
            galaxy.LocalServer(("127.0.0.1", self.srv.server_address[1]), galaxy.make_handler(self.app))

    def test_7_static_files_are_served(self):
        with urllib.request.urlopen(self.url + "/", timeout=10) as r:
            self.assertIn(b"Journey Galaxy", r.read())


if __name__ == "__main__":
    unittest.main()
