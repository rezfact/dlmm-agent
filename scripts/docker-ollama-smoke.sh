#!/usr/bin/env sh
# Smoke-test Meridian → Ollama in Docker (see docker-compose.ollama-smoke.yml).
set -e
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# Project name avoids clashing with your main `docker compose` meridian stack.
COMPOSE="docker compose -p meridian-ollama-smoke -f docker-compose.ollama-smoke.yml"

echo "==> Starting Ollama..."
$COMPOSE up -d ollama

echo "==> Waiting for Ollama API (localhost:11434)..."
i=0
while [ "$i" -lt 60 ]; do
  if curl -sf "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

echo "==> Pulling qwen2.5:3b (first run can take several minutes)..."
$COMPOSE exec -T ollama ollama pull qwen2.5:3b

echo "==> Running npm run test:ollama inside Meridian image..."
$COMPOSE run --rm meridian-smoke

echo "OK — docker Ollama smoke passed."
