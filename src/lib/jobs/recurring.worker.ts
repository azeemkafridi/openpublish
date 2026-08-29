import { Worker, type Job } from 'bullmq';
import { getRedisConnection, QUEUE_NAMES } from './queue';
import { db } from '../db';
import { recurringSchedules, posts, postPlatforms, channels, mediaFiles } from '../db/schema';
import { eq, and, lt, lte, inArray, count } from 'drizzle-orm';
import { createLogger } from '../logger';
import { logActivity } from '../activity/log';
import { calculateNextRunAt } from '../schedules/next-run';
import { checkPostQuotasBatch, getOrgPlan, getUserLimits } from '../quotas/check';

const logger = createLogger('recurring-worker');

export function createRecurringWorker() {
  return new Worker(
    QUEUE_NAMES.RECURRING,
    async (job: Job) => {
      if (job.name === 'process-recurring') {
        await processRecurringSchedules();
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 1,
    },
  );
}

async function processRecurringSchedules() {
  const now = new Date();

  const dueSchedules = await db
    .select()
    .from(recurringSchedules)
    .where(
      and(
        eq(recurringSchedules.isActive, true),
        lte(recurringSchedules.nextRunAt, now),
      ),
    )
    .limit(10);

  if (dueSchedules.length === 0) return;

  logger.info({ count: dueSchedules.length }, 'Processing due recurring schedules');

  for (const schedule of dueSchedules) {
    try {
      await createPostFromSchedule(schedule);

      // Calculate next run time (timezone-aware)
      const nextRunAt = calculateNextRunAt(
        schedule.frequency,
        schedule.dayOfWeek,
        schedule.dayOfMonth,
        schedule.timeOfDay || '09:00',
        schedule.timezone || 'UTC',
      );

      await db
        .update(recurringSchedules)
        .set({
          lastRunAt: now,
          nextRunAt,
        })
        .where(eq(recurringSchedules.id, schedule.id));

      logger.info(
        { scheduleId: schedule.id, nextRunAt },
        'Recurring schedule processed',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        { scheduleId: schedule.id, error: message },
        'Failed to process recurring schedule',
      );
    }
  }
}

async function createPostFromSchedule(
  schedule: typeof recurringSchedules.$inferSelect,
) {
  // Re-check the PLAN at execution time, not just at creation (mirrors the RSS
  // worker's downgrade handling). Without this, a Pro org's schedules kept
  // firing forever after a downgrade to Free, where recurringSchedules is 0.
  const limits = getUserLimits(await getOrgPlan(schedule.organizationId));
  if (limits.recurringSchedules === 0) {
    logger.warn(
      { scheduleId: schedule.id, orgId: schedule.organizationId },
      'Plan no longer includes recurring schedules — skipping (org downgraded)',
    );
    return;
  }
  if (limits.recurringSchedules > 0) {
    // Downgrade within paid tiers (e.g. Business unlimited → Pro 10): honour the
    // OLDEST `limit` schedules and skip the rest, deterministically, instead of
    // letting whichever fires first squat the quota.
    const [row] = await db
      .select({ n: count() })
      .from(recurringSchedules)
      .where(
        and(
          eq(recurringSchedules.organizationId, schedule.organizationId),
          eq(recurringSchedules.isActive, true),
          lt(recurringSchedules.id, schedule.id),
        ),
      );
    if ((row?.n ?? 0) >= limits.recurringSchedules) {
      logger.warn(
        { scheduleId: schedule.id, orgId: schedule.organizationId, limit: limits.recurringSchedules },
        'Schedule beyond the plan limit — skipping (org downgraded)',
      );
      return;
    }
  }

  // Get channel info to verify they still exist and are active
  const channelIds = schedule.channelIds || [];
  if (channelIds.length === 0) {
    logger.warn({ scheduleId: schedule.id }, 'No channels configured');
    return;
  }

  const activeChannels = await db
    .select()
    .from(channels)
    .where(
      and(eq(channels.isActive, true), eq(channels.organizationId, schedule.organizationId), inArray(channels.id, channelIds)),
    );

  if (activeChannels.length === 0) {
    logger.warn({ scheduleId: schedule.id }, 'No active channels found');
    return;
  }

  // Resolve which media files still exist and aren't deleted; store only IDs
  // (publish worker resolves full URLs fresh from the DB at publish time)
  const scheduleMediaIds = schedule.mediaFileIds || [];
  let validMediaIds: number[] = [];

  if (scheduleMediaIds.length > 0) {
    const media = await db
      .select({ id: mediaFiles.id })
      .from(mediaFiles)
      .where(and(
        inArray(mediaFiles.id, scheduleMediaIds),
        eq(mediaFiles.organizationId, schedule.organizationId),
        eq(mediaFiles.isOriginalDeleted, false),
      ));
    validMediaIds = media.map((m) => m.id);

    // A repeat schedule that specifies media must post WITH that media. The
    // query above drops rows that are gone or whose bytes were swept, so a
    // schedule whose media was deleted would quietly start emitting text-only
    // occurrences — on every future run, indefinitely, with nothing to
    // indicate the posts no longer match what was set up. Skip the occurrence
    // and say why instead.
    if (validMediaIds.length !== scheduleMediaIds.length) {
      const lostIds = scheduleMediaIds.filter((id) => !validMediaIds.includes(id));
      logger.error(
        { scheduleId: schedule.id, orgId: schedule.organizationId, scheduleMediaIds, lostIds },
        'Recurring schedule media is unavailable — skipping this occurrence',
      );
      logActivity({
        userId: schedule.userId,
        organizationId: schedule.organizationId,
        action: 'repeat.skipped',
        resource: 'schedule',
        resourceId: schedule.id,
        level: 'error',
        details: {
          reason: 'media_unavailable',
          scheduleName: schedule.name,
          lostMediaIds: lostIds,
          message: 'Attached media was deleted. Re-attach it to this repeat schedule to resume posting.',
        },
      });
      return;
    }
  }

  // Check quotas before creating
  const quotas = await checkPostQuotasBatch(schedule.organizationId);
  if (!quotas.daily.allowed || !quotas.monthly.allowed) {
    logger.warn({ scheduleId: schedule.id, orgId: schedule.organizationId }, 'Quota exceeded, skipping recurring post');
    return;
  }

  // Create the post
  const [post] = await db
    .insert(posts)
    .values({
      userId: schedule.userId,
      organizationId: schedule.organizationId,
      content: schedule.contentTemplate || '',
      mediaFiles: validMediaIds as any,
      status: 'scheduled',
      // Approval-gated schedules park each occurrence for an approver; the
      // check-scheduled reconciler skips 'pending' posts until then.
      approvalStatus: schedule.requireApproval ? 'pending' : 'none',
      scheduledAt: new Date(), // Due now — published by the next check-scheduled tick (≤1 min)
      timezone: schedule.timezone || 'UTC',
      postFormat: schedule.postFormat || 'post',
      postTypeOverrides: schedule.postTypeOverrides || {},
      platformSpecific: schedule.platformSpecific || {},
      threadParts: schedule.threadParts || null,
      recurringScheduleId: schedule.id,
      deleteMediaAfterPublish: false, // Don't delete media for recurring posts
    })
    .returning();

  // Create post_platform entries for each channel
  for (const channel of activeChannels) {
    await db.insert(postPlatforms).values({
      postId: post.id,
      channelId: channel.id,
      platform: channel.platform,
      status: 'pending',
    });
  }

  // No publish job here. The post is created as 'scheduled' (scheduledAt=now); the publish
  // worker's check-scheduled reconciler atomically claims and publishes it on its next tick.
  // Enqueuing a job too would create a second publish path racing the scheduled checker →
  // the same post published twice.

  logActivity({
    userId: schedule.userId,
    organizationId: schedule.organizationId,
    action: 'repeat.triggered',
    resource: 'schedule',
    resourceId: schedule.id,
    details: { postId: post.id, scheduleName: schedule.name, channels: activeChannels.length },
  });

  logger.info(
    {
      scheduleId: schedule.id,
      postId: post.id,
      channelCount: activeChannels.length,
    },
    'Post created from recurring schedule',
  );
}

