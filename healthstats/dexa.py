"""BodySpec DEXA results, fetched from a public share link and cached in config/dexa/."""
from __future__ import annotations

import hashlib
import json
import re
import urllib.request
from pathlib import Path

GRAPHQL = "https://www.bodyspec.com/graphql"
QUERY = """query ($cache: ID!) { reports { dexa(cache: $cache) { id error inputsJson reference
  summary { start { full: time(fmt: "Jan 02, 2006 at 3:04pm") } fat: fatGrams lean: leanGrams bone: boneGrams }
  sections { metric results { start { date } value parse: string percentile } } } } }"""

G_TO_LB = 1 / 453.59237


def share_id(link: str) -> str | None:
    m = re.search(r"([0-9a-f]{32})", link)
    return m.group(1) if m else None


def fetch(share: str, timeout: int = 30) -> dict:
    body = json.dumps({"query": QUERY, "variables": {"cache": share}}).encode()
    req = urllib.request.Request(GRAPHQL, data=body, headers={
        "content-type": "application/json",
        "referer": f"https://www.bodyspec.com/shared-dexa/{share}",
        "user-agent": "health-stats-site/1.0",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.load(resp)
    dexa = payload["data"]["reports"]["dexa"]
    if dexa.get("error"):
        raise RuntimeError(dexa["error"])
    return normalize(dexa)


def _pct(p):
    return None if p is None or p < 0 else p


def normalize(dexa: dict) -> dict:
    """Keep only body-composition metrics. Age and account identifiers are dropped."""
    sections = {s["metric"]: s["results"][-1] for s in dexa["sections"] if s["results"]}
    summ = dexa["summary"][-1]
    out: dict = {
        "date": sections["BODY_FAT_PCT"]["start"]["date"],
        "provider": "BodySpec DEXA",
        "fat_lb": round(summ["fat"] * G_TO_LB, 1),
        "lean_lb": round(summ["lean"] * G_TO_LB, 1),
        "bone_lb": round(summ["bone"] * G_TO_LB, 1),
    }
    out["total_lb"] = round(out["fat_lb"] + out["lean_lb"] + out["bone_lb"], 1)
    ref = None
    try:
        inputs = json.loads(dexa.get("inputsJson") or "{}")
        f = inputs.get("filter", {})
        ref = {"gender": f.get("gender"), "min_age": f.get("min_age"), "max_age": f.get("max_age"), "population": dexa.get("reference")}
    except (ValueError, AttributeError):
        pass
    out["reference"] = ref

    simple = {
        "BODY_FAT_PCT": "body_fat_pct",
        "VAT_MASS": "vat_lb",
        "BODY_MASS_INDEX": "bmi",
        "LEAN_MASS_INDEX": "lmi",
        "BONE_DENSITY": "bmd",
        "ALMI": "almi",
    }
    for metric, key in simple.items():
        r = sections.get(metric)
        if r:
            out[key] = round(r["value"], 3)
            out[f"{key}_percentile"] = _pct(r.get("percentile"))

    rmr = sections.get("RMR_ESTIMATE")
    if rmr and rmr.get("parse"):
        parts = rmr["parse"].split("#")
        out["rmr"] = {parts[i]: int(parts[i + 1]) for i in range(0, len(parts) - 1, 2)}

    reg = sections.get("REGIONAL_COMP")
    if reg and reg.get("parse"):
        data = json.loads(reg["parse"])
        out["regional"] = {
            region: {
                part: {"lb": round(v["grams"] * G_TO_LB, 2), "pct_region": v.get("pct_region"), "percentile": v.get("pct_ntile")}
                for part, v in comp.items()
            }
            for region, comp in data.items()
        }
    sym = sections.get("SYMMETRY_COMP")
    if sym and sym.get("parse"):
        data = json.loads(sym["parse"])
        out["symmetry"] = {
            limb: {side: {k: v for k, v in vals.items() if k.endswith("_lbs")} for side, vals in sides.items() if side in ("left", "right")}
            for limb, sides in data.items()
        }
    return out


def sync(links: list[str], cache_dir: Path, offline: bool = False, verbose: bool = True) -> list[dict]:
    """Fetch any share link not yet cached; return every cached scan, oldest first."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    index_file = cache_dir / "index.json"
    index = json.loads(index_file.read_text()) if index_file.exists() else {}
    for link in links:
        sid = share_id(link)
        if not sid:
            continue
        key = hashlib.sha256(sid.encode()).hexdigest()[:16]  # never commit the share link itself
        if key in index or offline:
            continue
        try:
            scan = fetch(sid)
        except Exception as exc:  # network hiccups shouldn't block a data refresh
            print(f"  ! could not fetch DEXA {sid[:6]}…: {exc}")
            continue
        (cache_dir / f"{scan['date']}.json").write_text(json.dumps(scan, indent=2))
        index[key] = scan["date"]
        if verbose:
            print(f"  fetched DEXA scan {scan['date']}")
    index_file.write_text(json.dumps(index, indent=2, sort_keys=True))
    scans = [json.loads(p.read_text()) for p in sorted(cache_dir.glob("*.json")) if p.name != "index.json"]
    return sorted(scans, key=lambda s: s["date"])
