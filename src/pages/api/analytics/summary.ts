import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { posts, postPlatforms } from '@/lib/db/schema';
import { eq, and, sql, count, gte, lte, isNotNull } from 'drizzle-orm';
import { cached } from '@/lib/cache';
import { clampFrom } from '@/lib/analytics/range';

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export const GET: APIRoute = async ({ locals, url }) => {
  const { user, organizationId } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const rawFrom = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  if (!rawFrom || !to) {
    return json({ error: 'Both from and to date parameters are required' }, 400);
  }

  const toDate = new Date(to);
  if (isNaN(new Date(rawFrom).getTime()) || isNaN(toDate.getTime())) {
    return json({ error: 'Invalid date format' }, 400);
  }

  // Enforce the 30-day max window (YouTube/Meta/etc. statistics-retention policies).
  const from = clampFrom(rawFrom);
  const fromDate = new Date(from);

  // Viewer timezone for day boundaries and bucketing. Without it everything is
  // UTC days: a post published this morning in Karachi (UTC+5) counted as
  // yesterday, and the chart's bars sat one day off the viewer's calendar.
  // Validated against the strict IANA-name shape; anything else falls back to
  // UTC (and an unknown-but-well-formed name fails the query loudly, not
  // silently wrong).
  const rawTz = url.searchParams.get('tz') || 'UTC';
  const tz = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(rawTz) ? rawTz : 'UTC';

  // Make toDate inclusive of the entire day (UTC pre-filter; the tz-aware date
  // comparison below is the authoritative window). ±1 day of slack so a
  // viewer-local day straddling UTC midnight isn't clipped by the pre-filter.
  const fromDateStart = new Date(fromDate.getTime() - 24 * 60 * 60 * 1000);
  const toDateEnd = new Date(toDate);
  toDateEnd.setUTCHours(23, 59, 59, 999);
  toDateEnd.setTime(toDateEnd.getTime() + 24 * 60 * 60 * 1000);

  // The 5000-row heatmap payload is only used by the analytics dashboard;
  // the overview fetches this endpoint too and was shipping ~1-2 MB of ISO
  // strings it never reads. Opt-in via ?heatmap=1.
  const wantHeatmap = url.searchParams.get('heatmap') === '1';

  const cacheKey = `cache:analytics:${organizationId}:summary:${from}:${to}:${tz}:${wantHeatmap ? 'h1' : 'h0'}`;
  const result = await cached(cacheKey, 300, async () => {

  // Bucket and filter on when a post actually went live, falling back to
  // creation for posts that never published. Filtering on createdAt alone
  // dropped posts drafted before the window but published inside it, and
  // plotted a post drafted Monday / published Friday on Monday.
  const activityAt = sql`COALESCE(${posts.publishedAt}, ${posts.createdAt})`;
  // The same instant expressed as the viewer's calendar day.
  //
  // The timezone is INLINED, not bound as a parameter. Drizzle emits a fresh
  // placeholder every time a fragment is interpolated, so a bound tz produced
  // `AT TIME ZONE $1` in SELECT and `$9` in GROUP BY — Postgres then treats
  // them as different expressions and rejects the query with "column
  // posts.published_at must appear in the GROUP BY clause". Inlining keeps the
  // expression text identical everywhere. Safe: `tz` is validated above against
  // a pattern that admits no quotes or backslashes.
  const activityDay = sql`(${activityAt} AT TIME ZONE ${sql.raw(`'${tz}'`)})::date`;

  const conditions = [
    eq(posts.organizationId, organizationId),
    // Index-friendly coarse bounds first, then the exact tz-aware day window.
    sql`${activityAt} >= ${fromDateStart}`,
    sql`${activityAt} <= ${toDateEnd}`,
    sql`${activityDay} >= ${from}::date`,
    sql`${activityDay} <= ${to.split('T')[0]}::date`,
  ];

  const whereClause = and(...conditions);

  // Total counts by status
  const statusCounts = await db
    .select({
      status: posts.status,
      count: count(),
    })
    .from(posts)
    .where(whereClause)
    .groupBy(posts.status);

  const statusMap: Record<string, number> = {};
  let totalPosts = 0;
  for (const row of statusCounts) {
    statusMap[row.status!] = row.count;
    totalPosts += row.count;
  }

  // By platform
  const platformCounts = await db
    .select({
      platform: postPlatforms.platform,
      status: postPlatforms.status,
      count: count(),
    })
    .from(postPlatforms)
    .innerJoin(posts, eq(postPlatforms.postId, posts.id))
    .where(whereClause)
    .groupBy(postPlatforms.platform, postPlatforms.status);

  const byPlatform: Record<string, { total: number; published: number; failed: number }> = {};
  for (const row of platformCounts) {
    if (!byPlatform[row.platform]) {
      byPlatform[row.platform] = { total: 0, published: 0, failed: 0 };
    }
    byPlatform[row.platform].total += row.count;
    if (row.status === 'published') {
      byPlatform[row.platform].published += row.count;
    } else if (row.status === 'failed') {
      byPlatform[row.platform].failed += row.count;
    }
  }

  // By day with per-platform published counts for tooltips
  const byDayRows = await db
    .select({
      date: sql<string>`${activityDay}`.as('date'),
      count: count(),
    })
    .from(posts)
    .where(whereClause)
    .groupBy(sql`${activityDay}`)
    .orderBy(sql`${activityDay}`);

  const byDayPlatformRows = await db
    .select({
      date: sql<string>`${activityDay}`.as('date'),
      platform: postPlatforms.platform,
      count: count(),
    })
    .from(postPlatforms)
    .innerJoin(posts, eq(postPlatforms.postId, posts.id))
    .where(and(whereClause, eq(postPlatforms.status, 'published')))
    .groupBy(sql`${activityDay}`, postPlatforms.platform);

  const dayPlatformMap: Record<string, Record<string, number>> = {};
  for (const row of byDayPlatformRows) {
    if (!dayPlatformMap[row.date]) dayPlatformMap[row.date] = {};
    dayPlatformMap[row.date][row.platform] = row.count;
  }

  const byDay = byDayRows.map((row) => ({
    date: row.date,
    count: row.count,
    platforms: dayPlatformMap[row.date] || {},
  }));

  // Publish timestamps for the posting-activity heatmap. Raw ISO timestamps (not
  // server-side day/hour buckets) so the client can bucket them in the viewer's
  // local timezone — grouping by hour in UTC here would shift cells for everyone
  // west/east of Greenwich. Capped to keep the payload bounded.
  const publishedTimeRows = wantHeatmap
    ? await db
        .select({ ts: posts.publishedAt })
        .from(posts)
        .where(
          and(
            eq(posts.organizationId, organizationId),
            isNotNull(posts.publishedAt),
            gte(posts.publishedAt, fromDate),
            lte(posts.publishedAt, toDateEnd),
          ),
        )
        .orderBy(posts.publishedAt)
        .limit(5000)
    : [];
  const publishedTimes = publishedTimeRows
    .map((r) => (r.ts instanceof Date ? r.ts.toISOString() : r.ts))
    .filter(Boolean);

  return {
    totalPosts,
    // Kept strictly 'published': `partial` is returned separately below and
    // rendered as its own tile, and AnalyticsDashboard derives Total by summing
    // these fields — folding partial into published would double-count it.
    published: statusMap['published'] || 0,
    failed: statusMap['failed'] || 0,
    scheduled: statusMap['scheduled'] || 0,
    partial: statusMap['partial'] || 0,
    byPlatform,
    byDay,
    publishedTimes,
  };

  }); // end cached()

  return json(result, 200, { 'Cache-Control': 'private, max-age=60' });
};
