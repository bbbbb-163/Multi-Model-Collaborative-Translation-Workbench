#!/usr/bin/env bash
# Run only after reviewing the production inspection and approving installation.
set -euo pipefail
umask 077
[[ ${EUID} -eq 0 ]] || { echo 'Use sudo bash deploy/install-auto-deploy.sh OWNER/REPO NUMERIC_REPO_ID'; exit 1; }
[[ $# -eq 2 ]] || { echo 'Supply the real Gitee owner/repo and numeric repository ID.'; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ $1 =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && $2 =~ ^[1-9][0-9]*$ ]] || exit 1
[[ ! -e /etc/mstar-deploy/config.json && ! -e /var/lib/mstar-deploy/state.json ]] || { echo 'Already installed; refusing to overwrite credentials/state.'; exit 1; }
for executable in python3 git docker curl flock ssh ssh-keygen ssh-keyscan systemctl; do command -v "$executable" >/dev/null; done
docker compose version
docker buildx version
test -s /opt/mstar/.env
test -s /opt/mstar/runtime/data/workbench.sqlite
test -s /opt/mstar/runtime/data/vault.key
curl -fsS --max-time 15 https://mstar.chat/api/health

# First change is a verified backup, with guaranteed application resume on errors.
MSTAR_PROJECT_DIR=/opt/mstar MSTAR_DATA_GUARD="$source_dir/deploy/auto/data_guard.py" \
  bash "$source_dir/deploy/backup.sh" /opt/mstar/backups

if ! id mstar-hook >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/mstar-hook --shell /usr/sbin/nologin mstar-hook
fi
[[ $(id -nG mstar-hook) == mstar-hook ]] || { echo 'Receiver account has unexpected groups (must not have docker/sudo).'; exit 1; }
install -d -m 0755 -o root -g root /usr/local/lib/mstar-deploy
install -d -m 0750 -o root -g mstar-hook /etc/mstar-deploy
install -d -m 0700 -o root -g root /var/lib/mstar-deploy
# Docker/Buildx client state must remain writable with ProtectHome=yes.
install -d -m 0700 -o root -g root /var/lib/mstar-deploy/docker /var/lib/mstar-deploy/docker/buildx
install -d -m 0700 -o mstar-hook -g mstar-hook /var/lib/mstar-hook
install -m 0644 -o root -g root "$source_dir"/deploy/auto/*.py "$source_dir"/deploy/auto/*.toml \
  "$source_dir/deploy/auto/Dockerfile.auto" "$source_dir/deploy/auto/config.example.json" /usr/local/lib/mstar-deploy/
install -m 0644 -o root -g root "$source_dir/.dockerignore" /usr/local/lib/mstar-deploy/dockerignore
install -m 0755 -o root -g root "$source_dir/deploy/backup.sh" /usr/local/lib/mstar-deploy/backup.sh
install -m 0644 -o root -g root "$source_dir/deploy/auto/Caddyfile" /etc/mstar-deploy/Caddyfile
install -m 0644 -o root -g root "$source_dir"/deploy/auto/*.service "$source_dir"/deploy/auto/*.timer /etc/systemd/system/
install -m 0644 -o root -g root "$source_dir/deploy/auto/mstar-hook.conf" /etc/tmpfiles.d/mstar-hook.conf
systemd-tmpfiles --create /etc/tmpfiles.d/mstar-hook.conf
python3 /usr/local/lib/mstar-deploy/configure.py "$1" "$2"
systemctl daemon-reload
systemctl enable docker
curl -fsS --max-time 15 https://mstar.chat/api/health
echo 'Installed only. Gitee trust/deploy public key, adoption, proxy activation and enablement remain explicit steps.'
echo 'Read deploy/GITEE_AUTO_DEPLOY.md. Existing .env, runtime/data and Caddy volumes retained.'
