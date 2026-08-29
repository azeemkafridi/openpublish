/**
 * Renders the REAL SQL drizzle generates for the auto-republish writes in
 * status-check.worker.ts and asserts it is the statement we verified against a
 * live Postgres (`PREPARE`d on bulkpublish-postgres-1 before shipping).
 *
 * Why this exists: `@lib/db` is mocked in every worker test, so those tests
 * prove the JS branches and nothing about the SQL. Two things here are only
 * checkable at the SQL level — the `retry_count = retry_count + 1` raw fragment
 * (it must reference the column, not a bound copy of a stale value) and the
 * conditional post claim's `RETURNING`, which is what makes the "only one job
 * enqueues a publish" guarantee work.
 *
 * No database is needed — `.toSQL()` renders the statement offline.
 */
import { describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql, eq, and, ne } from 'drizzle-orm';
import { postPlatforms, posts } from '@lib/db/schema';

// Query builder only; nothing is executed, so the client never gets called.
const db = drizzle({ client: { query: async () => ({ rows: [] }) } as never });

/** Mirrors the retryable-failure reset in status-check.worker.ts. */
function renderDeferQuery() {
  return db
    .update(postPlatforms)
    .set({
      status: 'pending',
      errorMessage: 'TikTok had a temporary problem.',
      platformPostId: null,
      retryCount: sql`${postPlatforms.retryCount} + 1`,
    })
    .where(eq(postPlatforms.id, 806))
    .toSQL();
}

/** Mirrors the atomic post claim in status-check.worker.ts. */
function renderClaimQuery() {
  return db
    .update(posts)
    .set({ status: 'publishing', updatedAt: new Date('2026-08-04T14:00:00Z') })
    .where(and(eq(posts.id, 539), ne(posts.status, 'publishing')))
    .returning({ id: posts.id })
    .toSQL();
}

describe('status-check auto-republish SQL', () => {
  it('increments retry_count from the column, not a bound value', () => {
    const { sql: text } = renderDeferQuery();

    // A read-modify-write in JS would race a concurrent retry; the increment
    // has to happen inside the statement.
    expect(text).toContain('"retry_count" = "post_platforms"."retry_count" + 1');
    expect(text).not.toMatch(/"retry_count" = \$\d/);
  });

  it('clears the spent publish id and resets the row to pending', () => {
    const { sql: text, params } = renderDeferQuery();

    expect(text).toContain('update "post_platforms" set');
    expect(text).toMatch(/"status" = \$\d/);
    // drizzle binds the null rather than inlining it — still clears the column.
    expect(text).toMatch(/"platform_post_id" = \$\d/);
    expect(params).toContain(null);
    // The message and row id stay bound — only the increment is raw.
    expect(params).toContain(806);
  });

  it('claims the post conditionally and returns the claimed row', () => {
    const { sql: text } = renderClaimQuery();

    // Without the `<>` guard two concurrently-failing platforms of one post
    // would each enqueue a publish job, publishing the post twice.
    expect(text).toContain('"status" <> $');
    expect(text).toMatch(/returning "id"$/);
  });
});
