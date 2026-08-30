import fs from 'node:fs';
import { Worker, type Job } from 'bullmq';
import { getRedisConnection, QUEUE_NAMES } from './queue';
import { db } from '../db';
import {
  posts,
  mediaFiles,
  activityLogs,
  notifications,
  postMetrics,
  accountMetrics,
} from '../db/schema';
import { eq, and, lt, gt, asc, or, sql } from 'drizzle-orm';
import { deleteFromR2, isR2Key } from '../media/r2';
import { createLogger } from '../logger';

const logger = createLogger('retention-worker');

const RETENTION_MONTHS = 3;
// Platform statistics (post + account metrics) are capped at 30 days to comply with the
// YouTube API Services Developer Policies (III.E.4) and the equivalent retention limits in
// the Meta, X, TikTok, LinkedIn and Pinterest developer terms. This is shorter than the
// general content-retention window above and applies to every platform uniformly.
const METRICS_RETENTION_DAYS = 30;
const BATCH_SIZE = 50;

function getCutoffDate(): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - RETENTION_MONTHS);
  return d;
}

function getMetricsCutoffDate(): Date {
  const d = new Date();
  d.setDate(d.getDate() - METRICS_RETENTION_DAYS);
  return d;
}

/** Delete a stored media file (R2 object or local path); never throws. */
async function deleteStoredFile(mediaId: number, path: string | null | undefined): Promise<void> {
  if (!path) return;
  try {
    if (isR2Key(path)) {
      await deleteFromR2(path);
    } else if (fs.existsSync(path)) {
      fs.unlinkSync(path);
    }
  } catch (err) {
    logger.warn({ mediaId, path, err }, 'Failed to delete media file');
  }
}

/**
 * Purge content from old posts while keeping rows for analytics.
 *
 * Nulls out content + mediaFiles references only — it does NOT delete the media
 * itself, because the same file may be reused by another post. Once the reference
 * is removed, purgeOrphanedMedia (run immediately after) reference-checks each
 * file and deletes only true orphans.
 */
async function purgeOldPostContent(): Promise<number> {
  const cutoff = getCutoffDate();
  let totalPurged = 0;

  // Paginate by id — the cursor guarantees forward progress.
  let lastId = 0;
  for (;;) {
    const oldPosts = await db
      .select({
        id: posts.id,
      })
      .from(posts)
      .where(
        and(
          gt(posts.id, lastId),
          lt(posts.createdAt, cutoff),
          // Only posts that still have content to purge
          sql`(${posts.content} IS NOT NULL AND ${posts.content} != '')`,
        ),
      )
      .orderBy(asc(posts.id))
      .limit(BATCH_SIZE);

    if (oldPosts.length === 0) break;

    for (const post of oldPosts) {
      lastId = post.id;

      // Drop only the post's content and its media references. The media rows are
      // left for purgeOrphanedMedia, which deletes a file only if no post still
      // references it.
      await db
        .update(posts)
        .set({
          content: null,
          mediaFiles: [],
        })
        .where(eq(posts.id, post.id));

      totalPurged++;
    }
  }

  return totalPurged;
}

/**
 * Sweep orphaned media — files older than the retention window that no post
 * references anymore. Catches uploads abandoned before submit and leftovers from
 * an import that failed mid-batch. (Media still attached to a post is handled by
 * purgeOldPostContent; this is the "attached to nothing" case it can't see.)
 *
 * Paginates by id so a still-referenced candidate is never re-scanned in a loop, and
 * reuses the same JSONB containment check as cleanupPostMedia (both `[id]` and
 * `[{id}]` storage formats).
 */
async function purgeOrphanedMedia(): Promise<number> {
  const cutoff = getCutoffDate();
  let totalDeleted = 0;
  let lastId = 0;

  for (;;) {
    const candidates = await db
      .select()
      .from(mediaFiles)
      .where(and(
        gt(mediaFiles.id, lastId),
        lt(mediaFiles.createdAt, cutoff),
        eq(mediaFiles.isOriginalDeleted, false),
      ))
      .orderBy(asc(mediaFiles.id))
      .limit(BATCH_SIZE);
    if (candidates.length === 0) break;

    for (const mf of candidates) {
      lastId = mf.id;

      // Still referenced by a post? (matches both stored formats)
      const [post] = await db
        .select({ id: posts.id })
        .from(posts)
        .where(and(
          eq(posts.organizationId, mf.organizationId),
          or(
            sql`${posts.mediaFiles} @> ${JSON.stringify([mf.id])}::jsonb`,
            sql`${posts.mediaFiles} @> ${JSON.stringify([{ id: mf.id }])}::jsonb`,
          ),
        ))
        .limit(1);
      if (post) continue;

      // Orphan — delete every derived file, then the row.
      await deleteStoredFile(mf.id, mf.originalPath);
      await deleteStoredFile(mf.id, mf.thumbnailPath);
      await deleteStoredFile(mf.id, mf.previewPath);
      await deleteStoredFile(mf.id, mf.largePath);
      const variants = (mf.variants ?? {}) as Record<string, { path?: string }>;
      for (const v of Object.values(variants)) await deleteStoredFile(mf.id, v?.path);
      await db.delete(mediaFiles).where(eq(mediaFiles.id, mf.id));
      totalDeleted++;
    }
  }
  return totalDeleted;
}

/**
 * Delete activity log entries older than the retention window.
 */
async function purgeOldActivityLogs(): Promise<number> {
  const cutoff = getCutoffDate();
  const result = await db
    .delete(activityLogs)
    .where(lt(activityLogs.createdAt, cutoff))
    .returning({ id: activityLogs.id });
  return result.length;
}

/**
 * Delete notifications older than the retention window.
 */
async function purgeOldNotifications(): Promise<number> {
  const cutoff = getCutoffDate();
  const result = await db
    .delete(notifications)
    .where(lt(notifications.createdAt, cutoff))
    .returning({ id: notifications.id });
  return result.length;
}

/**
 * Delete per-post metrics rows older than 30 days (platform-statistics retention cap).
 * `post_metrics` accumulates new rows on every sync — without retention it grows unbounded.
 */
async function purgeOldPostMetrics(): Promise<number> {
  const cutoff = getMetricsCutoffDate();
  const result = await db
    .delete(postMetrics)
    .where(lt(postMetrics.fetchedAt, cutoff))
    .returning({ id: postMetrics.id });
  return result.length;
}

/**
 * Delete daily account-level metrics older than 30 days (platform-statistics retention cap).
 * `account_metrics.date` is a varchar(10) YYYY-MM-DD string, compared lexicographically.
 */
async function purgeOldAccountMetrics(): Promise<number> {
  const cutoff = getMetricsCutoffDate();
  const cutoffDateStr = cutoff.toISOString().slice(0, 10);
  const result = await db
    .delete(accountMetrics)
    .where(lt(accountMetrics.date, cutoffDateStr))
    .returning({ id: accountMetrics.id });
  return result.length;
}

export function createRetentionWorker() {
  return new Worker(
    QUEUE_NAMES.RETENTION,
    async (job: Job) => {
      if (job.name !== 'run-retention') return;

      logger.info('Starting data retention cleanup');
      const start = Date.now();

      try {
        // Purge post content first, so media it frees can be swept as orphaned next.
        const postsPurged = await purgeOldPostContent();
        const [
          orphanMediaDeleted,
          activityDeleted,
          notificationsDeleted,
          postMetricsDeleted,
          accountMetricsDeleted,
        ] = await Promise.all([
          purgeOrphanedMedia(),
          purgeOldActivityLogs(),
          purgeOldNotifications(),
          purgeOldPostMetrics(),
          purgeOldAccountMetrics(),
        ]);

        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        logger.info(
          { postsPurged, orphanMediaDeleted, activityDeleted, notificationsDeleted, postMetricsDeleted, accountMetricsDeleted, elapsed },
          'Data retention cleanup completed',
        );
      } catch (err) {
        logger.error({ err }, 'Data retention cleanup failed');
        throw err;
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 1,
    },
  );
}
