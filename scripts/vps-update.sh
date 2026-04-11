#!/usr/bin/env bash
# Pull latest main on the VPS and rebuild/restart Meridian (Docker).
#
# From your laptop (repo root):
#   export VPS_HOST='user@your.vps.host'
#   export VPS_PATH='/path/to/dlmm-agent'   # directory that contains docker-compose.yml
#   bash scripts/vps-update.sh
#
# Requires SSH key access to VPS_HOST; Docker Compose v2 on the server.

set -euo pipefail
: "${VPS_HOST:?Set VPS_HOST, e.g. export VPS_HOST=user@203.0.113.10}"
: "${VPS_PATH:?Set VPS_PATH to the meridian repo on the server, e.g. export VPS_PATH=~/dlmm-agent}"

ssh -o BatchMode=yes "$VPS_HOST" "set -euo pipefail
  cd \"$VPS_PATH\"
  git fetch origin
  git pull origin main
  docker compose up -d --build
  docker compose ps
  echo '--- last logs ---'
  docker compose logs --tail=60 meridian
"
