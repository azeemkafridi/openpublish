#!/bin/sh
set -e

MODE="${APP_MODE:-web}"

# Every mode runs the migrator. It is safe to run concurrently: scripts/db-migrate.mjs
# takes a Postgres advisory lock, so web and worker (which deploy simultaneously from
# the same image) serialise instead of racing, and the worker no longer boots against a
# database the web container has not finished migrating yet.
#
# This replaced `drizzle-kit push --force`. `push` diffs schema.ts against the live DB,
# keeps no ledger, applies DDL non-transactionally, and — the reason it had to go —
# silently declines changes it does not like. On 2026-07-25 it left prod without
# `posts.approval_status` and every /api/posts query 500'd; as late as 2026-07-26 prod
# was still missing the whole `channel_sets` table while the deployed code queried it.
# Nothing recorded either fact, because there was nothing to record it in.
#
# `migrate` applies numbered files in order inside ONE transaction and writes
# drizzle.__drizzle_migrations. A failure is non-zero and `set -e` stops the container:
# crash-looping is loud and recoverable, a half-migrated app serving traffic is not.
echo "[entrypoint] Running database migrations (APP_MODE=$MODE)..."
node scripts/db-migrate.mjs
echo "[entrypoint] Migrations complete."

case "$MODE" in
  web)
    echo "[entrypoint] Starting web server on port ${PORT:-4321}..."
    exec node ./server.mjs
    ;;
  worker)
    echo "[entrypoint] Starting background workers..."
    exec node --import tsx ./workers/entry.ts
    ;;
  all)
    echo "[entrypoint] Starting workers in background..."
    node --import tsx ./workers/entry.ts &
    WORKER_PID=$!
    echo "[entrypoint] Starting web server on port ${PORT:-4321}..."
    node ./server.mjs &
    WEB_PID=$!
    # Wait for either to exit
    wait -n $WORKER_PID $WEB_PID
    echo "[entrypoint] A process exited, shutting down..."
    kill $WORKER_PID $WEB_PID 2>/dev/null || true
    wait
    ;;
  *)
    echo "[entrypoint] Unknown APP_MODE: $MODE (use web, worker, or all)"
    exit 1
    ;;
esac
