#!/usr/bin/env python3
"""Hermes Journey Galaxy: a local viewer for `hermes journey --json` graphs.

Run it:            python3 galaxy.py            (Windows: python galaxy.py)
Use Hermes now:    python3 galaxy.py --use-hermes
Only the demo:     python3 galaxy.py --demo
All options:       python3 galaxy.py --help

Standard library only (Python 3.8+). Serves ./web on 127.0.0.1 and never sends data anywhere.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

__version__ = "1.0.0"

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
EXAMPLES = ROOT / "examples"
STATE_DIR = ROOT / ".galaxy"
SETTINGS_FILE = STATE_DIR / "settings.json"
DEFAULT_PORT = 8791
MAX_IMPORT_BYTES = 50 * 1024 * 1024
IS_WIN = sys.platform == "win32"

try:  # keep printing safe on old Windows consoles
    sys.stdout.reconfigure(errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass


# --------------------------------------------------------------------------------------------
# Hermes Agent detection
# --------------------------------------------------------------------------------------------
def hermes_home() -> Path:
    """Where Hermes keeps its data: $HERMES_HOME, else the platform default."""
    env = os.environ.get("HERMES_HOME", "").strip()
    if env:
        return Path(os.path.expanduser(env))
    if IS_WIN:
        base = os.environ.get("LOCALAPPDATA", "").strip()
        return (Path(base) if base else Path.home() / "AppData" / "Local") / "hermes"
    return Path.home() / ".hermes"


def candidate_paths() -> list:
    """Places a Hermes launcher usually lives, most likely first."""
    exe = "hermes.exe" if IS_WIN else "hermes"
    home = hermes_home()
    found = []
    for env_name in ("HERMES_BIN", "HERMES_CLI"):
        if os.environ.get(env_name):
            found.append(Path(os.environ[env_name]))
    on_path = shutil.which("hermes")
    if on_path:
        found.append(Path(on_path))
    found += [
        home / "hermes-agent" / ".hermes" / "bin" / exe,  # standard installer layout
        home / "bin" / exe,
        Path.home() / ".local" / "bin" / "hermes",
        Path("/opt/homebrew/bin/hermes"),
        Path("/usr/local/bin/hermes"),
    ]
    if sys.platform == "darwin":  # Hermes Desktop bundles the agent inside the app
        for app in (Path("/Applications/Hermes.app"), Path.home() / "Applications" / "Hermes.app"):
            found.append(app / "Contents" / "Resources" / "agent-payload" / "repo" / ".hermes" / "bin" / "hermes")
    seen, out = set(), []
    for p in found:
        key = str(p).lower() if IS_WIN else str(p)
        if key not in seen:
            seen.add(key)
            out.append(p)
    return out


def _clean_env() -> dict:
    env = dict(os.environ)
    env.update({"PYTHONIOENCODING": "utf-8", "NO_COLOR": "1", "TERM": "dumb"})
    return env


class HermesCLI:
    """Runs the Hermes CLI. `cmd` is the command prefix, e.g. ['hermes'] or [python, 'fake.py']."""

    def __init__(self, cmd: list, home: Path | None = None):
        self.cmd = [str(c) for c in cmd]
        self.home = home or hermes_home()

    def run(self, args: list, timeout: int = 120) -> str:
        p = subprocess.run(self.cmd + args, capture_output=True, timeout=timeout, env=_clean_env(),
                           stdin=subprocess.DEVNULL)
        out = p.stdout.decode("utf-8", errors="replace")
        if p.returncode != 0 and not out.strip():
            raise RuntimeError(p.stderr.decode("utf-8", errors="replace").strip()[-400:] or f"exit {p.returncode}")
        return out

    def version(self) -> str:
        text = self.run(["--version"], timeout=30)
        m = re.search(r"v?(\d+\.\d+\.\d+)", text)
        if not m or "hermes" not in text.lower():
            raise RuntimeError("not a Hermes Agent launcher")
        return m.group(1)

    def profiles(self) -> list:
        """'default' plus every named profile folder that looks like a real Hermes home."""
        names = ["default"]
        pdir = self.home / "profiles"
        if pdir.is_dir():
            for d in sorted(pdir.iterdir()):
                if d.is_dir() and not d.name.startswith(".") and (d / "config.yaml").exists():
                    names.append(d.name)
        return names

    def export(self, profile: str = "default") -> dict:
        args = ["journey", "--json"] if profile == "default" else ["-p", profile, "journey", "--json"]
        return parse_json_output(self.run(args))


def parse_json_output(text: str) -> dict:
    """The CLI may print a warning before the JSON; read from the first '{'."""
    start = text.find("{")
    if start < 0:
        raise ValueError("no JSON in output")
    try:
        return json.loads(text[start:])
    except json.JSONDecodeError:
        return json.loads(text[start:text.rfind("}") + 1])


def display_path(p) -> str:
    """Show paths with the home folder collapsed to ~ (keeps usernames out of screenshots)."""
    s, h = str(p), str(Path.home())
    return "~" + s[len(h):] if s.lower().startswith(h.lower()) else s


def detect(explicit: str | None = None) -> dict:
    """Find a working Hermes install and summarize each profile's journey."""
    tried = []
    cands = [Path(explicit)] if explicit else candidate_paths()
    for path in cands:
        if not path.exists():
            continue
        tried.append(display_path(path))
        cli = HermesCLI([path])
        try:
            ver = cli.version()
        except Exception:
            continue
        return {"found": True, "path": display_path(path), "version": ver, "cli": cli, **summarize_profiles(cli)}
    return {"found": False, "tried": tried, "home": display_path(hermes_home()), "profiles": [], "exports": {}}


def summarize_profiles(cli: HermesCLI) -> dict:
    names = cli.profiles()
    exports, rows = {}, []

    def one(name):
        try:
            return name, cli.export(name), None
        except Exception as e:  # keep going: one broken profile shouldn't hide the rest
            return name, None, str(e)[:200]

    with ThreadPoolExecutor(max_workers=min(4, len(names))) as pool:
        for name, data, err in pool.map(one, names):
            row = {"name": name, "skills": 0, "memories": 0, "error": err}
            if data is not None:
                exports[name] = data
                nodes = [n for n in data.get("nodes", []) if n.get("state") not in ("archived", "deleted")]
                row["skills"] = sum(1 for n in nodes if n.get("kind") == "skill")
                row["memories"] = sum(1 for n in nodes if n.get("kind") == "memory")
            rows.append(row)
    return {"profiles": rows, "exports": exports, "exported_at": time.time()}


# --------------------------------------------------------------------------------------------
# Journey normalization: every input format becomes [{name, source, kind, graph:{nodes, edges}}]
# --------------------------------------------------------------------------------------------
STRIP_SUFFIX = re.compile(r"([-_ .](journey|journeys|redacted|combined|message|export|hermes))+$", re.I)


def name_from_file(stem: str) -> str:
    s = STRIP_SUFFIX.sub("", stem.strip()).strip(" -_.") or stem
    s = re.sub(r"[_]+", " ", s)
    return s.upper()[:24]


def to_ms(v) -> float | None:
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v) if v > 1e12 else float(v) * 1000.0
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp() * 1000.0
    except ValueError:
        return None


def normalize_graph(raw: dict, show_memory_text: bool = False) -> dict:
    """Raw `hermes journey --json` graph -> the renderer's node/edge format."""
    nodes, keep = [], set()
    for n in raw.get("nodes", []) or []:
        if n.get("state") in ("archived", "deleted"):
            continue
        ts = to_ms(n.get("timestamp"))
        nid = str(n.get("id", ""))
        if ts is None or not nid:
            continue
        kind = "memory" if n.get("kind") == "memory" else "skill"
        uses = n.get("useCount", n.get("use_count", 0)) or 0
        nodes.append({"id": nid, "kind": kind, "label": str(n.get("label") or nid)[:80], "timestamp": ts,
                      "use_count": int(uses), "pinned": bool(n.get("pinned")),
                      "_profile": n.get("memorySource")})
        keep.add(nid)
    # memory text stays on your machine, but is hidden on screen unless you ask for it
    mems = sorted((n for n in nodes if n["kind"] == "memory"), key=lambda n: n["timestamp"])
    counts = {"Profile": 0, "Memory": 0}  # numbered oldest first, separately for profile and memory notes
    for n in mems:
        if not show_memory_text:
            k = "Profile" if n["_profile"] in ("user", "profile") else "Memory"
            counts[k] += 1
            n["label"] = f"{k} note {counts[k]:02d}"
    for n in nodes:
        n.pop("_profile", None)
    edges, seen = [], set()
    for e in raw.get("edges", []) or []:
        a, b = str(e.get("source", "")), str(e.get("target", ""))
        if a in keep and b in keep and a != b and (a, b) not in seen and (b, a) not in seen:
            seen.add((a, b))
            edges.append({"source": a, "target": b})
    return {"nodes": nodes, "edges": edges}


def merge_graphs(graphs: list) -> dict:
    """Several profiles of one person -> one system. Same id = same skill (earliest date, highest use)."""
    by_id, edges = {}, []
    for g in graphs:
        for n in g.get("nodes", []) or []:
            cur = by_id.get(n.get("id"))
            if cur is None:
                by_id[n.get("id")] = dict(n)
            else:
                cur["timestamp"] = min(cur.get("timestamp") or 9e18, n.get("timestamp") or 9e18)
                cur["useCount"] = max(cur.get("useCount", 0) or 0, n.get("useCount", 0) or 0)
        edges += g.get("edges", []) or []
    return {"nodes": list(by_id.values()), "edges": edges}


def journeys_from_document(doc: dict, fallback_name: str, source: str, kind: str, show_memory_text: bool) -> list:
    """Accepts a raw journey, a multi-profile export, or a galaxy file with several people."""
    if isinstance(doc.get("profiles"), list) and doc["profiles"] and isinstance(doc["profiles"][0].get("graph"), dict):
        out = []  # galaxy file: one entry per person (already normalized or raw)
        for p in doc["profiles"]:
            out.append({"name": str(p.get("name") or p.get("id") or fallback_name).upper()[:24], "source": source,
                        "kind": kind, "color": p.get("color"), "palette": p.get("palette"), "star": p.get("star"),
                        "graph": normalize_graph(p["graph"], show_memory_text)})
        return out
    if isinstance(doc.get("profiles"), list):  # hermes-journey-multi-profile: merge into one person
        raw = merge_graphs(doc["profiles"])
    else:
        raw = doc
    name = str(doc.get("name") or fallback_name).upper()[:24]
    return [{"name": name, "source": source, "kind": kind, "graph": normalize_graph(raw, show_memory_text)}]


def load_file(path: Path, kind: str, show_memory_text: bool) -> list:
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    return journeys_from_document(parse_json_output(text), name_from_file(path.stem), path.name, kind, show_memory_text)


# --------------------------------------------------------------------------------------------
# App state
# --------------------------------------------------------------------------------------------
class Galaxy:
    def __init__(self, journeys_dir: Path, hermes_path: str | None, demo_only: bool):
        self.journeys_dir = journeys_dir
        self.hermes_path = hermes_path
        self.demo_only = demo_only
        self.settings = self._read_settings()
        self.detection: dict | None = None
        self._lock = threading.Lock()
        self._detect_done = threading.Event()

    # settings -------------------------------------------------------------------------
    def _read_settings(self) -> dict:
        try:
            s = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        except Exception:
            s = {}
        s.setdefault("hermes", "unset")  # unset | on | off
        s.setdefault("profiles", None)  # None = every profile with data
        s.setdefault("name", None)
        return s

    def save_settings(self, **changes) -> dict:
        with self._lock:
            self.settings.update({k: v for k, v in changes.items() if k in ("hermes", "profiles", "name")})
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            tmp = SETTINGS_FILE.with_suffix(f".{os.getpid()}.tmp")  # write then rename: never a half-written file
            tmp.write_text(json.dumps(self.settings, indent=2), encoding="utf-8")
            os.replace(tmp, SETTINGS_FILE)
        return self.settings

    # detection ------------------------------------------------------------------------
    def start_detection(self) -> None:
        if self.demo_only:
            self.detection = {"found": False, "skipped": True, "profiles": [], "exports": {}}
            self._detect_done.set()
            return

        def work():
            try:
                self.detection = detect(self.hermes_path)
            except Exception as e:
                self.detection = {"found": False, "error": str(e), "profiles": [], "exports": {}}
            self._detect_done.set()

        threading.Thread(target=work, daemon=True).start()

    def wait_detection(self, timeout: float = 120) -> dict:
        self._detect_done.wait(timeout)
        return self.detection or {"found": False, "pending": True, "profiles": [], "exports": {}}

    def refresh_hermes(self) -> dict:
        d = self.wait_detection()
        if d.get("found"):
            d.update(summarize_profiles(d["cli"]))
        return d

    # journeys ---------------------------------------------------------------------------
    def default_name(self, profile: str) -> str:
        if profile != "default":
            return profile.upper()[:24]
        if self.settings.get("name"):
            return str(self.settings["name"]).upper()[:24]
        try:
            return getpass.getuser().upper()[:24] or "MY HERMES"
        except Exception:
            return "MY HERMES"

    def journeys(self, show_memory_text: bool = False) -> dict:
        out, warnings = [], []
        d = self.detection or {}
        if self.settings["hermes"] == "on" and d.get("found") and not self.demo_only:
            wanted = self.settings.get("profiles")
            for row in d.get("profiles", []):
                name = row["name"]
                if wanted is not None and name not in wanted:
                    continue
                if row.get("error"):
                    warnings.append(f"Hermes profile '{name}' could not be read: {row['error']}")
                    continue
                if not (row["skills"] or row["memories"]):
                    warnings.append(f"Hermes profile '{name}' has no skills or memories yet, so it is not shown.")
                    continue
                for j in journeys_from_document(d["exports"][name], self.default_name(name), f"Hermes profile: {name}",
                                                "hermes", show_memory_text):
                    j["name"] = self.default_name(name)
                    out.append(j)
        if not self.demo_only:
            for f in sorted(self.journeys_dir.glob("*.json")) + sorted(self.journeys_dir.glob("*.txt")):
                try:
                    out += load_file(f, "file", show_memory_text)
                except Exception as e:
                    warnings.append(f"{f.name} could not be read: {e}")
        demo = False
        if not out:
            demo = True
            for f in sorted(EXAMPLES.glob("*.json")):
                out += load_file(f, "demo", show_memory_text)
        out = [j for j in out if j["graph"]["nodes"]]
        # names must be unique so labels and the comparison board stay readable
        seen: dict = {}
        for j in out:
            base = j["name"] or "JOURNEY"
            seen[base] = seen.get(base, 0) + 1
            if seen[base] > 1:
                j["name"] = f"{base} {seen[base]}"
        return {"journeys": out, "demo": demo, "warnings": warnings}

    def fingerprint(self) -> str:
        parts = [self.settings["hermes"], str(self.settings.get("profiles")), str(self.settings.get("name"))]
        for f in sorted(self.journeys_dir.glob("*")):
            if f.suffix in (".json", ".txt"):
                st = f.stat()
                parts.append(f"{f.name}:{st.st_size}:{int(st.st_mtime)}")
        d = self.detection or {}
        parts.append(str(d.get("exported_at", "")))
        return str(abs(hash("|".join(parts))))

    def state(self) -> dict:
        d = self.wait_detection()
        files = [f.name for f in sorted(self.journeys_dir.glob("*")) if f.suffix in (".json", ".txt")]
        return {
            "version": __version__,
            "hermes": {k: v for k, v in d.items() if k not in ("cli", "exports")},
            "settings": self.settings,
            "default_name": self.default_name("default"),
            "journeys_dir": display_path(self.journeys_dir),
            "files": files,
            "demo_only": self.demo_only,
        }

    def import_file(self, filename: str, body: bytes) -> str:
        doc = parse_json_output(body.decode("utf-8-sig", errors="replace"))
        if not isinstance(doc, dict) or not (doc.get("nodes") is not None or doc.get("profiles") is not None):
            raise ValueError("that file is not a Hermes journey (expected `hermes journey --json` output)")
        stem = re.sub(r"[^A-Za-z0-9 _.-]+", "", Path(filename).stem).strip() or "journey"
        self.journeys_dir.mkdir(parents=True, exist_ok=True)
        dest = self.journeys_dir / f"{stem}.json"
        dest.write_text(json.dumps(doc), encoding="utf-8")
        return dest.name


# --------------------------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------------------------
def make_handler(app: Galaxy):
    class Handler(SimpleHTTPRequestHandler):
        extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript",
                          ".mjs": "text/javascript", ".woff2": "font/woff2", ".svg": "image/svg+xml"}

        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(WEB), **kw)

        def log_message(self, fmt, *args):  # quiet by default
            if os.environ.get("GALAXY_DEBUG"):
                super().log_message(fmt, *args)

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def _local_only(self) -> bool:
            host = (self.headers.get("Host") or "").split(":")[0].strip("[]").lower()
            if host not in ("127.0.0.1", "localhost", "::1"):
                self.send_error(403, "local requests only")
                return False
            return True

        def _json(self, obj, code=200):
            body = json.dumps(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if not self._local_only():
                return
            u = urlparse(self.path)
            if not u.path.startswith("/api/"):
                return super().do_GET()
            q = parse_qs(u.query)
            try:
                if u.path == "/api/state":
                    return self._json(app.state())
                if u.path == "/api/journeys":
                    app.wait_detection()
                    return self._json(app.journeys(show_memory_text=q.get("memories", ["0"])[0] == "1"))
                if u.path == "/api/fingerprint":
                    return self._json({"fp": app.fingerprint()})
            except Exception as e:
                return self._json({"error": str(e)}, 500)
            self._json({"error": "not found"}, 404)

        def do_POST(self):
            if not self._local_only():
                return
            if self.headers.get("X-Galaxy") != "1":  # blocks cross-site form posts
                return self._json({"error": "missing X-Galaxy header"}, 403)
            u = urlparse(self.path)
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_IMPORT_BYTES:
                return self._json({"error": "file too large"}, 413)
            body = self.rfile.read(n) if n else b""
            try:
                if u.path == "/api/settings":
                    data = json.loads(body or b"{}")
                    return self._json({"settings": app.save_settings(**data)})
                if u.path == "/api/refresh":
                    d = app.refresh_hermes()
                    return self._json({"hermes": {k: v for k, v in d.items() if k not in ("cli", "exports")}})
                if u.path == "/api/import":
                    name = parse_qs(u.query).get("name", ["journey.json"])[0]
                    return self._json({"saved": app.import_file(name, body)})
            except Exception as e:
                return self._json({"error": str(e)}, 400)
            self._json({"error": "not found"}, 404)

    return Handler


class LocalServer(ThreadingHTTPServer):
    """Binds exclusively. Windows' SO_REUSEADDR lets two servers share a port, which hides the second
    launch behind the first; exclusive binding makes it move to the next free port instead."""
    allow_reuse_address = not IS_WIN
    daemon_threads = True

    def server_bind(self):
        import socket
        if IS_WIN and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def serve(app: Galaxy, port: int, open_browser: bool, query: str) -> None:
    server = None
    for p in range(port, port + 10):
        try:
            server = LocalServer(("127.0.0.1", p), make_handler(app))
            break
        except OSError:
            continue
    if server is None:
        sys.exit(f"Ports {port}-{port + 9} are all busy. Try: python3 galaxy.py --port 9100")
    if server.server_address[1] != port:
        print(f"  Port {port} is in use (maybe another galaxy is already running), using {server.server_address[1]}.")
    url = f"http://127.0.0.1:{server.server_address[1]}/{query}"
    print(f"\n  Hermes Journey Galaxy is running at {url}\n  Press Ctrl+C to stop.\n", flush=True)
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")


def terminal_prompt(app: Galaxy) -> None:
    """First run in a real terminal: offer the detected Hermes install. Agents and pipes skip this."""
    if app.settings["hermes"] != "unset" or app.demo_only or not sys.stdin.isatty():
        return
    print("  Looking for Hermes Agent...", flush=True)
    d = app.wait_detection()
    if not d.get("found"):
        print("  Hermes Agent was not found. The browser will show the demo galaxy and how to add a journey.")
        return
    rows = ", ".join(f"{r['name']} ({r['skills']} skills, {r['memories']} memories)" for r in d["profiles"])
    print(f"  Found Hermes Agent v{d['version']} at {d['path']}")
    print(f"  Profiles: {rows}")
    try:
        ans = input("  Render your journey from this install? [Y/n] ").strip().lower()
    except EOFError:
        return
    app.save_settings(hermes="off" if ans in ("n", "no") else "on")


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="View Hermes Agent journeys as a galaxy of solar systems.")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port to serve on (default {DEFAULT_PORT})")
    ap.add_argument("--no-open", action="store_true", help="don't open a browser tab")
    ap.add_argument("--use-hermes", action="store_true", help="use the detected Hermes install without asking")
    ap.add_argument("--no-hermes", action="store_true", help="don't read from Hermes; show journey files only")
    ap.add_argument("--hermes", metavar="PATH", help="path to the hermes launcher, if it isn't found automatically")
    ap.add_argument("--profile", metavar="NAMES", help="comma-separated Hermes profiles to show (default: all)")
    ap.add_argument("--name", help="label for your default profile's system (default: your username)")
    ap.add_argument("--journeys", metavar="DIR", default=str(ROOT / "journeys"), help="folder of journey files")
    ap.add_argument("--demo", action="store_true", help="show only the example galaxy")
    ap.add_argument("--tv", action="store_true", help="open in TV mode (no on-screen hints or menu button)")
    ap.add_argument("--detect", action="store_true", help="print what Hermes detection finds, then exit")
    ap.add_argument("--export", metavar="FILE", help="write the current galaxy to one shareable file, then exit")
    ap.add_argument("--version", action="version", version=f"hermes-journey-galaxy {__version__}")
    a = ap.parse_args(argv)

    app = Galaxy(Path(a.journeys).resolve(), a.hermes, a.demo)
    app.journeys_dir.mkdir(parents=True, exist_ok=True)
    if a.use_hermes:
        app.save_settings(hermes="on")
    if a.no_hermes:
        app.save_settings(hermes="off")
    if a.profile:
        app.save_settings(profiles=[p.strip() for p in a.profile.split(",") if p.strip()])
    if a.name:
        app.save_settings(name=a.name)
    app.start_detection()

    if a.detect:
        d = app.wait_detection()
        print(json.dumps({k: v for k, v in d.items() if k not in ("cli", "exports")}, indent=2))
        return
    if a.export:
        app.wait_detection()
        data = app.journeys(show_memory_text=False)
        Path(a.export).write_text(json.dumps({"format": "hermes-journey-galaxy", "profiles": data["journeys"]}),
                                  encoding="utf-8")
        print(f"Wrote {len(data['journeys'])} journeys to {a.export} (memory text removed).")
        return

    terminal_prompt(app)
    serve(app, a.port, not a.no_open, "?tv" if a.tv else "")


if __name__ == "__main__":
    main()
