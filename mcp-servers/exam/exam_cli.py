"""Shell access to the exam tools, for harnesses where MCP is blocked.

    python exam_cli.py                      -> list tools
    python exam_cli.py exam_status
    python exam_cli.py exam_run '{"test_object": "MyProject.Suites.Smoke"}'
    python exam_cli.py exam_groovy @script.json   (arguments read from a JSON file — easiest for long scripts)

Prints the tool result (JSON or text, clipped like MCP results); exit code 1 on error.
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from server import S  # noqa: E402


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help", "list"):
        for name, (_, meta) in S.tools.items():
            props = ", ".join(meta["inputSchema"].get("properties", {}).keys())
            print(f"{name}({props}) — {meta['description']}")
        return 0
    name, raw = argv[0], (argv[1] if len(argv) > 1 else "{}")
    if raw.startswith("@"):
        with open(raw[1:], encoding="utf-8") as fh:
            raw = fh.read()
    try:
        args = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        print(f"Error: arguments are not valid JSON ({e}). Tip: put them in a file and pass @file.json", file=sys.stderr)
        return 1
    res = S.call(name, args)
    print(res["content"][0]["text"])
    return 1 if res.get("isError") else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
