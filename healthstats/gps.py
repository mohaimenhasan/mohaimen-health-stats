"""Speed and sprint metrics from GPS tracks.

Only scalar summaries leave this module; coordinates are used transiently to derive
speed and are never written anywhere.
"""
from __future__ import annotations

import math
import re
from typing import IO

import numpy as np
import pandas as pd

# Thresholds for amateur football. Elite tracking uses 19.8 km/h (HSR) and 25.2 km/h (sprint);
# recreational players rarely hold 25 km/h, so we use slightly lower bands.
HSR_KMH = 18.0
SPRINT_KMH = 21.0
MIN_SPRINT_S = 2
MAX_PLAUSIBLE_KMH = 37.0
MAX_ACCEL_MS2 = 6.0
MAX_HACC_M = 20.0

_PT = re.compile(rb'<trkpt\s+lon="([-\d.]+)"\s+lat="([-\d.]+)"|<trkpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)"')
_TIME = re.compile(rb"<time>([^<]+)</time>")
_SPEED = re.compile(rb"<speed>([-\d.]+)</speed>")
_HACC = re.compile(rb"<hAcc>([-\d.]+)</hAcc>")


def parse_gpx(fh: IO[bytes]) -> pd.DataFrame:
    """Parse a GPX file into time/lat/lon/speed/hacc. Works for Apple and Strava GPX."""
    blob = fh.read()
    rows = []
    for chunk in blob.split(b"<trkpt")[1:]:
        chunk = b"<trkpt" + chunk.split(b"</trkpt>")[0]
        m = _PT.search(chunk)
        t = _TIME.search(chunk)
        if not m or not t:
            continue
        lon, lat = (m.group(1), m.group(2)) if m.group(1) else (m.group(4), m.group(3))
        sp = _SPEED.search(chunk)
        ha = _HACC.search(chunk)
        rows.append((t.group(1).decode(), float(lat), float(lon),
                     float(sp.group(1)) if sp else np.nan,
                     float(ha.group(1)) if ha else np.nan))
    df = pd.DataFrame(rows, columns=["time", "lat", "lon", "speed", "hacc"])
    if df.empty:
        return df
    df["time"] = pd.to_datetime(df["time"], utc=True, format="ISO8601")
    return df


def _haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp = p2 - p1
    dl = np.radians(lon2 - lon1)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * r * np.arcsin(np.sqrt(a))


def speed_series(df: pd.DataFrame, window_s: int = 2) -> pd.Series:
    """1 Hz speed in m/s, cleaned of GPS glitches.

    Uses the receiver's Doppler speed when the track has it (Apple runs/walks). Otherwise speed
    is the displacement across a centred ``window_s`` window, which damps per-fix jitter that
    would otherwise show up as fake 35+ km/h "sprints".
    """
    if df is None or len(df) < 10:
        return pd.Series(dtype=float)
    d = df.sort_values("time").copy()
    bad_acc = d["hacc"].notna() & ((d["hacc"] <= 0) | (d["hacc"] > MAX_HACC_M))
    d = d[~bad_acc].drop_duplicates("time", keep="last")
    if len(d) < 10 or d["time"].nunique() < 10:
        return pd.Series(dtype=float)
    d = d.set_index("time")
    device_ok = (d["speed"] >= 0).mean() >= 0.8
    if device_ok:
        s = d["speed"].where(d["speed"] >= 0).resample("1s").mean().interpolate(limit=3, limit_area="inside")
        s = s.rolling(window_s + 1, center=True, min_periods=1).mean()
    else:
        pos = d[["lat", "lon"]].resample("1s").mean().interpolate(limit=5, limit_area="inside")
        lat, lon = pos["lat"].to_numpy(), pos["lon"].to_numpy()
        h = window_s // 2
        a = window_s - h
        dist = np.full(len(pos), np.nan)
        if len(pos) > window_s:
            dist[h:len(pos) - a] = _haversine_m(lat[: len(pos) - window_s], lon[: len(pos) - window_s], lat[window_s:], lon[window_s:])
        s = pd.Series(dist / window_s, index=pos.index)
    s[s * 3.6 > MAX_PLAUSIBLE_KMH] = np.nan
    s[s.diff().abs() > MAX_ACCEL_MS2] = np.nan
    return s


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    runs, start = [], None
    for i, v in enumerate(mask):
        if v and start is None:
            start = i
        elif not v and start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, len(mask)))
    return runs


def speed_metrics(df: pd.DataFrame) -> dict | None:
    s = speed_series(df, window_s=2)
    if s.empty or s.notna().sum() < 60:
        return None
    v = s.fillna(0).to_numpy()
    # Top speed = best 5-second displacement, i.e. a speed actually held, not a GPS spike.
    s5 = speed_series(df, window_s=5)
    top = float(np.nanmax(s5.to_numpy())) * 3.6 if s5.notna().any() else np.nan

    sprint_mask = v * 3.6 >= SPRINT_KMH
    raw_runs = _runs(sprint_mask)
    merged: list[list[int]] = []
    for a, b in raw_runs:
        if merged and a - merged[-1][1] <= 2:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    sprints = [(a, b) for a, b in merged if b - a >= MIN_SPRINT_S]
    return {
        "gps_km": round(float(v.sum()) / 1000, 3),
        "top_kmh": round(top, 1),
        "hsr_m": round(float(v[v * 3.6 >= HSR_KMH].sum()), 0),
        "sprints": len(sprints),
        "sprint_m": round(float(sum(v[a:b].sum() for a, b in sprints)), 0),
        "gps_coverage_min": round(float(s.notna().sum()) / 60, 1),
    }
