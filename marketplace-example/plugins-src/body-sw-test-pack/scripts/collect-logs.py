"""Collect the newest CANoe test logs into one folder for a HIL report.

Usage: python collect-logs.py <canoe-log-folder> <output-folder> [--last N]
"""
import shutil
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    src, out = Path(argv[0]), Path(argv[1])
    last = int(argv[argv.index("--last") + 1]) if "--last" in argv else 20
    logs = sorted(src.glob("**/*.blf"), key=lambda p: p.stat().st_mtime, reverse=True)[:last]
    out.mkdir(parents=True, exist_ok=True)
    for p in logs:
        shutil.copy2(p, out / p.name)
    print(f"copied {len(logs)} log(s) to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
