import { Worker, type Job } from 'bullmq';
import { getRedisConnection, QUEUE_NAMES } from './queue';
import { db } from '../db';
import { channels, postPlatforms, posts, postMetrics, accountMetrics, apiUsageDaily, xApiUsageDaily } from '../db/schema';
import { eq, and, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { decrypt } from '../auth/crypto';
import { getPlatformHandler } from '../platforms/registry';
import { refreshChannelToken } from '../oauth/refresh-lock';
import type { PlatformName, ChannelData } from '../platforms/types';
import { createLogger } from '../logger';
import { X_API_COSTS_DCENTS, isBilledAction, type XApiAction } from '../platforms/x-usage';
import { METRICS_SUPPORTED_PLATFORMS } from '../platforms/metrics-support';
import { tiktokVideoUrl } from '../platforms/tiktok';

const logger = createLogger('metrics-sync-worker');

/**
 * Recurring fan-out: one `sync-metrics` job per org that has anything worth
 * syncing (a published platform row in the 30-day stats window). Staggered so
 * a fleet of orgs doesn't hit the platforms at the same instant.
 */
async function fanOutMetricsSync() {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const orgs = await db
    .selectDistinct({ organizationId: posts.organizationId })
    .from(posts)
    .innerJoin(postPlatforms, eq(postPlatforms.postId, posts.id))
    .where(
      and(
        eq(postPlatforms.status, 'published'),
        isNotNull(postPlatforms.platformPostId),
        gte(posts.publishedAt, thirtyDaysAgo),
      ),
    );

  const queue = (await import('./queue')).getQueue(QUEUE_NAMES.METRICS_SYNC);
  for (let i = 0; i < orgs.length; i++) {
    await queue.add(
      'sync-metrics',
      { organizationId: orgs[i].organizationId },
      {
        delay: i * 30_000, // 30s apart
        // Dedupe within one cron window only. The bucket suffix matters: a
        // completed BullMQ job blocks re-use of its id until it's removed, so
        // a bare per-org id would silently skip every later window.
        jobId: `sync-metrics-${orgs[i].organizationId}-${Math.floor(Date.now() / (6 * 3_600_000))}`,
        removeOnComplete: 50,
        removeOnFail: 100,
      },
    );
  }
  logger.info({ orgs: orgs.length }, 'Metrics sync fan-out enqueued');
}

// Platforms that support getPostMetrics(). Shared with the analytics API so the
// UI can tell "not synced yet" apart from "this platform never reports".
const SUPPORTED_PLATFORMS: PlatformName[] = METRICS_SUPPORTED_PLATFORMS;

export function createMetricsSyncWorker() {
  return new Worker(
    QUEUE_NAMES.METRICS_SYNC,
    async (job: Job) => {
      if (job.name === 'sync-metrics') {
        const { organizationId } = job.data as { organizationId: number };
        await syncOrgMetrics(organizationId);
      } else if (job.name === 'sync-all-metrics') {
        await fanOutMetricsSync();
      } else if (job.name === 'snapshot-x-api-usage') {
        await snapshotXApiUsage();
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 2,
    },
  );
}

/** Sync metrics for all published posts in an org from the last 30 days */
async function syncOrgMetrics(organizationId: number) {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // Get all published post_platforms for supported platforms in this org
  const publishedPPs = await db
    .select({
      ppId: postPlatforms.id,
      postId: postPlatforms.postId,
      channelId: postPlatforms.channelId,
      platform: postPlatforms.platform,
      platformPostId: postPlatforms.platformPostId,
      platformUrl: postPlatforms.platformUrl,
      platformSpecific: posts.platformSpecific,
    })
    .from(postPlatforms)
    .innerJoin(posts, eq(posts.id, postPlatforms.postId))
    .where(
      and(
        eq(posts.organizationId, organizationId),
        eq(postPlatforms.status, 'published'),
        isNotNull(postPlatforms.platformPostId),
        gte(posts.publishedAt, thirtyDaysAgo),
        inArray(postPlatforms.platform, SUPPORTED_PLATFORMS),
      ),
    );

  if (publishedPPs.length === 0) {
    logger.debug({ organizationId }, 'No published posts to sync metrics for');
    return;
  }

  // Group by channel for efficient API calls (reuse access token)
  const byChannel = new Map<number, typeof publishedPPs>();
  for (const pp of publishedPPs) {
    const list = byChannel.get(pp.channelId) || [];
    list.push(pp);
    byChannel.set(pp.channelId, list);
  }

  let totalSynced = 0;

  for (const [channelId, pps] of byChannel) {
    try {
      // Fetch channel with decrypted token
      const [channel] = await db
        .select()
        .from(channels)
        .where(and(eq(channels.id, channelId), eq(channels.isActive, true)));

      if (!channel || !channel.accessToken) {
        logger.debug({ channelId }, 'Channel inactive or no token, skipping');
        continue;
      }

      // X is the only platform that charges for reads, so its metrics sync is gated: it must be
      // explicitly opted in per channel, and runs at most once per 7 days. We mark the throttle
      // before attempting (not after success) so a failed/capped attempt can't be retried into a
      // drain. Other platforms (free reads) sync on every refresh.
      if (channel.platform === 'x') {
        const optedIn = (channel.metadata as Record<string, unknown> | null)?.metricsSyncEnabled === true;
        if (!optedIn) {
          logger.debug({ channelId }, 'X metrics sync not opted in — skipping');
          continue;
        }
        const xThrottleKey = `x:metrics:lastsync:${channelId}`;
        const redis = getRedisConnection();
        if (await redis.get(xThrottleKey)) {
          logger.debug({ channelId }, 'X metrics synced within the last 7 days — skipping');
          continue;
        }
        await redis.set(xThrottleKey, new Date().toISOString(), 'EX', 7 * 24 * 60 * 60);
      }

      const handler = getPlatformHandler(channel.platform as PlatformName);
      const decryptedToken = decrypt(channel.accessToken);

      const channelData: ChannelData = {
        id: channel.id,
        platform: channel.platform as PlatformName,
        accountId: channel.accountId,
        accountName: channel.accountName,
        accountType: channel.accountType || undefined,
        accessToken: decryptedToken,
        refreshToken: channel.refreshToken ? decrypt(channel.refreshToken) : undefined,
        metadata: channel.metadata as Record<string, unknown> | undefined,
        organizationId,
      };

      // Bluesky access JWTs live only ~2h and aren't in the proactive sweep, so by metrics
      // time the stored token is usually dead. Refresh + PERSIST it under the single-flight
      // lock and use the fresh token — the handler's in-run refresh can't persist, so it
      // would otherwise burn the single-use refresh token on every sync.
      if (channel.platform === 'bluesky' && channel.refreshToken) {
        const fresh = await refreshChannelToken(channel.id);
        if (fresh) channelData.accessToken = fresh;
      }

      // TikTok: a post can reach PUBLISH_COMPLETE before TikTok exposes its public
      // video id, so we stored the publish_id ("v_pub_url~..."), which /video/query/
      // can't read. Re-resolve those to the numeric video id and persist it, so it's
      // queried directly from here on. Only for non-private posts — SELF_ONLY posts
      // never get a public id, so retrying them would hit status/fetch for nothing.
      if (channel.platform === 'tiktok') {
        for (const pp of pps) {
          const id = pp.platformPostId;
          if (!id || /^\d+$/.test(id)) continue; // missing or already a numeric video id

          const ps = (pp.platformSpecific ?? {}) as Record<string, unknown>;
          const ttOpts = ((ps.tiktok as Record<string, unknown>) ?? ps);
          const privacy = (ttOpts.privacyLevel as string) || (ps.privacy_level as string) || 'SELF_ONLY';
          if (privacy === 'SELF_ONLY') continue;

          const videoId = await handler.resolvePublishId(channelData, id);
          if (videoId) {
            // The row was published from a publish_id, so its permalink was never set —
            // backfill it here or the "View post" link stays blank forever.
            const url = tiktokVideoUrl(channel.accountName, videoId);
            await db
              .update(postPlatforms)
              .set({ platformPostId: videoId, ...(pp.platformUrl ? {} : { platformUrl: url }) })
              .where(eq(postPlatforms.id, pp.ppId));
            pp.platformPostId = videoId; // use the resolved id for this run's metrics query
            logger.info({ ppId: pp.ppId, videoId }, 'Resolved TikTok publish_id to public video id');
          }
        }
      }

      const platformPostIds = pps.map((pp) => pp.platformPostId!);
      // Discord reads a post as /channels/{channelId}/messages/{id}; the
      // channel id is recorded only in the permalink, so pass the URLs along.
      const urlsById = Object.fromEntries(pps.map((pp) => [pp.platformPostId!, pp.platformUrl]));
      const metricsMap = await handler.getPostMetrics(channelData, platformPostIds, { urlsById });

      // Insert metrics rows
      for (const pp of pps) {
        const metrics = metricsMap.get(pp.platformPostId!);
        if (!metrics) continue;

        // Platforms can return negative counts. LinkedIn documents this
        // explicitly for likeCount: when a member likes a SPONSORED share and
        // later unlikes it, the like was never counted as organic but the
        // unlike is, so the organic total goes below zero. Storing that raw
        // would subtract from org-wide totals and could render "-3 likes".
        const n = (v: number | undefined) => Math.max(0, Math.round(v ?? 0));

        const impressions = n(metrics.impressions);
        const totalEngagements = n(metrics.likes) + n(metrics.comments) +
          n(metrics.shares) + n(metrics.clicks);
        const engagementRate = impressions > 0
          ? Math.round((totalEngagements / impressions) * 10000)
          : 0;

        await db.insert(postMetrics).values({
          postPlatformId: pp.ppId,
          postId: pp.postId,
          organizationId,
          platform: pp.platform,
          impressions,
          reach: n(metrics.reach),
          likes: n(metrics.likes),
          comments: n(metrics.comments),
          shares: n(metrics.shares),
          saves: n(metrics.saves),
          clicks: n(metrics.clicks),
          videoViews: n(metrics.videoViews),
          engagementRate,
          platformSpecificMetrics: metrics.extra ?? {},
          fetchedAt: new Date(),
        });

        totalSynced++;
      }

      // Rate limit safety: 500ms delay between channels
      await new Promise((r) => setTimeout(r, 500));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Gracefully skip channels with expired/invalid tokens
      if (message.includes('401') || message.includes('403')) {
        logger.warn({ channelId, error: message }, 'Channel auth failed, skipping');
      } else {
        logger.error({ channelId, error: message }, 'Metrics sync failed for channel');
      }
    }
  }

  logger.info({ organizationId, totalSynced, channels: byChannel.size }, 'Org metrics sync complete');

  // Note: auto-plug/auto-repost threshold checks used to live here, which meant they
  // only ever fired when a user happened to refresh analytics. They now run on their
  // own bounded schedule in engagement-check.worker.ts (delayed jobs enqueued at
  // publish time), fully decoupled from this on-demand sweep.

  // Account-level analytics — daily snapshots of followers, impressions, etc.
  await syncAccountAnalytics(organizationId);

  // Drop cached analytics responses NOW — the refresh route invalidates before
  // this job has written anything, so the UI's post-sync refetch would otherwise
  // repopulate the 300s cache with pre-sync data and pin stale numbers.
  const { invalidateCache } = await import('../cache');
  await invalidateCache(`cache:analytics:${organizationId}:*`).catch(() => {});
}



async function syncAccountAnalytics(organizationId: number) {
  const orgChannels = await db
    .select()
    .from(channels)
    .where(and(eq(channels.organizationId, organizationId), eq(channels.isActive, true)));

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  for (const channel of orgChannels) {
    if (!channel.accessToken) continue;

    try {
      const handler = getPlatformHandler(channel.platform as PlatformName);
      const channelData: ChannelData = {
        id: channel.id,
        platform: channel.platform as PlatformName,
        accountId: channel.accountId,
        accountName: channel.accountName,
        accountType: channel.accountType || undefined,
        accessToken: decrypt(channel.accessToken),
        refreshToken: channel.refreshToken ? decrypt(channel.refreshToken) : undefined,
        metadata: channel.metadata as Record<string, unknown> | undefined,
        organizationId,
      };

      const analytics = await handler.getAccountAnalytics(channelData);
      if (!analytics) continue;

      // Upsert — one row per channel per day
      await db
        .insert(accountMetrics)
        .values({
          channelId: channel.id,
          organizationId,
          platform: channel.platform,
          date: today,
          followers: analytics.followers ?? 0,
          following: analytics.following ?? 0,
          impressions: analytics.impressions ?? 0,
          reach: analytics.reach ?? 0,
          profileViews: analytics.profileViews ?? 0,
          websiteClicks: analytics.websiteClicks ?? 0,
          // Engagement rate is computed from post metrics, not account-level data
          platformSpecific: analytics.platformSpecific ?? {},
          fetchedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [accountMetrics.channelId, accountMetrics.date],
          // A partial read (rate-limited insights endpoint, account type without the
          // metric) comes back with fields undefined → zero-coalesced in VALUES. Only
          // overwrite the day's row with fields the API actually returned; keep the
          // existing value for absent ones instead of clobbering it with 0.
          set: {
            followers: analytics.followers !== undefined ? sql`EXCLUDED.followers` : sql`account_metrics.followers`,
            following: analytics.following !== undefined ? sql`EXCLUDED.following` : sql`account_metrics.following`,
            impressions: analytics.impressions !== undefined ? sql`EXCLUDED.impressions` : sql`account_metrics.impressions`,
            reach: analytics.reach !== undefined ? sql`EXCLUDED.reach` : sql`account_metrics.reach`,
            profileViews: analytics.profileViews !== undefined ? sql`EXCLUDED.profile_views` : sql`account_metrics.profile_views`,
            websiteClicks: analytics.websiteClicks !== undefined ? sql`EXCLUDED.website_clicks` : sql`account_metrics.website_clicks`,
            engagementRate: sql`EXCLUDED.engagement_rate`,
            platformSpecific: analytics.platformSpecific !== undefined ? sql`EXCLUDED.platform_specific` : sql`account_metrics.platform_specific`,
            fetchedAt: sql`EXCLUDED.fetched_at`,
          },
        });

      logger.info({ channelId: channel.id, platform: channel.platform, followers: analytics.followers }, 'Account analytics synced');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('401') || message.includes('403')) {
        logger.warn({ channelId: channel.id, error: message }, 'Account analytics auth failed, skipping');
      } else {
        logger.error({ channelId: channel.id, error: message }, 'Account analytics sync failed');
      }
    }

    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Snapshot daily X API usage from Redis counters to DB. Called from the daily 'snapshot-x-api-usage' job. */
/**
 * Non-blocking replacement for redis.keys(). KEYS is O(total keyspace) and blocks the
 * single-threaded Redis event loop for the whole scan — on a busy instance shared with
 * BullMQ that can stall every queue. SCAN walks the keyspace incrementally in COUNT-sized
 * batches, never holding the loop. Runs in the daily snapshot only, so cursor overhead is fine.
 */
async function scanKeys(redis: ReturnType<typeof getRedisConnection>, pattern: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    if (batch.length) found.push(...batch);
  } while (cursor !== '0');
  return found;
}

async function snapshotXApiUsage(): Promise<void> {
  try {
    const redis = getRedisConnection();
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    let saved = 0;
    for (const date of [today, yesterdayStr]) {
      // Pattern: x:api:cost:{orgId}:{date}:{action}  — exclude :count suffix keys
      const allKeys = await scanKeys(redis, `x:api:cost:*:${date}:*`);
      const costKeys = allKeys.filter((k) => !k.endsWith(':count'));

      for (const key of costKeys) {
        // Parse: x:api:cost:{orgId}:{date}:{action}
        const parts = key.split(':');
        const orgId = parseInt(parts[3], 10);
        const action = parts[5] as XApiAction;
        if (isNaN(orgId) || !action) continue;

        const cost = parseInt((await redis.get(key)) ?? '0', 10);
        if (!cost) continue;

        const count = parseInt((await redis.get(`${key}:count`)) ?? '0', 10);
        if (!(action in X_API_COSTS_DCENTS)) continue;

        await db
          .insert(xApiUsageDaily)
          .values({
            organizationId: orgId,
            date,
            actionType: action,
            callCount: count,
            costDcents: cost,
            billed: isBilledAction(action),
          })
          .onConflictDoUpdate({
            target: [xApiUsageDaily.organizationId, xApiUsageDaily.date, xApiUsageDaily.actionType],
            set: { callCount: count, costDcents: cost, updatedAt: new Date() },
          });
        saved++;
      }
    }

    // Also snapshot the regular API usage counter at the same time.
    await snapshotApiUsage();

    if (saved > 0) {
      logger.info({ saved }, 'X API usage snapshot saved');
    }
  } catch (error) {
    logger.warn({ error }, 'X API usage snapshot failed');
  }
}

/** Snapshot daily API usage from Redis counters to DB for historical tracking */
async function snapshotApiUsage() {
  try {
    const redis = getRedisConnection();
    const today = new Date().toISOString().slice(0, 10);
    // Also snapshot yesterday in case the previous run missed it
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    // Find all daily usage keys
    const todayKeys = await scanKeys(redis, `rl:api:daily:*:${today}`);
    const yesterdayKeys = await scanKeys(redis, `rl:api:daily:*:${yesterdayStr}`);
    const allKeys = [...new Set([...todayKeys, ...yesterdayKeys])];

    let saved = 0;
    for (const key of allKeys) {
      // Parse orgId and date from key: rl:api:daily:{orgId}:{date}
      const parts = key.split(':');
      const orgId = parseInt(parts[3], 10);
      const date = parts[4];
      if (isNaN(orgId) || !date) continue;

      const count = parseInt(await redis.get(key) ?? '0', 10);
      if (count === 0) continue;

      // Upsert — update count if row exists (counter may have increased since last snapshot)
      await db
        .insert(apiUsageDaily)
        .values({ organizationId: orgId, date, count })
        .onConflictDoUpdate({
          target: [apiUsageDaily.organizationId, apiUsageDaily.date],
          set: { count },
        });
      saved++;
    }

    if (saved > 0) {
      logger.info({ saved, keys: allKeys.length }, 'API usage snapshot saved');
    }
  } catch (error) {
    logger.warn({ error }, 'API usage snapshot failed');
  }
}
