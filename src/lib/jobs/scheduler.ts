import { getQueue, QUEUE_NAMES } from './queue';
import { createLogger } from '../logger';
import type { Queue } from 'bullmq';

const logger = createLogger('scheduler');

// Clear any existing repeatable jobs on a queue so that stale schedulers
// from previous deploys (with different patterns or names) don't keep firing
// alongside the fresh registration. Without this, token-refresh / check-scheduled
// ended up with duplicate ghost schedulers firing back-to-back.
async function clearExistingRepeatables(queue: Queue, jobName: string): Promise<void> {
  const repeatables = await queue.getRepeatableJobs();
  for (const r of repeatables) {
    if (r.name === jobName) {
      await queue.removeRepeatableByKey(r.key);
    }
  }
}

export async function setupRecurringJobs() {
  // Scheduled post publisher - runs every minute
  const publishQueue = getQueue(QUEUE_NAMES.PUBLISH);
  await clearExistingRepeatables(publishQueue, 'check-scheduled');
  await publishQueue.add(
    'check-scheduled',
    {},
    {
      repeat: { pattern: '* * * * *' }, // every minute
      removeOnComplete: 10,
      removeOnFail: 20,
    },
  );
  logger.info('Scheduled publish checker registered (every minute)');

  // Token refresh - runs every 40 minutes so short-lived tokens (e.g. Google
  // 1-hour access tokens) are always fresh before a scheduled post runs.
  // 40 min gives a 20-min safety buffer before the 1-hour expiry.
  const tokenQueue = getQueue(QUEUE_NAMES.TOKEN_REFRESH);
  await clearExistingRepeatables(tokenQueue, 'refresh-expiring-tokens');
  await tokenQueue.add(
    'refresh-expiring-tokens',
    {},
    {
      repeat: { pattern: '*/40 * * * *' }, // every 40 minutes
      removeOnComplete: 5,
      removeOnFail: 20,
    },
  );
  logger.info('Token refresh job registered (every 40 minutes)');

  // Recurring schedule processor - runs every minute
  const recurringQueue = getQueue(QUEUE_NAMES.RECURRING);
  await clearExistingRepeatables(recurringQueue, 'process-recurring');
  await recurringQueue.add(
    'process-recurring',
    {},
    {
      repeat: { pattern: '* * * * *' }, // every minute
      removeOnComplete: 10,
      removeOnFail: 20,
    },
  );
  logger.info('Recurring schedule processor registered (every minute)');

  // Media cleanup check - runs every 5 minutes
  const cleanupQueue = getQueue(QUEUE_NAMES.MEDIA_CLEANUP);
  await clearExistingRepeatables(cleanupQueue, 'check-cleanup');
  await cleanupQueue.add(
    'check-cleanup',
    {},
    {
      repeat: { pattern: '*/5 * * * *' },
      removeOnComplete: 5,
      removeOnFail: 20,
    },
  );
  logger.info('Media cleanup checker registered (every 5 minutes)');

  // Daily digest email was removed — clear any stale repeatable schedulers
  // left in Redis by previous deploys so they stop firing.
  const notificationQueue = getQueue(QUEUE_NAMES.NOTIFICATION);
  await clearExistingRepeatables(notificationQueue, 'daily-digest');
  logger.info('Daily digest removed (stale schedulers cleared)');

  // Metrics sync — background fan-out every 6 hours plus the on-demand path
  // (/api/analytics/refresh on analytics page mount). Without the cron, orgs
  // that publish but rarely open /analytics accumulated zero post_metrics rows,
  // so every dashboard read as empty. The expensive platform is still safe:
  // X reads remain per-channel opt-in + 7-day-throttled inside the worker; all
  // other platforms are free reads.
  const metricsSyncQueue = getQueue(QUEUE_NAMES.METRICS_SYNC);
  await clearExistingRepeatables(metricsSyncQueue, 'sync-all-metrics');
  await metricsSyncQueue.add(
    'sync-all-metrics',
    {},
    {
      repeat: { pattern: '30 */6 * * *' }, // every 6h, offset from the 3 AM jobs
      removeOnComplete: 5,
      removeOnFail: 20,
    },
  );
  logger.info('Metrics sync fan-out registered (every 6 hours)');

  // Daily X API usage snapshot - rolls Redis counters into Postgres for historical display.
  // Runs at 3 AM UTC alongside retention so daily aggregates are in DB before the day rolls.
  const snapshotQueue = getQueue(QUEUE_NAMES.METRICS_SYNC);
  await clearExistingRepeatables(snapshotQueue, 'snapshot-x-api-usage');
  await snapshotQueue.add(
    'snapshot-x-api-usage',
    {},
    {
      repeat: { pattern: '0 3 * * *' }, // 3 AM UTC daily
      removeOnComplete: 5,
      removeOnFail: 20,
    },
  );
  logger.info('X API usage snapshot job registered (daily at 3 AM UTC)');

  // Shortlink clicks — pull from Analytics Engine every 15 minutes. The worker
  // keeps a Redis watermark, so the cadence only affects freshness, never
  // correctness: a missed run is picked up by the next one.
  const linksSyncQueue = getQueue(QUEUE_NAMES.LINKS_SYNC);
  await clearExistingRepeatables(linksSyncQueue, 'sync-link-clicks');
  await linksSyncQueue.add(
    'sync-link-clicks',
    {},
    {
      repeat: { pattern: '*/15 * * * *' },
      removeOnComplete: 5,
      removeOnFail: 20,
    },
  );
  logger.info('Shortlink click sync registered (every 15 minutes)');

  // RSS autopost — poll enabled feeds every 15 minutes.
  const rssQueue = getQueue(QUEUE_NAMES.RSS);
  await clearExistingRepeatables(rssQueue, 'poll-feeds');
  await rssQueue.add(
    'poll-feeds',
    {},
    {
      repeat: { pattern: '*/15 * * * *' },
      removeOnComplete: 5,
      removeOnFail: 20,
    },
  );
  logger.info('RSS feed poller registered (every 15 minutes)');

  // Extra channel slots — hourly lifecycle pass: expiry-warning emails (7d/1d)
  // and over-limit enforcement for expired/refunded slots. Idempotent via the
  // warned/enforced stamps on channel_slots, so cadence only affects how fast a
  // lapse is acted on, never correctness.
  const channelSlotsQueue = getQueue(QUEUE_NAMES.CHANNEL_SLOTS);
  await clearExistingRepeatables(channelSlotsQueue, 'process-channel-slots');
  await channelSlotsQueue.add(
    'process-channel-slots',
    {},
    {
      repeat: { pattern: '25 * * * *' }, // hourly, offset from other jobs
      removeOnComplete: 5,
      removeOnFail: 20,
    },
  );
  logger.info('Channel slot lifecycle job registered (hourly)');

  // Data retention - runs daily at 3 AM
  const retentionQueue = getQueue(QUEUE_NAMES.RETENTION);
  await clearExistingRepeatables(retentionQueue, 'run-retention');
  await retentionQueue.add(
    'run-retention',
    {},
    {
      repeat: { pattern: '0 3 * * *' }, // 3 AM daily
      removeOnComplete: 3,
      removeOnFail: 10,
    },
  );
  logger.info('Data retention job registered (daily at 3 AM)');
}
