import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { createLogger } from '../logger';

const logger = createLogger('jobs');

let connection: IORedis | null = null;

export function getRedisConnection(): IORedis {
  if (!connection) {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    connection = new IORedis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    connection.on('error', (err) => {
      logger.error({ error: err.message }, 'Redis connection error');
    });
  }
  return connection;
}

// Queue names
export const QUEUE_NAMES = {
  PUBLISH: 'publish',
  STATUS_CHECK: 'status-check',
  TOKEN_REFRESH: 'token-refresh',
  MEDIA_CLEANUP: 'media-cleanup',
  NOTIFICATION: 'notification',
  RETENTION: 'retention',
  METRICS_SYNC: 'metrics-sync',
  ENGAGEMENT_CHECK: 'engagement-check',
} as const;

const queues = new Map<string, Queue>();

export function getQueue(name: string): Queue {
  if (!queues.has(name)) {
    const queue = new Queue(name, { connection: getRedisConnection() });
    // BullMQ re-emits Redis errors on the Queue emitter; an unhandled 'error' event is
    // thrown and (in the web process, which has no uncaughtException guard) crashes it.
    // Log and let BullMQ reconnect instead.
    queue.on('error', (err) => logger.error({ queue: name, error: err.message }, 'Queue error'));
    queues.set(name, queue);
  }
  return queues.get(name)!;
}

// Helper to add jobs
export async function addPublishJob(postId: number, delay?: number) {
  const queue = getQueue(QUEUE_NAMES.PUBLISH);
  await queue.add(
    'publish-post',
    { postId },
    {
      delay,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  );
  logger.info({ postId, delay }, 'Added publish job');
}

export async function addStatusCheckJob(
  postPlatformId: number,
  platform: string,
  publishId: string,
  channelId: number,
) {
  const queue = getQueue(QUEUE_NAMES.STATUS_CHECK);
  await queue.add(
    'check-status',
    { postPlatformId, platform, publishId, channelId },
    {
      // First check fires fast so IG/Threads containers that are ready in <2s get finalized
      // within the same UI frame the user is still watching. Fixed 3s polling then gives a
      // ~6min budget — long enough for slow TikTok/IG video processing so we don't
      // false-"timeout" a video that publishes a few minutes later (which would prompt a
      // user retry → duplicate). Fast posts still resolve in the first attempt or two.
      delay: 1000,
      attempts: 120,
      backoff: { type: 'fixed', delay: 3000 },
      removeOnComplete: 50,
      removeOnFail: 100,
    },
  );
}

export async function addMediaCleanupJob(postId: number) {
  const queue = getQueue(QUEUE_NAMES.MEDIA_CLEANUP);
  await queue.add(
    'cleanup-media',
    { postId },
    {
      delay: 60000, // Wait 1 minute after publish
      removeOnComplete: 50,
      removeOnFail: 100,
    },
  );
}

/**
 * Generate the 160px thumbnail + 400px preview for a media file the browser
 * uploaded straight to R2 (the SSR never saw the bytes). The worker pulls the
 * now-small object from R2, derives both sizes, and backfills the DB row.
 */
export async function addMediaThumbnailJob(mediaId: number) {
  const queue = getQueue(QUEUE_NAMES.MEDIA_CLEANUP);
  await queue.add(
    'generate-thumbnails',
    { mediaId },
    {
      removeOnComplete: 100,
      removeOnFail: 200,
      attempts: 3,
      backoff: { type: 'fixed', delay: 5000 },
    },
  );
}

/**
 * Delete R2 objects in the background. `delayMs` defaults to a short safety
 * delay; the publish worker passes a longer delay for transient platform-format
 * conversions so pull-based platforms (IG/FB) finish fetching the URL first.
 */
export async function addMediaDeleteJob(paths: string[], delayMs = 1000) {
  const queue = getQueue(QUEUE_NAMES.MEDIA_CLEANUP);
  await queue.add(
    'delete-files',
    { paths },
    {
      delay: delayMs,
      removeOnComplete: 50,
      removeOnFail: 100,
    },
  );
}

export async function addNotificationJob(
  userId: string,
  type: string,
  title: string,
  message: string,
  data?: Record<string, unknown>,
  organizationId?: number,
) {
  const queue = getQueue(QUEUE_NAMES.NOTIFICATION);
  await queue.add(
    'send-notification',
    { userId, type, title, message, data, organizationId },
    { removeOnComplete: 100, removeOnFail: 100 },
  );
}

export async function addMetricsSyncJob(organizationId?: number) {
  const queue = getQueue(QUEUE_NAMES.METRICS_SYNC);
  const jobName = organizationId ? 'sync-metrics' : 'sync-all-metrics';
  await queue.add(
    jobName,
    { organizationId },
    {
      removeOnComplete: 50,
      removeOnFail: 100,
    },
  );
  logger.info({ organizationId, jobName }, 'Added metrics sync job');
}

// Auto-plug/auto-repost engagement checks: a bounded set of delayed per-post jobs
// scheduled at publish time (Postiz-style), instead of piggybacking on the org-wide
// metrics sweep. Each check reads ONLY that post's metrics, so API cost is
// O(opted-in posts × 4) — never a recurring poll. Checks stop early once both
// automations have fired (see engagement-check.worker.ts).
export const ENGAGEMENT_CHECK_DELAYS_MS = [
  1 * 60 * 60 * 1000, //  1h — catches fast-viral posts
  6 * 60 * 60 * 1000, //  6h
  24 * 60 * 60 * 1000, // 24h
  72 * 60 * 60 * 1000, // 72h — slow burners; after this the post is done, forever
] as const;

export function engagementCheckJobId(postId: number, checkNumber: number): string {
  // NO COLONS: BullMQ rejects them in a custom job id ("Custom Id cannot
  // contain :") because it namespaces its own Redis keys with them. This threw
  // on every call, so engagement checks were never scheduled at all.
  return `engagement-${postId}-${checkNumber}`;
}

export async function addEngagementCheckJobs(postId: number) {
  const queue = getQueue(QUEUE_NAMES.ENGAGEMENT_CHECK);
  for (let i = 0; i < ENGAGEMENT_CHECK_DELAYS_MS.length; i++) {
    const checkNumber = i + 1;
    await queue.add(
      'check-engagement',
      { postId, checkNumber },
      {
        // Deterministic jobId dedupes re-enqueues (publish retries, partial→published
        // transitions) while a check is still scheduled — BullMQ ignores an add with
        // an existing jobId.
        jobId: engagementCheckJobId(postId, checkNumber),
        delay: ENGAGEMENT_CHECK_DELAYS_MS[i],
        attempts: 2,
        backoff: { type: 'fixed', delay: 60_000 },
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    );
  }
  logger.info({ postId, checks: ENGAGEMENT_CHECK_DELAYS_MS.length }, 'Scheduled engagement checks');
}

/** Cancel the not-yet-run engagement checks for a post (after fire or expiry). */
export async function removeRemainingEngagementChecks(postId: number, afterCheckNumber: number) {
  const queue = getQueue(QUEUE_NAMES.ENGAGEMENT_CHECK);
  for (let n = afterCheckNumber + 1; n <= ENGAGEMENT_CHECK_DELAYS_MS.length; n++) {
    // remove() is a no-op error for missing/active jobs — best-effort is fine here:
    // a check that survives cancellation exits early on the fired flags anyway.
    await queue.remove(engagementCheckJobId(postId, n)).catch(() => {});
  }
}

export async function closeRedisConnection(): Promise<void> {
  if (connection) {
    await connection.quit();
    connection = null;
  }
}

export type { Job };
