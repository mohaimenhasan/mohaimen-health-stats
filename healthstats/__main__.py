"""python -m healthstats [--inbox inbox] [--out site/data] [--offline]"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from . import build
from .sources import find_latest

ROOT = Path(__file__).resolve().parent.parent


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Rebuild site/data from the newest exports in the inbox.")
    ap.add_argument("--inbox", type=Path, default=ROOT / "inbox", help="folder holding Apple/Strava zips or unzipped folders")
    ap.add_argument("--out", type=Path, default=ROOT / "site/data")
    ap.add_argument("--offline", action="store_true", help="don't fetch new DEXA scans")
    ap.add_argument("-q", "--quiet", action="store_true")
    args = ap.parse_args(argv)

    t0 = time.time()
    found = find_latest(args.inbox)
    if "apple" not in found:
        print(f"No Apple Health export (zip or folder containing export.xml) found in {args.inbox}", file=sys.stderr)
        return 1
    if not args.quiet:
        for kind, src in found.items():
            print(f"  {kind:6s} ← {src}")
    links_file = args.inbox / "dexa_links.txt"
    links = [l.strip() for l in links_file.read_text().splitlines() if l.strip() and not l.startswith("#")] if links_file.exists() else []
    build.run(found["apple"], found.get("strava"), ROOT, args.out, links, offline=args.offline, verbose=not args.quiet)
    if not args.quiet:
        print(f"done in {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
