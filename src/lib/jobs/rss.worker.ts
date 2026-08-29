import { Worker, type Job } from 'bullmq';
import { getRedisConnection, getQueue, QUEUE_NAMES } from './queue';
import { db } from '../db';
import { rssFeeds, rssFeedItems, posts, postPlatforms, channels } from '../db/schema';
import { eq, and, inArray, isNull, or, lte, lt, sql } from 'drizzle-orm';
import { createLogger } from '../logger';
import { logActivity } from '../activity/log';
import { checkPostQuotasBatch, checkMediaStorageQuota, getOrgPlan, getUserLimits } from '../quotas/check';
import type { PlanLimits } from '../quotas/plans';
import { parseFeed, FeedParseError, type FeedItem } from '../rss/parse';
import { fetchFeedXmlConditional } from '../rss/fetch';
import {
  DEFAULT_FIELD_MAPPING,
  renderForChannel,
  selectItemMedia,
  type RssFieldMapping,
  type ChannelRender,
} from '../rss/mapping';
import { rehostUrlToMedia } from '../media/remote';

const logger = createLogger('rss-worker');

const MAX_ITEMS_PER_CYCLE = 5;

// Error backoff: first retry after one skipped cycle, doubling up to the cap;
// after MAX_CONSECUTIVE_FAILURES the feed is auto-disabled (surfaced via
// lastError + activity log) so a permanently-dead URL isn't polled forever.
const BASE_BACKOFF_MS = 15 * 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 20;

// RSS media imports run unattended, up to 5 items × every feed × every cycle —
// cap each download well below the interactive 100 MB import limit.
const RSS_MEDIA_MAX_BYTES = 25 * 1024 * 1024;

export function backoffDelayMs(failures: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);
}

/**
 * Baseline sentinel: null = the feed has never had a successful poll, so the
 * next success baselines the backlog instead of posting it. Falls back to
 * lastCheckedAt for rows last written by pre-lastSuccessAt code (production ran
 * `drizzle-kit push` when that shipped — DDL-only — so the migration's backfill
 * UPDATE never executed against those rows; deploys apply migrations properly now,
 * but the un-backfilled rows remain) — but only when the feed has no recorded
 * failures, since under
 * the old code a failed-only feed's lastCheckedAt was exactly the destroyed-
 * sentinel bug this replaces.
 */
export function baselineSentinel(feed: { lastSuccessAt: Date | null; lastCheckedAt: Date | null; consecutiveFailures: number }): Date | null {
  return feed.lastSuccessAt ?? (feed.consecutiveFailures === 0 ? feed.lastCheckedAt : null);
}

// Hard per-feed wall-clock budget: a tarpit origin (slow fetch + 5 slow media
// downloads) must fail this feed's job, not stall others.
const POLL_TIMEOUT_MS = 4 * 60 * 1000;

export function createRssWorker() {
  return new Worker(
    QUEUE_NAMES.RSS,
    async (job: Job) => {
      // 'poll-feeds' (the 15-min repeatable) fans out one 'poll-feed' job per
      // due feed, so one slow/hostile feed can't starve every other org's
      // polling the way the old single sequential cycle could.
      if (job.name === 'poll-feeds') {
        await enqueueDueFeeds();
      } else if (job.name === 'poll-feed') {
        await pollOneFeed(Number(job.data?.feedId));
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 4,
    },
  );
}

/**
 * Scheduler tick: enqueue one 'poll-feed' job per due feed. jobId dedupes a
 * feed still waiting/active from a previous tick; completed/failed jobs are
 * removed immediately so the next tick can re-enqueue.
 */
export async function enqueueDueFeeds() {
  pruneFeedFetchCache();
  const due = await db
    .select({ id: rssFeeds.id })
    .from(rssFeeds)
    .where(and(
      eq(rssFeeds.enabled, true),
      or(isNull(rssFeeds.nextPollAt), lte(rssFeeds.nextPollAt, new Date())),
    ));
  if (due.length > 0) {
    const queue = getQueue(QUEUE_NAMES.RSS);
    await queue.addBulk(
      due.map((f) => ({
        name: 'poll-feed',
        data: { feedId: f.id },
        // No colons — BullMQ rejects them in a custom job id.
        opts: { jobId: `poll-feed-${f.id}`, removeOnComplete: true, removeOnFail: true },
      })),
    );
  }
  logger.info({ due: due.length }, 'RSS poll cycle: feeds enqueued');
  await sweepStuckItems();
}

/**
 * Observability sweep: items stuck in 'claimed' (crash between claim and post
 * insert) are permanently dropped by design — make that visible instead of
 * silent. Read-only; runs once per cycle.
 */
async function sweepStuckItems() {
  try {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(rssFeedItems)
      .where(and(eq(rssFeedItems.status, 'claimed'), lt(rssFeedItems.createdAt, cutoff)));
    if (count > 0) {
      logger.warn({ stuckClaimedItems: count }, 'RSS items stuck in claimed state (crashed between claim and post) — these were dropped');
    }
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'RSS stuck-item sweep failed');
  }
}

/** Run one feed's poll with the success/backoff bookkeeping and a hard timeout. */
export async function pollOneFeed(feedId: number) {
  if (!Number.isFinite(feedId)) return;
  const [feed] = await db.select().from(rssFeeds).where(eq(rssFeeds.id, feedId)).limit(1);
  // Re-check under the job (the feed may have been disabled/backed off since enqueue).
  if (!feed || !feed.enabled) return;
  if (feed.nextPollAt && feed.nextPollAt.getTime() > Date.now()) return;

  // Plan drives auto-publish eligibility (draft-only on lower tiers, and this
  // also demotes feeds whose org downgraded after enabling publish mode) and
  // the per-feed poll cadence.
  const limits = getUserLimits(await getOrgPlan(feed.organizationId));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();
  try {
    const result = await Promise.race([
      pollFeed(feed, limits),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Feed poll timed out after ${POLL_TIMEOUT_MS / 1000}s`)), POLL_TIMEOUT_MS);
      }),
    ]);
    await db
      .update(rssFeeds)
      .set({
        lastCheckedAt: new Date(),
        lastSuccessAt: new Date(),
        consecutiveFailures: 0,
        // Next poll no sooner than the plan's interval (fresher = higher tier).
        nextPollAt: new Date(Date.now() + limits.rssPollIntervalMinutes * 60 * 1000),
        etag: result?.etag ?? null,
        lastModified: result?.lastModified ?? null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(rssFeeds.id, feed.id));
    logger.info({ feedId: feed.id, ms: Date.now() - startedAt }, 'RSS feed polled');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failures = feed.consecutiveFailures + 1;
    const disable = failures >= MAX_CONSECUTIVE_FAILURES;
    logger.warn({ feedId: feed.id, url: feed.feedUrl, error: message, failures, disable, ms: Date.now() - startedAt }, 'RSS poll failed');
    await db
      .update(rssFeeds)
      .set({
        lastCheckedAt: new Date(),
        consecutiveFailures: failures,
        nextPollAt: disable ? null : new Date(Date.now() + backoffDelayMs(failures)),
        ...(disable ? { enabled: false } : {}),
        lastError: (disable ? `Disabled after ${failures} consecutive failures. Last error: ` : '').concat(message).slice(0, 500),
        updatedAt: new Date(),
      })
      .where(eq(rssFeeds.id, feed.id));
    if (disable) {
      logActivity({
        userId: feed.userId,
        organizationId: feed.organizationId,
        action: 'rss.feed_disabled',
        resource: 'rss_feed',
        resourceId: feed.id,
        details: { feedName: feed.name, failures, lastError: message.slice(0, 200) },
      });
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ---- In-cycle shared-URL fetch cache ---------------------------------- */

type FeedCacheEntry =
  | { kind: 'content'; xml: string; etag: string | null; lastModified: string | null }
  | { kind: 'not_modified'; etag: string | null };

// Many feeds (across orgs) can point at one URL; fetch+parse it once per cycle
// and fan the result out. Settled entries only — with worker concurrency 4, at
// most 4 duplicate in-flight fetches can race before the cache fills, which is
// an acceptable bound that keeps the logic simple.
const FEED_CACHE_TTL_MS = 10 * 60 * 1000;
const feedFetchCache = new Map<string, { expires: number; entry: FeedCacheEntry }>();

export function clearFeedFetchCache() {
  feedFetchCache.clear();
}

/**
 * Drop expired entries (each can hold up to 2 MB of XML) so the long-lived
 * worker process doesn't retain one stale body per feed URL ever polled.
 * Runs at the start of every cycle; the 10-min TTL < 15-min cycle means a new
 * cycle always starts cold anyway.
 */
function pruneFeedFetchCache() {
  const now = Date.now();
  for (const [key, value] of feedFetchCache) {
    if (value.expires <= now) feedFetchCache.delete(key);
  }
}

function normalizeFeedUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    return u.href;
  } catch {
    return url;
  }
}

/**
 * Fetch a feed for polling, going through the in-cycle cache and per-feed
 * conditional-GET validators.
 */
async function fetchFeedForPoll(
  feed: typeof rssFeeds.$inferSelect,
): Promise<{ notModified: true } | { notModified?: false; xml: string; etag: string | null; lastModified: string | null }> {
  const key = normalizeFeedUrl(feed.feedUrl);
  const now = Date.now();
  const cached = feedFetchCache.get(key);
  if (cached && cached.expires > now) {
    if (cached.entry.kind === 'content') return cached.entry;
    // A cached 304 only proves freshness for feeds holding the SAME validator.
    if (feed.etag && cached.entry.etag === feed.etag) return { notModified: true };
    // Different/absent validators → this feed needs real content; fall through.
  }

  const result = await fetchFeedXmlConditional(feed.feedUrl, {
    etag: feed.etag,
    lastModified: feed.lastModified,
  });
  if (result.status === 'not_modified') {
    feedFetchCache.set(key, { expires: now + FEED_CACHE_TTL_MS, entry: { kind: 'not_modified', etag: feed.etag } });
    return { notModified: true };
  }
  feedFetchCache.set(key, {
    expires: now + FEED_CACHE_TTL_MS,
    entry: { kind: 'content', xml: result.xml, etag: result.etag, lastModified: result.lastModified },
  });
  return { xml: result.xml, etag: result.etag, lastModified: result.lastModified };
}

/**
 * Render one item for every channel of the feed via its field mapping. When
 * the item has a selected enclosure it is re-hosted to org media first; if
 * that fails we fall back to rendering without media (media-required channels
 * then skip with a clear reason instead of the whole item failing).
 */
async function buildItemRenders(
  feed: typeof rssFeeds.$inferSelect,
  item: FeedItem,
  activeChannels: Array<{ id: number; platform: string }>,
): Promise<{ renders: ChannelRender[]; mediaFiles: number[] }> {
  const mapping = (feed.fieldMapping as RssFieldMapping | null) ?? DEFAULT_FIELD_MAPPING;
  const ctx = { item, feedName: feed.name };

  let media = selectItemMedia(mapping, item);
  let mediaFiles: number[] = [];
  if (media) {
    try {
      // Storage quota gate: an automated importer must not silently fill the
      // org's media storage. Over quota → render without media (media-required
      // channels then skip with a clear reason).
      const storage = await checkMediaStorageQuota(feed.organizationId);
      if (!storage.allowed) {
        throw new Error(`media storage quota reached (${storage.current}/${storage.limit} MB)`);
      }
      const uploaded = await rehostUrlToMedia(media.url, feed.userId, feed.organizationId, {
        maxBytes: RSS_MEDIA_MAX_BYTES,
      });
      mediaFiles = [uploaded.id];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ feedId: feed.id, url: media.url, error: message }, 'RSS item media could not be imported — continuing without media');
      media = null;
    }
  }

  return { renders: activeChannels.map((ch) => renderForChannel(mapping, ctx, ch, media)), mediaFiles };
}

export async function pollFeed(
  feed: typeof rssFeeds.$inferSelect,
  limits?: Pick<PlanLimits, 'rssAutoPublish'>,
): Promise<{ etag: string | null; lastModified: string | null } | void> {
  const fetched = await fetchFeedForPoll(feed);
  if (fetched.notModified) {
    // Unchanged upstream — keep the validators we already hold.
    return { etag: feed.etag, lastModified: feed.lastModified };
  }
  const validators = { etag: fetched.etag, lastModified: fetched.lastModified };
  let parsed;
  try {
    parsed = parseFeed(fetched.xml, feed.feedUrl);
  } catch (err) {
    if (err instanceof FeedParseError) throw new Error(err.message);
    throw err;
  }
  if (parsed.items.length === 0) return validators;

  const guids = parsed.items.map((i) => i.guid);
  const seen = await db
    .select({ guid: rssFeedItems.guid })
    .from(rssFeedItems)
    .where(and(eq(rssFeedItems.feedId, feed.id), inArray(rssFeedItems.guid, guids)));
  const seenGuids = new Set(seen.map((s) => s.guid));
  const fresh = parsed.items.filter((i) => !seenGuids.has(i.guid));
  if (fresh.length === 0) return validators;

  // First SUCCESSFUL poll: baseline the feed's existing backlog without
  // posting, so enabling a feed doesn't flood every channel with old articles.
  // (Keyed on lastSuccessAt, not lastCheckedAt — a failed first poll must not
  // consume the sentinel and turn the whole backlog into "fresh" items.)
  if (!baselineSentinel(feed)) {
    await db
      .insert(rssFeedItems)
      .values(fresh.map((i) => ({ feedId: feed.id, guid: i.guid, status: 'baselined' })))
      .onConflictDoNothing();
    logger.info({ feedId: feed.id, baselined: fresh.length }, 'RSS feed baselined');
    return validators;
  }

  // Oldest first so posts appear in publication order; bounded per cycle.
  const toPost = fresh
    .sort((a, b) => (a.publishedAt?.getTime() ?? 0) - (b.publishedAt?.getTime() ?? 0))
    .slice(0, MAX_ITEMS_PER_CYCLE);
  if (fresh.length > toPost.length) {
    logger.info({ feedId: feed.id, deferred: fresh.length - toPost.length }, 'RSS items deferred to next cycle');
  }

  const activeChannels = await db
    .select()
    .from(channels)
    .where(and(
      eq(channels.isActive, true),
      eq(channels.organizationId, feed.organizationId),
      inArray(channels.id, feed.channelIds || []),
    ));
  if (activeChannels.length === 0) {
    throw new Error('No active channels configured for this feed');
  }

  // One quota check per cycle (each call is several DB round-trips); the cap of
  // MAX_ITEMS_PER_CYCLE bounds how far past the limit a single cycle can go,
  // and the next cycle re-checks.
  const quotas = await checkPostQuotasBatch(feed.organizationId);
  if (!quotas.daily.allowed || !quotas.monthly.allowed) {
    logger.warn({ feedId: feed.id, orgId: feed.organizationId }, 'Quota exceeded — deferring RSS items');
    return validators;
  }

  for (const item of toPost) {
    // Mark the item seen BEFORE creating the post: if this insert races another
    // poll or the post insert below fails mid-way, we prefer skipping an item
    // over auto-publishing the same article twice.
    const claimed = await db
      .insert(rssFeedItems)
      .values({ feedId: feed.id, guid: item.guid, status: 'claimed' })
      .onConflictDoNothing()
      .returning({ guid: rssFeedItems.guid });
    if (claimed.length === 0) continue; // another run already claimed it

    const { renders, mediaFiles } = await buildItemRenders(feed, item, activeChannels);
    const usable = renders.filter((r) => !r.skipped);
    const skipped = renders.filter((r) => r.skipped);

    if (usable.length === 0) {
      // Nothing publishable (e.g. every channel requires media the item lacks).
      // The item stays claimed so it isn't retried forever; surface why.
      logActivity({
        userId: feed.userId,
        organizationId: feed.organizationId,
        action: 'rss.item_skipped',
        resource: 'rss_feed',
        resourceId: feed.id,
        details: {
          feedName: feed.name,
          title: item.title.slice(0, 120),
          reasons: skipped.map((r) => ({ channelId: r.channelId, platform: r.platform, reason: r.skipReason })),
        },
      });
      logger.info({ feedId: feed.id, guid: item.guid, reasons: skipped.map((r) => r.skipReason) }, 'RSS item skipped on all channels');
      await db
        .update(rssFeedItems)
        .set({ status: 'skipped' })
        .where(and(eq(rssFeedItems.feedId, feed.id), eq(rssFeedItems.guid, item.guid)));
      continue;
    }

    // Base content + per-platform overrides — same model the Composer writes.
    const content = usable.find((r) => !r.overridden)?.text ?? usable[0].text;
    const platformContent: Record<string, string> = {};
    for (const r of usable) {
      if (r.text !== content) platformContent[r.platform] = r.text;
    }

    // Force draft when the plan doesn't allow auto-publish — this demotes feeds
    // whose org downgraded after enabling publish mode. When limits are omitted
    // (direct callers/tests) auto-publish is allowed, preserving feed.mode.
    const autoPublishAllowed = limits?.rssAutoPublish ?? true;
    const isDraft = feed.mode !== 'publish' || !autoPublishAllowed;
    const [post] = await db
      .insert(posts)
      .values({
        userId: feed.userId,
        organizationId: feed.organizationId,
        content,
        ...(Object.keys(platformContent).length > 0 ? { platformContent } : {}),
        mediaFiles: mediaFiles as any,
        status: isDraft ? 'draft' : 'scheduled',
        // Approval-gated feeds park each auto-published item for an approver.
        // Drafts never publish on their own, so they carry no approval state.
        approvalStatus: !isDraft && feed.requireApproval ? 'pending' : 'none',
        // Due now — the check-scheduled reconciler claims and publishes it.
        scheduledAt: isDraft ? null : new Date(),
        postFormat: 'post',
      })
      .returning();

    await db.insert(postPlatforms).values(
      usable.map((r) => ({
        postId: post.id,
        channelId: r.channelId,
        platform: r.platform,
        status: 'pending' as const,
      })),
    );

    if (skipped.length > 0) {
      logger.info(
        { feedId: feed.id, postId: post.id, skipped: skipped.map((r) => ({ channelId: r.channelId, reason: r.skipReason })) },
        'RSS item skipped on some channels',
      );
    }

    await db
      .update(rssFeedItems)
      .set({ postId: post.id, status: 'posted' })
      .where(and(eq(rssFeedItems.feedId, feed.id), eq(rssFeedItems.guid, item.guid)));

    logActivity({
      userId: feed.userId,
      organizationId: feed.organizationId,
      action: 'rss.item_posted',
      resource: 'rss_feed',
      resourceId: feed.id,
      details: { postId: post.id, feedName: feed.name, mode: feed.mode, title: item.title.slice(0, 120) },
    });

    logger.info({ feedId: feed.id, postId: post.id, mode: feed.mode }, 'RSS item turned into post');
  }
  return validators;
}
