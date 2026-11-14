"""Orchestrates the pipeline and writes the JSON files the static site reads."""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from . import analysis, dexa, privacy, strava as strava_mod
from .apple import parse_export
from .daily import daily_frame, nightly_sleep
from .sources import ExportSource
from .tz import LocalTime
from .workouts import attach_heart_rate, dedupe, impute_energy, localize, merge_strava

ROUND = {
    "steps": 0, "distance_km": 2, "active_kcal": 0, "basal_kcal": 0, "exercise_min": 0, "stand_min": 0, "flights": 0,
    "daylight_min": 0, "rhr": 1, "hrv": 1, "walking_hr": 1, "resp_rate": 1, "spo2": 1, "vo2max": 1,
    "walking_speed_kmh": 2, "step_length_cm": 1, "walking_asymmetry_pct": 1, "double_support_pct": 1,
    "steadiness_pct": 0, "run_power_w": 0, "run_speed_kmh": 2, "run_gct_ms": 0, "run_vert_osc_cm": 1,
    "run_stride_m": 2, "hr_recovery": 0, "six_min_walk_m": 0, "hr_avg": 0, "hr_min": 0, "hr_max": 0,
    "move_kcal": 0, "move_goal": 0, "exercise_ring_min": 0, "exercise_goal": 0, "stand_hours": 0, "stand_goal": 0,
    "sleep_h": 2, "bedtime_h": 2, "wake_h": 2, "deep_h": 2, "rem_h": 2, "core_h": 2, "weight_lb": 1,
    "bmr_est": 0, "tdee_est": 0, "workout_min": 0, "football_min": 0, "trimp": 0, "ctl": 1, "atl": 1, "tsb": 1,
    "diet_kcal": 0, "diet_protein_g": 0,
}
DAILY_COLUMNS = ["steps", "distance_km", "active_kcal", "basal_kcal", "exercise_min", "flights", "daylight_min",
                 "move_kcal", "move_goal", "exercise_ring_min", "exercise_goal", "stand_hours", "stand_goal",
                 "rhr", "hrv", "walking_hr", "vo2max", "resp_rate", "spo2", "hr_avg", "hr_max",
                 "walking_speed_kmh", "step_length_cm", "walking_asymmetry_pct", "double_support_pct",
                 "run_power_w", "run_speed_kmh", "run_gct_ms", "run_vert_osc_cm", "run_stride_m",
                 "sleep_h", "bedtime_h", "wake_h", "weight_lb", "bmr_est", "tdee_est",
                 "workout_min", "football_min", "trimp", "ctl", "atl", "tsb"]
WORKOUT_FIELDS = ["date", "hour", "weekday", "category", "activity", "duration_min", "distance_km", "active_kcal",
                  "avg_hr", "max_hr", "z1", "z2", "z3", "z4", "z5", "trimp", "relative_effort", "elevation_m",
                  "temp_f", "indoor", "top_kmh", "sprints", "hsr_m", "sprint_m", "gps_km", "weight_lb", "src", "kcal_est"]


def _clean(o):
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        f = float(o)
        if math.isnan(f) or math.isinf(f):
            return None
        return round(f, 3) if abs(f) < 1000 else round(f, 1)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, (pd.Timestamp, datetime)):
        return o.date().isoformat() if o.hour == 0 and o.minute == 0 else o.isoformat()
    if isinstance(o, pd.Period):
        return str(o)
    if o is pd.NaT or (o is not None and not isinstance(o, (str, bool, int)) and pd.isna(o)):
        return None
    return o


def _columnar(df: pd.DataFrame, index_name: str, index_fmt=str) -> dict:
    out = {index_name: [index_fmt(i) for i in df.index]}
    for c in df.columns:
        nd = ROUND.get(c, 2)
        vals = df[c].astype(float).round(nd)
        out[c] = [None if pd.isna(v) else (int(v) if nd == 0 else float(v)) for v in vals]
    return out


def _write(out_dir: Path, name: str, obj) -> None:
    (out_dir / name).write_text(json.dumps(_clean(obj), separators=(",", ":"), ensure_ascii=False))


def _last_window(s: pd.Series, end: pd.Timestamp, days: int) -> float | None:
    w = s[(s.index > end - pd.Timedelta(days=days)) & (s.index <= end)].dropna()
    return float(w.mean()) if len(w) >= 3 else None


# ---------------------------------------------------------------- football

def football_summary(w: pd.DataFrame, end: pd.Timestamp) -> dict:
    fb = w[w["category"] == "Football"].copy()
    if fb.empty:
        return {"games": 0}
    fb["year"] = fb["date"].dt.year
    gps = fb.dropna(subset=["top_kmh"])
    per_year = fb.groupby("year").agg(
        games=("duration_min", "size"), hours=("duration_min", lambda s: s.sum() / 60),
        km=("distance_km", "sum"), kcal=("active_kcal", "sum"), avg_hr=("avg_hr", "mean"),
        avg_min=("duration_min", "mean"), km_per_game=("distance_km", "mean"), kcal_per_game=("active_kcal", "mean"),
        z4=("z4", "sum"), z5=("z5", "sum"), zone_total=("z1", lambda s: 0),
    )
    zones = fb[["z1", "z2", "z3", "z4", "z5"]]
    per_year[["z1", "z2", "z3", "z4", "z5"]] = fb.groupby("year")[["z1", "z2", "z3", "z4", "z5"]].sum()
    per_year = per_year.drop(columns="zone_total")
    per_year["top_kmh_median"] = gps.groupby("year")["top_kmh"].median()
    per_year["sprints_per_game"] = gps.groupby("year")["sprints"].mean()

    heat = np.zeros((7, 24), dtype=int)
    for wd, hr in zip(fb["weekday"], fb["hour"]):
        heat[int(wd), int(hr)] += 1

    week_counts = fb.groupby(fb["date"].dt.to_period("W-SUN")).size()
    month_counts = fb.groupby(fb["date"].dt.to_period("M")).size()

    def rec(col, fn="idxmax", df=fb):
        d = df.dropna(subset=[col])
        if d.empty:
            return None
        r = d.loc[getattr(d[col], fn)()]
        return {"value": r[col], "date": r["date"].date().isoformat()}

    return {
        "games": len(fb),
        "hours": fb["duration_min"].sum() / 60,
        "km": fb["distance_km"].sum(),
        "kcal": fb["active_kcal"].sum(),
        "avg_minutes": fb["duration_min"].mean(),
        "avg_hr": fb["avg_hr"].mean(),
        "first_date": fb["date"].min().date().isoformat(),
        "zones_total_min": zones.sum().to_dict(),
        "gps_games": len(gps),
        "top_kmh_median": gps["top_kmh"].median() if len(gps) else None,
        "sprints_total": gps["sprints"].sum() if len(gps) else None,
        "sprints_per_game": gps["sprints"].mean() if len(gps) else None,
        "hsr_m_per_game": gps["hsr_m"].mean() if len(gps) else None,
        "per_year": {int(k): v for k, v in per_year.to_dict(orient="index").items()},
        "weekday_hour": heat.tolist(),
        "busiest_week": {"games": int(week_counts.max()), "week_of": str(week_counts.idxmax().start_time.date())},
        "busiest_month": {"games": int(month_counts.max()), "month": str(month_counts.idxmax())},
        "streak": analysis.streaks(fb["date"], end),
        "last_365": int((fb["date"] > end - pd.Timedelta(days=365)).sum()),
        "prev_365": int(((fb["date"] <= end - pd.Timedelta(days=365)) & (fb["date"] > end - pd.Timedelta(days=730))).sum()),
        "records": {
            "longest": rec("duration_min"),
            "most_kcal": rec("active_kcal", df=fb[~fb["kcal_est"].fillna(False).astype(bool)] if "kcal_est" in fb else fb),
            "farthest": rec("distance_km"),
            "highest_avg_hr": rec("avg_hr"),
            "top_speed": rec("top_kmh"),
            "most_sprints": rec("sprints"),
            "biggest_load": rec("trimp"),
        },
    }


# ---------------------------------------------------------------- main

def run(apple_src: ExportSource, strava_src: ExportSource | None, root: Path, out_dir: Path,
        dexa_links: list[str], offline: bool = False, verbose: bool = True) -> dict:
    cfg = json.loads((root / "config/profile.json").read_text())
    tz = cfg.get("timezone", "UTC")
    cache = root / ".cache"
    log = print if verbose else (lambda *a, **k: None)

    log("• parsing Apple Health export")
    apple = parse_export(apple_src, cache, verbose=verbose)
    export_ts = apple.export_date or pd.Timestamp.now(tz="UTC")
    end = export_ts.tz_convert(tz).tz_localize(None).normalize()

    log("• daily rollups")
    local = LocalTime(tz, apple.workouts)
    daily = daily_frame(apple, local)
    sleep = nightly_sleep(apple.sleep, local)
    if not sleep.empty:
        daily = daily.join(sleep, how="left")
    has_data = daily[["steps", "active_kcal"]].notna().any(axis=1) if "active_kcal" in daily else daily["steps"].notna()
    start = daily.index[has_data].min()
    daily = daily.reindex(pd.date_range(start, end, freq="D"))
    daily.index.name = "date"

    log("• weight model")
    weight_log = pd.read_csv(root / "config/weight_log.csv", dtype={"month": str})
    weight = analysis.build_weight(weight_log, daily, end)
    daily["weight_lb"] = weight.daily.reindex(daily.index)
    dob = pd.Timestamp(apple.dob) if apple.dob else None
    age = ((daily.index - dob).days / 365.25) if dob is not None else pd.Series(cfg.get("age_fallback", 30), index=daily.index)
    daily["bmr_est"] = analysis.mifflin_bmr(daily["weight_lb"], cfg["height_cm"], pd.Series(np.asarray(age, dtype=float), index=daily.index), cfg.get("sex", "male"))
    worn = daily["active_kcal"] > 50
    daily["tdee_est"] = (daily["bmr_est"] + daily["active_kcal"]).where(worn)

    log("• workouts")
    strava_df = strava_mod.load_activities(strava_src) if strava_src else pd.DataFrame()
    strava_gps = strava_mod.gpx_metrics(strava_src, strava_df) if strava_src is not None and not strava_df.empty else pd.DataFrame()
    w = dedupe(apple.workouts)
    w = merge_strava(w, strava_df, strava_gps)
    recent_rhr = daily["rhr"].dropna()
    rest_hr = float(recent_rhr[recent_rhr.index > end - pd.Timedelta(days=365)].median()) if len(recent_rhr) else 60.0
    w, hr_max = attach_heart_rate(w, apple.records["hr"], rest_hr)
    w = impute_energy(w)
    w = localize(w, local)
    w = w[w["date"] <= end].reset_index(drop=True)
    w["weight_lb"] = weight.daily.reindex(w["date"]).to_numpy()
    w["src"] = np.where(w["source"].str.contains("Watch", case=False), "Apple Watch",
                        np.where(w["source"] == "Strava", "Strava", "Other app"))

    by_day = w.groupby("date")
    daily["workout_min"] = by_day["duration_min"].sum().reindex(daily.index).fillna(0)
    daily["football_min"] = w[w["category"] == "Football"].groupby("date")["duration_min"].sum().reindex(daily.index).fillna(0)
    daily["trimp"] = by_day["trimp"].sum().reindex(daily.index).fillna(0)
    daily = daily.join(analysis.training_load(daily["trimp"]))

    log("• monthly / phases / correlations")
    monthly = analysis.monthly_table(daily, w)
    phases = analysis.resolve_phases(cfg.get("phases", []), weight.peak_date, daily.index.min(), end + pd.Timedelta(days=1))
    phase_rows = analysis.phase_table(phases, daily, w, weight)
    corr = analysis.correlations(monthly)
    football = football_summary(w, end)

    log("• DEXA")
    scans = dexa.sync(dexa_links, root / "config/dexa", offline=offline, verbose=verbose)

    events = [dict(e) for e in cfg.get("events", [])]
    for s in scans:
        events.append({"date": s["date"], "label": "DEXA scan"})

    cur_lb = float(weight.log["weight_lb"].iloc[-1]) if len(weight.log) else None
    kpis = {
        "weight_now_lb": cur_lb,
        "weight_peak_lb": weight.peak_lb,
        "weight_peak_date": weight.peak_date,
        "weight_lost_lb": (weight.peak_lb - cur_lb) if cur_lb is not None and weight.peak_lb else None,
        "bmi_now": (cur_lb / analysis.KG_LB) / (cfg["height_cm"] / 100) ** 2 if cur_lb else None,
        "body_fat_pct": scans[-1]["body_fat_pct"] if scans else None,
        "football_games": football.get("games"),
        "football_hours": football.get("hours"),
        "workouts": len(w),
        "workout_hours": w["duration_min"].sum() / 60,
        "rhr_now": _last_window(daily["rhr"], end, 30),
        "vo2max_now": _last_window(daily["vo2max"], end, 60) if "vo2max" in daily else None,
        "steps_30d": _last_window(daily["steps"], end, 30),
        "days_tracked": int(daily["active_kcal"].gt(50).sum()),
    }
    h_in = cfg["height_cm"] / 2.54
    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "export_date": end.date().isoformat(),
        "data_start": daily.index.min().date().isoformat(),
        "profile": {"title": cfg.get("title"), "display_name": cfg.get("display_name"),
                    "height_cm": cfg["height_cm"], "height_ftin": f"{int(h_in // 12)}′{round(h_in % 12)}″"},
        "kpis": kpis,
        "phases": phase_rows,
        "correlations": corr,
        "events": sorted(events, key=lambda e: e["date"]),
        "hr": {"max_est": hr_max, "rest_est": rest_hr},
        "counts": {
            "apple_samples": int(sum(len(v) for v in apple.records.values())),
            "apple_workouts": int(len(apple.workouts)),
            "strava_activities": int(len(strava_df)),
            "workouts_after_dedupe": int(len(w)),
        },
        "records": {
            "most_steps": {"value": daily["steps"].max(), "date": daily["steps"].idxmax()},
            "most_active_kcal": {"value": daily["active_kcal"].max(), "date": daily["active_kcal"].idxmax()},
            "longest_workout": {"value": w["duration_min"].max(), "date": w.loc[w["duration_min"].idxmax(), "date"],
                                "category": w.loc[w["duration_min"].idxmax(), "category"]},
        },
    }

    log("• writing site data")
    out_dir.mkdir(parents=True, exist_ok=True)
    _write(out_dir, "summary.json", summary)
    _write(out_dir, "daily.json", _columnar(daily[[c for c in DAILY_COLUMNS if c in daily]], "date", lambda d: d.date().isoformat()))
    mcols = [c for c in monthly.columns]
    _write(out_dir, "monthly.json", _columnar(monthly[mcols], "month"))
    wk = w.copy()
    wk["date"] = wk["date"].dt.date.astype(str)
    for c in WORKOUT_FIELDS:
        if c not in wk:
            wk[c] = np.nan
    rows = wk[WORKOUT_FIELDS].to_dict(orient="split")
    _write(out_dir, "workouts.json", {"columns": WORKOUT_FIELDS, "rows": rows["data"]})
    _write(out_dir, "football.json", football)
    _write(out_dir, "weight.json", {
        "log": weight.log.assign(date=weight.log["date"].dt.date.astype(str)).to_dict(orient="records"),
        "weigh_ins": weight.weigh_ins.assign(date=pd.to_datetime(weight.weigh_ins["date"]).dt.date.astype(str)).to_dict(orient="records") if len(weight.weigh_ins) else [],
        "dexa": [{"date": s["date"], "weight_lb": s["total_lb"], "body_fat_pct": s.get("body_fat_pct")} for s in scans],
        "peak": {"date": weight.peak_date, "weight_lb": weight.peak_lb},
        "height_cm": cfg["height_cm"],
    })
    _write(out_dir, "dexa.json", scans)

    problems = privacy.audit(out_dir)
    if problems:
        raise SystemExit("privacy audit failed:\n  " + "\n  ".join(problems))
    log(f"wrote {len(list(out_dir.glob('*.json')))} files to {out_dir} (privacy audit passed)")
    return summary
