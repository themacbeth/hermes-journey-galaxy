#!/bin/bash
# Double-click to start Hermes Journey Galaxy. Close this window (or press Ctrl+C) to stop it.
cd "$(dirname "$0")"
if command -v python3 >/dev/null 2>&1; then exec python3 galaxy.py "$@"; fi
echo "Python 3 was not found. Install it from https://www.python.org/downloads/ and double-click this file again."
read -r -p "Press Enter to close."
