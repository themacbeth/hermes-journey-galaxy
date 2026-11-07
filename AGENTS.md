# AGENTS.md

Instructions for coding agents (Hermes, Claude Code, Codex, Cursor and others) working in this repository.

## What this is

A local web app that renders `hermes journey --json` graphs as a 3D galaxy, one solar system per journey. `galaxy.py` is a small standard-library Python server. `web/` holds plain ES modules with three.js vendored in. Nothing is built or installed.

## Set it up for a user

Do these in order. Use `python3` on macOS and Linux and `python` on Windows.

1. Check Python is 3.8 or newer: `python3 --version`.
2. Check the user's Hermes install: `python3 galaxy.py --detect`.
   - `"found": true` gives the version, path, and `skills` / `memories` per profile.
   - `"found": false` means it found no Hermes. Ask the user where `hermes` is, or skip Hermes and use journey files.
3. Start the server **in the background**, because it runs until it is stopped:
   - Hermes found, and at least one profile has skills: `python3 galaxy.py --use-hermes`
   - Hermes not found: `python3 galaxy.py` (shows the demo galaxy, and the user can drop files in)
   - Headless or remote machine: add `--no-open` and give the user the URL.
4. Read the URL from the first line of output (`running at http://127.0.0.1:PORT/`). The port moves up from 8791 if it is busy.
5. Report the URL, the profiles and counts from step 2, and how to stop the server (Ctrl+C, or end the background process).

`--use-hermes` saves the user's choice to `.galaxy/settings.json`, so later plain runs reuse it. Pass `--no-hermes` to switch it off.

### Adding someone else's journey

Copy their file into `journeys/`. Any `*.json` or `*.txt` containing `hermes journey --json` output works, and so does a multi-profile export or a galaxy file made with `--export`. The label comes from the filename (`alex-journey.json` becomes ALEX). A running page picks the file up within about 4 seconds.

## Rules

- **Never print, log, or summarize memory text** from a user's journey. Memory nodes (`"kind": "memory"`) hold private notes. Report only counts. The app replaces memory labels with `Memory note NN` unless `?memories=1` is in the URL. Keep that the default.
- Don't write to the user's Hermes home (`~/.hermes`, `%LOCALAPPDATA%\hermes`, or `$HERMES_HOME`). This tool only reads, through the `hermes` CLI.
- Don't add runtime dependencies. The Python side is standard library only. The web side has no build step, so if you change three.js, rebuild `web/vendor/three.module.min.js` (see docs/ARCHITECTURE.md).
- Keep the server bound to `127.0.0.1`. Keep the Host-header check and the `X-Galaxy` header requirement on POST routes.
- Never commit anything in `journeys/` or `.galaxy/`. Both are git-ignored, because they hold real people's data.
- On-screen copy is plain sentences. Avoid em dashes and marketing words.

## Verify changes

```bash
python3 -m unittest discover -s tests      # 22 tests, about 1 s, standard library only
python3 galaxy.py --demo --no-open          # then open the URL and check the browser console for errors
```

The tests use `tests/fake_hermes.py` as a stand-in `hermes` CLI, so they don't need a real install.

For visual changes, check a wide shot and a close-up of one system at 1600×900 or larger. The browser exposes debug hooks:

- `__debug()` returns the state, phase, focused system, and selection.
- `__phase('wide' | 'grow' | 'compare' | 'core')` jumps the tour to a phase.
- `__tour(i)` dives into system `i`.
- `__skip(seconds)` fast-forwards the current phase.
- `__qa` holds the internals: `systems`, `camera`, `composer`, `renderer`.

## Where things are

| Change | File |
|---|---|
| Hermes detection, profile listing, CLI calls | `galaxy.py`: `candidate_paths`, `HermesCLI`, `detect` |
| Journey formats, filename labels, memory hiding | `galaxy.py`: `normalize_graph`, `journeys_from_document`, `name_from_file` |
| HTTP API (`/api/state`, `/api/journeys`, `/api/import` ...) | `galaxy.py`: `make_handler` |
| First-run card, menu, drag and drop, live reload | `web/app.js` |
| Colors and star types per system | `web/palette.js` |
| Rendering, layout, camera, idle tour, captions | `web/galaxy.js` |
| HUD layout and styles | `web/index.html` |
