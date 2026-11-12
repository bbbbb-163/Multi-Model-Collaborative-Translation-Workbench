#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo 'Run with: sudo bash deploy/install-docker-ubuntu.sh' >&2
  exit 1
fi
. /etc/os-release
if [[ ${ID} != ubuntu || ! ${VERSION_ID} =~ ^(22\.04|24\.04)$ ]]; then
  echo 'This installer supports Ubuntu 22.04 and 24.04 only.' >&2
  exit 1
fi
if command -v docker >/dev/null 2>&1; then
  docker compose version
  echo 'Docker is already installed. Existing installation was not changed.'
  exit 0
fi
for package in docker.io docker-compose docker-compose-v2 podman-docker containerd runc; do
  if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
    echo "Existing package $package found. Follow the official Docker migration instructions first." >&2
    exit 1
  fi
done

apt-get update
apt-get install -y ca-certificates curl python3
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker compose version
echo 'Docker installed. Continue with DEPLOYMENT.md.'
