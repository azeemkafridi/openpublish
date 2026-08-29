import { Worker, type Job } from 'bullmq';
import {
  getRedisConnection,
  QUEUE_NAMES,
  ENGAGEMENT_CHECK_DELAYS_MS,
  removeRemainingEngagementChecks,
} from './queue';
import { db } from '../db';
import { channels, postPlatforms, posts, postMetrics } from '../db/schema';
import { eq, and, inArray, isNotNull, sql } from 'drizzle-orm';
import { decrypt } from '../auth/crypto';
import { getPlatformHandler } from '../platforms/registry';
import { refreshChannelToken } from '../oauth/refresh-lock';
import type { PlatformName, ChannelData } from '../platforms/types';
import { METRICS_SUPPORTED_PLATFORMS } from '../platforms/metrics-support';
import { createLogger } from '../logger';

const logger = createLogger('engagement-check-worker');

const TOTAL_CHECKS = ENGAGEMENT_CHECK_DELAYS_MS.length;

// Small pause between the metrics read and the comment/repost write, so the
// action doesn't land in the same instant as the read (bot-pattern hygiene;
// Postiz does the same before its plug actions).
const ACTION_DELAY_MS = 2000;

/**
 * Auto-plug / auto-repost engagement checks.
 *
 * Each published post with either automation enabled gets a bounded set of
 * delayed jobs (1h/6h/24h/72h after publish — see queue.ts). A job reads ONLY
 * that post's metrics, stores the snapshot (free freshness for the analytics
 * page), and fires the comment/repost if the cross-platform like total crossed
 * the threshold. Once both automations have fired — or after the final check —
 * the remaining scheduled jobs are cancelled. Never a recurring poll.
 *
 * X note: the check deliberately does NOT require the channel's analytics
 * opt-in (metadata.metricsSyncEnabled) — enabling auto-plug/repost on a post is
 * itself explicit consent to a handful of single-post reads. The X handler
 * still enforces the org's monthly X budget internally, so an exhausted org
 * simply gets no metrics from that check.
 */
export function createEngagementCheckWorker() {
  return new Worker(
    QUEUE_NAMES.ENGAGEMENT_CHECK,
    async (job: Job) => {
      if (job.name === 'check-engagement') {
        const { postId, checkNumber } = job.data as { postId: number; checkNumber: number };
        await checkPostEngagement(postId, checkNumber);
      }
    },
    {
      connection: getRedisConnection(),
      // Low concurrency + these are single-post reads: thousands of posts crossing a
      // check boundary at once drain gradually instead of stampeding platform APIs.
      concurrency: 3,
    },
  );
}

function buildChannelData(channel: typeof channels.$inferSelect, organizationId: number): ChannelData {
  return {
    id: channel.id,
    platform: channel.platform as PlatformName,
    accountId: channel.accountId,
    accountName: channel.accountName,
    accountType: channel.accountType || undefined,
    accessToken: decrypt(channel.accessToken!),
    refreshToken: channel.refreshToken ? decrypt(channel.refreshToken) : undefined,
    metadata: channel.metadata as Record<string, unknown> | undefined,
    organizationId,
  };
}

export async function checkPostEngagement(postId: number, checkNumber: number) {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post) return;

  const plugPending = !!post.autoPlugEnabled && !post.autoPlugFired && !!post.autoPlugText;
  const repostPending = !!post.autoRepostEnabled && !post.autoRepostFired;

  if (!plugPending && !repostPending) {
    // Both already fired (or the user disabled them since publish) — nothing left to
    // watch, cancel the rest of the schedule.
    await removeRemainingEngagementChecks(postId, checkNumber);
    return;
  }

  const pps = await db
    .select({
      ppId: postPlatforms.id,
      channelId: postPlatforms.channelId,
      platform: postPlatforms.platform,
      platformPostId: postPlatforms.platformPostId,
      platformUrl: postPlatforms.platformUrl,
    })
    .from(postPlatforms)
    .where(
      and(
        eq(postPlatforms.postId, postId),
        eq(postPlatforms.status, 'published'),
        isNotNull(postPlatforms.platformPostId),
        // Platforms whose getPostMetrics() is implemented. Shared with the metrics
        // sweep rather than re-listed here, which is how the two used to drift.
        inArray(postPlatforms.platform, METRICS_SUPPORTED_PLATFORMS),
      ),
    );

  if (pps.length === 0) {
    await removeRemainingEngagementChecks(postId, checkNumber);
    return;
  }

  // --- Fetch fresh metrics, one targeted read per channel of THIS post ---
  const byChannel = new Map<number, typeof pps>();
  for (const pp of pps) {
    const list = byChannel.get(pp.channelId) || [];
    list.push(pp);
    byChannel.set(pp.channelId, list);
  }

  for (const [channelId, channelPps] of byChannel) {
    try {
      const [channel] = await db
        .select()
        .from(channels)
        .where(and(eq(channels.id, channelId), eq(channels.isActive, true)));
      if (!channel?.accessToken) continue;

      const handler = getPlatformHandler(channel.platform as PlatformName);
      const channelData = buildChannelData(channel, post.organizationId);

      // Bluesky access JWTs live ~2h — refresh + persist under the single-flight
      // lock, same as the metrics sweep, so we don't burn the refresh token.
      if (channel.platform === 'bluesky' && channel.refreshToken) {
        const fresh = await refreshChannelToken(channel.id);
        if (fresh) channelData.accessToken = fresh;
      }

      // TikTok can still hold a publish_id ("v_pub_url~…") that /video/query/ can't
      // read. Skip those here rather than resolving — the metrics sweep owns
      // re-resolution/persistence; a later check picks up the resolved id.
      const ids = channelPps
        .map((pp) => pp.platformPostId!)
        .filter((id) => channel.platform !== 'tiktok' || /^\d+$/.test(id));
      if (ids.length === 0) continue;

      // Discord addresses a message as /channels/{channelId}/messages/{id};
      // the channel id lives only in the stored permalink.
      const urlsById = Object.fromEntries(channelPps.map((pp) => [pp.platformPostId!, pp.platformUrl]));
      const metricsMap = await handler.getPostMetrics(channelData, ids, { urlsById });

      for (const pp of channelPps) {
        const metrics = metricsMap.get(pp.platformPostId!);
        if (!metrics) continue;

        const totalEngagements = (metrics.likes ?? 0) + (metrics.comments ?? 0) +
          (metrics.shares ?? 0) + (metrics.clicks ?? 0);
        const engagementRate = metrics.impressions && metrics.impressions > 0
          ? Math.round((totalEngagements / metrics.impressions) * 10000)
          : 0;

        await db.insert(postMetrics).values({
          postPlatformId: pp.ppId,
          postId,
          organizationId: post.organizationId,
          platform: pp.platform,
          impressions: metrics.impressions ?? 0,
          reach: metrics.reach ?? 0,
          likes: metrics.likes ?? 0,
          comments: metrics.comments ?? 0,
          shares: metrics.shares ?? 0,
          saves: metrics.saves ?? 0,
          clicks: metrics.clicks ?? 0,
          videoViews: metrics.videoViews ?? 0,
          engagementRate,
          platformSpecificMetrics: metrics.extra ?? {},
          fetchedAt: new Date(),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('401') || message.includes('403')) {
        logger.warn({ postId, channelId, error: message }, 'Engagement check auth failed, skipping channel');
      } else {
        logger.error({ postId, channelId, error: message }, 'Engagement check metrics fetch failed');
      }
    }
  }

  // --- Threshold check: peak stored likes per platform, summed ---
  // Read from the DB (not just this run's fetches) so a platform whose fetch
  // failed this round still contributes. MAX (not latest snapshot): a partial
  // platform read is stored zero-filled, and a zero "latest" row would mask a
  // real earlier count and un-cross a threshold that was already crossed.
  const latestMetrics = await db
    .select({
      totalLikes: sql<number>`COALESCE(SUM(pm.likes), 0)::int`,
    })
    .from(sql`(
      SELECT MAX(likes) AS likes
      FROM post_metrics pm
      WHERE pm.post_id = ${postId}
      GROUP BY post_platform_id
    ) pm`);
  const totalLikes = latestMetrics[0]?.totalLikes ?? 0;

  let plugDone = !plugPending;
  let repostDone = !repostPending;

  // Auto-Plug: atomically claim (autoPlugFired false→true) BEFORE posting so a
  // concurrent check / metrics sweep / crash mid-loop can't re-fire it.
  if (plugPending
      && totalLikes >= (post.autoPlugThreshold ?? 50)
      && (await db.update(posts).set({ autoPlugFired: true })
            .where(and(eq(posts.id, postId), eq(posts.autoPlugFired, false)))
            .returning({ id: posts.id })).length > 0) {
    logger.info({ postId, totalLikes, threshold: post.autoPlugThreshold, checkNumber }, 'Auto-plug triggered');
    await new Promise((r) => setTimeout(r, ACTION_DELAY_MS));
    await fireOnPlatforms(pps, post.organizationId, async (handler, channelData, platformPostId) => {
      const result = await handler.publishComment(channelData, platformPostId, post.autoPlugText!);
      return { ...result, action: 'auto-plug comment' };
    }, postId);
    plugDone = true;
  }

  // Auto-Repost: same atomic claim.
  if (repostPending
      && totalLikes >= (post.autoRepostThreshold ?? 100)
      && (await db.update(posts).set({ autoRepostFired: true })
            .where(and(eq(posts.id, postId), eq(posts.autoRepostFired, false)))
            .returning({ id: posts.id })).length > 0) {
    logger.info({ postId, totalLikes, threshold: post.autoRepostThreshold, checkNumber }, 'Auto-repost triggered');
    await new Promise((r) => setTimeout(r, ACTION_DELAY_MS));
    await fireOnPlatforms(pps, post.organizationId, async (handler, channelData, platformPostId) => {
      const result = await handler.repost(channelData, platformPostId);
      return { ...result, action: 'auto-repost' };
    }, postId);
    repostDone = true;
  }

  // Stop early once everything pending has fired; the final check needs no cleanup
  // (there is nothing scheduled after it).
  if (plugDone && repostDone && checkNumber < TOTAL_CHECKS) {
    await removeRemainingEngagementChecks(postId, checkNumber);
  }
}

/** Run a comment/repost action on every published platform of the post. */
async function fireOnPlatforms(
  pps: Array<{ ppId: number; channelId: number; platform: string; platformPostId: string | null }>,
  organizationId: number,
  action: (
    handler: ReturnType<typeof getPlatformHandler>,
    channelData: ChannelData,
    platformPostId: string,
  ) => Promise<{ success: boolean; error?: string; action: string }>,
  postId: number,
) {
  for (const pp of pps) {
    if (!pp.platformPostId) continue;
    try {
      const [channel] = await db
        .select()
        .from(channels)
        .where(and(eq(channels.id, pp.channelId), eq(channels.isActive, true)));
      if (!channel?.accessToken) continue;

      const handler = getPlatformHandler(pp.platform as PlatformName);
      const channelData = buildChannelData(channel, organizationId);

      const result = await action(handler, channelData, pp.platformPostId);
      if (result.success) {
        logger.info({ postId, platform: pp.platform }, `${result.action} succeeded`);
      } else {
        // Unsupported platforms return {success:false} from the base handler — logged
        // and skipped, never retried (the fired flag is already claimed).
        logger.warn({ postId, platform: pp.platform, error: result.error }, `${result.action} failed`);
      }
    } catch (error) {
      logger.error({ postId, platform: pp.platform, error: String(error) }, 'Engagement action error');
    }
  }
}
