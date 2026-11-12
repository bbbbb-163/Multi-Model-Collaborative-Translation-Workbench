"""Small shared helpers. No shell evaluation; no third party Python packages."""
import hashlib
import json
import os
import re
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path

SHA = re.compile(r"[0-9a-f]{40}\Z")
REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")


def utc():
    return datetime.now(timezone.utc).isoformat()


def audit(event, **fields):
    print(json.dumps(dict(time=utc(), event=event, **fields), ensure_ascii=True), flush=True)


def read_json(path, limit=65536):
    # Worker treats the receiver's queue as untrusted, including filesystem entries.
    fd = os.open(str(path), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError("Invalid JSON file size/type")
        raw = stream.read(limit + 1)
        if len(raw) > limit:
            raise ValueError("JSON too large")
    return json.loads(raw)


def atomic_json(path, value, mode=0o600):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            os.chmod(temporary, mode)
            json.dump(value, stream, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            directory = os.open(str(path.parent), os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def digest(path):
    result = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()
