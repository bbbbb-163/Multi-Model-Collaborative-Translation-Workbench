"""Local protocol, persistence, data-safety and deployment failure regressions.

Run: python -m unittest discover -s tests -p test_auto_deploy.py -v
Docker/systemd/SSH operations are mocked; these are NOT production acceptance.
"""
import base64
import hashlib
import hmac
import http.client
import http.server
import io
import json
import contextlib
import os
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
import urllib.parse
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy" / "auto"))
import receiver
import worker
import data_guard
import candidate
from common import atomic_json, read_json
REAL_GUARD_HASHES = worker.guard_hashes
REAL_TRIM = worker.trim
REAL_RESOURCES = worker.resources
REAL_EXPORT = worker.export

SECRET = "test-only-webhook-fixture-" + "x" * 48
SHA = "a" * 40
NEXT = "b" * 40
CONFIG = dict(secret=SECRET, repository="fixture/mstar", repository_id=123)


def payload(**updates):
    return dict(hook_name="push_hooks", ref="refs/heads/main", deleted=False, after=SHA,
                repository=dict(id=123, path_with_namespace="fixture/mstar", full_name="显示名称/工作台", ssh_url="git@gitee.com:fixture/mstar.git"), **updates)


def headers(stamp=None, encoded=False):
    stamp = str(int(time.time() * 1000)) if stamp is None else stamp
    sign = base64.b64encode(hmac.new(SECRET.encode(), (stamp + "\n" + SECRET).encode(), hashlib.sha256).digest()).decode()
    return {"Content-Type": "application/json", "X-Gitee-Event": "Push Hook", "X-Gitee-Timestamp": stamp,
            "X-Gitee-Token": urllib.parse.quote(sign, safe="") if encoded else sign}


class ProtocolTests(unittest.TestCase):
    def test_gitee_ping_authenticates_without_queueing_or_running_commands(self):
        with tempfile.TemporaryDirectory() as temporary:
            server = http.server.HTTPServer(("127.0.0.1", 0), receiver.Handler)
            server.config, server.inbox, server.requests = CONFIG, receiver.Inbox(temporary), []
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            probe = payload()
            probe.update(ref="refs/heads/test_version", repository={"id":151,"path_with_namespace":"oschina/git-osc","ssh_url":"git@gitee.com:oschina/git-osc.git"})
            try:
                def request(hdr, body=probe):
                    client = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                    client.request("POST", "/__gitee_deploy?timestamp=0&sign=fixture", json.dumps(body).encode(), hdr)
                    response = client.getresponse()
                    result = response.status, json.loads(response.read())
                    client.close()
                    return result
                signed = {**headers(encoded=True), "X-Gitee-Ping":"true"}
                with patch.object(server.inbox,"accept",side_effect=AssertionError("Ping must not touch the deployment queue")), patch("subprocess.run",side_effect=AssertionError("Ping must not execute commands")):
                    self.assertEqual(request(signed), (200, {"status":"pong"}))
                    self.assertEqual(request({**signed,"X-Gitee-Event":"push_hooks"})[0], 200)
                    self.assertEqual(request(signed, payload())[0], 200)
                    self.assertEqual(request({**signed,"X-Gitee-Token":"wrong"})[0], 401)
                    self.assertEqual(request({**headers("1576754827988"),"X-Gitee-Ping":"true"})[0], 401)
                    self.assertEqual(request(headers())[0], 422)
                    self.assertEqual(request({**signed,"X-Gitee-Ping":"false"})[0], 422)
                    self.assertEqual(request({**signed,"X-Gitee-Event":"Issue Hook"})[0], 422)
                self.assertFalse((Path(temporary)/"latest.json").exists())
                with contextlib.closing(sqlite3.connect(server.inbox.database)) as db:
                    self.assertEqual(db.execute("SELECT COUNT(*) FROM receipts").fetchone()[0],0)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

    def test_query_parameters_preserve_path_routing_and_header_authentication(self):
        with tempfile.TemporaryDirectory() as temporary:
            server = http.server.HTTPServer(("127.0.0.1", 0), receiver.Handler)
            server.config, server.inbox, server.requests = CONFIG, receiver.Inbox(temporary), []
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                def request(path, hdr=None):
                    client = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                    client.request("POST", path, json.dumps(payload()).encode(), headers() if hdr is None else hdr)
                    response = client.getresponse()
                    status = response.status
                    response.read()
                    client.close()
                    return status
                path = "/__gitee_deploy?timestamp=0&sign=untrusted-query-signature"
                with patch("subprocess.run", side_effect=AssertionError("Webhook must not execute commands")):
                    self.assertEqual(request(path), 202)
                    self.assertEqual(request("/__gitee_deploy?utm_source=fixture"), 200)
                    self.assertEqual(request("/__gitee_deploy"), 200)
                    self.assertEqual(request(path, {**headers(), "X-Gitee-Token": "wrong"}), 401)
                    self.assertEqual(request(path, headers("1576754827988")), 401)
                    self.assertEqual(request("/wrong?timestamp=0"), 404)
                    self.assertEqual(request("/__gitee_deploy/extra?timestamp=0"), 404)
                self.assertEqual(read_json(Path(temporary) / "latest.json")["sha"], SHA)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

    def test_official_headers_raw_and_url_encoded_base64(self):
        for encoded in (False, True):
            self.assertEqual(receiver.verify(headers(encoded=encoded), json.dumps(payload()).encode(), CONFIG), SHA)

    def test_reject_wrong_secret_branch_event_repo_delete_and_sha(self):
        cases = [({"ref": "refs/heads/feature"}, {}, 422),
                 ({}, {"X-Gitee-Event": "Tag Push Hook"}, 422),
                 ({}, {"X-Gitee-Token": "invalid"}, 401),
                 ({"hook_name": "issue_hooks"}, {}, 422),
                 ({"deleted": True}, {}, 422),
                 ({"after": "0" * 40}, {}, 422),
                 ({"after": "; touch /tmp/injected"}, {}, 422),
                 ({"repository": dict(id=124, path_with_namespace="fixture/mstar", ssh_url="git@gitee.com:fixture/mstar.git")}, {}, 403),
                 ({"repository": dict(id=123, path_with_namespace="attacker/mstar", ssh_url="git@gitee.com:fixture/mstar.git")}, {}, 403)]
        for body_update, header_update, status in cases:
            with self.subTest(body=body_update, header=header_update):
                body, hdr = payload(), headers()
                body.update(body_update)
                hdr.update(header_update)
                with self.assertRaises(receiver.Rejected) as error:
                    receiver.verify(hdr, json.dumps(body).encode(), CONFIG)
                self.assertEqual(error.exception.status, status)

    def test_expired_signature_invalid_json_and_body_limit(self):
        with self.assertRaises(receiver.Rejected):
            receiver.verify(headers("1576754827988"), json.dumps(payload()).encode(), CONFIG)
        with self.assertRaises(receiver.Rejected):
            receiver.verify(headers(), b"{invalid", CONFIG)
        with self.assertRaises(receiver.Rejected) as error:
            receiver.verify(headers(), b"x" * (receiver.MAX_BODY + 1), CONFIG)
        self.assertEqual(error.exception.status, 413)

    def test_durable_duplicate_and_latest_push_survives_restart(self):
        with tempfile.TemporaryDirectory() as temporary:
            inbox = receiver.Inbox(temporary)
            self.assertTrue(inbox.accept(SHA))
            original = read_json(Path(temporary) / "latest.json")
            self.assertFalse(receiver.Inbox(temporary).accept(SHA))
            self.assertEqual(original, read_json(Path(temporary) / "latest.json"))
            self.assertTrue(receiver.Inbox(temporary).accept(NEXT))
            self.assertEqual(read_json(Path(temporary) / "latest.json")["sha"], NEXT)

    def test_http_ack_is_fast_and_does_not_start_commands(self):
        with tempfile.TemporaryDirectory() as temporary:
            server = http.server.HTTPServer(("127.0.0.1", 0), receiver.Handler)
            server.config, server.inbox, server.requests = CONFIG, receiver.Inbox(temporary), []
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                def request(method="POST", body=None, hdr=None, path="/__gitee_deploy"):
                    client = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                    raw = json.dumps(payload()).encode() if body is None else body
                    client.request(method, path, raw, headers() if hdr is None else hdr)
                    response = client.getresponse()
                    result = response.status, response.read()
                    client.close()
                    return result
                with patch("subprocess.run", side_effect=AssertionError("HTTP must not execute any commands")):
                    start = time.monotonic()
                    self.assertEqual(request()[0], 202)
                    self.assertLess(time.monotonic() - start, 2)
                    self.assertEqual(request()[0], 200)
                    self.assertEqual(request("GET")[0], 405)
                    self.assertEqual(request(path="/wrong")[0], 404)
                    self.assertEqual(request(hdr={**headers(), "X-Gitee-Token": "wrong"})[0], 401)
                    self.assertEqual(request(body=b"", hdr={**headers(), "Content-Length": str(receiver.MAX_BODY + 1)})[0], 413)
                    self.assertEqual(request(hdr={**headers(), "Content-Type": "text/plain"})[0], 415)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


class BootstrapTests(unittest.TestCase):
    def test_proxy_validation_does_not_reuse_running_caddy_static_ip(self):
        with tempfile.TemporaryDirectory() as temporary:
            etc = Path(temporary)
            atomic_json(etc / "compose.json", {"services":{"caddy":{"volumes":[{"target":"/etc/caddy/Caddyfile","source":"/old/Caddyfile"}]}}})
            def command(args, **kwargs):
                return json.dumps([{"Image":"sha256:current-caddy"}]) if args[:2] == ["docker","inspect"] else ""
            with patch.object(worker,"ETC",etc), patch.object(worker,"compose",return_value="existing-caddy") as compose, patch.object(worker,"health"), patch.object(worker,"run",side_effect=command) as run:
                worker.activate_proxy({})
            validation = next(call.args[0] for call in run.call_args_list if call.args[0][:2] == ["docker","run"])
            self.assertEqual(validation[validation.index("--network")+1],"none")
            self.assertIn("sha256:current-caddy",validation)
            self.assertFalse(any(call.args and call.args[0]=="run" for call in compose.call_args_list))

    def test_only_expected_maintenance_script_additions_are_equivalent(self):
        host = dict(name="fixture", scripts={"build": "tsc", "test": "tsx --test"}, dependencies={"fixture": "1.0.0"})
        candidate = json.loads(json.dumps(host))
        candidate["scripts"].update({"test:deploy": "python -m unittest discover -s tests -p test_auto_deploy.py -v", "audit:repo": "python scripts/audit-repository.py"})
        self.assertTrue(worker.equivalent_initial_package(host, candidate))
        self.assertNotIn("test:deploy", host["scripts"])
        for mutation in ("dependencies", "build", "audit:repo"):
            changed = json.loads(json.dumps(candidate))
            if mutation == "dependencies":
                changed["dependencies"]["fixture"] = "2.0.0"
            else:
                changed["scripts"][mutation] = "unexpected command"
            self.assertFalse(worker.equivalent_initial_package(host, changed), mutation)

    def test_builder_requires_exact_reviewed_memory_and_cpu_limits(self):
        host = dict(Memory=640 * 1024 ** 2, MemorySwap=640 * 1024 ** 2, CpuQuota=100000, CpuPeriod=100000)
        def command(args, **kwargs):
            return json.dumps([{"HostConfig": host}]) if args[:2] == ["docker", "inspect"] else ""
        with patch.object(worker, "run", side_effect=command):
            worker.ensure_builder()
            host["Memory"] = 1024 ** 3
            with self.assertRaises(worker.ManualRequired):
                worker.ensure_builder()


def create_data(path):
    path.mkdir(exist_ok=True)
    (path / "vault.key").write_bytes(b"test-only-vault-fixture-data-32!!")
    (path / "files").mkdir()
    (path / "files" / "attachment").write_bytes(b"test attachment contents")
    with sqlite3.connect(path / "workbench.sqlite") as db:
        for name in data_guard.TABLES:
            db.execute('CREATE TABLE "' + name + '" (id TEXT PRIMARY KEY, data TEXT)')
            db.execute('INSERT INTO "' + name + '" VALUES (?,?)', ("existing", "synthetic fixture"))


class DataTests(unittest.TestCase):
    def test_optional_key_secrets_and_request_ledger_are_verified_without_breaking_legacy_backups(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "data"
            create_data(root)
            legacy = data_guard.snapshot(root)
            self.assertNotIn("access_key_secrets", legacy["tables"])
            with contextlib.closing(sqlite3.connect(root / "workbench.sqlite")) as db:
                for name in ("access_key_secrets", "model_requests"):
                    db.execute('CREATE TABLE "' + name + '" (id TEXT PRIMARY KEY, value TEXT)')
                    db.execute('INSERT INTO "' + name + '" VALUES (?,?)', ("fixture", "encrypted-or-usage"))
                db.commit()
            before = data_guard.snapshot(root)
            self.assertIn("model_requests", before["tables"])
            self.assertIn("access_key_secrets", before["tables"])
            self.assertFalse(data_guard.compatible(legacy, before), "Schema changes must still require review")
            for name in ("access_key_secrets", "model_requests"):
                after = json.loads(json.dumps(before))
                after["tables"][name].clear()
                self.assertFalse(data_guard.preserved(before, after))
            after = json.loads(json.dumps(before))
            after["tables"]["access_key_secrets"]["fixture"] = "changed"
            self.assertFalse(data_guard.preserved(before, after))
            archive = Path(temporary) / "optional-backup.tar.gz"
            def write_archive():
                with tarfile.open(archive, "w:gz") as tar:
                    tar.add(root, arcname=".")
                    raw = json.dumps(before).encode()
                    member = tarfile.TarInfo(".mstar-backup-manifest.json")
                    member.size = len(raw)
                    tar.addfile(member, io.BytesIO(raw))
            write_archive()
            self.assertEqual(data_guard.verify_archive(archive), before)
            with contextlib.closing(sqlite3.connect(root / "workbench.sqlite")) as db:
                db.execute("UPDATE access_key_secrets SET value='tampered'")
                db.commit()
            write_archive()
            with self.assertRaises(ValueError):
                data_guard.verify_archive(archive)

    def test_stopped_inventory_uses_private_database_copy_and_preserves_original(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            create_data(root)
            original = (root / "workbench.sqlite").read_bytes()
            real_connect = sqlite3.connect
            opened = []
            def connect(path, **kwargs):
                opened.append(path)
                return real_connect(path, **kwargs)
            with patch.object(data_guard.sqlite3, "connect", side_effect=connect):
                manifest = data_guard.stopped_snapshot(root)
            self.assertEqual((root / "workbench.sqlite").read_bytes(), original)
            self.assertTrue(all(not path.startswith(root.as_uri()) for path in opened))
            self.assertIn("existing", manifest["tables"]["security"])
            self.assertIn("files/attachment", manifest["attachments"])

    def test_backup_manifest_detects_lost_accounts_keys_records_files_and_vault(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            create_data(root)
            before = data_guard.snapshot(root)
            self.assertTrue(data_guard.preserved(before, data_guard.snapshot(root)))
            for table in data_guard.TABLES:
                after = json.loads(json.dumps(before))
                after["tables"][table].clear()
                self.assertFalse(data_guard.preserved(before, after), table)
            for field in ("vault", "schema"):
                after = dict(before, **{field: "changed"})
                self.assertFalse(data_guard.compatible(before, after))
            after = dict(before, attachments={})
            self.assertFalse(data_guard.preserved(before, after))

    def test_archive_is_verified_and_tampering_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "data"
            create_data(root)
            manifest = data_guard.snapshot(root)
            archive = Path(temporary) / "backup.tar.gz"
            def write_archive():
                with tarfile.open(archive, "w:gz") as tar:
                    tar.add(root, arcname=".")
                    raw = json.dumps(manifest).encode()
                    member = tarfile.TarInfo(".mstar-backup-manifest.json")
                    member.size = len(raw)
                    tar.addfile(member, io.BytesIO(raw))
            write_archive()
            self.assertEqual(data_guard.verify_archive(archive), manifest)
            (root / "files" / "attachment").write_bytes(b"corrupt")
            write_archive()
            with self.assertRaises(ValueError):
                data_guard.verify_archive(archive)

    def test_missing_database_or_vault_never_initializes(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(ValueError):
                data_guard.snapshot(temporary)
            self.assertEqual(list(Path(temporary).iterdir()), [])


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patches = []
        self.mock("STATE", self.root)
        self.mock("QUEUE", self.root / "latest.json")
        self.mock("DATA", self.root / "data")
        create_data(worker.DATA)
        self.baseline = data_guard.snapshot(worker.DATA)
        self.old = dict(image="mstar-workbench:previous", image_id="sha256:old", commit="c" * 40, schema=self.baseline["schema"])
        self.state = dict(current=self.old.copy(), previous=None, guards={})
        self.request = dict(id="d" * 32, sha=SHA)
        atomic_json(worker.QUEUE, self.request)
        atomic_json(self.root / "state.json", self.state)
        self.mock("fetch", return_value=SHA)
        self.mock("git", return_value="")
        self.mock("export")
        self.mock("LIB", self.root / "lib")
        worker.LIB.mkdir()
        (worker.LIB / "dockerignore").write_text("**\n")
        self.mock("guard_hashes", return_value={})
        self.mock("resources")
        self.mock("ensure_builder")
        self.mock("build")
        self.mock("validate_candidate", return_value={"logs": "synthetic-readiness-logs"})
        self.mock("health")
        self.mock("backup", return_value=(self.root / "verified-backup.tar.gz", self.baseline))
        self.mock("replace")
        self.mock("trim")
        def command(args, **kwargs):
            if args[:3] == ["docker", "image", "inspect"]:
                return json.dumps([dict(Id="sha256:old" if args[3] == self.old["image"] else "sha256:new", Config=dict(Labels={"org.opencontainers.image.revision": SHA}))])
            return ""
        self.mock("run", side_effect=command)

    def mock(self, name, *args, **kwargs):
        patcher = patch.object(worker, name, *args, **kwargs)
        self.patches.append(patcher)
        return patcher.start()

    def tearDown(self):
        for patcher in reversed(self.patches):
            patcher.stop()
        self.temp.cleanup()

    def test_success_records_sha_and_retains_previous_without_touching_proxy(self):
        worker.tick({})
        current = read_json(self.root / "state.json")
        self.assertEqual(current["current"]["commit"], SHA)
        self.assertEqual(current["previous"], self.old)
        self.assertEqual(current["last_result"], "deployed")
        self.assertFalse((self.root / "transaction.json").exists())
        self.assertTrue(data_guard.preserved(self.baseline, data_guard.snapshot(worker.DATA)))
        worker.replace.assert_called_once_with("mstar-workbench:git-" + SHA)

    def test_network_fetch_tests_build_resource_and_backup_fail_before_switch(self):
        for failing in ("fetch", "git", "resources", "build", "validate_candidate", "backup"):
            with self.subTest(failing=failing):
                atomic_json(self.root / "state.json", self.state)
                worker.replace.reset_mock()
                worker.backup.reset_mock()
                with patch.object(worker, failing, side_effect=RuntimeError("synthetic failure")):
                    worker.tick({})
                worker.replace.assert_not_called()
                current = read_json(self.root / "state.json")
                self.assertEqual(current["current"], self.old)
                self.assertEqual(current["last_result"], "failed")
                self.assertFalse((self.root / "transaction.json").exists())
                self.assertTrue(data_guard.preserved(self.baseline, data_guard.snapshot(worker.DATA)))

    def test_candidate_must_pass_before_any_production_backup_or_switch(self):
        order = []
        worker.validate_candidate.side_effect = lambda *args: order.append("candidate") or {"logs": "synthetic-logs"}
        worker.backup.side_effect = lambda *args: order.append("backup") or (self.root / "verified-backup.tar.gz", self.baseline)
        worker.replace.side_effect = lambda *args: order.append("switch")
        worker.tick({})
        self.assertEqual(order, ["candidate", "backup", "switch"])

    def test_candidate_failure_retains_old_data_and_is_not_retried(self):
        worker.validate_candidate.side_effect = RuntimeError("synthetic startup permission error")
        worker.tick({})
        worker.backup.assert_not_called()
        worker.replace.assert_not_called()
        self.assertEqual(read_json(worker.STATE / "state.json")["current"], self.old)
        worker.fetch.reset_mock()
        worker.tick({})
        worker.fetch.assert_not_called()
        self.assertTrue(data_guard.preserved(self.baseline, data_guard.snapshot(worker.DATA)))

    def test_start_failure_rolls_back_old_immutable_image(self):
        worker.replace.side_effect = [RuntimeError("new container failed"), None]
        worker.tick({})
        self.assertEqual([call.args[0] for call in worker.replace.call_args_list], ["mstar-workbench:git-" + SHA, self.old["image"]])
        self.assertEqual(read_json(self.root / "state.json")["current"], self.old)
        self.assertFalse((self.root / "transaction.json").exists())

    def test_public_or_container_health_failure_rolls_back(self):
        # Initial old health; post-backup health is mocked with backup(); new
        # health fails; rollback health passes.
        worker.health.side_effect = [None, RuntimeError("HTTPS failed"), None]
        worker.tick({})
        self.assertEqual(worker.replace.call_count, 2)
        self.assertEqual(worker.health.call_count, 3)
        self.assertFalse((self.root / "blocked.json").exists())

    def test_changed_schema_blocks_automatic_image_rollback_and_retries(self):
        def replace(_):
            with sqlite3.connect(worker.DATA / "workbench.sqlite") as db:
                db.execute("CREATE TABLE incompatible (id INTEGER)")
            raise RuntimeError("health failed after unexpected migration")
        worker.replace.side_effect = replace
        worker.tick({})
        self.assertEqual(worker.replace.call_count, 1)
        self.assertTrue((self.root / "blocked.json").exists())
        self.assertTrue((self.root / "transaction.json").exists())
        worker.fetch.reset_mock()
        worker.tick({})
        worker.fetch.assert_not_called()

    def test_migration_or_infrastructure_changes_require_human_review(self):
        worker.guard_hashes.return_value = {"server/store.ts": "new hash"}
        worker.tick({})
        worker.build.assert_not_called()
        worker.backup.assert_not_called()
        worker.replace.assert_not_called()
        self.assertTrue((self.root / "blocked.json").exists())

    def test_duplicate_tick_does_not_repeat_and_new_push_is_not_lost(self):
        worker.tick({})
        worker.fetch.reset_mock()
        worker.tick({})
        worker.fetch.assert_not_called()
        atomic_json(worker.QUEUE, dict(id="e" * 32, sha=NEXT))
        worker.fetch.return_value = SHA  # Already deployed remote tip.
        worker.tick({})
        worker.fetch.assert_called_once()
        self.assertEqual(read_json(self.root / "state.json")["processed_id"], "e" * 32)

    def test_last_push_during_build_remains_pending_for_next_tick(self):
        def new_push(_):
            atomic_json(worker.QUEUE, dict(id="e" * 32, sha=NEXT))
        worker.build.side_effect = new_push
        worker.tick({})
        self.assertEqual(read_json(self.root / "state.json")["processed_id"], self.request["id"])
        self.assertEqual(read_json(worker.QUEUE)["sha"], NEXT)

    def test_crash_transaction_prevents_unattended_retry(self):
        atomic_json(self.root / "transaction.json", {"old": self.old})
        worker.tick({})
        worker.fetch.assert_not_called()

    def test_guard_detects_new_migration_and_auth_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            tree = Path(temporary)
            (tree / "server").mkdir()
            (tree / "server" / "store.ts").write_text("database")
            first = REAL_GUARD_HASHES(tree)
            (tree / "server" / "new.ts").write_text('db.exec("ALTER TABLE tasks ADD COLUMN incompatible TEXT")')
            self.assertNotEqual(first, REAL_GUARD_HASHES(tree))
            (tree / "server" / "new.ts").unlink()
            (tree / "server" / "store.ts").write_text("changed encryption")
            self.assertNotEqual(first, REAL_GUARD_HASHES(tree))

    def test_retention_keeps_current_previous_and_two_or_three_backups(self):
        backups = self.root / "backups"
        backups.mkdir()
        for number in range(6):
            archive = backups / ("mstar-data-" + str(number) + ".tar.gz")
            archive.write_bytes(b"fixture")
            for suffix in (".sha256", ".config.tar.gz", ".config.tar.gz.sha256.json"):
                Path(str(archive) + suffix).write_bytes(b"fixture")
            os.utime(archive, (time.time() + number, time.time() + number))
        with patch.object(worker, "BACKUPS", backups):
            REAL_TRIM(dict(backup_keep=3, backup_max_age_days=14), self.state)
        data_archives = [p for p in backups.glob("*.tar.gz") if not p.name.endswith(".config.tar.gz")]
        self.assertEqual(len(data_archives), 3)
        self.assertEqual(len(list(backups.iterdir())), 12)

    def test_low_memory_and_low_disk_abort_before_build(self):
        with patch.object(Path, "read_text", return_value="MemAvailable: 100000 kB\n"):
            with self.assertRaises(RuntimeError):
                REAL_RESOURCES(dict(min_available_mb=1250, min_disk_mb=4096))
        with patch.object(Path, "read_text", return_value="MemAvailable: 2000000 kB\n"), patch.object(worker.shutil, "disk_usage", return_value=type("Usage", (), {"free": 100})()):
            with self.assertRaises(RuntimeError):
                REAL_RESOURCES(dict(min_available_mb=1250, min_disk_mb=4096))

    def test_source_symlink_archive_is_never_extracted(self):
        archive_path = self.root / "source.tar"
        def archive(*_):
            with tarfile.open(archive_path, "w") as tar:
                member = tarfile.TarInfo("escape")
                member.type, member.linkname = tarfile.SYMTYPE, "/opt/mstar/runtime/data/vault.key"
                tar.addfile(member)
        destination = self.root / "tree"
        destination.mkdir()
        worker.git.side_effect = archive
        with self.assertRaises(ValueError):
            REAL_EXPORT({}, SHA, destination)
        self.assertEqual(list(destination.iterdir()), [])
        self.assertFalse(archive_path.exists())

    def test_changed_rollback_image_tag_does_not_replace_container(self):
        worker.run.return_value = json.dumps([dict(Id="sha256:tampered")])
        worker.run.side_effect = None
        with self.assertRaises(worker.ManualRequired):
            worker.restore({}, self.old, self.baseline)
        worker.replace.assert_not_called()

    def test_status_remains_readable_without_deployment_lock(self):
        with patch.object(worker, "live", return_value={"Image": "sha256:old"}), contextlib.redirect_stdout(io.StringIO()) as output:
            worker.show_status()
        self.assertIn("sha256:old", output.getvalue())

    def test_competing_worker_returns_before_loading_config(self):
        fake_lock = type("Lock", (), {"LOCK_EX": 1, "LOCK_NB": 2, "flock": unittest.mock.Mock(side_effect=BlockingIOError)})()
        real_open = open
        def lock_open(path, *args, **kwargs):
            return real_open(self.root / "test.lock", *args, **kwargs)
        with patch.object(worker, "fcntl", fake_lock), patch.object(worker.os, "geteuid", return_value=0, create=True), patch("builtins.open", side_effect=lock_open), patch.object(worker, "config") as cfg, patch.object(sys, "argv", ["worker", "tick"]):
            worker.main()
        cfg.assert_not_called()
        worker.fetch.assert_not_called()

    def test_malformed_queue_cannot_select_commands_or_repository(self):
        atomic_json(worker.QUEUE, dict(id="x", sha=["shell"], remote="attacker"))
        with self.assertRaises(ValueError):
            worker.tick({})
        worker.fetch.assert_not_called()

    def test_rebaseline_cannot_approve_a_candidate_that_is_not_running(self):
        with patch.object(worker, "live", return_value={"Image": "sha256:old", "Config": {"Labels": {}}}):
            with self.assertRaises(worker.ManualRequired):
                worker.rebaseline({})
        worker.backup.assert_not_called()
        self.assertEqual(read_json(self.root / "state.json"), self.state)

    def test_rebaseline_cannot_erase_interrupted_transaction(self):
        atomic_json(self.root / "transaction.json", {"old": self.old})
        with self.assertRaises(worker.ManualRequired):
            worker.rebaseline({})
        worker.fetch.assert_not_called()


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.cid, self.image = "f" * 64, "sha256:" + "a" * 64
        self.running = self.started = self.removed = False
        self.startup_failure = self.permission_failure = self.bad_mount = False
        self.log_failure = False
        self.image_user = "node"
        self.calls = []
        self.output = b"synthetic application startup output\n"
        self.errors = b"synthetic full startup stack\n" + b"frame\n" * 100
        self.process = patch.object(candidate.subprocess, "run", side_effect=self.command)
        self.chown = patch.object(candidate.os, "chown", create=True)
        self.process.start()
        self.chown.start()

    def tearDown(self):
        self.process.stop()
        self.chown.stop()
        self.temporary.cleanup()

    def command(self, args, **_):
        self.calls.append(args)
        raw, err, code = b"", b"", 0
        if args[:3] == ["docker", "image", "inspect"]:
            raw = json.dumps([dict(Id=self.image, Config=dict(User=self.image_user, Labels={"org.opencontainers.image.revision": SHA}))]).encode()
        elif args[:2] == ["docker", "create"]:
            self.name = args[args.index("--name") + 1]
            self.token = next(v.split("=", 1)[1] for v in args if v.startswith("io.mstar.candidate-check="))
            mount = args[args.index("--mount") + 1]
            self.data = mount.split("source=", 1)[1].rsplit(",target=", 1)[0]
            raw = self.cid.encode()
        elif args[:2] == ["docker", "inspect"]:
            raw = json.dumps([dict(Name="/" + self.name, Image=self.image,
                Config=dict(Labels={"io.mstar.candidate-check": self.token}),
                HostConfig=dict(NetworkMode="none", PortBindings={}),
                Mounts=[dict(Source="/opt/mstar/runtime/data" if self.bad_mount else self.data, Destination="/app/.data")],
                State=dict(Running=self.running, ExitCode=1, Health=dict(Status="healthy")))]).encode()
        elif args[:2] == ["docker", "start"]:
            self.started = True
            self.running = not self.startup_failure
        elif args[:2] == ["docker", "exec"]:
            if args[-1] == candidate.READABILITY_JS:
                if self.permission_failure:
                    code, err = 1, b"EACCES: synthetic package.json permission failure\n"
                else:
                    raw = json.dumps(dict(uid=1000, gid=1000, files=10, directories=3, modes={"package.json": "644"})).encode()
            else:
                raw = b'{"health":true,"home":true,"admin":true}'
        elif args[:2] == ["docker", "stop"]:
            self.running = False
        elif args[:2] == ["docker", "logs"]:
            raw, err = self.output, self.errors
            if self.log_failure:
                code = 1
        elif args[:2] == ["docker", "rm"]:
            self.removed = True
        else:
            raise AssertionError(args)
        return subprocess.CompletedProcess(args, code, raw, err)

    def validate(self):
        return candidate.validate_candidate(self.image, SHA, self.root)

    def test_real_user_isolation_cleanup_and_full_logs(self):
        result = self.validate()
        self.assertTrue(result["passed"])
        self.assertTrue(self.started and self.removed)
        self.assertFalse(Path(self.data).exists())
        create = next(c for c in self.calls if c[:2] == ["docker", "create"])
        for option, value in (("--user", "node"), ("--network", "none"), ("--restart", "no"), ("--memory", "256m")):
            self.assertEqual(create[create.index(option) + 1], value)
        self.assertIn("--read-only", create)
        self.assertNotIn("--env-file", create)
        self.assertFalse(any("/opt/mstar" in v for v in create))
        self.assertIn("com.docker.compose.service=candidate", create)
        self.assertEqual((Path(result["logs"]) / "stdout.log").read_bytes(), self.output)
        self.assertEqual((Path(result["logs"]) / "stderr.log").read_bytes(), self.errors)

    def test_startup_exit_blocks_and_preserves_complete_error_stack(self):
        self.startup_failure = True
        with self.assertRaises(RuntimeError):
            self.validate()
        logs = next((self.root / "candidate-checks").iterdir())
        self.assertFalse(read_json(logs / "result.json")["passed"])
        self.assertEqual((logs / "stderr.log").read_bytes(), self.errors)
        self.assertTrue(self.removed)
        self.assertEqual(sum(c[:2] == ["docker", "start"] for c in self.calls), 1)

    def test_unreadable_runtime_file_blocks_and_saves_probe_error(self):
        self.permission_failure = True
        with self.assertRaises(RuntimeError):
            self.validate()
        logs = next((self.root / "candidate-checks").iterdir())
        self.assertIn("EACCES", (logs / "commands.jsonl").read_text())
        self.assertTrue(self.removed)

    def test_production_mount_is_rejected_before_start(self):
        self.bad_mount = True
        with self.assertRaises(RuntimeError):
            self.validate()
        self.assertFalse(self.started)

    def test_startup_timeout_stops_candidate_without_repeating_start(self):
        with patch.object(candidate.time, "monotonic", side_effect=[0, 121]):
            with self.assertRaises(RuntimeError):
                self.validate()
        self.assertTrue(self.removed)
        self.assertFalse(self.running)
        self.assertEqual(sum(c[:2] == ["docker", "start"] for c in self.calls), 1)
        logs = next((self.root / "candidate-checks").iterdir())
        self.assertIn("timed out", read_json(logs / "result.json")["error"])

    def test_log_capture_error_fails_closed_and_still_removes_candidate(self):
        self.log_failure = True
        with self.assertRaises(RuntimeError):
            self.validate()
        self.assertTrue(self.removed)
        logs = next((self.root / "candidate-checks").iterdir())
        result = read_json(logs / "result.json")
        self.assertFalse(result["passed"])
        self.assertTrue(result["cleanup_errors"])

    def test_root_image_is_rejected_before_container_creation(self):
        self.image_user = "root"
        with self.assertRaises(RuntimeError):
            self.validate()
        self.assertFalse(any(c[:2] == ["docker", "create"] for c in self.calls))

    def test_mutable_image_tag_is_not_accepted(self):
        with self.assertRaises(ValueError):
            candidate.validate_candidate("mstar-workbench:latest", SHA, self.root)
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
