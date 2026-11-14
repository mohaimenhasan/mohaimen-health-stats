"""Stream-parse Apple Health's export.xml into tidy pandas frames.

The export is ~1.5 GB of XML, so we iterate with lxml and drop each top-level element
as soon as it has been read. Only the record types we actually chart are retained.
"""
from __future__ import annotations

import pickle
import hashlib
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd
from lxml import etree

from .sources import ExportSource

HK_Q = "HKQuantityTypeIdentifier"
HK_C = "HKCategoryTypeIdentifier"

MI_KM = 1.609344
LB_KG = 0.45359237

# short name -> (column name, unit conversion factors into the canonical unit)
QUANTITY_TYPES: dict[str, tuple[str, dict[str, float]]] = {
    "StepCount": ("steps", {"count": 1}),
    "DistanceWalkingRunning": ("distance_km", {"mi": MI_KM, "km": 1, "m": 0.001}),
    "ActiveEnergyBurned": ("active_kcal", {"Cal": 1, "kcal": 1, "kJ": 0.239006}),
    "BasalEnergyBurned": ("basal_kcal", {"Cal": 1, "kcal": 1, "kJ": 0.239006}),
    "AppleExerciseTime": ("exercise_min", {"min": 1}),
    "AppleStandTime": ("stand_min", {"min": 1}),
    "FlightsClimbed": ("flights", {"count": 1}),
    "TimeInDaylight": ("daylight_min", {"min": 1}),
    "HeartRate": ("hr", {"count/min": 1}),
    "RestingHeartRate": ("rhr", {"count/min": 1}),
    "HeartRateVariabilitySDNN": ("hrv", {"ms": 1}),
    "WalkingHeartRateAverage": ("walking_hr", {"count/min": 1}),
    "HeartRateRecoveryOneMinute": ("hr_recovery", {"count/min": 1}),
    "RespiratoryRate": ("resp_rate", {"count/min": 1}),
    "OxygenSaturation": ("spo2", {"%": 100}),
    "VO2Max": ("vo2max", {"mL/min·kg": 1, "ml/(kg·min)": 1}),
    "WalkingSpeed": ("walking_speed_kmh", {"mi/hr": MI_KM, "km/hr": 1, "m/s": 3.6}),
    "WalkingStepLength": ("step_length_cm", {"in": 2.54, "cm": 1, "m": 100}),
    "WalkingAsymmetryPercentage": ("walking_asymmetry_pct", {"%": 100}),
    "WalkingDoubleSupportPercentage": ("double_support_pct", {"%": 100}),
    "AppleWalkingSteadiness": ("steadiness_pct", {"%": 100}),
    "SixMinuteWalkTestDistance": ("six_min_walk_m", {"m": 1}),
    "RunningPower": ("run_power_w", {"W": 1}),
    "RunningSpeed": ("run_speed_kmh", {"mi/hr": MI_KM, "km/hr": 1, "m/s": 3.6}),
    "RunningGroundContactTime": ("run_gct_ms", {"ms": 1}),
    "RunningVerticalOscillation": ("run_vert_osc_cm", {"cm": 1}),
    "RunningStrideLength": ("run_stride_m", {"m": 1}),
    "PhysicalEffort": ("physical_effort", {"kcal/hr·kg": 1}),
    "BodyMass": ("weight_kg", {"lb": LB_KG, "kg": 1}),
    "DietaryEnergyConsumed": ("diet_kcal", {"Cal": 1, "kcal": 1}),
    "DietaryProtein": ("diet_protein_g", {"g": 1}),
    "DietaryCarbohydrates": ("diet_carbs_g", {"g": 1}),
    "DietaryFatTotal": ("diet_fat_g", {"g": 1}),
}
CATEGORY_TYPES = {"SleepAnalysis": "sleep"}

WORKOUT_STAT_COLS = {
    "ActiveEnergyBurned": "active_kcal",
    "BasalEnergyBurned": "basal_kcal",
    "DistanceWalkingRunning": "distance_km",
    "DistanceCycling": "distance_km",
    "DistanceSwimming": "distance_km",
    "StepCount": "steps",
}
DIST_TO_KM = {"mi": MI_KM, "km": 1, "m": 0.001, "yd": 0.0009144}
ENERGY_TO_KCAL = {"Cal": 1, "kcal": 1, "kJ": 0.239006}

PARSER_VERSION = 4


@dataclass
class AppleData:
    export_date: pd.Timestamp | None
    dob: str | None = None  # used internally for BMR estimates; never written to the site
    records: dict[str, pd.DataFrame] = field(default_factory=dict)
    sleep: pd.DataFrame = field(default_factory=pd.DataFrame)
    workouts: pd.DataFrame = field(default_factory=pd.DataFrame)
    activity: pd.DataFrame = field(default_factory=pd.DataFrame)


def _to_ts(values: list[str]) -> pd.Series:
    return pd.to_datetime(pd.Series(values, dtype="string"), format="%Y-%m-%d %H:%M:%S %z", utc=True)


def _short(t: str) -> str:
    if t.startswith(HK_Q):
        return t[len(HK_Q):]
    if t.startswith(HK_C):
        return t[len(HK_C):]
    return t


def _f(v: str | None) -> float:
    try:
        return float(v) if v is not None else np.nan
    except ValueError:
        return np.nan


def _parse_workout(el) -> dict:
    a = el.attrib
    w: dict = {
        "activity": a.get("workoutActivityType", "").replace("HKWorkoutActivityType", ""),
        "source": a.get("sourceName", ""),
        "start": a.get("startDate"),
        "end": a.get("endDate"),
        "duration_min": _f(a.get("duration")) * {"min": 1, "hr": 60, "s": 1 / 60}.get(a.get("durationUnit", "min"), 1),
        "distance_km": _f(a.get("totalDistance")) * DIST_TO_KM.get(a.get("totalDistanceUnit", "km"), np.nan),
        "active_kcal": _f(a.get("totalEnergyBurned")) * ENERGY_TO_KCAL.get(a.get("totalEnergyBurnedUnit", "Cal"), np.nan),
        "indoor": None,
        "avg_mets": np.nan,
        "temp_f": np.nan,
        "humidity_pct": np.nan,
        "elevation_m": np.nan,
        "tz": None,
        "route": None,
        "pauses": 0,
        "hr_avg_stat": np.nan,
        "hr_max_stat": np.nan,
        "hr_min_stat": np.nan,
    }
    for c in el:
        tag = c.tag
        ca = c.attrib
        if tag == "MetadataEntry":
            k, v = ca.get("key"), ca.get("value", "")
            if k == "HKIndoorWorkout":
                w["indoor"] = v == "1"
            elif k == "HKAverageMETs":
                w["avg_mets"] = _f(v.split()[0])
            elif k == "HKWeatherTemperature":
                num, unit = (v.split() + [""])[:2]
                t = _f(num)
                w["temp_f"] = t * 9 / 5 + 32 if unit == "degC" else t
            elif k == "HKWeatherHumidity":
                h = _f(v.split()[0])
                w["humidity_pct"] = h / 100 if h > 100 else h
            elif k == "HKElevationAscended":
                num, unit = (v.split() + [""])[:2]
                w["elevation_m"] = _f(num) / 100 if unit == "cm" else _f(num) * (0.3048 if unit == "ft" else 1)
            elif k == "HKTimeZone":
                w["tz"] = v
        elif tag == "WorkoutStatistics":
            st = _short(ca.get("type", ""))
            unit = ca.get("unit", "")
            if st == "HeartRate":
                w["hr_avg_stat"] = _f(ca.get("average"))
                w["hr_max_stat"] = _f(ca.get("maximum"))
                w["hr_min_stat"] = _f(ca.get("minimum"))
            elif st in WORKOUT_STAT_COLS:
                col = WORKOUT_STAT_COLS[st]
                val = _f(ca.get("sum"))
                if col == "distance_km":
                    val *= DIST_TO_KM.get(unit, np.nan)
                elif col.endswith("kcal"):
                    val *= ENERGY_TO_KCAL.get(unit, np.nan)
                if col == "distance_km" and not np.isnan(w["distance_km"]):
                    continue
                if col == "active_kcal" and not np.isnan(w["active_kcal"]):
                    continue
                w[col] = val
        elif tag == "WorkoutRoute":
            for fr in c:
                if fr.tag == "FileReference":
                    w["route"] = fr.attrib.get("path")
        elif tag == "WorkoutEvent":
            if ca.get("type") == "HKWorkoutEventTypePause":
                w["pauses"] += 1
    return w


def parse_export(src: ExportSource, cache_dir: Path | None = None, verbose: bool = True) -> AppleData:
    key = hashlib.sha1(f"{src.fingerprint()}:{PARSER_VERSION}".encode()).hexdigest()[:16]
    cache_file = cache_dir / f"apple-{key}.pkl" if cache_dir else None
    if cache_file and cache_file.exists():
        if verbose:
            print(f"  using cached parse {cache_file.name}")
        with open(cache_file, "rb") as fh:
            return pickle.load(fh)

    raw: dict[str, dict[str, list]] = {}
    sleep_rows: list[tuple[str, str, str, str]] = []
    workouts: list[dict] = []
    activity: list[dict] = []
    export_date = None
    dob = None
    n = 0

    with src.open("export.xml") as fh:
        ctx = etree.iterparse(fh, events=("end",), huge_tree=True, resolve_entities=False, no_network=True, load_dtd=False)
        for _, el in ctx:
            parent = el.getparent()
            if parent is None or parent.getparent() is not None:
                continue  # only handle direct children of <HealthData>
            tag = el.tag
            a = el.attrib
            if tag == "Record":
                t = _short(a.get("type", ""))
                if t in QUANTITY_TYPES:
                    bucket = raw.setdefault(t, {"start": [], "end": [], "value": [], "source": [], "unit": []})
                    bucket["start"].append(a.get("startDate"))
                    bucket["end"].append(a.get("endDate"))
                    bucket["value"].append(a.get("value"))
                    bucket["source"].append(a.get("sourceName", ""))
                    bucket["unit"].append(a.get("unit", ""))
                elif t in CATEGORY_TYPES:
                    sleep_rows.append((a.get("startDate"), a.get("endDate"), a.get("value", ""), a.get("sourceName", "")))
            elif tag == "Workout":
                workouts.append(_parse_workout(el))
            elif tag == "ActivitySummary":
                activity.append(dict(a))
            elif tag == "ExportDate":
                export_date = a.get("value")
            elif tag == "Me":
                dob = a.get("HKCharacteristicTypeIdentifierDateOfBirth") or None
            el.clear(keep_tail=False)
            while el.getprevious() is not None:
                del parent[0]
            n += 1
            if verbose and n % 500_000 == 0:
                print(f"  …{n:,} elements")

    data = AppleData(
        export_date=pd.to_datetime(export_date, format="%Y-%m-%d %H:%M:%S %z", utc=True) if export_date else None,
        dob=dob,
    )

    for t, b in raw.items():
        col, factors = QUANTITY_TYPES[t]
        df = pd.DataFrame({
            "start": _to_ts(b["start"]),
            "end": _to_ts(b["end"]),
            "value": pd.to_numeric(pd.Series(b["value"]), errors="coerce"),
            "source": pd.Categorical(b["source"]),
        })
        units = pd.Series(b["unit"])
        df["value"] = df["value"] * units.map(factors).astype(float)
        df = df.dropna(subset=["value"]).sort_values("start").reset_index(drop=True)
        data.records[col] = df

    if sleep_rows:
        s = pd.DataFrame(sleep_rows, columns=["start", "end", "value", "source"])
        s["start"] = _to_ts(s["start"].tolist())
        s["end"] = _to_ts(s["end"].tolist())
        s["value"] = s["value"].str.replace("HKCategoryValueSleepAnalysis", "", regex=False)
        data.sleep = s.sort_values("start").reset_index(drop=True)

    if workouts:
        w = pd.DataFrame(workouts)
        w["start"] = _to_ts(w["start"].tolist())
        w["end"] = _to_ts(w["end"].tolist())
        data.workouts = w.sort_values("start").reset_index(drop=True)

    if activity:
        act = pd.DataFrame(activity)
        act = act.rename(columns={"dateComponents": "date"})
        for c in act.columns:
            if c != "date" and not c.endswith("Unit"):
                act[c] = pd.to_numeric(act[c], errors="coerce")
        act["date"] = pd.to_datetime(act["date"], errors="coerce")
        data.activity = act[act["date"] >= "2000-01-01"].reset_index(drop=True)

    if cache_file:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        with open(cache_file, "wb") as fh:
            pickle.dump(data, fh, protocol=pickle.HIGHEST_PROTOCOL)
    return data
