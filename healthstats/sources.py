"""Locate exports in a zip or folder so the pipeline never needs to unpack 2 GB to disk."""
from __future__ import annotations

import zipfile
from pathlib import Path
from typing import IO


class ExportSource:
    """Read-only view over an export that is either a .zip or an extracted folder."""

    def __init__(self, path: Path, root: str):
        self.path = Path(path)
        self.root = root.strip("/")
        self._zip = zipfile.ZipFile(self.path) if self.path.is_file() else None

    def _full(self, rel: str) -> str:
        rel = rel.lstrip("/")
        return f"{self.root}/{rel}" if self.root else rel

    def open(self, rel: str) -> IO[bytes]:
        if self._zip:
            return self._zip.open(self._full(rel))
        return open(self.path / self._full(rel), "rb")

    def exists(self, rel: str) -> bool:
        if self._zip:
            try:
                self._zip.getinfo(self._full(rel))
                return True
            except KeyError:
                return False
        return (self.path / self._full(rel)).exists()

    def fingerprint(self) -> str:
        target = self.path / self._full("export.xml") if self.path.is_dir() else self.path
        if not target.exists():
            target = self.path
        st = target.stat()
        return f"{target.resolve()}:{st.st_size}:{int(st.st_mtime)}"

    def __repr__(self) -> str:
        return f"ExportSource({self.path}, root={self.root!r})"


def _zip_root_for(zf: zipfile.ZipFile, marker: str) -> str | None:
    for name in zf.namelist():
        if "__MACOSX" in name:
            continue
        if name == marker or name.endswith("/" + marker):
            return name[: -len(marker)].rstrip("/")
    return None


def _dir_root_for(d: Path, marker: str) -> str | None:
    if (d / marker).exists():
        return ""
    for child in d.iterdir():
        if child.is_dir() and (child / marker).exists():
            return child.name
    return None


def detect(path: Path) -> tuple[str, ExportSource] | None:
    """Return ("apple"|"strava", source) if the path looks like a known export."""
    markers = {"apple": "export.xml", "strava": "activities.csv"}
    path = Path(path)
    if path.is_file() and path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as zf:
            for kind, marker in markers.items():
                root = _zip_root_for(zf, marker)
                if root is not None:
                    return kind, ExportSource(path, root)
    elif path.is_dir():
        for kind, marker in markers.items():
            root = _dir_root_for(path, marker)
            if root is not None:
                return kind, ExportSource(path, root)
    return None


def find_latest(inbox: Path) -> dict[str, ExportSource]:
    """Pick the most recently modified Apple and Strava export inside the inbox."""
    found: dict[str, tuple[float, ExportSource]] = {}
    if not inbox.exists():
        return {}
    for child in inbox.iterdir():
        if child.name.startswith("."):
            continue
        hit = detect(child)
        if not hit:
            continue
        kind, src = hit
        mtime = child.stat().st_mtime
        if kind not in found or mtime > found[kind][0]:
            found[kind] = (mtime, src)
    return {k: v[1] for k, v in found.items()}
