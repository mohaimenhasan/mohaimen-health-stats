"""Unit tests on synthetic data only — no personal exports needed."""
from __future__ import annotations

import io
import zipfile

import numpy as np
import pandas as pd
import pytest

from healthstats import gps, privacy, sources, vault
from healthstats.daily import nightly_sleep
from healthstats.tz import LocalTime
from healthstats.workouts import dedupe, impute_energy, localize


# --- GPS -------------------------------------------------------------------

def _track(speeds_ms: list[float], lat0: float = 10.0) -> pd.DataFrame:
    """1 Hz northbound track with the given per-second speeds (no device speed)."""
    m_per_deg = 111_195.0
    lat = lat0 + np.concatenate([[0], np.cumsum(speeds_ms[:-1])]) / m_per_deg
    t = pd.date_range("2026-01-01 19:00", periods=len(speeds_ms), freq="1s", tz="UTC")
    return pd.DataFrame({"time": t, "lat": lat, "lon": 20.0, "speed": np.nan, "hacc": 5.0})


def test_speed_metrics_counts_held_sprints_and_ignores_short_bursts():
    jog = [3.0] * 60
    sprint = [7.0] * 6        # 25.2 km/h for 6 s -> counts
    blip = [7.0] * 1          # single-second burst -> too short to be a sprint
    m = gps.speed_metrics(pd.DataFrame(_track(jog + sprint + jog + blip + jog)))
    assert m is not None
    assert m["sprints"] == 1
    assert 24 <= m["top_kmh"] <= 26
    assert m["gps_km"] == pytest.approx((180 * 3 + 7 * 7) / 1000, rel=0.05)


def test_speed_series_drops_gps_teleports():
    speeds = [3.0] * 60
    df = _track(speeds)
    df.loc[30, "lat"] += 0.01  # ~1.1 km jump for one fix
    s = gps.speed_series(df)
    assert np.nanmax(s.to_numpy()) * 3.6 < gps.MAX_PLAUSIBLE_KMH


def test_speed_metrics_none_for_tiny_tracks():
    assert gps.speed_metrics(_track([3.0] * 20)) is None


def test_parse_gpx_handles_both_attribute_orders():
    gpx = b"""<gpx><trk><trkseg>
    <trkpt lon="-122.3" lat="47.6"><time>2026-01-01T19:00:00Z</time></trkpt>
    <trkpt lat="47.7" lon="-122.4"><time>2026-01-01T19:00:01Z</time><extensions><speed>3.5</speed><hAcc>4</hAcc></extensions></trkpt>
    </trkseg></trk></gpx>"""
    df = gps.parse_gpx(io.BytesIO(gpx))
    assert list(df["lat"]) == [47.6, 47.7]
    assert list(df["lon"]) == [-122.3, -122.4]
    assert df["speed"].iloc[1] == 3.5 and np.isnan(df["speed"].iloc[0])


# --- Workouts --------------------------------------------------------------

def _w(start, minutes, source, activity="Soccer", **kw):
    s = pd.Timestamp(start, tz="UTC")
    return {"start": s, "end": s + pd.Timedelta(minutes=minutes), "duration_min": minutes,
            "source": source, "activity": activity, **kw}


def test_dedupe_keeps_watch_over_other_apps_and_drops_tiny_sessions():
    w = pd.DataFrame([
        _w("2026-01-01 19:00", 60, "Strava"),
        _w("2026-01-01 19:05", 55, "Apple Watch"),
        _w("2026-01-02 19:00", 60, "Strava"),          # no overlap -> kept
        _w("2026-01-03 19:00", 2, "Apple Watch"),  # < MIN_WORKOUT_MIN
    ])
    out = dedupe(w)
    assert list(out["source"]) == ["Apple Watch", "Strava"]


def test_impute_energy_fills_missing_kcal_from_hr_fit():
    rng = np.random.default_rng(0)
    hr = rng.uniform(120, 170, 40)
    rows = [_w(f"2026-01-{1 + i % 28:02d} 19:00", 60, "Watch", avg_hr=h, active_kcal=60 * (0.1 * h - 4))
            for i, h in enumerate(hr)]
    rows.append(_w("2026-02-01 19:00", 60, "Strava", avg_hr=150.0, active_kcal=np.nan))
    rows.append(_w("2026-02-02 19:00", 30, "Strava", activity="Yoga", avg_hr=100.0, active_kcal=np.nan))
    out = impute_energy(pd.DataFrame(rows))
    football = out.iloc[-2]
    assert football["kcal_est"]
    assert football["active_kcal"] == pytest.approx(60 * (0.1 * 150 - 4), rel=0.02)
    yoga = out.iloc[-1]  # no training data for this category -> left alone
    assert not yoga["kcal_est"] and np.isnan(yoga["active_kcal"])
    assert not out.iloc[:-2]["kcal_est"].any()


def test_localize_prefers_workout_zone_then_inferred_zone():
    w = pd.DataFrame([
        {**_w("2026-01-01 03:00", 60, "Watch"), "tz": "America/New_York"},
        {**_w("2026-01-01 04:00", 60, "Strava"), "tz": None},
    ])
    out = localize(w, LocalTime("America/Los_Angeles", w))
    assert list(out["hour"]) == [22, 23]  # both Eastern: 03:00Z/04:00Z -> 22:00/23:00 EST
    assert list(out["date"].dt.day) == [31, 31]
    assert list(out["category"]) == ["Football", "Football"]


# --- Time zones & sleep ----------------------------------------------------

def test_localtime_uses_nearest_tagged_workout():
    tagged = pd.DataFrame({
        "start": pd.to_datetime(["2025-06-01 12:00Z", "2025-07-01 12:00Z"]),
        "tz": ["Europe/London", "Asia/Dhaka"],
    })
    lt = LocalTime("America/Los_Angeles", tagged)
    s = pd.Series(pd.to_datetime(["2025-06-03 23:30Z", "2025-06-29 23:30Z"]))
    assert list(lt.zones(s)) == ["Europe/London", "Asia/Dhaka"]
    local = lt(s)
    assert local.iloc[0] == pd.Timestamp("2025-06-04 00:30")  # BST
    assert local.iloc[1] == pd.Timestamp("2025-06-30 05:30")  # UTC+6


def test_localtime_default_without_tags():
    lt = LocalTime("America/Los_Angeles")
    s = pd.Series(pd.to_datetime(["2025-01-01 08:00Z"]))
    assert lt(s).iloc[0] == pd.Timestamp("2025-01-01 00:00")


def test_nightly_sleep_labels_by_wake_date_and_skips_naps():
    def seg(a, b, value="InBed", source="iPhone"):
        return {"start": pd.Timestamp(a, tz="UTC"), "end": pd.Timestamp(b, tz="UTC"), "value": value, "source": source}

    sleep = pd.DataFrame([
        seg("2024-03-02 08:30", "2024-03-02 15:00"),                      # 00:30–07:00 PST
        seg("2024-03-02 22:00", "2024-03-02 23:30"),                      # 14:00 nap -> ignored
        seg("2024-03-03 07:00", "2024-03-03 11:00", "AsleepCore", "Watch"),
        seg("2024-03-03 11:00", "2024-03-03 14:30", "AsleepDeep", "Watch"),
        seg("2024-03-03 06:30", "2024-03-03 15:00"),                      # InBed superseded by watch
    ])
    n = nightly_sleep(sleep, LocalTime("America/Los_Angeles"))
    assert list(n.index.strftime("%Y-%m-%d")) == ["2024-03-02", "2024-03-03"]
    first, second = n.iloc[0], n.iloc[1]
    assert first["sleep_kind"] == "in_bed" and first["sleep_h"] == pytest.approx(6.5)
    assert first["bedtime_h"] == pytest.approx(0.5)
    assert second["sleep_kind"] == "asleep" and second["sleep_h"] == pytest.approx(7.5)
    assert second["bedtime_h"] == pytest.approx(-1.0)  # 23:00 the night before
    assert second["deep_h"] == pytest.approx(3.5)


# --- Sources ---------------------------------------------------------------

def test_detect_and_find_latest(tmp_path):
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    with zipfile.ZipFile(inbox / "export.zip", "w") as z:
        z.writestr("apple_health_export/export.xml", "<HealthData/>")
    strava = inbox / "strava_dump"
    strava.mkdir()
    (strava / "activities.csv").write_text("Activity ID\n")
    (inbox / "notes.txt").write_text("hi")

    kind, src = sources.detect(inbox / "export.zip")
    assert kind == "apple" and src.root == "apple_health_export"
    assert src.open("export.xml").read() == b"<HealthData/>"

    found = sources.find_latest(inbox)
    assert set(found) == {"apple", "strava"}
    assert found["strava"].exists("activities.csv")


# --- Privacy ---------------------------------------------------------------

@pytest.mark.parametrize("payload, label", [
    ('{"who": "me@example.com"}', "email address"),
    ('{"lat": 47.6}', "GPS coordinate pair"),
    ('{"src": "https://x/shared-dexa/abc"}', "DEXA share link"),
    ('{"dob": "2000-01-01"}', "date of birth"),
])
def test_privacy_audit_flags_leaks(tmp_path, payload, label):
    (tmp_path / "a.json").write_text(payload)
    problems = privacy.audit(tmp_path)
    assert any(label in p for p in problems)


def test_privacy_audit_passes_clean_aggregates_and_honours_extra(tmp_path):
    (tmp_path / "a.json").write_text('{"weight_lb": [158, 205, 147], "top_kmh": 26.1}')
    assert privacy.audit(tmp_path) == []
    assert privacy.audit(tmp_path, extra={"secret": "205, 147"})


# --- data vault --------------------------------------------------------------

def _data_tree(root):
    (root / "site/data").mkdir(parents=True)
    (root / "site/data/daily.json").write_text('{"weight_lb":[150]}')
    (root / "config/dexa").mkdir(parents=True)
    (root / "config/dexa/scan.json").write_text("{}")
    (root / "config/weight_log.csv").write_text("date,weight_lb\n2026-01-01,150\n")


def test_vault_round_trip_and_partial_open(tmp_path):
    src, dst = tmp_path / "src", tmp_path / "dst"
    _data_tree(src)
    key = vault.Fernet.generate_key()
    assert vault.seal(src, key) is True
    assert b"weight_lb" not in (src / vault.VAULT).read_bytes()
    assert vault.seal(src, key) is False  # unchanged data leaves data.enc untouched

    dst.mkdir()
    (dst / vault.VAULT).write_bytes((src / vault.VAULT).read_bytes())
    assert vault.open_vault(dst, key, only="site/data") == ["site/data/daily.json"]
    assert (dst / "site/data/daily.json").read_text() == '{"weight_lb":[150]}'
    assert not (dst / "config").exists()


def test_vault_rejects_wrong_key(tmp_path):
    _data_tree(tmp_path)
    vault.seal(tmp_path, vault.Fernet.generate_key())
    with pytest.raises(SystemExit, match="wrong key"):
        vault.open_vault(tmp_path, vault.Fernet.generate_key())
