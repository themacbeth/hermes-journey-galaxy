#!/usr/bin/env python3
"""A stand-in for the `hermes` CLI, used by the tests. Answers --version and journey --json."""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
args = sys.argv[1:]

if args[:1] == ["--version"]:
    print("Hermes Agent v9.9.9 (test) · stable")
    sys.exit(0)

profile = "default"
if args[:1] == ["-p"]:
    profile, args = args[1], args[2:]

if args[:2] == ["journey", "--json"]:
    if profile == "broken":
        print("boom", file=sys.stderr)
        sys.exit(2)
    sys.stderr.write("warning: this goes to stderr and must be ignored\n")
    print("note: a line before the JSON, like some CLIs print")
    src = HERE / ("sample-journey.json" if profile == "default" else "empty-journey.json")
    print(src.read_text(encoding="utf-8"))
    sys.exit(0)

print(f"unexpected args: {sys.argv[1:]}", file=sys.stderr)
sys.exit(1)
