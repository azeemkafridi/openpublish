import { db } from '../db';
import { mediaFiles, posts, postPlatforms } from '../db/schema';
import { eq, and, or, sql, ne } from 'drizzle-orm';
import { deleteFromR2, isR2Key } from './r2';
import { createLogger } from '../logger';
import fs from 'node:fs';

const logger = createLogger('media-storage');

export async function cleanupPostMedia(postId: number): Promise<void> {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post || !post.deleteMediaAfterPublish) return;

  // Check if all platforms are published
  const platforms = await db
    .select()
    .from(postPlatforms)
    .where(eq(postPlatforms.postId, postId));

  const allDone = platforms.every(
    (p) => p.status === 'published' || p.status === 'failed',
  );

  if (!allDone) {
    logger.debug({ postId }, 'Not all platforms done, skipping cleanup');
    return;
  }

  // Delete original files for media referenced in this post (verify ownership)
  const mediaRefs = post.mediaFiles || [];
  for (const ref of mediaRefs) {
    // Handle both formats: plain numeric ID or object with .id
    const mediaId = typeof ref === 'number' ? ref : (ref as any)?.id as number | undefined;
    if (!mediaId) continue;

    // Skip if another post in this org still references the same media file
    const [otherPost] = await db
      .select({ id: posts.id })
      .from(posts)
      .where(and(
        eq(posts.organizationId, post.organizationId),
        ne(posts.id, postId),
        or(
          sql`${posts.mediaFiles} @> ${JSON.stringify([mediaId])}::jsonb`,
          sql`${posts.mediaFiles} @> ${JSON.stringify([{ id: mediaId }])}::jsonb`,
        ),
      ))
      .limit(1);
    if (otherPost) {
      logger.debug({ mediaId, postId }, 'Media referenced by other posts, skipping cleanup');
      continue;
    }

    const [media] = await db
      .select()
      .from(mediaFiles)
      .where(and(eq(mediaFiles.id, mediaId), eq(mediaFiles.organizationId, post.organizationId)))
      .limit(1);

    if (!media || media.isOriginalDeleted) continue;

    try {
      if (isR2Key(media.originalPath)) {
        await deleteFromR2(media.originalPath);
      } else if (fs.existsSync(media.originalPath)) {
        fs.unlinkSync(media.originalPath);
      }

      logger.info(
        { mediaId: media.id, path: media.originalPath },
        'Deleted original media file',
      );

      // Converted variants (jpg_92, bluesky, story_9_16, etc.) are only ever
      // consumed by the publish worker at publish time — once the original is
      // gone, the variants can't power a re-publish, so they're pure storage
      // leak if we leave them. Sweep them alongside the original.
      const variants = (media.variants ?? {}) as Record<string, { path: string; mimeType: string }>;
      const variantNames = Object.keys(variants);
      for (const name of variantNames) {
        const variant = variants[name];
        if (!variant?.path) continue;
        try {
          if (isR2Key(variant.path)) {
            await deleteFromR2(variant.path);
          } else if (fs.existsSync(variant.path)) {
            fs.unlinkSync(variant.path);
          }
          logger.info(
            { mediaId: media.id, variant: name, path: variant.path },
            'Deleted media variant',
          );
        } catch (variantErr) {
          // Don't let a single bad variant block the whole cleanup.
          logger.warn(
            { mediaId: media.id, variant: name, path: variant.path, error: variantErr },
            'Failed to delete media variant',
          );
        }
      }

      await db
        .update(mediaFiles)
        .set({ isOriginalDeleted: true, variants: {} })
        .where(eq(mediaFiles.id, media.id));
    } catch (error) {
      logger.error(
        { mediaId: media.id, error },
        'Failed to delete original media file',
      );
    }
  }
}
