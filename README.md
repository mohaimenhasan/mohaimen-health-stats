# My Fitness

A visualization-only dashboard built from Apple Health and Strava exports, plus BodySpec DEXA scans. The home view focuses on training analysis: weekly consistency, intensity distribution, sport comparisons, distance rate, training load and next-day resting-HR relationships. Body measurements, DEXA, daily health and weight correlations are in a separate **Body & health** view.

Date presets and custom dates apply across both views. The sport filter controls training metrics; daily health measurements remain date-based. Views, dates and sports persist in the URL. Info buttons show definitions, missing-data rules and estimates on hover, keyboard focus or tap; clicking pins them open.

**Live site:** https://mohaimenhasan.github.io/mohaimen-health-stats/ (sign-in required; anyone can request access from the sign-in page)

## How it works

```
inbox/ (gitignored)                      healthstats/ (Python)              site/ (GitHub Pages)
├─ Apple export ───────────────────────┐  parse → merge → analyse →         ├─ index.html, app.js (ECharts)
├─ Strava export ─────────────────────┼─► privacy audit ───────────────►  ├─ data/*.json (local only)
└─ dexa_links.txt ────────────────────┘                                     └─ fitness.enc (deployed)
config/  profile.json, weight_log.csv + dexa/ (gitignored)
data.enc  encrypted bundle of site/data, weight_log.csv and dexa/ (the only copy in git)
worker/   Cloudflare Worker: sign-in handoff, decrypts fitness.enc for approved viewers, access requests
```

1. `python -m healthstats` finds the newest Apple and Strava export in `inbox/`. Each can be a zip or an unzipped folder. It writes JSON files to `site/data/`.
2. A privacy audit scans generated files and aborts if it finds an email, GPS coordinates, a DEXA share link, a birth date or a phone number.
3. `python -m healthstats.vault seal` encrypts `site/data/`, `config/weight_log.csv` and `config/dexa/` into `data.enc` (Fernet, key in the gitignored `.data-key`).
4. Pushing to `main` triggers `.github/workflows/pages.yml`. It runs the tests, decrypts `site/data/` with the `DATA_KEY` repo secret and runs the audit. `python -m healthstats.vault pack` then seals the site data into `site/fitness.enc` for the Worker's public key (`config/site-pubkey.pem`), `site/data/` is deleted and `site/` is deployed. Neither the Pages site nor its artifact contains readable data. The artifact is kept for 1 day.
5. The Worker fetches `fitness.enc`, decrypts it with its private key and returns the data only to signed-in, approved viewers. New data appears within about 15 minutes of a deploy (Pages CDN plus a 5-minute Worker cache).

## Data access

- **Repository:** no readable personal data. Generated data and personal inputs exist only inside `data.enc`, and earlier readable versions were removed from `main`'s history.
- **Key:** `.data-key` (local, gitignored) and the `DATA_KEY` Actions secret. Keep a backup of `.data-key`; without it `data.enc` cannot be decrypted.
- **Live site:** GitHub Pages serves only the page code and `fitness.enc`. The data is decrypted by the Worker and sent only to approved viewers, who can still see (and save) whatever their browser receives.

## Access

Sign-in uses [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/) (Zero Trust free plan, up to 50 users) in front of the Worker at `https://fitness.mohaimenhasan.workers.dev`.

1. **Sign in:** the page's *Sign in* button goes to `/auth/login` on the Worker. Access asks for an email and sends a one-time code (or uses Google, if added). The Worker checks the Access JWT, confirms the email is the owner or approved, and redirects back to the site with a 7-day session token in the URL fragment. The page stores it and removes it from the URL.
2. **Request access:** the *Request access* button opens a form that posts name, email and an optional note to `/api/request`, protected by [Turnstile](https://developers.cloudflare.com/turnstile/) (loaded only when the form opens). Requests are kept in Workers KV for 30 days.
3. **Notification:** `.github/workflows/access-requests.yml` runs every 15 minutes. It authenticates to the Worker with a GitHub OIDC token that only this workflow on `main` can mint, gets counts only (no names or emails), and @mentions the owner on an *Access requests* issue. The issue closes when nothing is pending. The run fails if the Worker cannot decrypt the deployed `fitness.enc`, so a broken data deploy shows up as a failed-workflow email. GitHub disables scheduled workflows after 60 days without repository activity; re-enable it in the Actions tab if that happens.
4. **Approve:** the owner sees an *Admin* link beside *Sign out* after signing in. It opens `https://fitness.mohaimenhasan.workers.dev/auth/admin`, which lists pending requests. Other viewers do not see the link; the Worker still enforces owner-only access. *Approve* adds the email to the Zero Trust list used by the Access policy and to KV; *Send link* opens a pre-filled email with the site link. *Remove* revokes access, and the viewer's next page load shows the sign-in page.

**Add Google sign-in (optional).** In Google Cloud, create an OAuth client (*Web application*) with JavaScript origin `https://mohaimen-fitness.cloudflareaccess.com` and redirect URI `https://mohaimen-fitness.cloudflareaccess.com/cdn-cgi/access/callback`. Then add it under Zero Trust → Integrations → Identity providers → Google ([guide](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/)). The Access app accepts all configured identity providers, so no other change is needed.

**Deploy the Worker** (after changing `worker/`):

```sh
cd worker && npx wrangler deploy
```

Secrets (set once with `npx wrangler secret put <NAME>`): `OWNER_EMAIL`, `SESSION_SECRET`, `SITE_PRIVATE_KEY` (private half of `config/site-pubkey.pem`), `TURNSTILE_SECRET`, `CF_API_TOKEN` (Zero Trust write, used to edit the viewer list). Rotating `SESSION_SECRET` signs everyone out.

## Updating the site

Export the data:
- **Apple Health:** Health app → profile → *Export All Health Data*.
- **Strava:** Settings → My Account → *Download or Delete Your Account* → *Request your archive*.

Then run:

```sh
scripts/update.sh ~/Downloads/export.zip ~/Downloads/export_12345.zip
```

The script copies the zips into `inbox/`, rebuilds, audits, re-seals `data.enc`, commits `data.enc` + `config/profile.json`, and pushes. Pass `--no-push` to only commit locally. If you omit the zip arguments, it uses whatever is already in `inbox/`.

Other inputs:
- **New DEXA scan:** add the BodySpec share link as a new line in `inbox/dexa_links.txt`. The pipeline fetches each link once and caches the result in `config/dexa/`. Only a hash of the link is stored.
- **Weight log:** append `YYYY-MM,lb` rows to `config/weight_log.csv`.
- **Comparison periods:** edit `config/profile.json`.

## Development

```sh
python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m healthstats.vault open   # restore site/data and config inputs (needs .data-key or DATA_KEY)
.venv/bin/python -m healthstats          # rebuild data (~20 s cold; parsed Apple data is cached in .cache/)
.venv/bin/python -m pytest -q tests      # unit tests on synthetic data
node --test tests/test_fitness.mjs worker/test/worker.test.mjs   # sport filters, training load, Worker auth
python3 -m http.server -d site 8000      # preview at http://localhost:8000 (reads site/data, no sign-in)
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
| `build.py` | Orchestrates the pipeline and writes aggregate JSON |
| `privacy.py` | Final scan of generated files for selected identifiers |
| `vault.py` | Encrypts and decrypts `data.enc`; `pack` seals site data into `site/fitness.enc` for the Worker |

The interface uses the project skills in `.agents/skills/`, installed with `npx skills add`; `npx ui-skills` was used to review the UI guidance. The `premium-frontend-ui` skill from `github/awesome-copilot` is also installed. Dashboard interactions retain native controls and reduced-motion support rather than adding decorative animation.

## Methods

- **Weight:** monthly self-reported log, Apple Health scale entries and DEXA, interpolated to daily values.
- **Workouts:**
  - Apple Health and Strava sessions are merged. When several apps record the same session (≥50% overlap), only one copy is kept, with Apple Watch preferred.
  - Sessions without energy data get kcal estimated from avg HR. The fit uses my own sessions of the same type, and the site marks these values with `~`.
- **Local time:** Apple stores every timestamp in the exporting phone's offset. Each timestamp is therefore shifted to the time zone of the nearest Apple Watch workout.
- **Heart rate:** max HR is the 99.9th percentile of in-workout HR. Zones are 60/70/80/90% of max HR. Training load uses Banister TRIMP; fitness is the 42-day EWMA and fatigue the 7-day EWMA.
- **Soccer speed:** taken from Strava GPX only, using a 2-second displacement window with plausibility filters. A sprint means ≥21 km/h held for ≥2 s. Top speed is the best 5-second average.
- **Sport filters:** options come from recorded activities, with grouped choices for categories containing multiple activity types. Soccer is the display name for the pipeline's Football category.
- **Training load:** sport-specific curves use the full recorded history before clipping to the selected dates, so changing the start date does not reset fitness or fatigue.
- **Consistency:** active Monday-based weeks, consecutive active-week streaks and trailing 8-week participation. Empty weeks mean no recorded selected sessions, not necessarily no exercise.
- **Intensity:** Z4 + Z5 minutes as a share of known HR-zone minutes; missing HR time is excluded.
- **Next-day resting HR:** selected-sport TRIMP paired with the following day's RHR deviation from its preceding 28-day mean (at least 7 baseline readings). Both paired days must be inside the range. These associations are not causal.
- **Correlations:** computed on daily, weekly or monthly buckets according to the selected date range. Workout-session correlations follow the sport filter. They are observational and say nothing about causation.

## Privacy

- Raw exports (`inbox/`, `*.zip`, `*.xml`, `*.gpx`, `*.fit`) are gitignored.
- Generated data, the weight log and DEXA results are committed only as `data.enc`.
- The deployed site holds only `fitness.enc`; readable data is served by the Worker to approved, signed-in viewers.
- The privacy scan checks generated files for selected identifiers before they are sealed.
- Access-request details stay in Workers KV. The repository, issue and Actions logs only ever see counts.
