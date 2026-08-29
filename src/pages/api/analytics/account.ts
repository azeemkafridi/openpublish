import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { accountMetrics, channels } from '@/lib/db/schema';
import { eq, and, gte, lte, desc, sql } from 'drizzle-orm';
import { cached } from '@/lib/cache';
import { clampFrom } from '@/lib/analytics/range';

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

export const GET: APIRoute = async ({ locals, url }) => {
  const { user, organizationId } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const channelIdParam = url.searchParams.get('channelId');
  const rawFrom = url.searchParams.get('from') || daysAgo(30);
  const to = url.searchParams.get('to') || todayStr();

  if (isNaN(new Date(rawFrom).getTime()) || isNaN(new Date(to).getTime())) {
    return json({ error: 'Invalid date format' }, 400);
  }

  // Enforce the 30-day max window (YouTube/Meta/etc. statistics-retention policies).
  const from = clampFrom(rawFrom);

  // Build conditions
  const conditions = [
    eq(accountMetrics.organizationId, organizationId),
    gte(accountMetrics.date, from),
    lte(accountMetrics.date, to),
  ];

  if (channelIdParam) {
    const channelId = parseInt(channelIdParam, 10);
    if (isNaN(channelId)) {
      return json({ error: 'Invalid channelId' }, 400);
    }
    conditions.push(eq(accountMetrics.channelId, channelId));
  }

  const cacheKey = `cache:analytics:${organizationId}:account:${from}:${to}:${channelIdParam || 'all'}`;
  const result = await cached(cacheKey, 300, async () => {

  // Fetch metrics
  const metrics = await db
    .select({
      date: accountMetrics.date,
      channelId: accountMetrics.channelId,
      platform: accountMetrics.platform,
      followers: accountMetrics.followers,
      following: accountMetrics.following,
      impressions: accountMetrics.impressions,
      reach: accountMetrics.reach,
      profileViews: accountMetrics.profileViews,
      websiteClicks: accountMetrics.websiteClicks,
      // ALWAYS null — never a measurement. Nothing computes an account-level
      // engagement rate: syncAccountAnalytics omits the column on insert and
      // its upsert writes EXCLUDED.engagement_rate, which is the same default
      // 0, so all 125 production rows across all 9 platforms are 0. Returning
      // that 0 made it indistinguishable from a measured 0% — the exact
      // confusion `supportedMetrics` exists to prevent — and the SDKs type it
      // as `number | null`, so null is both honest and non-breaking. Use the
      // per-post engagementRate from /api/analytics/engagement instead.
      // Cast is required: a bare NULL has Postgres type `unknown`, which some
      // clients and any wrapping CTE reject. No bound parameters here, so the
      // fragment is safe to reuse (see .claude/rules/raw-sql.md).
      // The .as() is load-bearing: without it drizzle emits a bare
      // `NULL::integer` with no alias, Postgres names the column `?column?`,
      // and the field decodes to undefined rather than null — silently, with
      // no error. See .claude/rules/raw-sql.md.
      engagementRate: sql<number | null>`NULL::integer`.as('engagement_rate'),
      // Per-platform extras (e.g. TikTok total likes + video count) — surfaced as
      // their own cards in the UI so platform-specific metrics aren't lost.
      platformSpecific: accountMetrics.platformSpecific,
    })
    .from(accountMetrics)
    .where(and(...conditions))
    .orderBy(desc(accountMetrics.date));

  // Fetch channels for this org (for the channel selector)
  const orgChannels = await db
    .select({
      id: channels.id,
      platform: channels.platform,
      accountName: channels.accountName,
    })
    .from(channels)
    .where(
      and(
        eq(channels.organizationId, organizationId),
        eq(channels.isActive, true),
      ),
    );

  return {
    metrics,
    channels: orgChannels,
  };

  }); // end cached()

  return json(result, 200, { 'Cache-Control': 'private, max-age=60' });
};
