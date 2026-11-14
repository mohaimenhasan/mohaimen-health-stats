#!/usr/bin/env bash
# Refresh the site from new exports and publish it.
#
#   scripts/update.sh [export.zip] [strava_export.zip] [--no-push]
#
# Zips passed as arguments are copied into inbox/. With no arguments, whatever is
# already in inbox/ is used (the newest Apple and the newest Strava export win).
set -euo pipefail
cd "$(dirname "$0")/.."

PY=.venv/bin/python
if [ ! -x "$PY" ]; then
  BASE=$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3)
  "$BASE" -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi

mkdir -p inbox
push=1
for arg in "$@"; do
  case "$arg" in
    --no-push) push=0 ;;
    *.zip)
      dest="inbox/$(basename "$arg")"
      cp "$arg" "$dest"
      touch "$dest"  # newest file wins in inbox/
      echo "copied $(basename "$arg") → inbox/" ;;
    *) echo "skipping $arg (expected a .zip or --no-push)" >&2 ;;
  esac
done

"$PY" -m healthstats
"$PY" -m healthstats.privacy site config
if [ ! -f .data-key ] && [ -z "${DATA_KEY:-}" ]; then
  echo "Missing .data-key (restore your backup, or: $PY -m healthstats.vault keygen && gh secret set DATA_KEY < .data-key)" >&2
  exit 1
fi
"$PY" -m healthstats.vault seal

git add data.enc config
if git diff --cached --quiet; then
  echo "No data changes to publish."
  exit 0
fi
git commit -q -m "Data refresh $(date +%Y-%m-%d)"
if [ "$push" = 1 ]; then
  git push -q
  echo "Pushed. GitHub Pages redeploys in about a minute."
else
  echo "Committed locally (not pushed)."
fi
