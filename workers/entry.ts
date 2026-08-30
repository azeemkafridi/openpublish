import 'dotenv/config';
import { createPublishWorker } from '../src/lib/jobs/publish.worker';
import { createStatusCheckWorker } from '../src/lib/jobs/status-check.worker';
import { createTokenRefreshWorker } from '../src/lib/jobs/token-refresh.worker';
import { createMediaCleanupWorker } from '../src/lib/jobs/media-cleanup.worker';
import { createNotificationWorker } from '../src/lib/jobs/notification.worker';
import { createRetentionWorker } from '../src/lib/jobs/retention.worker';
import { createMetricsSyncWorker } from '../src/lib/jobs/metrics-sync.worker';
import { createEngagementCheckWorker } from '../src/lib/jobs/engagement-check.worker';
import { setupRecurringJobs } from '../src/lib/jobs/scheduler';
import { closeRedisConnection } from '../src/lib/jobs/queue';
import { createLogger } from '../src/lib/logger';

const logger = createLogger('worker-main');

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled rejection in worker process');
  process.exit(1);
});
process.on('uncaughtException', (error) => {
  logger.error({ error }, 'Uncaught exception in worker process');
  process.exit(1);
});

async function main() {
  if (process.env.ENGINE === 'cloud') {
    logger.info('ENGINE=cloud — publishing runs in the BulkPublish cloud; local workers are not needed. Exiting.');
    return;
  }
  logger.info('Starting openPublish workers...');

  // Register platform handlers
  await import('../src/lib/platforms/init');
  logger.info('Platform handlers registered');

  // Create all workers
  const publishWorker = createPublishWorker();
  logger.info('Publish worker started');

  const statusCheckWorker = createStatusCheckWorker();
  logger.info('Status check worker started');

  const tokenRefreshWorker = createTokenRefreshWorker();
  logger.info('Token refresh worker started');

  const mediaCleanupWorker = createMediaCleanupWorker();
  logger.info('Media cleanup worker started');

  const notificationWorker = createNotificationWorker();
  logger.info('Notification worker started');

  const retentionWorker = createRetentionWorker();
  logger.info('Retention worker started');

  const metricsSyncWorker = createMetricsSyncWorker();
  logger.info('Metrics sync worker started');

  const engagementCheckWorker = createEngagementCheckWorker();
  logger.info('Engagement check worker started');

  // BullMQ re-emits Redis/ioredis errors on each Worker. Without an 'error' listener the
  // event is thrown, trips the uncaughtException handler above, and exits the process —
  // turning a transient Redis blip into a crash-loop that abandons in-flight jobs. Log and
  // keep running instead; BullMQ reconnects on its own.
  const workers = [
    publishWorker, statusCheckWorker, tokenRefreshWorker, mediaCleanupWorker,
    notificationWorker, retentionWorker, metricsSyncWorker,
    engagementCheckWorker,
  ];
  for (const w of workers) {
    w.on('error', (err) => logger.error({ err }, 'BullMQ worker error (non-fatal)'));

    // Only log a failure loudly once a job has exhausted its retries — logging every
    // intermediate attempt would bury real failures under transient ones.
    w.on('failed', (job, err) => {
      const attempts = job?.opts?.attempts ?? 1;
      const made = job?.attemptsMade ?? 0;
      const exhausted = made >= attempts;
      logger.error(
        { queue: w.name, jobId: job?.id, jobName: job?.name, attempt: made, attempts, err },
        exhausted ? 'Job failed permanently' : 'Job attempt failed, will retry',
      );
    });
  }

  // Set up recurring cron jobs
  await setupRecurringJobs();
  logger.info('Recurring jobs scheduled');

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down workers...');
    await Promise.all(workers.map((w) => w.close()));
    await closeRedisConnection();
    logger.info('All workers shut down');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('All workers running. Press Ctrl+C to stop.');
}

main().catch((error) => {
  logger.error({ error }, 'Worker startup failed');
  process.exit(1);
});
