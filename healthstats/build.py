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


def _mean_window(s: pd.Series, center: pd.Timestamp, days: int) -> float | None:
    if s is None:
        return None
    w = s[(s.index >= center - pd.Timedelta(days=days)) & (s.index <= center + pd.Timedelta(days=days))].dropna()
    return float(w.mean()) if len(w) >= 5 else None


def _last_window(s: pd.Series, end: pd.Timestamp, days: int) -> float | None:
    w = s[(s.index > end - pd.Timedelta(days=days)) & (s.index <= end)].dropna()
    return float(w.mean()) if len(w) >= 3 else None


def _fmt(x, nd=0):
    return f"{x:,.{nd}f}"


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


# ---------------------------------------------------------------- insights

def make_insights(ctx: dict) -> list[dict]:
    out: list[dict] = []
    daily, weight, fb, monthly, dexa_scans, phases, corr = (ctx[k] for k in ("daily", "weight", "football", "monthly", "dexa", "phases", "corr"))
    end = ctx["end"]

    def add(key, kicker, headline, body, tone="neutral"):
        out.append({"id": key, "kicker": kicker, "headline": headline, "body": body, "tone": tone})

    def guard(fn):
        try:
            fn()
        except Exception as exc:  # one broken insight should never break the build
            print(f"  ! insight skipped: {fn.__name__}: {exc}")

    log = weight.log
    cur = float(log["weight_lb"].iloc[-1]) if len(log) else None
    height_m = ctx["height_cm"] / 100

    def _bmi(lb):
        return lb / analysis.KG_LB / height_m ** 2

    def weight_story():
        first = log.iloc[0]
        if weight.peak_date is None or cur is None:
            return
        gain = weight.peak_lb - first["weight_lb"]
        yrs = (weight.peak_date - first["date"]).days / 365.25
        add("gain", "The slow creep", f"+{gain:.0f} lb in {yrs:.1f} years",
            f"From {first['weight_lb']:.0f} lb in {first['date']:%b %Y} (when full-time work started) to a peak of {weight.peak_lb:.0f} lb in {weight.peak_date:%b %Y} — about {gain / yrs:.0f} lb a year, BMI {_bmi(first['weight_lb']):.1f} → {_bmi(weight.peak_lb):.1f}.", "bad")
        lost = weight.peak_lb - cur
        months = max((log["date"].iloc[-1] - weight.peak_date).days / 30.44, 1)
        add("loss", "The cut", f"−{lost:.0f} lb in {months:.0f} months",
            f"{weight.peak_lb:.0f} → {cur:.0f} lb ({lost / weight.peak_lb * 100:.0f}% of body weight), averaging {lost / months:.1f} lb/month or {lost / months * 12 / 52:.1f} lb/week. That's roughly {lost * analysis.KCAL_PER_LB:,.0f} kcal of cumulative deficit.", "good")
        lg = log.set_index("date")["weight_lb"].diff()
        lg = lg[lg.index > weight.peak_date]
        if len(lg):
            d = lg.idxmin()
            add("fastest", "Steepest month", f"−{abs(lg.min()):.0f} lb in a month",
                f"The biggest single drop in the log landed in {d:%B %Y}.", "good")

    def dexa_story():
        if not dexa_scans:
            return
        s = dexa_scans[-1]
        ref = s.get("reference") or {}
        pop = f"{ref.get('gender', '').lower()}s aged {ref.get('min_age')}–{ref.get('max_age')}" if ref.get("min_age") else "the reference population"
        bf_p = s.get("body_fat_pct_percentile")
        txt = f"DEXA on {pd.Timestamp(s['date']):%b %-d, %Y}: {s['fat_lb']:.1f} lb fat, {s['lean_lb']:.1f} lb lean, {s['bone_lb']:.1f} lb bone."
        if bf_p is not None:
            txt += f" Lower body fat than {100 - bf_p}% of {pop}."
        if s.get("vat_lb") is not None:
            txt += f" Visceral fat just {s['vat_lb']:.2f} lb."
        add("dexa", "Body composition", f"{s['body_fat_pct']:.1f}% body fat", txt, "good")
        reg = s.get("regional", {}).get("legs", {}).get("lean", {})
        if reg.get("percentile") and reg["percentile"] >= 80:
            add("legs", "Footballer's legs", f"Leg lean mass: {reg['percentile']}th percentile",
                f"{reg['lb']:.1f} lb of lean tissue in the legs — top {100 - reg['percentile']}% — while arms sit at the {s['regional']['arms']['lean']['percentile']}th. Fifteen years of football shows up on the scan.", "good")

    def heart_story():
        if weight.peak_date is None:
            return
        load_note = ""
        if "ctl" in daily:
            c0, c1 = _mean_window(daily["ctl"], weight.peak_date, 45), _last_window(daily["ctl"], end, 60)
            if c0 and c1 and c1 > c0 * 1.3:
                load_note = f" Over the same span training load rose {c1 / c0:.1f}× while eating in a deficit — both commonly push resting HR up and HRV down."
        for col, name, unit, better in (("rhr", "Resting heart rate", "bpm", "down"), ("vo2max", "VO₂ max", "ml/kg/min", "up"),
                                        ("hrv", "Heart-rate variability", "ms", "up"), ("walking_speed_kmh", "Walking speed", "km/h", "up")):
            if col not in daily:
                continue
            at_peak = _mean_window(daily[col], weight.peak_date, 45)
            now = _last_window(daily[col], end, 60)
            if at_peak is None or now is None:
                continue
            delta = now - at_peak
            good = (delta < 0) if better == "down" else (delta > 0)
            nd = 2 if col == "walking_speed_kmh" else 1
            add(f"{col}_change", name, f"{at_peak:.{nd}f} → {now:.{nd}f} {unit}",
                f"Average around peak weight vs. the last 60 days ({'+' if delta > 0 else ''}{delta:.{nd}f} {unit})." + (load_note if col in ("rhr", "hrv") and not good else ""),
                "good" if good else "warn")

    def corr_story():
        top = [c for c in corr if c["metric"] in ("rhr", "vo2max", "walking_speed_kmh", "hrv") and abs(c["r"]) >= 0.4]
        for c in top[:2]:
            direction = "rises" if c["per_10lb"] > 0 else "drops"
            add(f"corr_{c['metric']}", "Weight vs. " + c["label"], f"r = {c['r']:.2f}",
                f"Across {c['n']} months, every 10 lb of body weight {direction} {c['label']} by {abs(c['per_10lb']):.2f} on average (correlation, not causation).")

    def football_story():
        if not fb or not fb.get("games"):
            return
        add("football_total", "Football", f"{fb['games']} games, {fb['hours']:.0f} hours",
            f"Tracked since {pd.Timestamp(fb['first_date']):%b %Y}: {fb['km']:,.0f} km covered and {fb['kcal']:,.0f} active kcal burned on the pitch.", "good")
        if fb["prev_365"]:
            ratio = fb["last_365"] / fb["prev_365"]
            add("football_volume", "More football", f"{fb['last_365']} games in the last 12 months",
                f"vs. {fb['prev_365']} the year before ({ratio:.1f}×). Busiest month: {fb['busiest_month']['games']} games in {pd.Period(fb['busiest_month']['month']):%B %Y}.", "good" if ratio >= 1 else "bad")
        years = fb["per_year"]
        if len(years) >= 2:
            ys = sorted(years)
            a, b = years[ys[0]], years[ys[-1]]
            if a.get("km_per_game") and b.get("km_per_game"):
                add("football_engine", "Bigger engine", f"{a['km_per_game']:.1f} → {b['km_per_game']:.1f} km per game",
                    f"Average distance per game in {ys[0]} vs {ys[-1]}, with games averaging {b['avg_min']:.0f} minutes now.", "good")
        if fb.get("gps_games"):
            ts = fb["records"]["top_speed"]
            add("football_speed", "Sprinting", f"{fb['top_kmh_median']:.1f} km/h typical top speed",
                f"From {fb['gps_games']} GPS-tracked games: ~{fb['sprints_per_game']:.0f} sprints (≥21 km/h) and {fb['hsr_m_per_game']:.0f} m of high-speed running per game. Fastest 5-second burst: {ts['value']:.1f} km/h.")
        st = fb["streak"]
        if st["longest_weeks"] >= 4:
            add("football_streak", "Consistency", f"{st['longest_weeks']} straight weeks with football",
                f"Longest run of consecutive weeks with at least one game{'; currently on ' + str(st['current_weeks']) + ' weeks' if st['current_weeks'] > 1 else ''}.", "good")

    def phases_story():
        p = {r["key"]: r for r in phases}
        if "desk" in p and "cut" in p and p["desk"].get("steps") and p["cut"].get("steps"):
            d, c = p["desk"], p["cut"]
            add("phase_activity", "What changed", f"{d['workout_hours_per_week']:.1f} → {c['workout_hours_per_week']:.1f} training hrs/week",
                f"Desk years vs. the cut: steps {d['steps']:,.0f} → {c['steps']:,.0f}/day, active energy {d['active_kcal']:.0f} → {c['active_kcal']:.0f} kcal/day, football {d['football_per_month']:.1f} → {c['football_per_month']:.1f} games/month.", "good")

    def energy_story():
        if not dexa_scans or "basal_kcal" not in daily:
            return
        rmr = (dexa_scans[-1].get("rmr") or {})
        if not rmr:
            return
        dexa_rmr = max(rmr.values())
        watch = _last_window(daily["basal_kcal"].where(daily["basal_kcal"] > 1000), end, 60)
        bmr = _last_window(daily["bmr_est"], end, 30) if "bmr_est" in daily else None
        if watch:
            add("rmr", "Metabolism", f"~{dexa_rmr:,} kcal/day at rest",
                f"DEXA-based RMR (lean-mass equation) vs. {watch:,.0f} kcal/day of basal energy from the watch" + (f" and {bmr:,.0f} from Mifflin-St Jeor." if bmr else "."))

    def load_story():
        if "ctl" not in daily:
            return
        ctl = daily["ctl"].dropna()
        if ctl.empty:
            return
        peak_day = ctl.idxmax()
        add("fitness", "Training load", f"Fitness peaked {peak_day:%b %Y}",
            f"42-day heart-rate training load (CTL) hit {ctl.max():.0f} on {peak_day:%b %-d, %Y}; it's {ctl.iloc[-1]:.0f} now.")

    def rings_story():
        if "all_rings_pct" not in monthly:
            return
        p = {r["key"]: r for r in phases}
        if "cut" not in p:
            return
        m = monthly.copy()
        m.index = m.index.to_timestamp()
        cut = m[m.index >= pd.Timestamp(p["cut"]["start"])]["exercise_closed_pct"].mean()
        before = m[m.index < pd.Timestamp(p["cut"]["start"])]["exercise_closed_pct"].mean()
        if np.isfinite(cut) and np.isfinite(before):
            add("rings", "Exercise ring", f"Closed {cut:.0f}% of days",
                f"During the cut, vs. {before:.0f}% before it.", "good" if cut > before else "neutral")

    def intake_story():
        if "implied_intake_kcal" not in monthly or weight.peak_date is None:
            return
        m = monthly.copy()
        m.index = m.index.to_timestamp()
        cut = m[m.index > weight.peak_date].dropna(subset=["implied_intake_kcal"])
        desk = m[(m.index <= weight.peak_date) & (m.index >= pd.Timestamp("2020-08-01"))].dropna(subset=["implied_intake_kcal"])
        if len(cut) >= 3 and len(desk) >= 6:
            add("intake", "Energy balance (estimated)", f"~{cut['tdee_est'].mean() - cut['implied_intake_kcal'].mean():,.0f} kcal/day deficit",
                f"Watch-measured expenditure averaged {cut['tdee_est'].mean():,.0f} kcal/day during the cut. Back-solving from the weight curve (3,500 kcal/lb) puts intake near {cut['implied_intake_kcal'].mean():,.0f} kcal/day, vs. ~{desk['implied_intake_kcal'].mean():,.0f} during the desk years. Rough model — watch calorie estimates run high.")

    def habits_story():
        w = ctx["workouts"]
        fbw = w[w["category"] == "Football"]
        if fbw.empty:
            return
        days = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"]
        wd = fbw["weekday"].value_counts()
        evening = (fbw["hour"] >= 17).mean() * 100
        add("habits", "When I play", f"{days[int(wd.idxmax())]}, mostly after work",
            f"{wd.max() / len(fbw) * 100:.0f}% of games fall on {days[int(wd.idxmax())]}; {evening:.0f}% kick off at 5 pm or later.")

    for fn in (weight_story, dexa_story, football_story, habits_story, phases_story, intake_story, heart_story, corr_story, energy_story, load_story, rings_story):
        guard(fn)
    return out


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

    insights = make_insights({"daily": daily, "weight": weight, "football": football, "monthly": monthly,
                              "dexa": scans, "phases": phase_rows, "corr": corr, "end": end,
                              "workouts": w, "height_cm": cfg["height_cm"]})

    events = [dict(e) for e in cfg.get("events", [])]
    if weight.peak_date is not None:
        events.append({"date": weight.peak_date.date().isoformat(), "label": f"Peak {weight.peak_lb:.0f} lb"})
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
        "profile": {"title": cfg.get("title"), "display_name": cfg.get("display_name"), "tagline": cfg.get("tagline"),
                    "height_cm": cfg["height_cm"], "height_ftin": f"{int(h_in // 12)}′{round(h_in % 12)}″"},
        "kpis": kpis,
        "insights": insights,
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
    log(f"✓ wrote {len(list(out_dir.glob('*.json')))} files to {out_dir} (privacy audit passed)")
    return summary
