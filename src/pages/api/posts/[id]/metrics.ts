import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { postMetrics, postPlatforms, posts, channels } from '@/lib/db/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { postMetricsSupported, supportedMetrics } from '@/lib/platforms/metrics-support';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=60' },
  });
}

export const GET: APIRoute = async ({ locals, params }) => {
  const { user, organizationId } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const postId = Number(params.id);
  if (!postId) return json({ error: 'Invalid post ID' }, 400);

  // Verify post belongs to org
  const [post] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.id, postId), eq(posts.organizationId, organizationId)));

  if (!post) return json({ error: 'Post not found' }, 404);

  // Get all post_platforms for this post
  const pps = await db
    .select({
      id: postPlatforms.id,
      platform: postPlatforms.platform,
      platformPostId: postPlatforms.platformPostId,
      platformUrl: postPlatforms.platformUrl,
      status: postPlatforms.status,
      // LinkedIn share statistics exist for organization pages only, so support
      // is account-type-dependent — see metrics-support.ts.
      accountType: channels.accountType,
    })
    .from(postPlatforms)
    .leftJoin(channels, eq(channels.id, postPlatforms.channelId))
    .where(eq(postPlatforms.postId, postId));

  // Link-click tracking (shortlink redirector) is a cloud feature; self-host
  // reports zero link clicks.
  const linkClicksByPostPlatform = new Map<number, number>();

  // For each post_platform, get the latest metrics + last 10 history snapshots
  const platforms = [];
  let totalImpressions = 0;
  let totalLikes = 0;
  let totalComments = 0;
  let totalShares = 0;
  let totalClicks = 0;
  let totalVideoViews = 0;
  let totalLinkClicks = 0;

  for (const pp of pps) {
    const allMetrics = await db
      .select()
      .from(postMetrics)
      .where(eq(postMetrics.postPlatformId, pp.id))
      .orderBy(desc(postMetrics.fetchedAt))
      .limit(10);

    // Which of the eight metric columns this channel can ever populate. The rest
    // are stored as 0 by the worker regardless of what the platform returned, so
    // consumers must not present them as measurements.
    const support = {
      metricsSupported: postMetricsSupported(pp.platform, pp.accountType),
      supportedMetrics: supportedMetrics(pp.platform, pp.accountType),
    };

    const linkClicks = linkClicksByPostPlatform.get(pp.id) || 0;
    totalLinkClicks += linkClicks;

    if (allMetrics.length === 0) {
      platforms.push({
        platform: pp.platform,
        platformPostId: pp.platformPostId,
        platformUrl: pp.platformUrl,
        status: pp.status,
        ...support,
        // Deliberately outside `latest`: link clicks exist independently of any
        // platform snapshot, so a platform that reports nothing still has them.
        linkClicks,
        latest: null,
        history: [],
      });
      continue;
    }

    const latest = allMetrics[0];

    totalImpressions += latest.impressions || 0;
    totalLikes += latest.likes || 0;
    totalComments += latest.comments || 0;
    totalShares += latest.shares || 0;
    totalClicks += latest.clicks || 0;
    totalVideoViews += latest.videoViews || 0;

    platforms.push({
      platform: pp.platform,
      platformPostId: pp.platformPostId,
      platformUrl: pp.platformUrl,
      status: pp.status,
      ...support,
      linkClicks,
      latest: {
        impressions: latest.impressions,
        reach: latest.reach,
        likes: latest.likes,
        comments: latest.comments,
        shares: latest.shares,
        saves: latest.saves,
        clicks: latest.clicks,
        videoViews: latest.videoViews,
        engagementRate: latest.engagementRate,
        platformSpecificMetrics: latest.platformSpecificMetrics,
        fetchedAt: latest.fetchedAt,
      },
      history: allMetrics.map((m) => ({
        impressions: m.impressions,
        likes: m.likes,
        comments: m.comments,
        shares: m.shares,
        fetchedAt: m.fetchedAt,
      })),
    });
  }

  return json({
    postId,
    platforms,
    totals: {
      impressions: totalImpressions,
      likes: totalLikes,
      comments: totalComments,
      shares: totalShares,
      clicks: totalClicks,
      videoViews: totalVideoViews,
      linkClicks: totalLinkClicks,
    },
  });
};
