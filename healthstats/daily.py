"""Daily rollups of HealthKit samples and nightly sleep."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .apple import AppleData
from .tz import LocalTime

CUMULATIVE = ["steps", "distance_km", "active_kcal", "basal_kcal", "exercise_min", "stand_min", "flights",
              "daylight_min", "diet_kcal", "diet_protein_g", "diet_carbs_g", "diet_fat_g"]
MEAN = ["rhr", "hrv", "walking_hr", "resp_rate", "spo2", "vo2max", "walking_speed_kmh", "step_length_cm",
        "walking_asymmetry_pct", "double_support_pct", "steadiness_pct", "run_power_w", "run_speed_kmh",
        "run_gct_ms", "run_vert_osc_cm", "run_stride_m", "hr_recovery", "six_min_walk_m"]

ASLEEP = {"AsleepCore", "AsleepDeep", "AsleepREM", "AsleepUnspecified", "Asleep"}


def _local_date(ts: pd.Series, tz: LocalTime) -> pd.Series:
    return tz.date(ts)


def daily_frame(apple: AppleData, tz: LocalTime) -> pd.DataFrame:
    parts = []
    for col in CUMULATIVE:
        df = apple.records.get(col)
        if df is None or df.empty:
            continue
        # Phone and watch both log steps/distance; Apple de-dupes internally, we approximate
        # that by taking the best-covered source each day.
        g = df.assign(date=_local_date(df["start"], tz)).groupby(["date", "source"], observed=True)["value"].sum()
        parts.append(g.groupby(level="date").max().rename(col))
    for col in MEAN:
        df = apple.records.get(col)
        if df is None or df.empty:
            continue
        parts.append(df.assign(date=_local_date(df["start"], tz)).groupby("date")["value"].mean().rename(col))
    hr = apple.records.get("hr")
    if hr is not None and not hr.empty:
        g = hr.assign(date=_local_date(hr["start"], tz)).groupby("date")["value"]
        parts += [g.mean().rename("hr_avg"), g.min().rename("hr_min"), g.max().rename("hr_max")]
    wt = apple.records.get("weight_kg")
    if wt is not None and not wt.empty:
        parts.append(wt.assign(date=_local_date(wt["start"], tz)).groupby("date")["value"].last().rename("weight_kg"))

    daily = pd.concat(parts, axis=1).sort_index()

    act = apple.activity
    if act is not None and not act.empty:
        a = act.set_index("date")
        rings = pd.DataFrame({
            "move_kcal": a.get("activeEnergyBurned"),
            "move_goal": a.get("activeEnergyBurnedGoal"),
            "exercise_ring_min": a.get("appleExerciseTime"),
            "exercise_goal": a.get("appleExerciseTimeGoal"),
            "stand_hours": a.get("appleStandHours"),
            "stand_goal": a.get("appleStandHoursGoal"),
        })
        rings = rings[(rings["move_goal"] > 0) | (rings["move_kcal"] > 0)]
        daily = daily.join(rings, how="outer")
        # Apple's own ring totals are de-duplicated; prefer them over our per-source estimate.
        has = daily["move_kcal"].notna() & (daily["move_kcal"] > 0)
        daily.loc[has, "active_kcal"] = daily.loc[has, "move_kcal"]

    daily.index.name = "date"
    return daily


def _union_hours(intervals: list[tuple[pd.Timestamp, pd.Timestamp]]) -> float:
    if not intervals:
        return 0.0
    intervals.sort()
    total = 0.0
    cur_s, cur_e = intervals[0]
    for s, e in intervals[1:]:
        if s <= cur_e:
            cur_e = max(cur_e, e)
        else:
            total += (cur_e - cur_s).total_seconds()
            cur_s, cur_e = s, e
    total += (cur_e - cur_s).total_seconds()
    return total / 3600


def _in_zones(ts: pd.Series, zones: pd.Series) -> pd.Series:
    out = pd.Series(pd.NaT, index=ts.index, dtype="datetime64[ns]")
    for z in pd.unique(zones):
        sel = (zones == z).to_numpy()
        out[sel] = ts[sel].dt.tz_convert(z).dt.tz_localize(None).astype("datetime64[ns]").to_numpy()
    return out


def nightly_sleep(sleep: pd.DataFrame, tz: LocalTime) -> pd.DataFrame:
    """One row per night, labelled by wake-up date. Daytime naps are ignored."""
    if sleep is None or sleep.empty:
        return pd.DataFrame()
    s = sleep.copy()
    zones = tz.zones(s["start"])
    s["ls"] = _in_zones(s["start"], zones)
    s["le"] = _in_zones(s["end"], zones)
    s = s[(s["le"] > s["ls"]) & ~s["ls"].dt.hour.between(11, 17)]
    s["night"] = (s["ls"] + pd.Timedelta(hours=12)).dt.normalize()
    s["is_watch"] = s["source"].str.contains("Watch", case=False)
    rows = []
    for night, g in s.groupby("night"):
        asleep = g[g["value"].isin(ASLEEP)]
        if not asleep.empty and asleep["is_watch"].any():
            asleep = asleep[asleep["is_watch"]]
        in_bed = g[g["value"] == "InBed"]
        basis = asleep if not asleep.empty else in_bed
        if basis.empty:
            continue
        hours = _union_hours(list(zip(basis["ls"], basis["le"])))
        if not 2.5 <= hours <= 14:
            continue
        bed = basis["ls"].min()
        wake = basis["le"].max()
        stage = {k: _union_hours(list(zip(x["ls"], x["le"]))) for k, x in asleep.groupby("value")} if not asleep.empty else {}
        rows.append({
            "date": night,
            "sleep_h": hours,
            "sleep_kind": "asleep" if not asleep.empty else "in_bed",
            "bedtime_h": (bed - night).total_seconds() / 3600,  # hours relative to midnight of wake day (negative = before midnight)
            "wake_h": (wake - night).total_seconds() / 3600,
            "deep_h": stage.get("AsleepDeep", np.nan),
            "rem_h": stage.get("AsleepREM", np.nan),
            "core_h": stage.get("AsleepCore", np.nan),
        })
    return pd.DataFrame(rows).set_index("date") if rows else pd.DataFrame()
