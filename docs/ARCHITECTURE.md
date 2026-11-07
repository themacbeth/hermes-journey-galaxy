# Architecture

## Overview

```text
hermes CLI ──(journey --json)──> galaxy.py ──(/api/journeys)──> web/app.js ──> web/galaxy.js (three.js)
journeys/*.json ───────────────────┘   │
examples/*.json (demo, used when nothing else is available)
```

`galaxy.py` turns every source into one list of journeys:

```json
{ "name": "ALEX", "source": "alex-journey.json", "kind": "file|hermes|demo",
  "graph": { "nodes": [{ "id", "kind": "skill|memory", "label", "timestamp": ms, "use_count", "pinned" }],
             "edges": [{ "source", "target" }] } }
```

Normalization rules are in `normalize_graph`:

- Archived nodes are dropped.
- Timestamps become milliseconds; seconds and ISO strings are both accepted.
- Edges that point at missing nodes are dropped, and so are duplicate edges in either direction.
- Memory labels are replaced with `Memory note NN` (or `Profile note NN` for user-profile notes) unless `?memories=1` is in the URL.

## Accepted input formats

| Format | Detected by | Result |
|---|---|---|
| `hermes journey --json` | top-level `nodes` | one system, labeled from `name` or the filename |
| Multi-profile export | `profiles[]`, each with `nodes` | merged into one system: same id = same skill, earliest date, highest use count |
| Galaxy file (`--export`) | `profiles[]`, each with `graph` | one system per entry |

Text before the first `{` is ignored, so a `.txt` file saved from a chat or a terminal still loads.

## HTTP API

All routes answer only when the Host header is `127.0.0.1`, `localhost`, or `::1`. POST routes also need the `X-Galaxy: 1` header, which blocks cross-site form posts.

| Route | Purpose |
|---|---|
| `GET /api/state` | Detection result (path, version, profile counts), saved settings, file list |
| `GET /api/journeys[?memories=1]` | Normalized journeys, plus `demo` and `warnings` |
| `GET /api/fingerprint` | Changes when files, settings or Hermes data change; the page polls it every 4 s |
| `POST /api/settings` | `{hermes: "on"|"off", profiles: [..]|null, name}` |
| `POST /api/refresh` | Re-reads every Hermes profile |
| `POST /api/import?name=FILE` | Saves a dropped journey into `journeys/` after checking it is a journey |

## Renderer (web/galaxy.js)

- **Layout.** Each journey is a system. Planets sit at a radius set by their learn date, oldest closest to the star. `layoutSystems()` places the systems with a relaxation solver so their footprints never overlap. Every system shares one plane and one angular speed, so the galaxy turns as a rigid body and the spacing never changes.
- **Render passes.** The background pass draws everything. When a system is in focus, a blur pass softens the rest, and the focused system is drawn again on a sharp layer. Bloom, FXAA, and a film pass (vignette and grain) follow.
- **Performance.** Distant systems draw their planets as one `Points` batch, and close systems switch to meshes. Orbit rings are merged into one `LineSegments` per system and revealed with `setDrawRange`. On 4K screens the pixel ratio is capped at about 1440p.
- **Idle tour.** `BEATS` cycles through grow (every journey from day one), wide, a dive into a system with a timeline replay and node highlights, the core close-up, and the comparison boards. Any input switches to interactive mode, and 25 s of idle returns to the tour.
- **Labels.** DOM labels are positioned once per frame, after the camera moves, from `project(camera)`. Neighbor labels use greedy placement to avoid overlaps.
- **Rebuild.** `buildGalaxy(journeys)` disposes the old systems and builds new ones. It is called on load, on live reload, and after an import.

## Rebuilding vendored three.js

`web/vendor/three.module.min.js` is three r160, plus the addons the renderer uses, bundled into one ES module:

```bash
mkdir -p /tmp/three-vendor && cd /tmp/three-vendor
npm init -y >/dev/null && npm install three@0.160.0 esbuild@0.24.0
cat > entry.mjs <<'EOF'
export * from "three";
export { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
export { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
export { Pass } from "three/examples/jsm/postprocessing/Pass.js";
export { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
export { FXAAShader } from "three/examples/jsm/shaders/FXAAShader.js";
export { HorizontalBlurShader } from "three/examples/jsm/shaders/HorizontalBlurShader.js";
export { VerticalBlurShader } from "three/examples/jsm/shaders/VerticalBlurShader.js";
EOF
npx esbuild entry.mjs --bundle --format=esm --minify --legal-comments=eof --outfile=three.module.min.js
cp three.module.min.js <repo>/web/vendor/
```

## Demo data

`examples/*.json` are 7 fictional journeys, generated in the exact `hermes journey --json` shape, using real Hermes skill names with invented people, dates and use counts. `web/demo-galaxy.json` holds the same data, normalized, for static hosting such as GitHub Pages, where `/api` does not exist.
