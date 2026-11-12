#!/usr/bin/env bash
set -euo pipefail
umask 077
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
project_dir=${MSTAR_PROJECT_DIR:-$(cd -- "$script_dir/.." && pwd)}
cd -- "$project_dir"
if [[ ${EUID} -ne 0 ]]; then echo 'Run backup as root.' >&2; exit 1; fi
if [[ ${MSTAR_LOCK_HELD:-0} != 1 ]]; then
  exec 9>/run/lock/mstar-deploy.lock
  flock -n 9 || { echo 'Another deployment/backup is active.' >&2; exit 1; }
fi
compose=(docker compose --project-directory "$project_dir")
if [[ -n ${MSTAR_COMPOSE_FILE:-} ]]; then compose+=(-f "$MSTAR_COMPOSE_FILE"); fi
guard=${MSTAR_DATA_GUARD:-"$script_dir/auto/data_guard.py"}
[[ -f $guard ]] || { echo 'Missing backup integrity verifier.' >&2; exit 1; }
output_dir=${1:-"$project_dir/backups"}
mkdir -p -- "$output_dir"
output_dir=$(cd -- "$output_dir" && pwd)
archive="$output_dir/mstar-data-$(date -u +%Y%m%dT%H%M%SZ)-$$.tar.gz"
partial="${archive}.partial"

container_id=$("${compose[@]}" ps --all --quiet workbench)
if [[ -z $container_id ]]; then
  echo 'No workbench container exists; nothing to back up.' >&2
  exit 1
fi
data_dir=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/.data"}}{{.Source}}{{end}}{{end}}' "$container_id")
if [[ -z $data_dir || ! -f $data_dir/workbench.sqlite || ! -f $data_dir/vault.key ]]; then
  echo 'Expected database and vault.key were not found in the data mount.' >&2
  exit 1
fi
case "$output_dir/" in
  "$data_dir/"*) echo 'Backups must be outside the application data directory.' >&2; exit 1 ;;
esac
was_running=$(docker inspect --format '{{.State.Running}}' "$container_id")
resume=0
manifest_dir=$(mktemp -d)
cleanup() {
  local result=$?
  set +e
  trap - EXIT INT TERM
  if [[ -f $partial ]]; then rm -f -- "$partial"; fi
  rm -f -- "$manifest_dir/.mstar-backup-manifest.json"
  rmdir -- "$manifest_dir"
  if [[ $resume == 1 ]]; then
    if ! "${compose[@]}" start --wait --wait-timeout 180 workbench; then
      echo 'Backup finished but application restart failed. Run docker compose start workbench.' >&2
      result=1
    fi
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ $was_running == true ]]; then
  resume=1
  echo 'Stopping workbench briefly for a consistent database/files/vault backup.'
  "${compose[@]}" stop workbench
fi
python3 "$guard" snapshot-stopped "$data_dir" "$manifest_dir/.mstar-backup-manifest.json"
tar -C "$data_dir" -czf "$partial" . -C "$manifest_dir" .mstar-backup-manifest.json
tar -tzf "$partial" >/dev/null
python3 "$guard" verify "$partial"
mv -- "$partial" "$archive"
sha256sum "$archive" > "${archive}.sha256"
sha256sum -c "${archive}.sha256"
echo "Backup: $archive"
echo 'Contains private data and encryption key. Copy it to a protected location off this server.'
