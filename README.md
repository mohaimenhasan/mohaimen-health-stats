# Body Stats

A personal dashboard built from my Apple Health and Strava exports, plus BodySpec DEXA scans. It covers my weight journey, football (⚽️) volume and intensity, heart and fitness trends, training load, energy balance and sleep.

**Live site:** https://mohaimenhasan.github.io/mohaimen-health-stats/

## How it works

```
inbox/ (gitignored)                      healthstats/ (Python)              site/ (static, GitHub Pages)
├─ export.zip or apple_health_export/ ─┐  parse → merge → analyse →         ├─ index.html, app.js (ECharts)
├─ strava export zip/folder ───────────┼─► privacy audit ───────────────►  └─ data/*.json  (aggregates only)
└─ dexa_links.txt ─────────────────────┘
config/  profile.json, weight_log.csv, dexa/ (cached scan results)
```

1. `python -m healthstats` finds the newest Apple and Strava export in `inbox/`. Each can be a zip or an unzipped folder. It then writes seven JSON files to `site/data/`.
2. A privacy audit scans the output and aborts the build if it finds an email, GPS coordinates, a DEXA share link, a birth date or a phone number.
3. Pushing to `main` triggers `.github/workflows/pages.yml`. The workflow runs the tests and the audit again, then deploys `site/` to GitHub Pages.

## Updating the site

Export the data:
- **Apple Health:** Health app → profile → *Export All Health Data*.
- **Strava:** Settings → My Account → *Download or Delete Your Account* → *Request your archive*.

Then run:

```sh
scripts/update.sh ~/Downloads/export.zip ~/Downloads/export_12345.zip
```

The script copies the zips into `inbox/`, rebuilds, audits, commits `site/data` + `config`, and pushes. Pass `--no-push` to only commit locally. If you omit the zip arguments, it uses whatever is already in `inbox/`.

Other inputs:
- **New DEXA scan:** add the BodySpec share link as a new line in `inbox/dexa_links.txt`. The pipeline fetches each link once and caches the result in `config/dexa/`. Only a hash of the link is stored.
- **Weight log:** append `YYYY-MM,lb` rows to `config/weight_log.csv`.
- **Phases and life events:** edit `config/profile.json`.

## Development

```sh
python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m healthstats          # rebuild data (~20 s cold; parsed Apple data is cached in .cache/)
.venv/bin/python -m pytest -q tests      # unit tests on synthetic data
python3 -m http.server -d site 8000      # preview at http://localhost:8000
```

| Module | Role |
| --- | --- |
| `sources.py` | Reads exports straight from a zip or a folder, so nothing needs unzipping |
| `apple.py` | Streaming parser for `export.xml` (records, workouts, sleep, HR) |
| `strava.py`, `gps.py` | Strava activities plus speed and sprint metrics from GPX tracks |
| `tz.py` | Infers local time zones from Apple Watch workout tags |
| `daily.py` | Daily rollups and nightly sleep |
| `workouts.py` | Merge, de-duplicate, HR zones, TRIMP load, kcal imputation |
| `analysis.py` | Weight model, monthly table, phases, correlations, fitness and fatigue |
| `dexa.py` | BodySpec DEXA fetch and normalisation |
| `build.py` | Orchestrates everything and writes the insight text |
| `privacy.py` | Final audit of everything that gets published |

## Methods

- **Weight:** monthly self-reported log, Apple Health scale entries and DEXA, interpolated to daily values.
- **Workouts:**
  - Apple Health and Strava sessions are merged. When several apps record the same session (≥50% overlap), only one copy is kept, with Apple Watch preferred.
  - Sessions without energy data get kcal estimated from avg HR. The fit uses my own sessions of the same type, and the site marks these values with `~`.
- **Local time:** Apple stores every timestamp in the exporting phone's offset. Each timestamp is therefore shifted to the time zone of the nearest Apple Watch workout.
- **Heart rate:** max HR is the 99.9th percentile of in-workout HR. Zones are 60/70/80/90% of max HR. Training load uses Banister TRIMP; fitness is the 42-day EWMA and fatigue the 7-day EWMA.
- **Football speed:** taken from Strava GPX only, using a 2-second displacement window with plausibility filters. A sprint means ≥21 km/h held for ≥2 s. Top speed is the best 5-second average.
- **Correlations:** computed on monthly averages. They are observational and say nothing about causation.

## Privacy

The repo is public. Raw exports (`inbox/`, `*.zip`, `*.xml`, `*.gpx`, `*.fit`) are gitignored and never leave this machine. Only aggregate numbers are published: no GPS coordinates, locations, contacts, clinical records, birth date or DEXA share links.
