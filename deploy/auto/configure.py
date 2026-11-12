"""Explicit operator action, called only by the first-install script."""
import json
import os
import secrets
import subprocess
import sys
from pathlib import Path
from common import REPO, atomic_json

repository, identifier = sys.argv[1:]
if not REPO.fullmatch(repository) or not identifier.isdigit() or int(identifier) <= 0:
    raise SystemExit("Supply actual owner/repo and positive numeric Gitee repository ID")
etc = Path("/etc/mstar-deploy")
if any((etc / name).exists() for name in ("config.json", "webhook.json", "gitee_ed25519")):
    raise SystemExit("Existing deployment credentials/config: refusing overwrite")
template = json.loads((Path(__file__).parent / "config.example.json").read_text())
template.update(repository=repository, repository_id=int(identifier), remote="git@gitee.com:" + repository + ".git")
atomic_json(etc / "config.json", template)
atomic_json(etc / "webhook.json", dict(repository=repository, repository_id=int(identifier), secret=secrets.token_hex(32)), mode=0o640)
import grp
os.chown(etc / "webhook.json", 0, grp.getgrnam("mstar-hook").gr_gid)
subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "mstar-gitee-readonly-deploy", "-f", str(etc / "gitee_ed25519")], check=True)
os.chmod(etc / "gitee_ed25519", 0o600)
print("Created dedicated Gitee deploy key and webhook secret in /etc/mstar-deploy. No service enabled.")
