#!/usr/bin/env bash
# Read-only inventory. Deliberately does not display .env, keys or account rows.
set -euo pipefail
cd /opt/mstar
uname -sr
free -m
swapon --show --bytes
df -Pm /opt/mstar /var/lib/docker
docker version --format '{{.Server.Version}}'
docker compose version
docker buildx version
docker compose ps
for service in workbench caddy; do
  cid=$(docker compose ps --quiet "$service")
  test -n "$cid"
  docker inspect --format '{{.Name}} image={{.Image}} project={{index .Config.Labels "com.docker.compose.project"}} state={{.State.Status}} mounts={{json .Mounts}}' "$cid"
done
docker volume inspect mstar_caddy_data mstar_caddy_config --format '{{.Name}} {{.Mountpoint}}'
stat -c '%a %u:%g %n' .env runtime/data runtime/data/workbench.sqlite runtime/data/vault.key
ss -lntp '( sport = :80 or sport = :443 or sport = :3210 )'
curl -fsS --max-time 15 https://mstar.chat/api/health
systemctl is-enabled docker
echo 'Read-only inspection complete. Review before approving installation/proxy switch.'
