/**
 * Renders the REAL SQL drizzle generates for the analytics day-bucketing query
 * and asserts it is valid Postgres.
 *
 * Why this exists: every other test in this suite mocks `@lib/db`, so they
 * validate our JS and nothing about the SQL. A tz bound as a parameter shipped
 * to production and 500'd on every Overview load — drizzle emits a FRESH
 * placeholder each time a `sql` fragment is interpolated, so the same fragment
 * became `AT TIME ZONE $1` in SELECT and `$9` in GROUP BY. Postgres compares
 * grouped expressions textually, decided they differed, and rejected the query:
 *   column "posts.published_at" must appear in the GROUP BY clause
 *
 * No database is needed — `.toSQL()` renders the statement offline.
 */
import { describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql, eq, and, count } from 'drizzle-orm';
import { posts } from '@lib/db/schema';

// Query builder only; nothing is executed, so the client never gets called.
const db = drizzle({ client: { query: async () => ({ rows: [] }) } as never });

/** Mirrors webapp/src/pages/api/analytics/summary.ts. */
function buildDayExpr(tz: string) {
  const activityAt = sql`COALESCE(${posts.publishedAt}, ${posts.createdAt})`;
  return sql`(${activityAt} AT TIME ZONE ${sql.raw(`'${tz}'`)})::date`;
}

function renderByDayQuery(tz: string): string {
  const activityDay = buildDayExpr(tz);
  return db
    .select({ date: sql<string>`${activityDay}`.as('date'), count: count() })
    .from(posts)
    .where(and(eq(posts.organizationId, 1), sql`${activityDay} >= ${'2026-07-01'}::date`))
    .groupBy(sql`${activityDay}`)
    .orderBy(sql`${activityDay}`)
    .toSQL().sql;
}

describe('analytics summary day-bucketing SQL', () => {
  it('never parameterizes the timezone', () => {
    const text = renderByDayQuery('Asia/Karachi');

    // `AT TIME ZONE $n` is the exact shape that broke production: each
    // interpolation gets its own placeholder number.
    expect(text).not.toMatch(/AT TIME ZONE \$\d/);
    expect(text).toContain("AT TIME ZONE 'Asia/Karachi'");
  });

  it('renders an identical day expression in SELECT, GROUP BY and ORDER BY', () => {
    const text = renderByDayQuery('Asia/Karachi');
    const dayExpr =
      '(COALESCE("posts"."published_at", "posts"."created_at") AT TIME ZONE \'Asia/Karachi\')::date';

    // Postgres matches grouped expressions textually — if these diverge it
    // rejects the query at runtime, which mocked tests cannot see.
    const occurrences = text.split(dayExpr).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });

  it('still binds ordinary values as parameters (no accidental inlining)', () => {
    const text = renderByDayQuery('UTC');

    // Only the validated tz literal is inlined; org id and dates stay bound.
    expect(text).toMatch(/"posts"\."organization_id" = \$\d/);
    expect(text).toMatch(/\$\d::date/);
  });
});

export {};
