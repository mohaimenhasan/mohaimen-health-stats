"""Unify Apple + Strava workouts, de-duplicate, and derive HR zones / training load."""
from __future__ import annotations

import numpy as np
import pandas as pd

CATEGORY = {
    "Soccer": "Football",
    "Running": "Running",
    "Walking": "Walking",
    "Hiking": "Hiking",
    "TraditionalStrengthTraining": "Strength",
    "FunctionalStrengthTraining": "Strength",
    "CoreTraining": "Strength",
    "Cycling": "Cycling",
    "Rowing": "Cardio machines",
    "Elliptical": "Cardio machines",
    "StairClimbing": "Cardio machines",
    "Swimming": "Swimming",
}
RACKET_AND_COURT = {"Tennis", "Badminton", "Pickleball", "Basketball", "Volleyball", "Squash", "TableTennis"}

ZONE_BOUNDS = (0.6, 0.7, 0.8, 0.9)  # fraction of HRmax that starts Z2..Z5
MIN_WORKOUT_MIN = 4
MAX_SAMPLE_GAP_S = 30
DENSE_PER_MIN = 0.5  # HR samples per minute needed to trust zone minutes


def category(activity: str) -> str:
    if activity in CATEGORY:
        return CATEGORY[activity]
    if activity in RACKET_AND_COURT:
        return "Other sports"
    return "Other"


def _priority(source: str) -> int:
    s = source.lower()
    if "watch" in s:
        return 0
    if "strong" in s:
        return 1
    if "nike" in s:
        return 2
    if "strava" in s:
        return 3
    return 4


def _overlap_frac(a0, a1, b0, b1) -> float:
    inter = (min(a1, b1) - max(a0, b0)).total_seconds()
    shorter = min((a1 - a0).total_seconds(), (b1 - b0).total_seconds())
    return inter / shorter if shorter > 0 and inter > 0 else 0.0


def dedupe(workouts: pd.DataFrame) -> pd.DataFrame:
    """Several apps write the same session to Health; keep the best source per session."""
    w = workouts[workouts["duration_min"] >= MIN_WORKOUT_MIN].copy()
    w["_prio"] = w["source"].map(_priority)
    w = w.sort_values(["_prio", "start"])
    kept: list[int] = []
    spans: list[tuple[pd.Timestamp, pd.Timestamp]] = []
    for idx, r in w.iterrows():
        if any(_overlap_frac(r["start"], r["end"], s, e) >= 0.5 for s, e in spans):
            continue
        kept.append(idx)
        spans.append((r["start"], r["end"]))
    return w.loc[kept].drop(columns="_prio").sort_values("start").reset_index(drop=True)


def merge_strava(apple: pd.DataFrame, strava: pd.DataFrame, strava_gps: pd.DataFrame) -> pd.DataFrame:
    """Attach Strava extras to matching Apple sessions and append Strava-only sessions."""
    w = apple.copy()
    w["relative_effort"] = np.nan
    w["in_strava"] = False
    for col in ("gps_km", "top_kmh", "hsr_m", "sprints", "sprint_m"):
        w[col] = np.nan
    if strava is None or strava.empty:
        return w

    extra = []
    starts = w["start"]
    for sidx, s in strava.iterrows():
        match = None
        if len(w):
            near = np.where(np.abs((starts - s["start"]).dt.total_seconds().to_numpy()) <= 90 * 60)[0]
            best = 0.0
            for i in near:
                r = w.iloc[i]
                close_start = abs((r["start"] - s["start"]).total_seconds()) <= 300
                frac = _overlap_frac(r["start"], r["end"], s["start"], s["end"])
                score = max(frac, 0.99 if close_start else 0)
                if score > best:
                    best, match = score, i
            if best < 0.5:
                match = None
        gps_row = strava_gps.loc[sidx] if not strava_gps.empty and sidx in strava_gps.index else None
        if match is not None:
            w.iat[match, w.columns.get_loc("in_strava")] = True
            w.iat[match, w.columns.get_loc("relative_effort")] = s["relative_effort"]
            # Sessions Strava wrote into Health often lack energy/HR; fill gaps from the Strava summary.
            for wcol, scol in (("active_kcal", "active_kcal"), ("distance_km", "distance_km"), ("elevation_m", "elevation_m"),
                               ("hr_avg_stat", "avg_hr"), ("hr_max_stat", "max_hr")):
                j = w.columns.get_loc(wcol)
                if pd.isna(w.iat[match, j]) and pd.notna(s[scol]):
                    w.iat[match, j] = s[scol]
            if gps_row is not None:
                for col in ("gps_km", "top_kmh", "hsr_m", "sprints", "sprint_m"):
                    w.iat[match, w.columns.get_loc(col)] = gps_row[col]
        elif s["duration_min"] >= MIN_WORKOUT_MIN:
            row = {
                "activity": s["activity"], "source": "Strava", "start": s["start"], "end": s["end"],
                "duration_min": s["duration_min"], "distance_km": s["distance_km"], "active_kcal": s["active_kcal"],
                "elevation_m": s["elevation_m"], "hr_avg_stat": s["avg_hr"], "hr_max_stat": s["max_hr"],
                "relative_effort": s["relative_effort"], "in_strava": True,
            }
            if gps_row is not None:
                for col in ("gps_km", "top_kmh", "hsr_m", "sprints", "sprint_m"):
                    row[col] = gps_row[col]
            extra.append(row)
    if extra:
        w = pd.concat([w, pd.DataFrame(extra)], ignore_index=True)
    return w.sort_values("start").reset_index(drop=True)


def _banister(duration_min: float, avg_hr: float, rest_hr: float, hr_max: float) -> float:
    hrr = np.clip((avg_hr - rest_hr) / (hr_max - rest_hr), 0, 1)
    return float(duration_min * hrr * 0.64 * np.exp(1.92 * hrr))


def attach_heart_rate(w: pd.DataFrame, hr: pd.DataFrame, rest_hr: float) -> tuple[pd.DataFrame, float]:
    """Per-workout HR stats, zone minutes and Banister TRIMP.

    Older exports only carry background HR (~every 10 min) for many workouts, so zones are computed only
    when sampling is dense. TRIMP uses the classic average-HR form so it's comparable across years, and
    is imputed from energy (per-category TRIMP/kcal ratio) when no HR exists at all.
    """
    w = w.copy()
    hr = hr.sort_values("start")
    t = hr["start"].dt.tz_convert("UTC").dt.tz_localize(None).to_numpy().astype("datetime64[ns]").astype(np.int64)
    v = hr["value"].to_numpy(dtype=float)
    windows = []
    for _, r in w.iterrows():
        i0, i1 = np.searchsorted(t, r["start"].value), np.searchsorted(t, r["end"].value)
        windows.append((i0, i1))

    dense_vals = [v[i0:i1] for (i0, i1), d in zip(windows, w["duration_min"]) if (i1 - i0) >= max(10, DENSE_PER_MIN * d)]
    pooled = np.concatenate(dense_vals) if dense_vals else np.array([190.0])
    hr_max = float(np.clip(np.percentile(pooled, 99.9), 170, 215))

    cols = {k: [] for k in ("avg_hr", "max_hr", "z1", "z2", "z3", "z4", "z5", "trimp", "hr_quality")}
    for (_, r), (i0, i1) in zip(w.iterrows(), windows):
        n = i1 - i0
        zones = [np.nan] * 5
        if n >= max(10, DENSE_PER_MIN * r["duration_min"]):
            vs = v[i0:i1]
            dt = np.clip(np.diff(np.append(t[i0:i1], r["end"].value)) / 1e9, 0, MAX_SAMPLE_GAP_S)
            zones = list(np.bincount(np.digitize(vs / hr_max, ZONE_BOUNDS), weights=dt, minlength=5) / 60)
            avg, mx, q = float(np.average(vs, weights=np.maximum(dt, 1e-3))), float(vs.max()), "dense"
        elif pd.notna(r.get("hr_avg_stat")):
            avg, mx, q = float(r["hr_avg_stat"]), r.get("hr_max_stat", np.nan), "summary"
        elif n >= 3:
            vs = v[i0:i1]
            avg, mx, q = float(vs.mean()), float(vs.max()), "sparse"
        else:
            avg, mx, q = np.nan, np.nan, "none"
        for k, z in zip(("z1", "z2", "z3", "z4", "z5"), zones):
            cols[k].append(z)
        cols["avg_hr"].append(avg)
        cols["max_hr"].append(mx)
        cols["hr_quality"].append(q)
        cols["trimp"].append(_banister(r["duration_min"], avg, rest_hr, hr_max) if np.isfinite(avg) else np.nan)
    for k, vals in cols.items():
        w[k] = vals

    # impute missing load from energy, then duration, using per-category medians
    cat = w["activity"].map(category)
    has = w["trimp"].notna() & (w["active_kcal"] > 0)
    per_kcal = (w.loc[has, "trimp"] / w.loc[has, "active_kcal"]).groupby(cat[has]).median()
    per_min = (w.loc[w["trimp"].notna(), "trimp"] / w.loc[w["trimp"].notna(), "duration_min"]).groupby(cat[w["trimp"].notna()]).median()
    glob_kcal = float((w.loc[has, "trimp"] / w.loc[has, "active_kcal"]).median()) if has.any() else 0.1
    glob_min = float(per_min.median()) if len(per_min) else 1.0
    miss = w["trimp"].isna()
    est_k = w["active_kcal"] * cat.map(per_kcal).fillna(glob_kcal)
    est_m = w["duration_min"] * cat.map(per_min).fillna(glob_min)
    w.loc[miss, "trimp"] = est_k[miss].where(est_k[miss].notna(), est_m[miss])
    w["load_est"] = miss
    return w, hr_max


def impute_energy(w: pd.DataFrame, min_train: int = 10) -> pd.DataFrame:
    """Estimate active kcal for sessions without it (e.g. Strava-only recordings).

    Uses this person's own sessions of the same category: a linear fit of kcal/min on
    average HR when there's enough HR data, otherwise the median kcal/min.
    """
    w = w.copy()
    cat = w["activity"].map(category)
    rate = w["active_kcal"] / w["duration_min"]
    known = (w["active_kcal"] > 0) & (w["duration_min"] > 5) & rate.between(1, 25)
    miss = ~(w["active_kcal"] > 0) & (w["duration_min"] > 0)
    w["kcal_est"] = False
    for c in cat[miss].unique():
        train = known & (cat == c)
        if train.sum() < min_train:
            continue
        est = pd.Series(float(rate[train].median()), index=w.index)
        with_hr = train & w["avg_hr"].notna()
        if with_hr.sum() >= 2 * min_train:
            slope, icpt = np.polyfit(w.loc[with_hr, "avg_hr"].astype(float), rate[with_hr].astype(float), 1)
            fit = icpt + slope * w["avg_hr"]
            lo, hi = rate[train].quantile([0.05, 0.95])
            est = fit.clip(lo, hi).where(w["avg_hr"].notna(), est)
        target = miss & (cat == c)
        w.loc[target, "active_kcal"] = (est * w["duration_min"])[target]
        w.loc[target, "kcal_est"] = True
    return w


def _valid_tz(name: str) -> bool:
    try:
        pd.Timestamp("2020-01-01", tz=name)
        return True
    except Exception:
        return False


def localize(w: pd.DataFrame, tz) -> pd.DataFrame:
    """Local start time: the workout's own HKTimeZone when tagged, else the inferred zone."""
    w = w.copy()
    zones = tz.zones(w["start"])
    if "tz" in w:
        own = w["tz"].where(w["tz"].map(lambda z: isinstance(z, str) and _valid_tz(z)))
        zones = own.fillna(zones)
    local = pd.Series(pd.NaT, index=w.index, dtype="datetime64[ns]")
    for z in pd.unique(zones):
        sel = (zones == z).to_numpy()
        local[sel] = w.loc[sel, "start"].dt.tz_convert(z).dt.tz_localize(None).astype("datetime64[ns]").to_numpy()
    w["local_start"] = local
    w["date"] = pd.to_datetime(w["local_start"]).dt.normalize()
    w["hour"] = pd.to_datetime(w["local_start"]).dt.hour
    w["weekday"] = pd.to_datetime(w["local_start"]).dt.day_of_week
    w["category"] = w["activity"].map(category)
    return w
