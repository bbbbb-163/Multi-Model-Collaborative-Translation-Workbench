#!/usr/bin/env bash
# Fingerprint MUST come from a separately verified Gitee support/admin channel.
set -euo pipefail
umask 077
[[ ${EUID} -eq 0 && $# -eq 1 && $1 =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]] || { echo 'Use sudo bash deploy/trust-gitee-host.sh VERIFIED_SHA256_FINGERPRINT'; exit 1; }
[[ -d /etc/mstar-deploy ]] || { echo 'Install first.'; exit 1; }
[[ ! -e /etc/mstar-deploy/known_hosts ]] || { echo 'Trust file exists. Review rotation procedure; refusing overwrite.'; exit 1; }
temporary=$(mktemp)
selected=$(mktemp)
trap 'rm -f -- "$temporary" "$selected"' EXIT
ssh-keyscan -T 15 -t ed25519,ecdsa,rsa gitee.com > "$temporary" 2>/dev/null
while IFS= read -r line; do
  printf '%s\n' "$line" > "$selected"
  fingerprint=$(ssh-keygen -lf "$selected" -E sha256 | awk '{print $2}')
  if [[ $fingerprint == "$1" ]]; then
    install -m 0600 -o root -g root "$selected" /etc/mstar-deploy/known_hosts
    echo "Pinned independently verified Gitee host fingerprint: $fingerprint"
    exit 0
  fi
done < "$temporary"
echo 'No scanned host key matched the verified fingerprint. Trust NOT installed.' >&2
exit 1
