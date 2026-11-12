#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd -- "$project_dir"

if [[ ${EUID} -ne 0 ]]; then
  echo 'Run with: sudo bash deploy/start.sh' >&2
  exit 1
fi
exec 9>/run/lock/mstar-deploy.lock
flock -n 9 || { echo 'Another deployment/backup is active.' >&2; exit 1; }
if [[ -f /var/lib/mstar-deploy/state.json ]]; then
  echo 'Automatic deployment has taken over. See deploy/GITEE_AUTO_DEPLOY.md; do not rebuild a rollback tag.' >&2
  exit 1
fi
if [[ ! -f .env ]]; then
  echo 'First copy .env.example to .env and review DOMAIN.' >&2
  exit 1
fi
docker compose version
docker compose config --quiet

# Resolve the bind mount without executing .env as shell code.
# The image's application user is UID/GID 1000.
data_dir=$(docker compose config --format json | python3 -c 'import json,sys; c=json.load(sys.stdin); print(next(v["source"] for v in c["services"]["workbench"]["volumes"] if v["target"]=="/app/.data"))')
if [[ ! -d $data_dir ]]; then
  install -d -m 0700 -o 1000 -g 1000 -- "$data_dir"
fi
if [[ $(stat -c '%u:%g' -- "$data_dir") != '1000:1000' ]]; then
  echo "Data directory must belong to UID/GID 1000:1000: $data_dir" >&2
  echo 'Check the directory before changing ownership. Existing data was not modified.' >&2
  exit 1
fi

# Validate proxy configuration before replacing a running application.
docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose build --pull workbench
docker compose up -d --wait --wait-timeout 180
docker compose ps
echo 'Containers started. Run the public HTTPS checks in DEPLOYMENT.md.'
