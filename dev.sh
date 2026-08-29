#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

ENV_NAME="${NODE_ENV:-development}"
SKIP_MIGRATE=0
PASS_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env=*)        ENV_NAME="${1#*=}"; shift ;;
    --env)          ENV_NAME="${2:?--env requires a value}"; shift 2 ;;
    --skip-migrate) SKIP_MIGRATE=1; shift ;;
    --)             shift; PASS_ARGS+=("$@"); break ;;
    *)              PASS_ARGS+=("$1"); shift ;;
  esac
done

export NODE_ENV="$ENV_NAME"

# Cascade env files (last wins): .env → .env.<env> → .env.local → .env.<env>.local
ENV_FILES=(
  ".env"
  ".env.${ENV_NAME}"
  ".env.local"
  ".env.${ENV_NAME}.local"
)

LOADED=()
for file in "${ENV_FILES[@]}"; do
  full="$SCRIPT_DIR/$file"
  if [[ -f "$full" ]]; then
    set -a; source "$full"; set +a
    LOADED+=("$file")
  fi
done

if [[ ${#LOADED[@]} -eq 0 ]]; then
  echo "[dev] WARNING: no env files found at $SCRIPT_DIR" >&2
  echo "[dev]   looked for: ${ENV_FILES[*]}" >&2
else
  echo "[dev] env=$ENV_NAME loaded: ${LOADED[*]}"
fi

PORT="${PORT:-4321}"

# If BASE_URL points at ngrok, verify the agent is running locally — otherwise
# better-auth sets cookies scoped to the ngrok host and they won't stick when
# you actually browse via http://localhost:$PORT. When the agent is up we also
# honour the live tunnel URL in case it differs from the configured one.
if [[ "${BASE_URL:-}" =~ ngrok ]]; then
  if tunnel_json="$(curl --silent --max-time 1 --fail http://127.0.0.1:4040/api/tunnels 2>/dev/null)"; then
    live_url="$(printf '%s' "$tunnel_json" | grep -oE '"public_url"[[:space:]]*:[[:space:]]*"https://[^"]*"' | head -1 | sed -E 's|.*"(https://[^"]*)".*|\1|')"
    if [[ -n "$live_url" && "$live_url" != "${BASE_URL%/}" ]]; then
      echo "[dev] ngrok agent up — overriding BASE_URL=$BASE_URL → $live_url"
      export BASE_URL="$live_url"
    else
      echo "[dev] ngrok agent up — BASE_URL=$BASE_URL"
    fi
  else
    echo "[dev] ngrok agent not running — falling back to BASE_URL=http://localhost:$PORT"
    export BASE_URL="http://localhost:$PORT"
  fi
fi

if [[ "$SKIP_MIGRATE" -eq 0 ]]; then
  echo "[dev] Running DB migrations..."
  cd "$SCRIPT_DIR"
  # Same runner production uses, so local and prod can never diverge in behaviour.
  # If your dev DB predates the migrate cutover it will refuse and tell you to run
  # `npm run db:baseline` once.
  node scripts/db-migrate.mjs
fi

echo "[dev] Starting dev server on http://localhost:$PORT ..."
cd "$SCRIPT_DIR"
exec npm run dev -- --port "$PORT" ${PASS_ARGS[@]+"${PASS_ARGS[@]}"}
