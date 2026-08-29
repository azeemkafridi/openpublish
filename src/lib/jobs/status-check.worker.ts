import { Worker, type Job } from 'bullmq';
import { getRedisConnection, QUEUE_NAMES, addNotificationJob, addMediaCleanupJob, addPublishJob } from './queue';
import { db } from '../db';
import { postPlatforms, posts, channels } from '../db/schema';
import { eq, and, ne, sql } from 'drizzle-orm';
import { decrypt } from '../auth/crypto';
import { getPlatformHandler } from '../platforms/registry';
import { platformDisplayName } from '../platforms/types';
import type { PlatformName, ChannelData } from '../platforms/types';
import { createLogger } from '../logger';
import { logActivity } from '../activity/log';
import { recordFirstCommentResult } from '../posts/first-comment';

const logger = createLogger('status-check-worker');

/**
 * How many times a platform's own transient ingest failure (StatusResult.retryable
 * — e.g. TikTok's `fail_reason: internal`) re-publishes a post by itself.
 *
 * Auto-retries spend the same per-platform budget as the manual Retry button
 * (postPlatforms.retryCount/maxRetries) and deliberately stop one short of it,
 * so the user always keeps at least one manual retry after we've given up.
 */
export const MAX_AUTO_REPUBLISH = 2;

/**
 * Delay before the automatic re-publish. Long enough for a platform-side blip
 * to pass, and safely under publish.worker's STUCK_RECLAIM_MS (15 min) — a
 * longer delay would let the stuck-post sweep re-drive the same post while our
 * delayed publish job is still sitting in the queue, publishing it twice.
 */
export const AUTO_REPUBLISH_DELAY_MS = 5 * 60_000;

export function createStatusCheckWorker() {
  return new Worker(
    QUEUE_NAMES.STATUS_CHECK,
    async (job: Job) => {
      const { postPlatformId, platform, publishId, channelId } = job.data;

      logger.info(
        { postPlatformId, platform, publishId, attempt: job.attemptsMade },
        'Checking publish status',
      );

      const [pp] = await db
        .select()
        .from(postPlatforms)
        .where(eq(postPlatforms.id, postPlatformId))
        .limit(1);

      // 'pending' means the row was reset out from under this check — by the
      // auto-republish below, or by the user editing the post — so the publish
      // id we were handed is stale and a fresh publish already owns the row.
      // Without this, a job that re-runs after resetting the row (e.g. the
      // enqueue threw and BullMQ retried it) would poll the dead id, see the
      // same failure again, and queue a second publish.
      if (!pp || pp.status === 'published' || pp.status === 'failed' || pp.status === 'pending') {
        logger.info({ postPlatformId, status: pp?.status }, 'Already resolved, skipping');
        return;
      }

      // Fetch post early to get organizationId for channel ownership check
      const [post] = await db
        .select()
        .from(posts)
        .where(eq(posts.id, pp.postId))
        .limit(1);

      if (!post) {
        logger.error({ postPlatformId, postId: pp.postId }, 'Post not found');
        return;
      }

      const [channel] = await db
        .select()
        .from(channels)
        .where(and(eq(channels.id, channelId), eq(channels.organizationId, post.organizationId)))
        .limit(1);

      if (!channel) {
        logger.error({ channelId }, 'Channel not found');
        await db
          .update(postPlatforms)
          .set({
            status: 'failed',
            errorMessage: 'Channel not found or disconnected',
          })
          .where(eq(postPlatforms.id, postPlatformId));
        await updatePostStatus(pp.postId);
        return;
      }

      const handler = getPlatformHandler(platform as PlatformName);

      const channelData: ChannelData = {
        id: channel.id,
        platform: channel.platform as PlatformName,
        accountId: channel.accountId,
        accountName: channel.accountName,
        accountType: channel.accountType ?? undefined,
        accessToken: channel.accessToken ? decrypt(channel.accessToken) : '',
        refreshToken: channel.refreshToken ? decrypt(channel.refreshToken) : undefined,
        metadata: channel.metadata as Record<string, unknown>,
      };

      let result;
      try {
        result = await handler.checkPublishStatus(channelData, publishId);
      } catch (err) {
        // A thrown error (network/5xx) on the FINAL attempt must still resolve the row —
        // otherwise it's stuck 'processing' forever. Earlier attempts re-throw so BullMQ
        // retries as normal.
        if (job.attemptsMade >= (job.opts?.attempts || 20) - 1) {
          logger.error({ postPlatformId, err }, 'Status check threw on the final attempt — marking failed');
          await db
            .update(postPlatforms)
            .set({ status: 'failed', errorMessage: 'Publishing status could not be confirmed' })
            .where(eq(postPlatforms.id, postPlatformId));
          await updatePostStatus(pp.postId);
          return;
        }
        throw err;
      }

      if (result.status === 'published') {
        await db
          .update(postPlatforms)
          .set({
            status: 'published',
            platformPostId: result.postId || publishId,
            // Only set the permalink if checkStatus resolved one. Some platforms
            // (e.g. YouTube) already saved it during publish and don't return it
            // here — don't overwrite a good URL with undefined.
            ...(result.url ? { platformUrl: result.url } : {}),
            publishedAt: new Date(),
            // Clear any transient error left by an auto-republish attempt.
            errorMessage: null,
          })
          .where(eq(postPlatforms.id, postPlatformId));

        logger.info({ postPlatformId, postId: result.postId }, 'Platform publish confirmed');

        // Log activity for async publish confirmation
        {
          logActivity({
            userId: post.userId,
            organizationId: post.organizationId,
            action: 'post.status_confirmed',
            resourceId: pp.postId,
            details: { platform, publishId },
          });

          // Post first comment (deferred from publish worker for async platforms)
          const firstComment = (post.platformSpecific as Record<string, unknown> | undefined)?._firstComment as string | undefined;
          const confirmedPostId = result.postId || publishId;
          if (firstComment && confirmedPostId) {
            try {
              const commentResult = await handler.publishComment(channelData, confirmedPostId, firstComment);
              logger.info({ platform, postId: confirmedPostId, success: commentResult.success }, 'First comment result (async)');
              await recordFirstCommentResult(pp.postId, platform, {
                status: commentResult.success ? 'posted' : 'failed',
                error: commentResult.success ? undefined : commentResult.error,
                at: new Date().toISOString(),
              }).catch(() => {});
            } catch (commentErr) {
              logger.warn({ platform, error: commentErr }, 'First comment failed after async confirmation');
              await recordFirstCommentResult(pp.postId, platform, {
                status: 'failed',
                error: commentErr instanceof Error ? commentErr.message : String(commentErr),
                at: new Date().toISOString(),
              }).catch(() => {});
            }
          }
        }

        // Update overall post status
        await updatePostStatus(pp.postId);
      } else if (result.status === 'failed') {
        // The platform failed for a reason IT calls transient (TikTok
        // `fail_reason: internal`, a timed-out media pull). Polling again is
        // useless — the publish id is spent — so re-run the whole publish
        // instead of failing the post and making the user press Retry for a
        // blip on the platform's side.
        const retryCount = pp.retryCount ?? 0;
        const autoBudget = Math.min(MAX_AUTO_REPUBLISH, Math.max(0, (pp.maxRetries ?? 3) - 1));

        if (result.retryable && retryCount < autoBudget) {
          await db
            .update(postPlatforms)
            .set({
              status: 'pending',
              errorMessage: result.message || 'Publishing failed',
              // The publish id died with this attempt; the re-publish mints a
              // fresh one. Leaving it would point the row at a dead upload.
              platformPostId: null,
              retryCount: sql`${postPlatforms.retryCount} + 1`,
            })
            .where(eq(postPlatforms.id, postPlatformId));

          // Atomically flip the post back to 'publishing' — same claim the
          // manual retry endpoint uses. If another job already did (two
          // platforms of one post failing together), it enqueued the publish
          // job and our 'pending' row rides along with it.
          const [claimed] = await db
            .update(posts)
            .set({ status: 'publishing', updatedAt: new Date() })
            .where(and(eq(posts.id, pp.postId), ne(posts.status, 'publishing')))
            .returning({ id: posts.id });

          if (claimed) {
            await addPublishJob(pp.postId, AUTO_REPUBLISH_DELAY_MS);
          }

          logger.warn(
            { postPlatformId, platform, message: result.message, attempt: retryCount + 1, autoBudget, enqueued: !!claimed },
            'Platform reported a retryable failure — re-publishing automatically',
          );

          logActivity({
            userId: post.userId,
            organizationId: post.organizationId,
            action: 'post.retried',
            resourceId: pp.postId,
            details: { platform, auto: true, reason: result.message, attempt: retryCount + 1 },
            level: 'warning',
          });

          // No user notification: they only hear about it if the retries run out.
          return;
        }

        // Say so when this post has already been retried — otherwise the email
        // reads like a one-off blip nobody even tried to ride out. Phrased for
        // retryCount as a whole: it also counts manual retries.
        const failureMessage =
          result.retryable && retryCount > 0
            ? `${result.message || 'Publishing failed'} This post was already retried ${retryCount} ${retryCount === 1 ? 'time' : 'times'} without success.`
            : result.message || 'Publishing failed';

        await db
          .update(postPlatforms)
          .set({
            status: 'failed',
            errorMessage: failureMessage,
          })
          .where(eq(postPlatforms.id, postPlatformId));

        logger.error({ postPlatformId, message: failureMessage, retryCount }, 'Platform publish failed');

        // Send failure notification
        logActivity({
          userId: post.userId,
          organizationId: post.organizationId,
          action: 'post.status_failed',
          resourceId: pp.postId,
          details: { platform, error: failureMessage },
          level: 'error',
        });

        await addNotificationJob(
          post.userId,
          'post_failed',
          `Failed to publish to ${platformDisplayName(platform)}`,
          failureMessage,
          { postId: pp.postId, platform, channelId },
          post.organizationId,
        );

        await updatePostStatus(pp.postId);
      } else {
        // Still processing - check if this is the last attempt
        if (job.attemptsMade >= (job.opts?.attempts || 20) - 1) {
          logger.error(
            { postPlatformId, attempts: job.attemptsMade },
            'Status check exhausted all attempts, marking as failed',
          );
          await db
            .update(postPlatforms)
            .set({
              status: 'failed',
              errorMessage: 'Publishing timed out - platform did not confirm publication',
            })
            .where(eq(postPlatforms.id, postPlatformId));

          // Send failure notification
          logActivity({
            userId: post.userId,
            organizationId: post.organizationId,
            action: 'post.status_failed',
            resourceId: pp.postId,
            details: { platform, error: 'Publishing timed out' },
            level: 'error',
          });

          await addNotificationJob(
            post.userId,
            'post_failed',
            `Failed to publish to ${platformDisplayName(platform)}`,
            'Publishing timed out - platform did not confirm publication',
            { postId: pp.postId, platform, channelId },
            post.organizationId,
          );

          await updatePostStatus(pp.postId);
          return;
        }

        // BullMQ will retry based on the job configuration
        logger.info(
          { postPlatformId, message: result.message },
          'Still processing, will retry',
        );
        throw new Error(`Still processing: ${result.message}`);
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 5,
    },
  );
}

async function updatePostStatus(postId: number) {
  const platforms = await db
    .select()
    .from(postPlatforms)
    .where(eq(postPlatforms.postId, postId));

  const allDone = platforms.every(
    (p) => p.status === 'published' || p.status === 'failed',
  );

  if (!allDone) return;

  const anyPublished = platforms.some((p) => p.status === 'published');
  const allPublished = platforms.every((p) => p.status === 'published');

  let status: 'published' | 'partial' | 'failed';
  if (allPublished) {
    status = 'published';
  } else if (anyPublished) {
    status = 'partial';
  } else {
    status = 'failed';
  }

  await db
    .update(posts)
    .set({
      status,
      // Preserve the first publish time — this runs again on retries and on
      // every async confirmation.
      publishedAt: anyPublished ? sql`COALESCE(${posts.publishedAt}, NOW())` : undefined,
      updatedAt: new Date(),
    })
    .where(eq(posts.id, postId));

  // Posts finalized here (any platform that went through async 'processing')
  // never hit the publish worker's cleanup enqueue — without this, media with
  // deleteMediaAfterPublish=true is stranded forever (isOriginalDeleted stays false).
  // Deliberately 'published' only. A partial post still has a failed channel the
  // user can retry, and cleanupPostMedia would delete the R2 originals that the
  // retry needs (lib/media/storage.ts treats published-or-failed as "all done",
  // and the publish path reads originalPath with no isOriginalDeleted guard).
  if (status === 'published') {
    const [post] = await db
      .select({ deleteMediaAfterPublish: posts.deleteMediaAfterPublish })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);
    if (post?.deleteMediaAfterPublish) {
      await addMediaCleanupJob(postId);
    }
  }

  logger.info({ postId, status }, 'Post status updated after status check');
}
