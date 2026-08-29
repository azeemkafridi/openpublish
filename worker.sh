#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

ENV_NAME="${NODE_ENV:-development}"
PASS_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env=*) ENV_NAME="${1#*=}"; shift ;;
    --env)   ENV_NAME="${2:?--env requires a value}"; shift 2 ;;
    --)      shift; PASS_ARGS+=("$@"); break ;;
    *)       PASS_ARGS+=("$1"); shift ;;
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
  echo "[worker] WARNING: no env files found at $SCRIPT_DIR" >&2
  echo "[worker]   looked for: ${ENV_FILES[*]}" >&2
else
  echo "[worker] env=$ENV_NAME loaded: ${LOADED[*]}"
fi

# Match dev.sh: if BASE_URL is an ngrok URL but the agent isn't running, fall
# back to localhost so anything that emits a URL (reset-password emails, etc)
# uses an address the developer can actually open.
PORT="${PORT:-4321}"
if [[ "${BASE_URL:-}" =~ ngrok ]]; then
  if tunnel_json="$(curl --silent --max-time 1 --fail http://127.0.0.1:4040/api/tunnels 2>/dev/null)"; then
    live_url="$(printf '%s' "$tunnel_json" | grep -oE '"public_url"[[:space:]]*:[[:space:]]*"https://[^"]*"' | head -1 | sed -E 's/.*"(https://[^"]*)".*/\1/')"
    if [[ -n "$live_url" && "$live_url" != "${BASE_URL%/}" ]]; then
      echo "[worker] ngrok agent up — overriding BASE_URL=$BASE_URL → $live_url"
      export BASE_URL="$live_url"
    else
      echo "[worker] ngrok agent up — BASE_URL=$BASE_URL"
    fi
  else
    echo "[worker] ngrok agent not running — falling back to BASE_URL=http://localhost:$PORT"
    export BASE_URL="http://localhost:$PORT"
  fi
fi

cd "$SCRIPT_DIR"
exec npx tsx workers/entry.ts ${PASS_ARGS[@]+"${PASS_ARGS[@]}"}
