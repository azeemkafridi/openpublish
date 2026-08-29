import { Worker, type Job } from 'bullmq';
import { getRedisConnection, QUEUE_NAMES } from './queue';
import { cleanupPostMedia } from '../media/storage';
import { deleteMediaFile, generateThumbnailsForMedia } from '../media/upload';
import { createLogger } from '../logger';

const logger = createLogger('media-cleanup-worker');

export function createMediaCleanupWorker() {
  return new Worker(
    QUEUE_NAMES.MEDIA_CLEANUP,
    async (job: Job) => {
      if (job.name === 'cleanup-media') {
        const { postId } = job.data;
        logger.info({ postId }, 'Running media cleanup for post');
        await cleanupPostMedia(postId);
        return;
      }

      if (job.name === 'generate-thumbnails') {
        const { mediaId } = job.data;
        logger.info({ mediaId }, 'Generating media thumbnails from R2');
        await generateThumbnailsForMedia(mediaId);
        return;
      }

      if (job.name === 'delete-files') {
        const { paths } = job.data as { paths: string[] };
        logger.info({ count: paths.length }, 'Deleting media files from R2');
        for (const p of paths) {
          try {
            await deleteMediaFile(p);
          } catch (err) {
            logger.warn({ path: p, error: err }, 'Failed to delete file from R2');
          }
        }
        return;
      }

      if (job.name === 'check-cleanup') {
        logger.debug('Periodic media cleanup check');
        return;
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 2,
    },
  );
}
