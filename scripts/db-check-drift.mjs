#!/usr/bin/env node
/**
 * Fails if schema.ts contains changes that no migration file would produce.
 *
 * This is the guard that was missing. `api_usage_daily` (a whole table, PK, FK and two
 * indexes) and `posts.post_format` lived in schema.ts for months with no migration that
 * creates them. Nobody noticed, because production ran `drizzle-kit push` — which reads
 * schema.ts directly and therefore never needs the migration files to be correct. Any
 * environment built from migrations alone would have been silently missing them.
 *
 * How it works: `drizzle-kit generate` diffs schema.ts against the newest snapshot in
 * meta/. If they already agree it prints "No schema changes, nothing to migrate" and
 * writes nothing. If they disagree it writes a new .sql + snapshot — which in CI means
 * someone edited schema.ts without running `npm run db:generate`.
 *
 * Any file it created is removed before exiting, so this is safe to run anywhere.
 *
 * Exit codes: 0 = in sync, 1 = drift detected (or the check itself failed).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(here, '..', 'src', 'lib', 'db', 'migrations');
const META = path.join(MIGRATIONS, 'meta');

const snapshot = (dir) => new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);

const beforeSql = snapshot(MIGRATIONS);
const beforeMeta = snapshot(META);
const journalPath = path.join(META, '_journal.json');
const journalBefore = fs.readFileSync(journalPath, 'utf8');

let output = '';
let failed = false;
try {
  output = execFileSync('npx', ['drizzle-kit', 'generate', '--name=drift_check'], {
    cwd: path.join(here, '..'),
    encoding: 'utf8',
    // stdin ignored on purpose: generate prompts when it suspects a rename, and a
    // prompt with no answer must fail the check, never wait for one. The timeout is
    // the backstop so CI cannot hang if it ignores EOF.
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
} catch (err) {
  output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  failed = true;
}

// Roll back anything generate wrote, whatever the outcome.
const created = [
  ...[...snapshot(MIGRATIONS)].filter((f) => !beforeSql.has(f)).map((f) => path.join(MIGRATIONS, f)),
  ...[...snapshot(META)].filter((f) => !beforeMeta.has(f)).map((f) => path.join(META, f)),
];
for (const f of created) {
  if (fs.statSync(f).isFile()) fs.unlinkSync(f);
}
fs.writeFileSync(journalPath, journalBefore);

if (failed) {
  console.error('[db-check-drift] drizzle-kit generate failed:\n' + output);
  process.exit(1);
}

const newMigrations = created.filter((f) => f.endsWith('.sql'));
if (newMigrations.length > 0) {
  console.error(
    '[db-check-drift] DRIFT: schema.ts has changes with no migration file.\n' +
    `  drizzle-kit generated: ${newMigrations.map((f) => path.basename(f)).join(', ')}\n` +
    '  (the generated file was discarded — nothing was left behind)\n\n' +
    '  Fix: run `npm run db:generate` and commit the migration alongside your schema.ts change.\n' +
    '  A schema.ts edit without a migration only works because push reads schema.ts directly;\n' +
    '  every migrate-built database would be missing it.',
  );
  process.exit(1);
}

console.log('[db-check-drift] OK — schema.ts and the migration files agree.');
