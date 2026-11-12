"""Exercise the installed worker against synthetic data in a private project.

Run on the server as root after installing the controller and prebuilding an
image. No production container is stopped or replaced. No ports are published.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import uuid

sys.path.insert(0, "/usr/local/lib/mstar-deploy")
import worker
from data_guard import TABLES, snapshot


def production_state():
    result = {}
    for name in ("mstar-workbench-1", "mstar-caddy-1"):
        info = json.loads(worker.run(["docker", "inspect", name]))[0]
        result[name] = {"id": info["Id"], "image": info["Image"], "started": info["State"]["StartedAt"], "restarts": info["RestartCount"]}
    for name in ("/opt/mstar/.env", "/opt/mstar/runtime/data/vault.key"):
        result[name] = hashlib.sha256(Path(name).read_bytes()).hexdigest()
    return result


def main():
    if os.geteuid() != 0:
        raise SystemExit("Run as root")
    os.umask(0o077)
    before = production_state()
    old_id = before["mstar-workbench-1"]["image"]
    prebuilt = json.loads(Path("/var/lib/mstar-deploy/prebuilt.json").read_text())
    new_id = prebuilt["image_id"]
    assert old_id != new_id
    project = "mstar-rollback-check-" + uuid.uuid4().hex[:12]
    original_run = worker.run

    with tempfile.TemporaryDirectory(prefix="mstar-rollback-check-", dir="/var/tmp") as directory:
        root = Path(directory).resolve()
        assert root.parent == Path("/var/tmp") and root.name.startswith("mstar-rollback-check-")
        data = root / "data"
        data.mkdir()
        (data / "files").mkdir()
        (data / "vault.key").write_bytes(b"synthetic-rollback-key-fixture!!!")
        with contextlib.closing(sqlite3.connect(data / "workbench.sqlite")) as db:
            for table in TABLES:
                db.execute('CREATE TABLE "' + table + '" (id TEXT PRIMARY KEY, data TEXT)')
                db.execute('INSERT INTO "' + table + '" VALUES (?, ?)', ("fixture", "synthetic"))
            db.commit()
        baseline = snapshot(data)
        # The actual initial image lacks the newly added maintenance command;
        # the prebuilt image has it. Simulate only the latter being unhealthy.
        program = "const p=require('/app/package.json');const bad=Object.hasOwn(p.scripts,'test:deploy');require('node:http').createServer((q,s)=>{s.writeHead(bad?503:200,{'Content-Type':'application/json'});s.end(JSON.stringify({ok:!bad}))}).listen(3210,'127.0.0.1')"
        health = "fetch('http://127.0.0.1:3210/api/health',{signal:AbortSignal.timeout(1500)}).then(async r=>{if(!r.ok||!(await r.json()).ok)process.exit(1)}).catch(()=>process.exit(1))"
        configuration = {"name": project, "services": {"workbench": {
            "image": old_id, "network_mode": "none", "read_only": True,
            "command": ["node", "-e", program], "restart": "no", "init": True,
            "mem_limit": "192m", "cpus": 0.5, "pids_limit": 64,
            "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
            "volumes": [{"type": "bind", "source": str(data), "target": "/app/.data", "read_only": True}],
            "healthcheck": {"test": ["CMD", "node", "-e", health], "interval": "1s", "timeout": "2s", "start_period": "1s", "retries": 1},
        }}}
        (root / "compose.json").write_text(json.dumps(configuration))
        worker.ETC = root
        worker.STATE = root
        worker.DATA = data

        def isolated_run(args, **kwargs):
            args = list(args)
            if args[:2] == ["docker", "compose"]:
                assert str(root / "compose.json") in [str(v) for v in args]
                args[2:2] = ["--project-name", project]
            return original_run(args, **kwargs)

        worker.run = isolated_run
        cfg = {"public_health": "https://mstar.chat/api/health"}
        try:
            worker.replace(old_id)
            worker.health(cfg, old_id)
            first = worker.live()
            assert first["Config"]["Labels"]["com.docker.compose.project"] == project
            assert first["HostConfig"]["NetworkMode"] == "none"
            assert all(not bindings for bindings in first["NetworkSettings"]["Ports"].values())
            assert all(mount["Source"] != "/opt/mstar/runtime/data" for mount in first["Mounts"])
            failed_as_expected = False
            try:
                worker.replace(new_id)
            except RuntimeError:
                failed = worker.live()
                failed_as_expected = failed["Image"] == new_id and failed["State"].get("Health", {}).get("Status") == "unhealthy"
            assert failed_as_expected, "The simulated unhealthy image did not fail as expected"
            worker.restore(cfg, {"image": old_id, "image_id": old_id, "schema": baseline["schema"]}, baseline)
            restored = worker.live()
            assert restored["Image"] == old_id and restored["State"]["Health"]["Status"] == "healthy"
            assert snapshot(data) == baseline
            with contextlib.closing(sqlite3.connect(data / "workbench.sqlite")) as db:
                db.execute("CREATE TABLE unsafe_fixture_migration (id INTEGER)")
                db.commit()
            unsafe_refused = False
            try:
                worker.restore(cfg, {"image": old_id, "image_id": old_id, "schema": baseline["schema"]}, baseline)
            except worker.ManualRequired:
                unsafe_refused = True
            assert unsafe_refused and worker.live()["Id"] == restored["Id"]
            result = {"isolated_project": project, "unhealthy_image_rejected": True, "previous_image_restored_healthy": True, "synthetic_data_preserved": True, "unsafe_schema_rollback_refused": True}
        finally:
            worker.compose("down", "--remove-orphans", capture=False)
            worker.run = original_run
        assert production_state() == before, "Production container/config state changed"
        result.update(production_unchanged=True, temporary_project_removed=True)
        print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
