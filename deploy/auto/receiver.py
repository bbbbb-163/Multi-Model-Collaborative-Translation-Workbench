"""Gitee JSON Push receiver. Runs WITHOUT root, sudo, Git or Docker access."""
import base64
import hashlib
import hmac
import http.server
import json
import os
import socketserver
import sqlite3
import sys
import time
import urllib.parse
import uuid
from pathlib import Path

from common import REPO, SHA, atomic_json, audit, read_json

MAX_BODY = 2 * 1024 * 1024


class Rejected(Exception):
    def __init__(self, status, reason):
        self.status, self.reason = status, reason


def verify(headers, raw, config, now=None):
    now = time.time() if now is None else now
    if len(raw) > MAX_BODY:
        raise Rejected(413, "body_too_large")
    stamp = headers.get("X-Gitee-Timestamp", "")
    token = headers.get("X-Gitee-Token", "")
    if not isinstance(stamp, str) or not stamp.isascii() or not stamp.isdigit() or len(stamp) != 13:
        raise Rejected(401, "invalid_timestamp")
    if abs(now * 1000 - int(stamp)) > 300_000:
        raise Rejected(401, "expired_signature")
    secret = config["secret"]
    expected = base64.b64encode(hmac.new(secret.encode(), (stamp + "\n" + secret).encode(), hashlib.sha256).digest()).decode()
    # Gitee documents URL-encoded base64; the JSON example uses raw base64.
    # unquote preserves '+' (unquote_plus would corrupt raw base64).
    actual = urllib.parse.unquote(token)
    if not hmac.compare_digest(expected.encode(), actual.encode()):
        raise Rejected(401, "bad_signature")
    ping = headers.get("X-Gitee-Ping", "").strip().lower() == "true"
    if headers.get("X-Gitee-Event") not in (("Push Hook", "push_hooks") if ping else ("Push Hook",)):
        raise Rejected(422, "not_push")
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeError):
        raise Rejected(400, "invalid_json")
    if not isinstance(body, dict) or body.get("hook_name") != "push_hooks":
        raise Rejected(422, "not_push")
    if ping:
        # Gitee's test button sends synthetic test_version/sample-repository
        # data. Authentication proves connectivity, not deployment eligibility.
        return None
    if body.get("ref") != "refs/heads/main":
        raise Rejected(422, "not_main")
    if body.get("deleted") is not False:
        raise Rejected(422, "deleted_or_missing_flag")
    sha = body.get("after", "")
    if not isinstance(sha, str) or not SHA.fullmatch(sha) or sha == "0" * 40:
        raise Rejected(422, "invalid_commit")
    repository = body.get("repository")
    if not isinstance(repository, dict):
        raise Rejected(403, "wrong_repository")
    # full_name is often a display name in Gitee, so deliberately do not use it.
    if (type(repository.get("id")) is not int or repository["id"] != config["repository_id"]
            or repository.get("path_with_namespace") != config["repository"]
            or repository.get("ssh_url") != "git@gitee.com:" + config["repository"] + ".git"):
        raise Rejected(403, "wrong_repository")
    return sha


class Inbox:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.database = self.directory / "receipts.sqlite"
        with sqlite3.connect(str(self.database)) as db:
            db.execute("CREATE TABLE IF NOT EXISTS receipts (sha TEXT PRIMARY KEY, received REAL NOT NULL)")

    def accept(self, sha):
        with sqlite3.connect(str(self.database), timeout=2) as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM receipts WHERE sha=?", (sha,)).fetchone():
                return False
            previous = None
            try:
                previous = read_json(self.directory / "latest.json", limit=4096)
            except (OSError, ValueError):
                pass
            # Write durable wakeup before receipt. A crash can repeat a wakeup,
            # but cannot mark an event delivered without a durable queue entry.
            atomic_json(self.directory / "latest.json", dict(id=uuid.uuid4().hex, sha=sha, received=time.time()))
            db.execute("INSERT INTO receipts VALUES (?, ?)", (sha, time.time()))
            db.execute("DELETE FROM receipts WHERE sha NOT IN (SELECT sha FROM receipts ORDER BY received DESC LIMIT 2048)")
        if isinstance(previous, dict) and isinstance(previous.get("sha"), str) and SHA.fullmatch(previous["sha"]):
            audit("queue_pointer_replaced", previous_sha=previous["sha"], next_sha=sha, strategy="latest_main_tip")
        return True


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "MstarHook"
    protocol_version = "HTTP/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(8)

    def log_message(self, *_):
        pass  # Never log request URLs, credentials, headers or payloads.

    def reply(self, status, reason):
        encoded = json.dumps(dict(status=reason)).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def do_POST(self):
        try:
            if urllib.parse.urlsplit(self.path).path != "/__gitee_deploy":
                raise Rejected(404, "not_found")
            now = time.monotonic()
            self.server.requests = [t for t in self.server.requests if now - t < 60]
            if len(self.server.requests) >= 120:
                raise Rejected(429, "rate_limited")
            self.server.requests.append(now)
            for header in ("Content-Length", "Content-Type", "X-Gitee-Token", "X-Gitee-Timestamp", "X-Gitee-Event"):
                if len(self.headers.get_all(header, [])) != 1:
                    raise Rejected(400, "ambiguous_headers")
            if len(self.headers.get_all("X-Gitee-Ping", [])) > 1:
                raise Rejected(400, "ambiguous_headers")
            if self.headers.get("Transfer-Encoding") or self.headers.get_content_type() != "application/json":
                raise Rejected(415, "json_required")
            size_text = self.headers["Content-Length"]
            if not size_text.isascii() or not size_text.isdigit():
                raise Rejected(400, "invalid_length")
            size = int(size_text)
            if not 0 < size <= MAX_BODY:
                raise Rejected(413, "body_too_large")
            raw = self.rfile.read(size)
            if len(raw) != size:
                raise Rejected(400, "incomplete_body")
            sha = verify(self.headers, raw, self.server.config)
            if sha is None:
                audit("ping_authenticated", repository_id_verified=False)
                self.reply(200, "pong")
                return
            accepted = self.server.inbox.accept(sha)
            audit("accepted" if accepted else "duplicate", sha=sha,
                  repository_id=self.server.config["repository_id"], ref="refs/heads/main")
            self.reply(202 if accepted else 200, "queued" if accepted else "duplicate")
        except Rejected as error:
            audit("rejected", reason=error.reason)
            self.reply(error.status, error.reason)
        except (OSError, sqlite3.Error, ValueError):
            audit("receiver_error")
            self.reply(503, "queue_unavailable")

    def do_GET(self):
        self.reply(405, "post_required")

    do_HEAD = do_GET
    do_PUT = do_GET
    do_DELETE = do_GET


def main():
    config = read_json(sys.argv[1])
    if (not REPO.fullmatch(config["repository"]) or type(config["repository_id"]) is not int
            or len(config["secret"]) < 48):
        raise ValueError("Invalid receiver configuration")
    endpoint = "/run/mstar-hook/hook.sock"
    if os.path.exists(endpoint):
        os.unlink(endpoint)
    # Single bounded process, bounded request body/read timeout, no thread flood.
    with socketserver.UnixStreamServer(endpoint, Handler) as server:
        os.chmod(endpoint, 0o660)
        server.config = config
        server.inbox = Inbox("/var/lib/mstar-hook")
        server.requests = []
        audit("receiver_ready")
        server.serve_forever()


if __name__ == "__main__":
    main()
