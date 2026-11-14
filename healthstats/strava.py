"""Strava bulk export: activities.csv summaries plus GPX tracks for speed metrics."""
from __future__ import annotations

import io

import numpy as np
import pandas as pd

from . import gps
from .sources import ExportSource

TYPE_MAP = {
    "Football (Soccer)": "Soccer",
    "Soccer": "Soccer",
    "Run": "Running",
    "Trail Run": "Running",
    "Virtual Run": "Running",
    "Walk": "Walking",
    "Hike": "Hiking",
    "Ride": "Cycling",
    "Virtual Ride": "Cycling",
    "E-Bike Ride": "Cycling",
    "Weight Training": "TraditionalStrengthTraining",
    "Workout": "Other",
    "Swim": "Swimming",
    "Rowing": "Rowing",
    "Yoga": "Yoga",
    "Tennis": "Tennis",
    "Badminton": "Badminton",
    "Pickleball": "Pickleball",
    "Basketball": "Basketball",
    "Volleyball": "Volleyball",
}
GPS_TYPES = {"Soccer", "Running", "Walking", "Hiking"}


def _num(df: pd.DataFrame, col: str) -> pd.Series:
    if col not in df:
        return pd.Series(np.nan, index=df.index)
    return pd.to_numeric(df[col], errors="coerce")


def load_activities(src: ExportSource) -> pd.DataFrame:
    with src.open("activities.csv") as fh:
        raw = pd.read_csv(io.TextIOWrapper(fh, encoding="utf-8"), low_memory=False)
    start = pd.to_datetime(raw["Activity Date"], format="%b %d, %Y, %I:%M:%S %p", utc=True, errors="coerce")
    if start.isna().mean() > 0.5:
        start = pd.to_datetime(raw["Activity Date"], format="mixed", utc=True, errors="coerce")
    elapsed = _num(raw, "Elapsed Time.1").fillna(_num(raw, "Elapsed Time"))
    dist_m = _num(raw, "Distance.1")
    df = pd.DataFrame({
        "strava_type": raw["Activity Type"],
        "activity": raw["Activity Type"].map(TYPE_MAP).fillna("Other"),
        "start": start,
        "duration_min": elapsed / 60,
        "moving_min": _num(raw, "Moving Time") / 60,
        "distance_km": dist_m / 1000,
        "elevation_m": _num(raw, "Elevation Gain"),
        "avg_hr": _num(raw, "Average Heart Rate"),
        "max_hr": _num(raw, "Max Heart Rate.1").fillna(_num(raw, "Max Heart Rate")),
        "active_kcal": _num(raw, "Calories"),
        "relative_effort": _num(raw, "Relative Effort.1").fillna(_num(raw, "Relative Effort")),
        "total_weight_lifted_kg": _num(raw, "Total Weight Lifted"),
        "filename": raw.get("Filename"),
    })
    df["end"] = df["start"] + pd.to_timedelta(df["duration_min"], unit="m")
    for c in ("distance_km", "active_kcal", "avg_hr", "max_hr", "elevation_m"):
        df.loc[df[c] <= 0, c] = np.nan
    return df.dropna(subset=["start"]).sort_values("start").reset_index(drop=True)


def gpx_metrics(src: ExportSource, acts: pd.DataFrame) -> pd.DataFrame:
    """Per-activity speed/sprint metrics for GPX tracks (coordinates are discarded)."""
    rows = []
    for idx, r in acts.iterrows():
        fn = r.get("filename")
        if not isinstance(fn, str) or not fn.endswith(".gpx") or r["activity"] not in GPS_TYPES:
            continue
        if not src.exists(fn):
            continue
        with src.open(fn) as fh:
            m = gps.speed_metrics(gps.parse_gpx(fh))
        if m:
            m["idx"] = idx
            rows.append(m)
    return pd.DataFrame(rows).set_index("idx") if rows else pd.DataFrame()
