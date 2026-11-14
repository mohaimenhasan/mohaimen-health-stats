"""Encrypted bundle of the generated site data, so the public repo holds no readable personal data.

    python -m healthstats.vault keygen               # once: writes .data-key (gitignored)
    python -m healthstats.vault seal                 # site/data + config data -> data.enc
    python -m healthstats.vault open [--only PATH]   # data.enc -> files (CI uses --only site/data)

The key is read from $DATA_KEY, falling back to .data-key in the repo root.
"""
from __future__ import annotations

import argparse
import gzip
import io
import os
import sys
import tarfile
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

ROOT = Path(__file__).resolve().parent.parent
VAULT = "data.enc"
KEY_FILE = ".data-key"
PATHS = ("site/data", "config/weight_log.csv", "config/dexa")
SKIP = {".DS_Store"}


def load_key(root: Path = ROOT) -> bytes:
    key = os.environ.get("DATA_KEY", "").strip()
    if not key and (root / KEY_FILE).is_file():
        key = (root / KEY_FILE).read_text().strip()
    if not key:
        raise SystemExit(f"No key: set DATA_KEY or create {KEY_FILE} (python -m healthstats.vault keygen)")
    return key.encode()


def _files(root: Path, paths=PATHS) -> list[Path]:
    out: list[Path] = []
    for rel in paths:
        p = root / rel
        if p.is_file():
            out.append(p)
        elif p.is_dir():
            out += [f for f in p.rglob("*") if f.is_file() and f.name not in SKIP]
    return sorted(out, key=lambda f: f.relative_to(root).as_posix())


def bundle(root: Path = ROOT, paths=PATHS) -> bytes:
    """Deterministic tar.gz of the data paths (same files -> same bytes)."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for f in _files(root, paths):
            data = f.read_bytes()
            info = tarfile.TarInfo(f.relative_to(root).as_posix())
            info.size, info.mtime, info.mode = len(data), 0, 0o644
            tar.addfile(info, io.BytesIO(data))
    return gzip.compress(raw.getvalue(), mtime=0)


def seal(root: Path = ROOT, key: bytes | None = None) -> bool:
    """Encrypt the data paths into data.enc. Returns False if the contents are unchanged."""
    key = key or load_key(root)
    blob = bundle(root)
    vault = root / VAULT
    if vault.is_file():
        try:
            if Fernet(key).decrypt(vault.read_bytes()) == blob:
                return False
        except InvalidToken:
            pass
    vault.write_bytes(Fernet(key).encrypt(blob))
    return True


def open_vault(root: Path = ROOT, key: bytes | None = None, only: str | None = None) -> list[str]:
    """Decrypt data.enc into root. Returns the extracted paths."""
    key = key or load_key(root)
    try:
        blob = Fernet(key).decrypt((root / VAULT).read_bytes())
    except InvalidToken:
        raise SystemExit("data.enc: wrong key or corrupted file") from None
    prefix = only.strip("/") if only else None
    names: list[str] = []
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(blob)), mode="r") as tar:
        members = [m for m in tar.getmembers()
                   if m.isfile() and (prefix is None or m.name == prefix or m.name.startswith(prefix + "/"))]
        tar.extractall(root, members=members, filter="data")
        names = [m.name for m in members]
    return names


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m healthstats.vault")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("keygen")
    sub.add_parser("seal")
    o = sub.add_parser("open")
    o.add_argument("--only", help="extract only this path (e.g. site/data)")
    args = ap.parse_args(argv)

    if args.cmd == "keygen":
        kf = ROOT / KEY_FILE
        if kf.exists():
            raise SystemExit(f"{KEY_FILE} already exists")
        kf.write_text(Fernet.generate_key().decode() + "\n")
        kf.chmod(0o600)
        print(f"wrote {KEY_FILE}; store it as the DATA_KEY repo secret and keep a backup")
    elif args.cmd == "seal":
        print(f"{VAULT} updated" if seal() else f"{VAULT} unchanged")
    else:
        names = open_vault(only=args.only)
        if not names:
            raise SystemExit(f"nothing matched {args.only!r} in {VAULT}")
        print(f"extracted {len(names)} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
