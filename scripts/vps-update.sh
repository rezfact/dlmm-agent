#!/usr/bin/env bash
# Pull latest main on the VPS, optionally sync user-config.json, then rebuild/restart Meridian (Docker).
#
# From your laptop (repo root):
#   export VPS_HOST='user@your.vps.host'
#   export VPS_PATH='/path/to/meridian'   # directory that contains docker-compose.yml
#   bash scripts/vps-update.sh
#
# Optional — push a local JSON to the server volume before restart (host path = $VPS_PATH/meridian-data/):
#   export MERIDIAN_USER_CONFIG_LOCAL="$PWD/vps_backup/user-config.json"   # explicit
#   # If unset and ./vps_backup/user-config.json exists, that file is synced automatically.
#
# Requires SSH key access to VPS_HOST; Docker Compose v2 on the server.

set -euo pipefail
: "${VPS_HOST:?Set VPS_HOST, e.g. export VPS_HOST=user@203.0.113.10}"
: "${VPS_PATH:?Set VPS_PATH to the meridian repo on the server, e.g. export VPS_PATH=~/dlmm-agent}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CONFIG_LOCAL="${MERIDIAN_USER_CONFIG_LOCAL:-}"
if [[ -z "$CONFIG_LOCAL" && -f "$ROOT/vps_backup/user-config.json" ]]; then
  CONFIG_LOCAL="$ROOT/vps_backup/user-config.json"
fi

if [[ -n "$CONFIG_LOCAL" ]]; then
  if [[ ! -f "$CONFIG_LOCAL" ]]; then
    echo "MERIDIAN_USER_CONFIG_LOCAL is set but not a file: $CONFIG_LOCAL" >&2
    exit 1
  fi
  echo "scp: $CONFIG_LOCAL -> $VPS_HOST:$VPS_PATH/meridian-data/user-config.json"
  ssh -o BatchMode=yes "$VPS_HOST" "mkdir -p \"$VPS_PATH/meridian-data\""
  scp -o BatchMode=yes "$CONFIG_LOCAL" "$VPS_HOST:$VPS_PATH/meridian-data/user-config.json"
fi

ssh -o BatchMode=yes "$VPS_HOST" "set -euo pipefail
  cd \"$VPS_PATH\"
  git fetch origin
  git pull origin main
  docker compose up -d --build
  docker compose ps
  echo '--- last logs ---'
  docker compose logs --tail=60 meridian
"
