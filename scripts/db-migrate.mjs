#!/usr/bin/env node
/**
 * Database migration runner — the single entry point for schema changes.
 *
 * WHY THIS EXISTS
 * ---------------
 * Production used to deploy schema with `drizzle-kit push --force`. `push` diffs
 * schema.ts against the live DB and applies whatever it thinks is needed. It keeps
 * no ledger, so nothing records what ran, and when it silently declines a change
 * there is no trace at all. That is not hypothetical: on 2026-07-25 a deploy booted
 * against a DB missing `posts.approval_status` and every /api/posts query 500'd, and
 * as late as 2026-07-26 production was still missing the entire `channel_sets` table
 * while the deployed code queried it on every /api/channel-sets request.
 *
 * `migrate` fixes this: it applies numbered files in order, records each one in
 * drizzle.__drizzle_migrations, and — verified in drizzle-orm/pg-core/dialect.js —
 * wraps the whole pending set in ONE transaction. Either the deploy's schema change
 * lands completely or the DB is untouched and the container refuses to start.
 *
 * THE BASELINE PROBLEM
 * --------------------
 * A DB built by `push` has the tables but no ledger. Pointing `migrate` at it would
 * replay from 0000 and fail on "relation already exists". Such a DB must be baselined
 * once: record the migrations as applied without running them. This script refuses to
 * start rather than guess — run it with DRIZZLE_BASELINE=1 (`npm run db:baseline`)
 * deliberately, once per pre-existing database.
 *
 * Exit codes: 0 ok, 1 failure (never exit 0 on a failed migration — a half-migrated
 * app serving traffic is far worse than a crash-looping container).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.join(here, '..', 'src', 'lib', 'db', 'migrations');

// Arbitrary but fixed: serialises concurrent migrators (web + worker + a manual run)
// so two containers can never interleave DDL against the same database.
const ADVISORY_LOCK_KEY = 4820147326159283n;

const BASELINE = process.env.DRIZZLE_BASELINE === '1';

function log(msg) {
  console.log(`[db-migrate] ${msg}`);
}

function fail(msg) {
  console.error(`[db-migrate] FATAL: ${msg}`);
  process.exit(1);
}

/**
 * Local convenience: when run straight from a shell (`npm run db:baseline`) there is no
 * env cascade, unlike dev.sh. Load the same four files in the same order so a local
 * invocation behaves identically. Containers and CI already export DATABASE_URL, so this
 * never runs there — and it never overrides a variable that is already set.
 */
function loadLocalEnv() {
  const root = path.join(here, '..');
  const nodeEnv = process.env.NODE_ENV || 'development';
  const files = ['.env', `.env.${nodeEnv}`, '.env.local', `.env.${nodeEnv}.local`];
  for (const name of files) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let value = m[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

if (!process.env.DATABASE_URL) loadLocalEnv();

const url = process.env.DATABASE_URL;
if (!url) fail('DATABASE_URL is not set (and no .env file supplied one).');

const client = new pg.Client({ connectionString: url });

try {
  await client.connect();
} catch (err) {
  fail(`cannot connect to the database: ${err.message}`);
}

let locked = false;
try {
  await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY.toString()]);
  locked = true;

  const files = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  if (files.length === 0) fail(`no migration files found in ${MIGRATIONS_FOLDER}`);
  const knownHashes = new Set(files.map((f) => f.hash));

  // What does the ledger claim? Missing table => no ledger at all.
  let ledgerHashes = [];
  const present = await client.query(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present",
  );
  if (present.rows[0].present) {
    const rows = await client.query('SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id');
    ledgerHashes = rows.rows.map((r) => r.hash);
  }

  // Does the database already carry application tables?
  const { rows: [{ tables }] } = await client.query(`
    SELECT count(*)::int AS tables
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);

  // Ledger entries that match no file on disk mean the ledger describes a migration
  // set this checkout no longer has — i.e. the history was squashed. Replaying on top
  // of it would try to re-create existing objects.
  const foreign = ledgerHashes.filter((h) => !knownHashes.has(h));

  const state =
    ledgerHashes.length === 0 && tables === 0 ? 'fresh'
    : ledgerHashes.length === 0 ? 'no-ledger'
    : foreign.length > 0 ? 'stale-ledger'
    : 'ok';

  log(`ledger=${ledgerHashes.length} row(s), public schema has ${tables} table(s), ${files.length} migration file(s) on disk → ${state}`);

  const needsBaseline = state === 'no-ledger' || state === 'stale-ledger';

  if (needsBaseline && !BASELINE) {
    fail(
      state === 'no-ledger'
        ? 'this database has tables but no migration ledger — it predates the switch to\n' +
          '  `drizzle-kit migrate` (it was built by `push`).\n' +
          '  Running migrations now would replay from 0000 and fail on existing objects.\n' +
          '  Verify its schema matches the migration end-state, then baseline it ONCE:\n' +
          '      npm run db:baseline\n' +
          '  Refusing to start.'
        : `this database's ledger records ${foreign.length} migration(s) that no longer exist on disk.\n` +
          '  The migration history was squashed into a new baseline; the old ledger is meaningless.\n' +
          '  If this schema already matches the current migration end-state, re-baseline it ONCE:\n' +
          '      npm run db:baseline\n' +
          '  Refusing to start.',
    );
  }

  if (BASELINE) {
    if (state === 'fresh') {
      fail('DRIZZLE_BASELINE=1 on an empty database. Run a normal migration instead — it will build the schema from scratch.');
    }
    if (state === 'ok') {
      log(`already baselined against the current migration set (${ledgerHashes.length} row(s)) — nothing to do.`);
      process.exit(0);
    }

    // Record every migration as applied WITHOUT executing its SQL. Assumes the schema
    // already matches the migration end-state — verify that before running this.
    log(`baselining: recording ${files.length} migration(s) as already applied (no SQL will run).`);
    await client.query('BEGIN');
    await client.query('CREATE SCHEMA IF NOT EXISTS drizzle');
    await client.query(`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);
    // Drop the superseded ledger wholesale when re-baselining after a squash.
    await client.query('DELETE FROM drizzle.__drizzle_migrations');
    for (const f of files) {
      await client.query(
        'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
        [f.hash, f.folderMillis],
      );
    }
    await client.query('COMMIT');
    log('baseline complete. Re-run without DRIZZLE_BASELINE to apply any newer migrations.');
    process.exit(0);
  }

  log('applying migrations...');
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  const { rows: [{ applied: now }] } = await client.query(
    'SELECT count(*)::int AS applied FROM drizzle.__drizzle_migrations',
  );
  log(`done — ledger now records ${now} applied migration(s).`);
} catch (err) {
  console.error(err);
  fail(`migration failed: ${err.message}`);
} finally {
  if (locked) {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY.toString()]).catch(() => {});
  }
  await client.end().catch(() => {});
}
