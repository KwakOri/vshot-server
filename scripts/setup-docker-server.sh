#!/usr/bin/env bash

set -Eeuo pipefail

if [ "${EUID}" -ne 0 ]; then
  echo "Please run as root or with sudo" >&2
  exit 1
fi

DEPLOY_USER="${DEPLOY_USER:-vshot}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/vshot}"

echo "Installing Docker for VShot"
echo "  Deploy user: ${DEPLOY_USER}"
echo "  Deploy path: ${DEPLOY_PATH}"

if ! command -v docker >/dev/null 2>&1; then
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://get.docker.com -o "$installer"
  sh "$installer"
fi

systemctl enable --now docker

if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi

if ! getent group docker >/dev/null 2>&1; then
  groupadd docker
fi

usermod -aG docker "$DEPLOY_USER"
install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_PATH"

if [ ! -f "$DEPLOY_PATH/.env.production" ]; then
  install -m 0600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /dev/null "$DEPLOY_PATH/.env.production"
  echo "Created empty $DEPLOY_PATH/.env.production"
else
  chmod 0600 "$DEPLOY_PATH/.env.production"
fi

docker compose version
echo "Docker setup complete. Log in to GHCR before the first pull."
