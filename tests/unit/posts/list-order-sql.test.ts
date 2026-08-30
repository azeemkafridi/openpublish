/**
 * Renders the REAL SQL drizzle generates for the GET /api/posts page query and
 * asserts the ordering is valid Postgres that carries no bound parameters.
 *
 * Why this exists: every other test mocks `@lib/db`, so they validate our JS
 * and nothing about the SQL. This query orders
 * by a `sql` fragment; if that fragment ever interpolated a VALUE rather than
 * column references, drizzle would emit a fresh placeholder per use and the
 * numbering would shift under the WHERE clause's parameters.
 *
 * The ordering itself is the fix for scheduled posts vanishing from the
 * Published tab: sorted by createdAt alone, a post written Jul 16 and published
 * Aug 1 sorted among Jul 16 posts, 92 rows down the list.
 *
 * No database is needed — `.toSQL()` renders the statement offline.
 */
import { describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql, eq, and, desc, inArray } from 'drizzle-orm';
import { posts } from '@lib/db/schema';

// Query builder only; nothing is executed, so the client never gets called.
const db = drizzle({ client: { query: async () => ({ rows: [] }) } as never });

/** Mirrors POST_TIMELINE_ORDER in webapp/src/pages/api/posts/index.ts. */
const POST_TIMELINE_ORDER = sql`COALESCE(${posts.publishedAt}, ${posts.scheduledAt}, ${posts.createdAt}) DESC`;

function renderPageQuery() {
  return db
    .select()
    .from(posts)
    .where(
      and(
        eq(posts.organizationId, 5),
        inArray(posts.status, ['published', 'partial'] as never),
      ),
    )
    .orderBy(POST_TIMELINE_ORDER, desc(posts.id))
    .limit(20)
    .offset(0)
    .toSQL();
}

describe('GET /api/posts page ordering SQL', () => {
  it('orders by COALESCE(published_at, scheduled_at, created_at) DESC then id DESC', () => {
    const { sql: rendered } = renderPageQuery();

    expect(rendered).toContain(
      'order by COALESCE("posts"."published_at", "posts"."scheduled_at", "posts"."created_at") DESC',
    );
    expect(rendered).toMatch(/order by COALESCE\([^)]*\) DESC, "posts"\."id" desc/);
  });

  it('the ordering fragment binds no parameters', () => {
    // If the ORDER BY fragment ever interpolated a value, its placeholder would
    // land between the WHERE clause's and limit/offset's, shifting the numbering
    // of everything after it.
    const { sql: rendered, params } = renderPageQuery();

    const orderBy = rendered.slice(rendered.indexOf('order by'), rendered.indexOf(' limit '));
    expect(orderBy).not.toMatch(/\$\d/);
    // org id, the two status values, then the limit — nothing from the ordering.
    // (drizzle omits `offset 0` entirely, so it contributes no parameter here.)
    expect(params).toEqual([5, 'published', 'partial', 20]);
  });

  it('references real columns, not aliases that could go stale', () => {
    const { sql: rendered } = renderPageQuery();
    expect(rendered).toContain('"posts"."published_at"');
    expect(rendered).toContain('"posts"."scheduled_at"');
    expect(rendered).toContain('"posts"."created_at"');
  });
});

export {};
