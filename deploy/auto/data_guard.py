"""Read-only production integrity inventory; never prints account rows/secrets."""
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tarfile
import tempfile
from pathlib import Path

from common import atomic_json, digest

TABLES = ("security", "providers", "access_keys", "catalog", "tasks", "messages", "files")


def snapshot(directory, database_directory=None):
    directory = Path(directory).resolve()
    if not (directory / "workbench.sqlite").is_file() or not (directory / "vault.key").is_file():
        raise ValueError("Existing database/vault is required; refusing initialization")
    database_directory = Path(database_directory).resolve() if database_directory else directory
    with sqlite3.connect((database_directory / "workbench.sqlite").as_uri() + "?mode=ro", uri=True) as db:
        db.execute("BEGIN")
        if db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise ValueError("SQLite integrity check failed")
        schema = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").fetchall()
        result = dict(schema=hashlib.sha256(json.dumps(schema).encode()).hexdigest(), vault=digest(directory / "vault.key"), tables={}, attachments={})
        optional = tuple(name for name in ("access_key_secrets", "model_requests")
                         if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone())
        for table in TABLES + optional:
            rows = db.execute('SELECT * FROM "' + table + '" ORDER BY id').fetchall()
            result["tables"][table] = {str(row[0]): hashlib.sha256(json.dumps(row, sort_keys=True).encode()).hexdigest() for row in rows}
    for path in sorted((directory / "files").rglob("*")):
        if path.is_symlink():
            raise ValueError("Symlink found in attachment directory")
        if path.is_file():
            result["attachments"][path.relative_to(directory).as_posix()] = digest(path)
    return result


def stopped_snapshot(directory):
    # Caller must have stopped the application. SQLite may create WAL/SHM files
    # even for mode=ro; inspect a private copy so root cannot create auxiliaries
    # in the application's UID-1000 data directory during backup.
    directory = Path(directory)
    with tempfile.TemporaryDirectory(prefix="mstar-inventory-") as temporary:
        for name in ("workbench.sqlite", "workbench.sqlite-wal", "workbench.sqlite-shm"):
            source = directory / name
            if source.is_file():
                shutil.copyfile(source, Path(temporary) / name)
        return snapshot(directory, database_directory=temporary)


def compatible(before, after):
    return before["schema"] == after["schema"] and before["vault"] == after["vault"]


def preserved(before, after):
    if not compatible(before, after):
        return False
    for table, rows in before["tables"].items():
        current = after["tables"][table]
        if not set(rows).issubset(current):
            return False
        if table in ("security", "providers", "access_keys", "catalog", "access_key_secrets"):
            if any(current[key] != value for key, value in rows.items()):
                return False
    return all(after["attachments"].get(key) == value for key, value in before["attachments"].items())


def verify_archive(path):
    # Stream each file, verify its digest, and quick_check a private temporary DB.
    # Never extract the archive onto production data.
    with tarfile.open(path, "r:gz") as archive, tempfile.TemporaryDirectory(prefix="mstar-verify-") as temporary:
        members = archive.getmembers()
        names = {}
        for member in members:
            name = member.name.removeprefix("./") if hasattr(str, "removeprefix") else member.name.lstrip("./")
            if member.name.startswith("/") or ".." in Path(member.name).parts or member.issym() or member.islnk():
                raise ValueError("Unsafe member in backup")
            if member.isfile():
                if name in names:
                    raise ValueError("Duplicate member in backup")
                names[name] = member
        manifest = json.load(archive.extractfile(names[".mstar-backup-manifest.json"]))
        for name, expected in dict(manifest["attachments"], **{"vault.key": manifest["vault"]}).items():
            stream = archive.extractfile(names[name])
            actual = hashlib.sha256()
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                actual.update(chunk)
            if actual.hexdigest() != expected:
                raise ValueError("Backup file checksum mismatch")
        for name in ("workbench.sqlite", "workbench.sqlite-wal", "workbench.sqlite-shm", "vault.key"):
            if name in names:
                with open(Path(temporary) / name, "wb") as output:
                    source = archive.extractfile(names[name])
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        output.write(chunk)
        # DB records include credential ciphertext, hashes and metadata; compare
        # their digests, not just row counts or tar validity.
        restored = snapshot(temporary)
        if restored["tables"] != manifest["tables"] or not compatible(manifest, restored):
            raise ValueError("Backup database inventory mismatch")
    return manifest


if __name__ == "__main__":
    if sys.argv[1] == "snapshot":
        atomic_json(sys.argv[3], snapshot(sys.argv[2]))
    elif sys.argv[1] == "snapshot-stopped":
        atomic_json(sys.argv[3], stopped_snapshot(sys.argv[2]))
    elif sys.argv[1] == "verify":
        verify_archive(sys.argv[2])
        print("Backup database, vault and attachment checksums verified.")
    else:
        raise SystemExit("Use snapshot DATA OUTPUT or verify ARCHIVE")
