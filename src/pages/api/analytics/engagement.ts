import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { postMetrics, postPlatforms, posts, mediaFiles } from '@/lib/db/schema';
import { eq, and, gte, lte, sql, desc, inArray } from 'drizzle-orm';
import { cached } from '@/lib/cache';
import { clampFrom } from '@/lib/analytics/range';
import { getMediaPublicUrl } from '@/lib/media/upload';
import {
  postMetricsSupported,
  supportedMetrics,
  ALL_METRIC_KEYS,
  CONDITIONAL_METRICS,
  type MetricKey,
} from '@/lib/platforms/metrics-support';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=60' },
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

  const toDateEnd = new Date(toDate);
  // setUTCHours, not setHours — end-of-day must not depend on the server's TZ.
  toDateEnd.setUTCHours(23, 59, 59, 999);

  const channelId = url.searchParams.get('channelId');

  // `?top=1` returns the ranked topPosts but omits `allPosts`. Overview only
  // renders the top 5; shipping the full per-post array (337 posts in prod)
  // just to slice 5 off it is why Overview used to rank a /api/posts page
  // client-side instead — and that divergence made the two Top Posts lists
  // disagree. Separate cache key so the two shapes never overwrite each other.
  const topOnly = url.searchParams.get('top') === '1';

  const cacheKey = `cache:analytics:${organizationId}:engagement:${from}:${to}:${channelId || 'all'}:${topOnly ? 'top' : 'full'}`;
  const result = await cached(cacheKey, 300, async () => {

  // Start from every PUBLISHED post_platform in range and LEFT JOIN its latest
  // metrics snapshot. Posts that published but haven't been metrics-synced yet
  // (brand-new posts, platforms whose stats API lags, or zero-engagement posts)
  // still appear — with zeroed metrics — instead of vanishing from analytics
  // until a snapshot lands. This is what makes a just-published post show up.
  const latestMetrics = await db.execute(sql`
    SELECT
      pp.id AS post_platform_id,
      pp.post_id,
      pp.platform,
      COALESCE(pm.impressions, 0)   AS impressions,
      COALESCE(pm.reach, 0)         AS reach,
      COALESCE(pm.likes, 0)         AS likes,
      COALESCE(pm.comments, 0)      AS comments,
      COALESCE(pm.shares, 0)        AS shares,
      COALESCE(pm.saves, 0)         AS saves,
      COALESCE(pm.clicks, 0)        AS clicks,
      COALESCE(pm.video_views, 0)   AS video_views,
      COALESCE(pm.engagement_rate, 0) AS engagement_rate,
      pm.fetched_at,
      p.content,
      p.media_files,
      p.published_at,
      pp.platform_url,
      pp.platform_post_id,
      c.account_type,
      c.id           AS channel_id,
      c.account_name,
      c.metadata     AS channel_metadata
    FROM post_platforms pp
    JOIN posts p ON p.id = pp.post_id
    LEFT JOIN channels c ON c.id = pp.channel_id
    LEFT JOIN LATERAL (
      SELECT m.impressions, m.reach, m.likes, m.comments, m.shares, m.saves,
             m.clicks, m.video_views, m.engagement_rate, m.fetched_at
      FROM post_metrics m
      WHERE m.post_platform_id = pp.id
      ORDER BY m.fetched_at DESC
      LIMIT 1
    ) pm ON TRUE
    WHERE p.organization_id = ${organizationId}
      AND pp.status = 'published'
      AND pp.platform_post_id IS NOT NULL
      AND p.published_at >= ${fromDate.toISOString()}
      AND p.published_at <= ${toDateEnd.toISOString()}
      ${channelId ? sql`AND pp.channel_id = ${parseInt(channelId, 10)}` : sql``}
    ORDER BY pp.id
  `);

  const rows = latestMetrics.rows as Array<{
    post_platform_id: number;
    post_id: number;
    platform: string;
    impressions: number;
    reach: number;
    likes: number;
    comments: number;
    shares: number;
    saves: number;
    clicks: number;
    video_views: number;
    engagement_rate: number;
    fetched_at: string;
    content: string;
    media_files: unknown;
    published_at: string;
    platform_url: string | null;
    platform_post_id: string;
    account_type: string | null;
    channel_id: number | null;
    account_name: string | null;
    channel_metadata: Record<string, unknown> | null;
  }>;

  // Shortlink clicks, summed per post_platform.
  //
  // Link-click tracking (shortlink redirector) is a cloud feature; self-host
  // reports zero link clicks.
  const linkClicksByPostPlatform = new Map<number, number>();

  // X charges per read, so its metrics sync is opt-in per channel
  // (metadata.metricsSyncEnabled, toggled on the Channels page) and capped at
  // once per 7 days. Without the opt-in NO snapshot is ever written for that
  // channel — every X figure below stays 0 and "Refresh Metrics" cannot change
  // it. Analytics said nothing about this, so it read as broken metrics.
  const metricsDisabledChannels = Array.from(
    new Map(
      rows
        .filter(
          (r) =>
            r.platform === 'x' &&
            r.channel_id != null &&
            (r.channel_metadata as Record<string, unknown> | null)?.metricsSyncEnabled !== true,
        )
        .map((r) => [r.channel_id!, { id: r.channel_id!, platform: r.platform, accountName: r.account_name }]),
    ).values(),
  );

  // Platforms in range whose posts can never have metrics (no getPostMetrics,
  // or LinkedIn personal/profile channels). Their rows still COALESCE to 0
  // above, so the UI must label them rather than present 0 as a measurement.
  const unmeasuredPlatforms = Array.from(
    new Set(
      rows
        .filter((r) => !postMetricsSupported(r.platform, r.account_type))
        .map((r) => r.platform),
    ),
  ).sort();

  // Per-metric support across the platforms actually present in this range.
  // The org-wide totals below sum every published row, so a total is only a
  // real measurement if at least one in-range platform reports that metric.
  // An X-only org has no reach/saves/clicks/videoViews source at all — those
  // totals must render as "—", not as a confident 0.
  // Union across rows, not first-row-wins: LinkedIn support is account-type
  // dependent, so an org with both a company page and a personal profile would
  // otherwise inherit whichever channel happened to sort first — dashing out
  // every LinkedIn metric when a measurable page exists, or vice versa.
  const platformSupport: Record<string, MetricKey[]> = {};
  for (const r of rows) {
    const merged = new Set([
      ...(platformSupport[r.platform] ?? []),
      ...supportedMetrics(r.platform, r.account_type),
    ]);
    platformSupport[r.platform] = ALL_METRIC_KEYS.filter((k) => merged.has(k));
  }
  const supportedTotals: MetricKey[] = ALL_METRIC_KEYS.filter((k) =>
    Object.values(platformSupport).some((keys) => keys.includes(k)),
  );
  // Metrics only SOME in-range platforms report — the total is real but covers
  // fewer posts than the impressions total does, which is worth a footnote
  // rather than silently under-reporting.
  const partialTotals: Record<string, string[]> = {};
  for (const k of supportedTotals) {
    const missing = Object.entries(platformSupport)
      .filter(([, keys]) => !keys.includes(k))
      .map(([p]) => p)
      .sort();
    if (missing.length > 0) partialTotals[k] = missing;
  }

  // Supported-but-permission-gated metrics for the platforms in range (today:
  // Facebook's insights metrics, which need read_insights). A 0 here means
  // "we may not be allowed to read it", which is neither a dash nor a
  // trustworthy measurement — consumers should say so rather than guess.
  const conditionalMetrics: Record<string, MetricKey[]> = {};
  for (const platform of Object.keys(platformSupport)) {
    const keys = CONDITIONAL_METRICS[platform as keyof typeof CONDITIONAL_METRICS];
    if (keys?.length) conditionalMetrics[platform] = keys;
  }

  // Aggregates
  let totalImpressions = 0;
  let totalLikes = 0;
  let totalComments = 0;
  let totalShares = 0;
  let totalClicks = 0;
  let totalEngagements = 0;
  let totalSaves = 0;
  let totalVideoViews = 0;
  let totalReach = 0;
  let totalLinkClicks = 0;
  let rateSum = 0;
  let rateCount = 0;

  const byPlatform: Record<string, {
    impressions: number;
    likes: number;
    comments: number;
    shares: number;
    clicks: number;
    linkClicks: number;
    posts: number;
  }> = {};

  const byDayMap = new Map<
    string,
    { impressions: number; engagements: number; reach: number; linkClicks: number }
  >();

  // For per-post analytics
  const postAggMap = new Map<number, {
    postId: number;
    content: string;
    mediaFiles: unknown;
    publishedAt: string;
    totalImpressions: number;
    totalLikes: number;
    totalComments: number;
    totalShares: number;
    totalSaves: number;
    totalClicks: number;
    totalVideoViews: number;
    totalLinkClicks: number;
    totalEngagementRate: number;
    engagementRateCount: number;
    platforms: Array<{ platform: string; platformUrl: string | null }>;
    platformMetrics: Array<{ platform: string; platformUrl: string | null; impressions: number; likes: number; comments: number; shares: number; saves: number; clicks: number; videoViews: number; linkClicks: number; engagementRate: number; metricsSupported: boolean }>;
  }>();

  for (const row of rows) {
    const impressions = row.impressions || 0;
    const reach = row.reach || 0;
    const likes = row.likes || 0;
    const comments = row.comments || 0;
    const shares = row.shares || 0;
    const clicks = row.clicks || 0;
    const saves = row.saves || 0;
    const videoViews = row.video_views || 0;
    const linkClicks = linkClicksByPostPlatform.get(row.post_platform_id) || 0;
    // linkClicks stays OUT of `engagements`: the same visit can register both a
    // platform-reported click and one of ours, so adding it would double-count
    // and silently redefine an existing headline number.
    const engagements = likes + comments + shares + clicks;

    totalLinkClicks += linkClicks;
    totalImpressions += impressions;
    totalReach += reach;
    totalLikes += likes;
    totalComments += comments;
    totalShares += shares;
    totalClicks += clicks;
    totalSaves += saves;
    totalVideoViews += videoViews;
    totalEngagements += engagements;

    // Average over every row whose rate is MEASURABLE, not every row whose rate
    // is non-zero. The worker computes engagement_rate as engagements ÷
    // impressions and stores 0 when impressions is 0, so `impressions > 0` is
    // exactly the "this number means something" test. Filtering on
    // `engagement_rate > 0` instead dropped every post that genuinely got no
    // engagement — 1704 of 2571 measurable rows in production, 66% — which
    // inflated the reported average to a mean over only the posts that
    // performed.
    if (impressions > 0) {
      rateSum += row.engagement_rate;
      rateCount++;
    }

    // By platform
    if (!byPlatform[row.platform]) {
      byPlatform[row.platform] = { impressions: 0, likes: 0, comments: 0, shares: 0, clicks: 0, linkClicks: 0, posts: 0 };
    }
    byPlatform[row.platform].impressions += impressions;
    byPlatform[row.platform].likes += likes;
    byPlatform[row.platform].comments += comments;
    byPlatform[row.platform].shares += shares;
    byPlatform[row.platform].clicks += clicks;
    byPlatform[row.platform].linkClicks += linkClicks;
    byPlatform[row.platform].posts++;

    // By day
    const day = row.published_at ? new Date(row.published_at).toISOString().slice(0, 10) : '';
    if (day) {
      const existing = byDayMap.get(day) || { impressions: 0, engagements: 0, reach: 0, linkClicks: 0 };
      existing.impressions += impressions;
      existing.engagements += engagements;
      existing.reach += reach;
      existing.linkClicks += linkClicks;
      byDayMap.set(day, existing);
    }

    // Aggregate by post
    const postId = row.post_id;
    const platMetric = {
      platform: row.platform,
      platformUrl: row.platform_url,
      impressions, likes, comments, shares, saves, clicks, videoViews, linkClicks,
      // THIS channel's own rate. The post-level `engagementRate` below is an
      // average across the post's platforms, so rendering it beside a single
      // platform's counters showed (for example) Instagram's 24.55% next to
      // TikTok's zeros. Per-platform panels must read this field.
      engagementRate: row.engagement_rate || 0,
      // false => the zeros above are "not reported", not "measured zero".
      metricsSupported: postMetricsSupported(row.platform, row.account_type),
      // Which of the eight columns this channel can ever populate. Everything
      // else is a stored 0 that means "the API has no such field" — the UI
      // dashes those rather than printing a number the platform never gave us.
      supportedMetrics: supportedMetrics(row.platform, row.account_type),
    };
    const existing = postAggMap.get(postId);
    if (existing) {
      existing.totalImpressions += impressions;
      existing.totalLikes += likes;
      existing.totalComments += comments;
      existing.totalShares += shares;
      existing.totalSaves += saves;
      existing.totalClicks += clicks;
      existing.totalVideoViews += videoViews;
      existing.totalLinkClicks += linkClicks;
      // Same measurable-vs-non-zero distinction as avgEngagementRate above.
      if (impressions > 0) { existing.totalEngagementRate += row.engagement_rate; existing.engagementRateCount++; }
      existing.platforms.push({ platform: row.platform, platformUrl: row.platform_url });
      existing.platformMetrics.push(platMetric);
    } else {
      postAggMap.set(postId, {
        postId,
        content: row.content || '',
        mediaFiles: row.media_files,
        publishedAt: row.published_at,
        totalImpressions: impressions,
        totalLikes: likes,
        totalComments: comments,
        totalShares: shares,
        totalSaves: saves,
        totalClicks: clicks,
        totalVideoViews: videoViews,
        totalLinkClicks: linkClicks,
        totalEngagementRate: impressions > 0 ? row.engagement_rate : 0,
        engagementRateCount: impressions > 0 ? 1 : 0,
        platforms: [{ platform: row.platform, platformUrl: row.platform_url }],
        platformMetrics: [platMetric],
      });
    }
  }

  const avgEngagementRate = rateCount > 0 ? Math.round(rateSum / rateCount) : 0;

  const byDay = Array.from(byDayMap.entries())
    .map(([date, data]) => ({ date, ...data }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Resolve thumbnails from media_files table
  const allMediaIds = new Set<number>();
  for (const p of postAggMap.values()) {
    if (Array.isArray(p.mediaFiles)) {
      for (const id of p.mediaFiles) {
        if (typeof id === 'number') allMediaIds.add(id);
      }
    }
  }
  const thumbMap = new Map<number, string>();
  if (allMediaIds.size > 0) {
    const mediaRows = await db
      .select({
        id: mediaFiles.id,
        thumbnailPath: mediaFiles.thumbnailPath,
        previewPath: mediaFiles.previewPath,
        largePath: mediaFiles.largePath,
      })
      .from(mediaFiles)
      .where(inArray(mediaFiles.id, Array.from(allMediaIds)));
    for (const row of mediaRows) {
      // Preview (400px) before thumbnail (160px): this feeds the post mockup in
      // the analytics preview pane, where a 160px crop was visibly blurry. The
      // same URL also backs the small list rows, which downscale fine.
      const path = row.previewPath || row.largePath || row.thumbnailPath;
      if (path) thumbMap.set(row.id, getMediaPublicUrl(path));
    }
  }

  // Sort param for post list
  const sortField = url.searchParams.get('sort') || 'date';
  const sortOrder = url.searchParams.get('order') || 'desc';
  const sortFn = (a: typeof postAggMap extends Map<number, infer V> ? V : never, b: typeof postAggMap extends Map<number, infer V> ? V : never) => {
    let va: number, vb: number;
    switch (sortField) {
      case 'impressions': va = a.totalImpressions; vb = b.totalImpressions; break;
      case 'likes': va = a.totalLikes; vb = b.totalLikes; break;
      case 'comments': va = a.totalComments; vb = b.totalComments; break;
      case 'shares': va = a.totalShares; vb = b.totalShares; break;
      case 'linkClicks': va = a.totalLinkClicks; vb = b.totalLinkClicks; break;
      case 'date': default: va = new Date(a.publishedAt).getTime(); vb = new Date(b.publishedAt).getTime(); break;
    }
    return sortOrder === 'asc' ? va - vb : vb - va;
  };

  const allPostsSorted = Array.from(postAggMap.values()).sort(sortFn);

  const mapPost = (p: (typeof allPostsSorted)[number]) => ({
    postId: p.postId,
    content: p.content.slice(0, 120),
    thumbnail: Array.isArray(p.mediaFiles) && p.mediaFiles.length > 0 && typeof p.mediaFiles[0] === 'number'
      ? thumbMap.get(p.mediaFiles[0] as number)
      : undefined,
    publishedAt: p.publishedAt,
    impressions: p.totalImpressions,
    likes: p.totalLikes,
    comments: p.totalComments,
    shares: p.totalShares,
    saves: p.totalSaves,
    clicks: p.totalClicks,
    videoViews: p.totalVideoViews,
    linkClicks: p.totalLinkClicks,
    engagementRate: p.engagementRateCount > 0 ? Math.round(p.totalEngagementRate / p.engagementRateCount) : 0,
    platforms: p.platforms,
    platformMetrics: p.platformMetrics,
  });

  const allPosts = allPostsSorted.map(mapPost);
  // Top 10 by impressions for backwards compatibility / overview
  const topPosts = Array.from(postAggMap.values())
    .sort((a, b) => b.totalImpressions - a.totalImpressions)
    .slice(0, 10)
    .map(mapPost);

  return {
    totalImpressions,
    totalEngagements,
    totalLikes,
    totalComments,
    totalShares,
    totalClicks,
    totalSaves,
    totalVideoViews,
    totalReach,
    // Clicks on tracked shortlinks we own — distinct from `totalClicks`,
    // which is what the platforms themselves report.
    totalLinkClicks,
    avgEngagementRate, // basis points
    byPlatform,
    byDay,
    topPosts,
    allPosts: topOnly ? [] : allPosts,
    unmeasuredPlatforms,
    metricsDisabledChannels,
    metricSupport: platformSupport,
    supportedTotals,
    partialTotals,
    conditionalMetrics,
  };

  }); // end cached()

  return json(result);
};
