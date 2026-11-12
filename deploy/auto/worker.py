"""Root-owned fixed deployment controller. No HTTP handler can invoke commands.

All production paths/configuration come from protected /etc, never the queue or
the fetched repo. Candidate code executes only within the limited Docker builder.
"""
import argparse
import copy
try:
    import fcntl
except ImportError:  # Allows pure/mocked tests on the Windows development host.
    fcntl = None
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path

from common import REPO, SHA, atomic_json, audit, digest, read_json, utc
from data_guard import compatible, preserved, snapshot, verify_archive
from candidate import validate_candidate

ETC = Path("/etc/mstar-deploy")
STATE = Path("/var/lib/mstar-deploy")
LIB = Path("/usr/local/lib/mstar-deploy")
QUEUE = Path("/var/lib/mstar-hook/latest.json")
BUILDER = "mstar-autodeploy"
BUILD_MEMORY_MB = 640
DATA = Path("/opt/mstar/runtime/data")
BACKUPS = Path("/opt/mstar/backups")


class ManualRequired(RuntimeError):
    pass


def run(args, timeout=120, env=None, capture=True):
    # Do not include command output in exceptions: Git/Compose can contain secrets.
    result = subprocess.run([str(v) for v in args], check=False, timeout=timeout,
                            env=env, stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None)
    if result.returncode:
        raise RuntimeError("Command failed: " + str(args[0]) + " (exit " + str(result.returncode) + ")")
    return result.stdout.decode().strip() if capture else ""


def config():
    value = read_json(ETC / "config.json")
    if (not REPO.fullmatch(value["repository"]) or value["remote"] != "git@gitee.com:" + value["repository"] + ".git"
            or value["project_dir"] != "/opt/mstar" or value["public_health"] != "https://mstar.chat/api/health"):
        raise ValueError("Unexpected repository/production location")
    return value


def git(cfg, *args):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null",
               GIT_SSH_COMMAND="ssh -F /dev/null -i /etc/mstar-deploy/gitee_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/mstar-deploy/known_hosts -o ConnectTimeout=15")
    return run(["git", "-c", "core.hooksPath=/dev/null", "--git-dir=" + str(STATE / "repo.git"), *args], timeout=180, env=env)


def fetch(cfg):
    repo = STATE / "repo.git"
    if not repo.exists():
        run(["git", "init", "--bare", repo])
        git(cfg, "remote", "add", "origin", cfg["remote"])
    if git(cfg, "remote", "get-url", "origin") != cfg["remote"]:
        raise ManualRequired("Git origin differs from protected configuration")
    git(cfg, "fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main")
    sha = git(cfg, "rev-parse", "refs/remotes/origin/main^{commit}")
    if not SHA.fullmatch(sha):
        raise ValueError("Invalid remote commit")
    return sha


def export(cfg, sha, directory):
    archive_path = STATE / "source.tar"
    try:
        git(cfg, "archive", "--format=tar", "--output=" + str(archive_path), sha)
        if archive_path.stat().st_size > 100 * 1024 * 1024:
            raise ValueError("Source archive exceeds 100 MiB")
        with tarfile.open(archive_path) as archive:
            members = archive.getmembers()
            if len(members) > 10000:
                raise ValueError("Too many source files")
            for member in members:
                parts = Path(member.name).parts
                if (member.name.startswith("/") or ".." in parts or "\\" in member.name
                        or not (member.isfile() or member.isdir()) or ".git" in parts):
                    raise ValueError("Unsafe source archive member")
                path = directory / member.name
                if member.isdir():
                    path.mkdir(parents=True, exist_ok=True)
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with open(path, "xb") as out:
                        shutil.copyfileobj(archive.extractfile(member), out)
    finally:
        archive_path.unlink(missing_ok=True)


def guard_hashes(tree):
    result = {}
    # Freeze data initialization, encryption/auth and infrastructure. Newly added
    # schema/migration/SQLite code is also flagged, independent of its filename.
    for path in sorted(tree.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(tree).as_posix()
        guarded = relative in ("server/store.ts", "server/auth.ts", "compose.yaml", "Dockerfile", ".dockerignore", ".env.example", "deploy/Caddyfile")
        guarded |= relative.startswith("deploy/") and path.suffix in (".py", ".sh", ".auto", ".toml", ".service", ".timer", ".json", ".conf")
        if relative.startswith(("server/", "shared/")):
            content = path.read_text(encoding="utf-8", errors="replace")
            guarded |= bool(re.search(r"node:sqlite|\b(?:ALTER|CREATE|DROP)\s+(?:TABLE|INDEX)|\bmigrat|\bschema", content, re.I))
        if guarded:
            result[relative] = digest(path)
    return result


def compose(*args, image=None, proxy=False, capture=True):
    base = ETC / ("proxy.json" if proxy else "compose.json")
    command = ["docker", "compose", "--project-directory", "/opt/mstar", "-f", base]
    if image:
        atomic_json(STATE / "image.json", {"services": {"workbench": {"image": image}}})
        command += ["-f", STATE / "image.json"]
    return run(command + list(args), timeout=240, capture=capture)


def live():
    cid = compose("ps", "--all", "--quiet", "workbench")
    if not cid or "\n" in cid:
        raise ManualRequired("Expected exactly one existing workbench container")
    info = json.loads(run(["docker", "inspect", cid]))[0]
    mounts = [m for m in info["Mounts"] if m["Destination"] == "/app/.data"]
    if len(mounts) != 1 or mounts[0]["Type"] != "bind" or Path(mounts[0]["Source"]).resolve() != DATA:
        raise ManualRequired("Production data mount changed")
    return info


def health(cfg, image_id=None):
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        info = live()
        if image_id and info["Image"] != image_id:
            raise ManualRequired("Running container does not match selected image")
        status = info["State"]
        if status.get("Health", {}).get("Status") == "healthy" and status["Running"]:
            try:
                # Check inside the app AND public TLS through the unchanged proxy.
                run(["docker", "exec", info["Id"], "node", "-e", "fetch('http://127.0.0.1:3210/api/health',{signal:AbortSignal.timeout(4000)}).then(async r=>{if(!r.ok||!(await r.json()).ok)process.exit(1)}).catch(()=>process.exit(1))"], timeout=10)
                with urllib.request.urlopen(cfg["public_health"], timeout=10) as response:
                    if response.status == 200 and json.loads(response.read(4096)).get("ok") is True:
                        return
            except (OSError, ValueError, RuntimeError):
                pass
        time.sleep(3)
    raise RuntimeError("Container/local/public HTTPS health check failed")


def resources(cfg, backup_size=0):
    mem = dict(re.findall(r"^(\w+):\s+(\d+) kB", Path("/proc/meminfo").read_text(), re.M))
    if int(mem["MemAvailable"]) < cfg["min_available_mb"] * 1024:
        raise RuntimeError("Insufficient available RAM; old version retained; swap unchanged")
    for path in (STATE, DATA, Path("/var/lib/docker")):
        if shutil.disk_usage(path).free < cfg["min_disk_mb"] * 1024 * 1024 + backup_size * 2:
            raise RuntimeError("Insufficient disk headroom; old version retained")


def backup(cfg):
    output = BACKUPS
    output.mkdir(mode=0o700, exist_ok=True)
    previous = set(output.glob("mstar-data-*.tar.gz"))
    env = dict(os.environ, MSTAR_PROJECT_DIR=cfg["project_dir"], MSTAR_COMPOSE_FILE=str(ETC / "compose.json"),
               MSTAR_DATA_GUARD=str(LIB / "data_guard.py"), MSTAR_LOCK_HELD="1")
    run(["bash", LIB / "backup.sh", output], timeout=900, env=env, capture=False)
    added = set(output.glob("mstar-data-*.tar.gz")) - previous
    if len(added) != 1:
        raise RuntimeError("No unique completed backup")
    archive = added.pop()
    expected = (Path(str(archive) + ".sha256")).read_text().split()[0]
    if digest(archive) != expected:
        raise RuntimeError("Backup SHA256 mismatch")
    manifest = verify_archive(archive)
    # Protected .env, frozen compose, credentials and Caddy metadata are backed
    # up separately. Do not copy Caddy's live certificate volume or reset it.
    configuration = Path(str(archive) + ".config.tar.gz")
    with tarfile.open(configuration, "w:gz") as tar:
        tar.add(ETC, arcname="etc/mstar-deploy")
        tar.add("/opt/mstar/.env", arcname="opt/mstar/.env")
        tar.add(STATE / "state.json", arcname="state.json")
    atomic_json(Path(str(configuration) + ".sha256.json"), {"sha256": digest(configuration)})
    health(cfg)
    return archive, manifest


def ensure_builder():
    try:
        run(["docker", "buildx", "inspect", BUILDER])
    except RuntimeError:
        run(["docker", "buildx", "create", "--name", BUILDER, "--driver", "docker-container",
             "--driver-opt", "memory=640m,memory-swap=640m,cpu-quota=100000,cpu-period=100000,restart-policy=no",
             "--buildkitd-config", LIB / "buildkitd.toml"])
    run(["docker", "buildx", "inspect", BUILDER, "--bootstrap"], timeout=180)
    info = json.loads(run(["docker", "inspect", "buildx_buildkit_" + BUILDER + "0"]))[0]
    host = info["HostConfig"]
    if host["Memory"] != BUILD_MEMORY_MB * 1024 ** 2 or host["MemorySwap"] != BUILD_MEMORY_MB * 1024 ** 2 or host["CpuQuota"] != 100000 or host["CpuPeriod"] != 100000:
        raise ManualRequired("Existing builder resource limits differ; review builder manually")


def build(args):
    process = subprocess.Popen([str(arg) for arg in args])
    deadline = time.monotonic() + 1800
    try:
        while process.poll() is None:
            if time.monotonic() > deadline:
                raise RuntimeError("Build timed out")
            mem = dict(re.findall(r"^(\w+):\s+(\d+) kB", Path("/proc/meminfo").read_text(), re.M))
            if int(mem["MemAvailable"]) < 192 * 1024:
                raise RuntimeError("Host memory reserve exhausted during build")
            if any(shutil.disk_usage(path).free < 1024 ** 3 for path in (STATE, Path("/var/lib/docker"))):
                raise RuntimeError("Host disk reserve exhausted during build")
            time.sleep(5)
        if process.returncode:
            raise RuntimeError("Image tests/build failed; see build output above")
    except BaseException:
        process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        raise
    finally:
        run(["docker", "buildx", "stop", BUILDER])


def trim(cfg, state):
    # Never prune Docker globally, never touch volumes. Keep current + previous
    # immutable image IDs. Only this controller's uniquely named image tags.
    keep = {r["image"] for r in (state["current"], state.get("previous")) if r}
    images = run(["docker", "image", "ls", "--filter", "label=io.mstar.autodeploy=true", "--format", "{{.Repository}}:{{.Tag}}"])
    for tag in images.splitlines():
        if tag.startswith("mstar-workbench:git-") and tag not in keep:
            run(["docker", "image", "rm", tag])
    archives = sorted((p for p in BACKUPS.glob("mstar-data-*.tar.gz") if not p.name.endswith(".config.tar.gz")), key=lambda p: p.stat().st_mtime, reverse=True)
    for index, archive in enumerate(archives):
        # Absolute count cap, plus age expiry; always retain two newest backups.
        expired = time.time() - archive.stat().st_mtime > cfg["backup_max_age_days"] * 86400
        if index < 2 or (index < cfg["backup_keep"] and not expired):
            continue
        # Only delete verified backups with own sidecars, after a healthy deploy.
        if not Path(str(archive) + ".sha256").exists():
            continue
        for suffix in ("", ".sha256", ".config.tar.gz", ".config.tar.gz.sha256.json"):
            Path(str(archive) + suffix).unlink(missing_ok=True)


def replace(image):
    compose("up", "-d", "--no-deps", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180", "workbench", image=image, capture=False)


def restore(cfg, old, baseline):
    if old.get("schema") != baseline["schema"]:
        raise ManualRequired("Rollback target's verified schema differs from backup baseline")
    if json.loads(run(["docker", "image", "inspect", old["image"]]))[0]["Id"] != old["image_id"]:
        raise ManualRequired("Rollback image tag no longer matches recorded immutable image ID")
    if not compatible(baseline, snapshot(DATA)):
        raise ManualRequired("Schema/vault differs: image rollback is unsafe; do not restore database automatically")
    replace(old["image"])
    health(cfg, old["image_id"])
    if not preserved(baseline, snapshot(DATA)):
        raise ManualRequired("Rollback image is healthy, but data inventory requires manual review")


def deploy(cfg, request, state):
    sha = fetch(cfg)
    # Payload selects neither repository URL, command, file path nor executable.
    git(cfg, "merge-base", "--is-ancestor", request["sha"], sha)
    if sha != request["sha"]:
        audit("coalesced_to_main_tip", event_sha=request["sha"], selected_sha=sha)
    if state["current"]["commit"] == sha:
        return "already_current"
    audit("deploy_started", sha=sha)
    old = state["current"]
    health(cfg, old["image_id"])
    resources(cfg)
    with tempfile.TemporaryDirectory(prefix="source-", dir=STATE) as temporary:
        tree = Path(temporary)
        export(cfg, sha, tree)
        if guard_hashes(tree) != state["guards"]:
            raise ManualRequired("Data/infrastructure contract changed: review migration/rollback plan; manual release and rebaseline required")
        # Even an operator-approved candidate ignore file cannot expand the
        # installed builder's context. Never copy production paths into a layer.
        shutil.copyfile(LIB / "dockerignore", tree / ".dockerignore")
        ensure_builder()
        image = "mstar-workbench:git-" + sha
        # No stop/recreate is allowed before build/test succeeds.
        build(["docker", "buildx", "build", "--builder", BUILDER, "--load", "--progress", "plain",
             "--file", LIB / "Dockerfile.auto", "--build-arg", "COMMIT_SHA=" + sha,
             "--tag", image, tree])
        info = json.loads(run(["docker", "image", "inspect", image]))[0]
        if info["Config"]["Labels"].get("org.opencontainers.image.revision") != sha:
            raise RuntimeError("Built image revision differs")
    run(["docker", "buildx", "stop", BUILDER])
    size = sum(p.stat().st_size for p in DATA.rglob("*") if p.is_file())
    resources(cfg, size)
    readiness = validate_candidate(info["Id"], sha, STATE)
    audit("candidate_verified", sha=sha, logs=readiness["logs"])
    archive, baseline = backup(cfg)
    audit("backup_verified", archive=str(archive))
    new = dict(image=image, image_id=info["Id"], commit=sha, completed=utc(), guards=state["guards"], schema=baseline["schema"])
    transaction = dict(old=old, new=new, baseline=baseline, backup=str(archive), started=utc())
    atomic_json(STATE / "transaction.json", transaction)
    audit("switching_container", sha=sha, previous_sha=old.get("commit"))
    # Power loss/SIGKILL after this point leaves a durable transaction. Next
    # timer refuses to retry until an operator runs the explicit recovery.
    try:
        replace(image)
        health(cfg, info["Id"])
        after = snapshot(DATA)
        if not preserved(baseline, after):
            raise ManualRequired("Production data inventory changed unexpectedly; manual review required")
    except ManualRequired:
        raise
    except Exception:
        audit("rolling_back", sha=old.get("commit"))
        restore(cfg, old, baseline)
        (STATE / "transaction.json").unlink()
        raise RuntimeError("New release failed; previous image restored and checked")
    state.update(current=new, previous=old)
    atomic_json(STATE / "state.json", state)
    (STATE / "transaction.json").unlink()
    audit("deployed", sha=sha, backup=str(archive))
    try:
        trim(cfg, state)
    except Exception:
        audit("retention_cleanup_failed", action="check_disk_and_journal")
    return "deployed"


def tick(cfg, retry=False):
    if (STATE / "blocked.json").exists() or (STATE / "transaction.json").exists():
        return
    if not QUEUE.exists():
        return
    request = read_json(QUEUE, limit=4096)
    if (not isinstance(request, dict) or not isinstance(request.get("sha"), str) or not SHA.fullmatch(request["sha"])
            or request["sha"] == "0" * 40 or not isinstance(request.get("id"), str) or not re.fullmatch(r"[0-9a-f]{32}", request["id"])):
        raise ValueError("Invalid queue envelope")
    state = read_json(STATE / "state.json")
    if state.get("processed_id") == request["id"] and not retry:
        return
    result = "failed"
    try:
        result = deploy(cfg, request, state)
    except Exception as error:
        result = "manual_required" if isinstance(error, ManualRequired) or (STATE / "transaction.json").exists() else "failed"
        audit(result, sha=request["sha"], reason=str(error))
        if result == "manual_required":
            atomic_json(STATE / "blocked.json", dict(time=utc(), reason=str(error), request=request))
    finally:
        try:
            run(["docker", "buildx", "stop", BUILDER])
        except Exception:
            pass
        state.update(processed_id=request["id"], last_result=result, last_event_sha=request["sha"], finished=utc())
        atomic_json(STATE / "state.json", state)
        audit("event_finished", id=request["id"], sha=request["sha"], result=result)


def escape_compose(value):
    if isinstance(value, dict):
        return {key: escape_compose(item) for key, item in value.items()}
    if isinstance(value, list):
        return [escape_compose(item) for item in value]
    return value.replace("$", "$$") if isinstance(value, str) else value


def equivalent_initial_package(host, candidate):
    # Only the two exact local maintenance commands may differ at bootstrap.
    # Dependencies, runtime/build scripts and all other metadata stay strict.
    expected = {
        "test:deploy": "python -m unittest discover -s tests -p test_auto_deploy.py -v",
        "audit:repo": "python scripts/audit-repository.py",
    }
    left, right = copy.deepcopy(host), copy.deepcopy(candidate)
    for value in (left, right):
        scripts = value.get("scripts", {})
        for name, command in expected.items():
            if name in scripts:
                if scripts[name] != command:
                    return False
                del scripts[name]
    return left == right


def adopt(cfg):
    if (STATE / "state.json").exists():
        raise ManualRequired("Already adopted. Do not overwrite rollback history")
    sha = fetch(cfg)
    with tempfile.TemporaryDirectory(prefix="adopt-", dir=STATE) as temporary:
        tree = Path(temporary)
        export(cfg, sha, tree)
        # The business source on the existing host must match Gitee, accounting
        # for Windows line endings. No claim is made about a legacy image SHA.
        business = ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.server.json", "vite.config.ts", "index.html"]
        business += [p.relative_to(tree).as_posix() for directory in ("server", "shared", "src") for p in (tree / directory).rglob("*") if p.is_file()]
        for name in business:
            host = Path(cfg["project_dir"]) / name
            if name == "package.json" and host.is_file():
                matches = equivalent_initial_package(read_json(host), read_json(tree / name))
            else:
                matches = host.is_file() and host.read_bytes().replace(b"\r\n", b"\n") == (tree / name).read_bytes().replace(b"\r\n", b"\n")
            if not matches:
                raise ManualRequired("Existing business source differs from Gitee: " + name)
        frozen = json.loads(run(["docker", "compose", "--project-directory", cfg["project_dir"], "-f", "/opt/mstar/compose.yaml", "config", "--format", "json"]))
        if frozen.get("name") != "mstar":
            raise ManualRequired("Expected existing Compose project mstar")
        frozen["services"]["workbench"].pop("build", None)
        atomic_json(ETC / "compose.json", escape_compose(frozen))
        info = live()
        health(cfg, info["Image"])
        tag = "mstar-workbench:adopt-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        run(["docker", "image", "tag", info["Image"], tag])
        guards = guard_hashes(tree)
        state = dict(current=dict(image=tag, image_id=info["Image"], commit=None, completed=utc(), schema=snapshot(DATA)["schema"], guards=guards),
                     previous=None, baseline_source_sha=sha, guards=guards, last_result="adopted")
        atomic_json(STATE / "state.json", state)
        try:
            archive, _ = backup(cfg)
        except Exception:
            (STATE / "state.json").unlink()
            raise
        audit("adopted_existing_image", baseline_source_sha=sha, image_id=info["Image"], backup=str(archive), commit="unknown_until_first_deploy")


def activate_proxy(cfg):
    frozen = read_json(ETC / "compose.json")
    proxy = copy.deepcopy(frozen)
    volumes = proxy["services"]["caddy"]["volumes"]
    target = next(v for v in volumes if v["target"] == "/etc/caddy/Caddyfile")
    target["source"] = str(ETC / "Caddyfile")
    volumes.append(dict(type="bind", source="/run/mstar-hook", target="/run/mstar-hook", read_only=True, bind=dict(create_host_path=False)))
    atomic_json(ETC / "proxy.json", proxy)
    # compose run inherits the live service's static IP and collides with the
    # running proxy. Validate the exact current image without a network or ports.
    cid = compose("ps", "--quiet", "caddy")
    image = json.loads(run(["docker", "inspect", cid]))[0]["Image"]
    run(["docker", "run", "--rm", "--network", "none", "--read-only",
         "--tmpfs", "/tmp:rw,noexec,nosuid,size=8m", "--tmpfs", "/data:rw,noexec,nosuid,size=8m",
         "--tmpfs", "/config:rw,noexec,nosuid,size=8m", "--memory", "96m", "--cpus", "0.5",
         "--env", "DOMAIN=mstar.chat", "--volume", str(ETC / "Caddyfile") + ":/etc/caddy/Caddyfile:ro",
         image, "caddy", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"], capture=False)
    try:
        compose("up", "-d", "--no-deps", "--no-build", "--pull", "never", "caddy", proxy=True, capture=False)
        health(cfg)
    except Exception:
        compose("up", "-d", "--no-deps", "--no-build", "--pull", "never", "caddy", capture=False)
        raise
    audit("proxy_activated", action="enable_webhook_after_verification")


def show_status():
    # Atomic read-only status must remain usable while the deployment holds its
    # exclusive lock. The live immutable ID also exposes any manual drift.
    if (STATE / "state.json").exists():
        state = read_json(STATE / "state.json")
        compact = {key: value for key, value in state.items() if key != "guards"}
        for key in ("current", "previous"):
            if compact.get(key):
                compact[key] = {k: v for k, v in compact[key].items() if k != "guards"}
        print(json.dumps(compact, ensure_ascii=True, indent=2))
    if (STATE / "blocked.json").exists():
        print("blocked=" + json.dumps(read_json(STATE / "blocked.json")))
    print("interrupted_transaction=" + str((STATE / "transaction.json").exists()))
    print("live_image_id=" + live()["Image"])


def rebaseline(cfg):
    """Operator only, AFTER a separately reviewed/manual production upgrade.

    Cannot approve an unbuilt candidate or perform migrations. Requires that the
    current healthy container already carries the actual main commit label.
    """
    if (STATE / "transaction.json").exists():
        raise ManualRequired("Resolve interrupted transaction before rebaseline")
    state = read_json(STATE / "state.json")
    sha = fetch(cfg)
    info = live()
    if info["Config"].get("Labels", {}).get("org.opencontainers.image.revision") != sha:
        raise ManualRequired("Manual release is not already running the verified main commit")
    health(cfg, info["Image"])
    archive, baseline = backup(cfg)
    with tempfile.TemporaryDirectory(prefix="reviewed-", dir=STATE) as temporary:
        export(cfg, sha, Path(temporary))
        guards = guard_hashes(Path(temporary))
    tag = "mstar-workbench:git-" + sha
    run(["docker", "image", "tag", info["Image"], tag])
    current = dict(image=tag, image_id=info["Image"], commit=sha, completed=utc(), schema=baseline["schema"], guards=guards)
    previous = state["current"] if state["current"]["image_id"] != info["Image"] else state.get("previous")
    state.update(current=current, previous=previous, guards=guards, last_result="operator_rebaseline")
    atomic_json(STATE / "state.json", state)
    # Explicit unblock remains separate, so baseline review cannot launch a job.
    atomic_json(STATE / "blocked.json", dict(time=utc(), reason="operator_rebaseline; inspect then unblock"))
    audit("operator_rebaseline_completed", sha=sha, backup=str(archive))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("tick", "status", "adopt", "activate-proxy", "retry", "recover", "rollback", "unblock", "rescue", "rebaseline"))
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit("Run using sudo")
    os.umask(0o077)
    STATE.mkdir(mode=0o700, exist_ok=True)
    if args.action == "status":
        show_status()
        return
    with open("/run/lock/mstar-deploy.lock", "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        cfg = config()
        if args.action == "adopt":
            adopt(cfg)
        elif args.action == "activate-proxy":
            activate_proxy(cfg)
        elif args.action == "rebaseline":
            rebaseline(cfg)
        elif args.action in ("tick", "retry"):
            tick(cfg, retry=args.action == "retry")
        elif args.action == "rescue":
            if (STATE / "transaction.json").exists():
                atomic_json(STATE / "blocked.json", dict(time=utc(), reason="interrupted_switch; operator recover required"))
            elif (STATE / "state.json").exists():
                state = read_json(STATE / "state.json")
                info = live()
                if not info["State"]["Running"] and info["Image"] == state["current"]["image_id"]:
                    compose("start", "--wait", "--wait-timeout", "180", "workbench", capture=False)
                    health(cfg, info["Image"])
                    audit("backup_interruption_resumed_previous_application")
        elif args.action == "unblock":
            if (STATE / "transaction.json").exists():
                raise ManualRequired("Recover transaction before unblocking")
            (STATE / "blocked.json").unlink(missing_ok=True)
            audit("operator_unblocked")
        elif args.action == "recover":
            transaction = read_json(STATE / "transaction.json", limit=128 * 1024 * 1024)
            restore(cfg, transaction["old"], transaction["baseline"])
            state = read_json(STATE / "state.json")
            state["current"] = transaction["old"]
            state["last_result"] = "operator_recovered"
            atomic_json(STATE / "state.json", state)
            (STATE / "transaction.json").unlink()
            atomic_json(STATE / "blocked.json", dict(time=utc(), reason="operator_recovered; inspect then unblock"))
            audit("operator_recovered", action="inspect_then_unblock")
        elif args.action == "rollback":
            if (STATE / "transaction.json").exists():
                raise ManualRequired("Use recover for interrupted deployment")
            state = read_json(STATE / "state.json")
            previous = state.get("previous")
            if not previous or previous.get("guards") != state["guards"]:
                raise ManualRequired("No compatible previous image")
            baseline = snapshot(DATA)
            if previous.get("schema") != baseline["schema"]:
                raise ManualRequired("Database schema differs from previous image's verified schema")
            archive, _ = backup(cfg)
            atomic_json(STATE / "transaction.json", dict(old=state["current"], new=previous, baseline=baseline, backup=str(archive)))
            restore(cfg, previous, baseline)
            state.update(current=previous, previous=state["current"], last_result="operator_rollback")
            atomic_json(STATE / "state.json", state)
            (STATE / "transaction.json").unlink()
            # A manual rollback must not be undone by a queued event.
            atomic_json(STATE / "blocked.json", dict(time=utc(), reason="operator_rollback; review before unblock"))
            audit("operator_rollback_completed")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        audit("controller_failed", reason=str(error))
        raise SystemExit(1)
