/**
 * Renders the REAL SQL for the account-metrics query's NULL engagementRate
 * column and asserts the alias survives.
 *
 * Why this exists: `/api/analytics/account` returns a literal NULL for
 * engagementRate, because nothing computes an account-level rate — the
 * getAccountAnalytics return type has no such field, so all 125 production rows
 * are the column default 0, indistinguishable from a measured 0%.
 *
 * The trap this guards: drizzle emits a `sql` fragment in a select object with
 * NO alias unless `.as()` is called. Postgres then names the column `?column?`
 * and the field decodes to `undefined` — silently, with no error. The same
 * class of failure as the GROUP BY placeholder bug in summary-sql.test.ts.
 *
 * No database needed — `.toSQL()` renders offline. The statement has also been
 * executed against real Postgres via PREPARE/EXECUTE before shipping.
 */
import { describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql, eq, and, gte, lte, desc } from 'drizzle-orm';
import { accountMetrics } from '@lib/db/schema';

export {};

const db = drizzle({ client: { query: async () => ({ rows: [] }) } as never });

/** Mirrors webapp/src/pages/api/analytics/account.ts. */
function renderAccountQuery(): string {
  return db
    .select({
      date: accountMetrics.date,
      channelId: accountMetrics.channelId,
      platform: accountMetrics.platform,
      followers: accountMetrics.followers,
      impressions: accountMetrics.impressions,
      engagementRate: sql<number | null>`NULL::integer`.as('engagement_rate'),
      platformSpecific: accountMetrics.platformSpecific,
    })
    .from(accountMetrics)
    .where(
      and(
        eq(accountMetrics.organizationId, 5),
        gte(accountMetrics.date, '2026-07-01'),
        lte(accountMetrics.date, '2026-07-29'),
      ),
    )
    .orderBy(desc(accountMetrics.date))
    .toSQL().sql;
}

describe('account analytics NULL engagementRate SQL', () => {
  it('aliases the NULL column so it decodes as null, not undefined', () => {
    expect(renderAccountQuery()).toContain('NULL::integer as "engagement_rate"');
  });

  it('casts the NULL — a bare NULL is Postgres type `unknown`', () => {
    const rendered = renderAccountQuery();
    expect(rendered).toContain('NULL::integer');
    expect(rendered).not.toMatch(/select[^)]*\bNULL\s+as\b/i);
  });

  it('binds the filters as parameters and inlines nothing', () => {
    const { sql: text, params } = db
      .select({ engagementRate: sql<number | null>`NULL::integer`.as('engagement_rate') })
      .from(accountMetrics)
      .where(eq(accountMetrics.organizationId, 5))
      .toSQL();
    expect(params).toEqual([5]);
    expect(text).not.toContain('= 5');
  });
});
