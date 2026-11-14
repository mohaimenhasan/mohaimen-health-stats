"""Derived tables: weight curve, monthly rollups, phase comparisons, correlations, energy balance."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

KG_LB = 2.20462262
KCAL_PER_LB = 3500


# ---------------------------------------------------------------- weight

@dataclass
class WeightModel:
    log: pd.DataFrame          # date, weight_lb (user's monthly log)
    weigh_ins: pd.DataFrame    # date, weight_lb (HealthKit scale/manual entries)
    daily: pd.Series           # interpolated daily weight (lb)
    peak_date: pd.Timestamp | None
    peak_lb: float | None


def build_weight(log_csv: pd.DataFrame, daily: pd.DataFrame, end: pd.Timestamp) -> WeightModel:
    log = log_csv.copy()
    log["date"] = pd.to_datetime(log["month"] + "-15")
    log.loc[log["date"] > end, "date"] = end
    log = log[["date", "weight_lb"]].sort_values("date").reset_index(drop=True)

    weigh = pd.DataFrame(columns=["date", "weight_lb"])
    if "weight_kg" in daily:
        wk = daily["weight_kg"].dropna()
        weigh = pd.DataFrame({"date": wk.index, "weight_lb": wk.values * KG_LB})

    if log.empty:
        return WeightModel(log, weigh, pd.Series(dtype=float), None, None)
    idx = pd.date_range(log["date"].min(), end, freq="D")
    series = log.set_index("date")["weight_lb"].reindex(idx.union(log["date"])).interpolate("time").reindex(idx).ffill()
    peak = log.loc[log["weight_lb"].idxmax()]
    return WeightModel(log, weigh, series, peak["date"], float(peak["weight_lb"]))


# ---------------------------------------------------------------- energy

def mifflin_bmr(weight_lb: pd.Series, height_cm: float, age_years: pd.Series, sex: str) -> pd.Series:
    kg = weight_lb / KG_LB
    return 10 * kg + 6.25 * height_cm - 5 * age_years + (5 if sex == "male" else -161)


# ---------------------------------------------------------------- monthly

MONTHLY_MEANS = ["steps", "distance_km", "active_kcal", "basal_kcal", "exercise_min", "flights", "daylight_min",
                 "rhr", "hrv", "walking_hr", "vo2max", "resp_rate", "spo2", "walking_speed_kmh", "step_length_cm",
                 "walking_asymmetry_pct", "double_support_pct", "sleep_h", "bedtime_h", "wake_h", "weight_lb",
                 "bmr_est", "tdee_est", "trimp"]


SPARSE_MIN = {"sleep_h": 10, "bedtime_h": 10, "wake_h": 10, "hrv": 3, "rhr": 7}


def _phase_mean(d: pd.DataFrame, col: str, min_n: int = 30):
    if col not in d:
        return None
    s = d[col].dropna()
    return float(s.mean()) if len(s) >= min_n else None


def monthly_table(daily: pd.DataFrame, workouts: pd.DataFrame) -> pd.DataFrame:
    d = daily.copy()
    d["month"] = d.index.to_period("M")
    agg = {c: "mean" for c in MONTHLY_MEANS if c in d}
    m = d.groupby("month").agg(agg)
    # sparse signals (sleep, VO2max spot checks) need enough samples to mean anything
    for col, min_n in SPARSE_MIN.items():
        if col in d:
            n = d.groupby("month")[col].count()
            m.loc[n < min_n, col] = np.nan
    m["days"] = d.groupby("month").size()
    m["days_with_watch"] = d.groupby("month")["active_kcal"].apply(lambda s: int((s > 50).sum()))

    if {"move_kcal", "move_goal"} <= set(d.columns):
        ring = d[d["move_goal"] > 0]
        g = ring.groupby("month")
        m["move_closed_pct"] = g.apply(lambda x: (x["move_kcal"] >= x["move_goal"]).mean() * 100)
        m["exercise_closed_pct"] = g.apply(lambda x: (x["exercise_ring_min"] >= x["exercise_goal"]).mean() * 100)
        m["stand_closed_pct"] = g.apply(lambda x: (x["stand_hours"] >= x["stand_goal"]).mean() * 100)
        m["all_rings_pct"] = g.apply(lambda x: ((x["move_kcal"] >= x["move_goal"]) & (x["exercise_ring_min"] >= x["exercise_goal"])
                                                 & (x["stand_hours"] >= x["stand_goal"])).mean() * 100)

    if "weight_lb" in d:
        wl = d["weight_lb"].dropna()
        first = wl.groupby(wl.index.to_period("M")).first()
        last = wl.groupby(wl.index.to_period("M")).last()
        # change across the month = next month's first value minus this month's first value
        nxt = first.shift(-1).fillna(last)
        m["weight_change_lb"] = (nxt - first).reindex(m.index)

    w = workouts.copy()
    w["month"] = w["date"].dt.to_period("M")
    m["workouts"] = w.groupby("month").size()
    m["workout_min"] = w.groupby("month")["duration_min"].sum()
    for cat, g in w.groupby("category"):
        key = cat.lower().replace(" ", "_")
        m[f"min_{key}"] = g.groupby("month")["duration_min"].sum()
    fb = w[w["category"] == "Football"]
    m["football_games"] = fb.groupby("month").size()
    m["football_km"] = fb.groupby("month")["distance_km"].sum()
    m["football_kcal"] = fb.groupby("month")["active_kcal"].sum()
    m["football_top_kmh"] = fb.groupby("month")["top_kmh"].median()
    fill0 = [c for c in m.columns if c.startswith("min_") or c in ("workouts", "workout_min", "football_games", "football_km", "football_kcal")]
    m[fill0] = m[fill0].fillna(0)

    if {"tdee_est", "weight_change_lb"} <= set(m.columns):
        ok = m["days_with_watch"] >= 20
        # energy balance: intake = expenditure + stored energy (negative when losing weight)
        m["implied_intake_kcal"] = np.where(ok, m["tdee_est"] + m["weight_change_lb"] * KCAL_PER_LB / m["days"], np.nan)
    return m


# ---------------------------------------------------------------- phases

def resolve_phases(cfg: list[dict], peak: pd.Timestamp | None, start: pd.Timestamp, end: pd.Timestamp) -> list[dict]:
    def res(v, default):
        if v is None:
            return default
        if v == "peak":
            return peak if peak is not None else default
        return pd.Timestamp(v)

    out = []
    for p in cfg:
        s, e = res(p.get("start"), start), res(p.get("end"), end)
        if e <= start or s >= end:
            continue
        out.append({**p, "start": max(s, start), "end": min(e, end)})
    return out


def phase_table(phases: list[dict], daily: pd.DataFrame, workouts: pd.DataFrame, weight: WeightModel) -> list[dict]:
    rows = []
    for p in phases:
        s, e = p["start"], p["end"]
        d = daily[(daily.index >= s) & (daily.index < e)]
        wk = workouts[(workouts["date"] >= s) & (workouts["date"] < e)]
        fb = wk[wk["category"] == "Football"]
        weeks = max((e - s).days / 7, 1)
        watch_days = d[d["active_kcal"] > 50] if "active_kcal" in d else d
        wl = weight.daily[(weight.daily.index >= s) & (weight.daily.index < e)]
        row = {
            "key": p["key"], "label": p["label"],
            "start": s.date().isoformat(), "end": e.date().isoformat(), "days": (e - s).days,
            "steps": watch_days["steps"].mean() if "steps" in d else None,
            "active_kcal": watch_days["active_kcal"].mean() if "active_kcal" in d else None,
            "exercise_min": watch_days["exercise_min"].mean() if "exercise_min" in d else None,
            "workouts_per_week": len(wk) / weeks,
            "workout_hours_per_week": wk["duration_min"].sum() / 60 / weeks,
            "football_per_month": len(fb) / weeks * 52 / 12,
            "football_hours": fb["duration_min"].sum() / 60,
            "rhr": _phase_mean(d, "rhr", 30),
            "hrv": _phase_mean(d, "hrv", 30),
            "vo2max": _phase_mean(d, "vo2max", 5),
            "walking_speed_kmh": _phase_mean(d, "walking_speed_kmh", 30),
            "sleep_h": _phase_mean(d, "sleep_h", 30),
            "weight_start_lb": float(wl.iloc[0]) if len(wl) else None,
            "weight_end_lb": float(wl.iloc[-1]) if len(wl) else None,
        }
        if row["weight_start_lb"] is not None and len(wl) > 30:
            row["weight_lb_per_month"] = (row["weight_end_lb"] - row["weight_start_lb"]) / (len(wl) / 30.44)
        rows.append(row)
    return rows


# ---------------------------------------------------------------- correlations

CORR_TARGETS = {
    "rhr": "Resting heart rate",
    "hrv": "HRV (SDNN)",
    "vo2max": "VO₂ max",
    "walking_speed_kmh": "Walking speed",
    "step_length_cm": "Step length",
    "walking_hr": "Walking heart rate",
    "steps": "Daily steps",
    "active_kcal": "Active calories",
    "football_games": "Football games / month",
    "sleep_h": "Sleep",
}


def correlations(monthly: pd.DataFrame) -> list[dict]:
    out = []
    if "weight_lb" not in monthly:
        return out
    m = monthly[monthly["days_with_watch"] >= 15] if "days_with_watch" in monthly else monthly
    for col, label in CORR_TARGETS.items():
        if col not in m:
            continue
        pair = m[["weight_lb", col]].dropna()
        if len(pair) < 8 or pair[col].std() == 0:
            continue
        r = float(pair["weight_lb"].corr(pair[col]))
        slope, intercept = np.polyfit(pair["weight_lb"], pair[col], 1)
        out.append({"metric": col, "label": label, "r": r, "n": len(pair),
                    "per_10lb": float(slope * 10), "intercept": float(intercept), "slope": float(slope)})
    return sorted(out, key=lambda x: -abs(x["r"]))


# ---------------------------------------------------------------- training load

def training_load(trimp: pd.Series) -> pd.DataFrame:
    """Banister fitness (42-day) / fatigue (7-day) curves from daily TRIMP."""
    t = trimp.fillna(0)
    ctl = t.ewm(alpha=1 - np.exp(-1 / 42), adjust=False).mean()
    atl = t.ewm(alpha=1 - np.exp(-1 / 7), adjust=False).mean()
    return pd.DataFrame({"ctl": ctl, "atl": atl, "tsb": ctl - atl})


def streaks(dates: pd.Series, as_of: pd.Timestamp) -> dict:
    """Longest run of consecutive ISO weeks with at least one session."""
    if dates.empty:
        return {"longest_weeks": 0, "current_weeks": 0}
    weeks = sorted(set(pd.to_datetime(dates).dt.to_period("W-SUN")))
    longest = cur = 1
    for a, b in zip(weeks, weeks[1:]):
        cur = cur + 1 if (b - a).n == 1 else 1
        longest = max(longest, cur)
    this_week = as_of.to_period("W-SUN")
    current = 0
    if weeks and (this_week - weeks[-1]).n <= 1:
        current = 1
        for a, b in zip(reversed(weeks[:-1]), reversed(weeks)):
            if (b - a).n == 1:
                current += 1
            else:
                break
    return {"longest_weeks": longest, "current_weeks": current}
