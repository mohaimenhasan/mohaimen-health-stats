"""Last line of defence: scan generated files for anything that shouldn't be public."""
from __future__ import annotations

import re
from pathlib import Path

PATTERNS = {
    "email address": re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    "GPS coordinate pair": re.compile(r'"(lat|lon|latitude|longitude)"\s*:'),
    "DEXA share link": re.compile(r"shared-dexa|[0-9a-f]{32}"),
    "date of birth": re.compile(r"DateOfBirth|date_of_birth|\"dob\""),
    "phone number": re.compile(r"\+?\d{1,2}[ -]?\(?\d{3}\)?[ -]\d{3}-\d{4}"),
}


def audit(*paths: Path, extra: dict[str, str] | None = None) -> list[str]:
    """Return human-readable problems found in any .json/.html/.js/.csv file under the given paths."""
    pats = dict(PATTERNS)
    for label, literal in (extra or {}).items():
        if literal:
            pats[label] = re.compile(re.escape(literal))
    problems = []
    for root in paths:
        files = [root] if root.is_file() else [p for p in root.rglob("*") if p.suffix in {".json", ".html", ".js", ".csv", ".md"}]
        for f in files:
            text = f.read_text(errors="ignore")
            for label, pat in pats.items():
                m = pat.search(text)
                if m:
                    problems.append(f"{f}: {label} ({m.group(0)[:40]!r})")
    return problems


if __name__ == "__main__":
    import sys

    found = audit(*(Path(a) for a in (sys.argv[1:] or ["site"])))
    print("\n".join(found) or "privacy audit passed")
    sys.exit(1 if found else 0)
