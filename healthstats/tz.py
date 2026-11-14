"""Local wall-clock time for UTC timestamps.

Apple Health exports every record in the exporting phone's current offset, so the
original local time is lost. Apple Watch workouts keep an ``HKTimeZone`` tag, which
gives a timeline of where the watch was. Each timestamp takes the zone of the
nearest tagged workout, falling back to the configured default.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


class LocalTime:
    def __init__(self, default: str, workouts: pd.DataFrame | None = None):
        self.default = default
        tl = pd.DataFrame(columns=["t", "tz"])
        if workouts is not None and not workouts.empty and "tz" in workouts:
            w = workouts.dropna(subset=["tz", "start"])
            w = w[w["tz"].map(_valid)]
            tl = pd.DataFrame({"t": _utc_naive(w["start"]), "tz": w["tz"].astype(str).to_numpy()})
            tl = tl.sort_values("t").reset_index(drop=True)
        self.timeline = tl

    def zones(self, ts: pd.Series) -> pd.Series:
        """Time zone name for each timestamp (same index as ``ts``)."""
        out = pd.Series(self.default, index=ts.index, dtype=object)
        if self.timeline.empty:
            return out
        ok = ts.notna().to_numpy()
        if not ok.any():
            return out
        key = pd.DataFrame({"t": _utc_naive(ts[ok]), "i": np.flatnonzero(ok)}).sort_values("t")
        m = pd.merge_asof(key, self.timeline, on="t", direction="nearest")
        z = np.full(len(ts), self.default, dtype=object)
        z[m["i"].to_numpy()] = m["tz"].fillna(self.default).to_numpy()
        return pd.Series(z, index=ts.index, dtype=object)

    def __call__(self, ts: pd.Series) -> pd.Series:
        """Naive local datetimes for tz-aware ``ts``."""
        zones = self.zones(ts)
        utc = ts.dt.tz_convert("UTC")
        out = pd.Series(pd.NaT, index=ts.index, dtype="datetime64[ns]")
        for z in pd.unique(zones):
            sel = (zones == z).to_numpy()
            out[sel] = utc[sel].dt.tz_convert(z).dt.tz_localize(None).astype("datetime64[ns]").to_numpy()
        return out

    def date(self, ts: pd.Series) -> pd.Series:
        return self(ts).dt.normalize()


def _utc_naive(ts: pd.Series) -> np.ndarray:
    return ts.dt.tz_convert("UTC").dt.tz_localize(None).astype("datetime64[ns]").to_numpy()


def _valid(name) -> bool:
    try:
        pd.Timestamp("2020-01-01", tz=str(name))
        return True
    except Exception:
        return False
