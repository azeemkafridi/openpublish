import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { createLogger } from '../logger';
import { extractVideoFrame, probeVideo } from './ffmpeg';

const logger = createLogger('thumbnail');

// Scratch space only — see the note in upload.ts: this must NOT sit inside the
// local-storage root, or storing a derivative under the `thumbnails/` key would
// land on this same path and the temp cleanup would delete it.
const THUMBNAIL_DIR = path.join(
  path.resolve(process.env.MEDIA_TMP_DIR || path.join(os.tmpdir(), 'openpublish')),
  'thumbnails',
);

// Owned here rather than relying on upload.ts having been imported first —
// sharp's .toFile() throws ENOENT if the directory is missing.
fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });

/**
 * Small square crop for cards, lists, notifications (displayed at 40-80px).
 * 160px covers 80px display @ 2x retina.
 */
const THUMB_SIZE = 160;

/**
 * Medium preview for media library grids, uploaders (displayed at 140-200px).
 * 400px covers 200px display @ 2x retina.
 */
const PREVIEW_WIDTH = 400;

/**
 * Large derivative for lightboxes, composer previews and analytics preview
 * panes (displayed up to ~600px). 1200px covers that @ 2x retina without
 * decoding the original, which for a modern phone photo means tens of MB of
 * bitmap in the browser.
 */
const LARGE_WIDTH = 1200;

export interface ThumbnailResult {
  thumbnailPath: string | null;  // 160x160 square crop
  previewPath: string | null;    // 400px wide proportional
  largePath: string | null;      // 1200px wide proportional
  width?: number;
  height?: number;
  duration?: number;
}

const EMPTY: ThumbnailResult = { thumbnailPath: null, previewPath: null, largePath: null };

export async function generateThumbnail(
  originalPath: string,
  mimeType: string,
  uniqueName: string,
): Promise<ThumbnailResult> {
  if (mimeType.startsWith('image/')) {
    return generateImageThumbnails(originalPath, uniqueName);
  }

  if (mimeType.startsWith('video/')) {
    return generateVideoThumbnail(originalPath, uniqueName);
  }

  return EMPTY;
}

/**
 * Produce the three derivatives from any sharp-readable source (an uploaded
 * image, or a poster frame extracted from a video).
 */
async function renderDerivatives(
  source: string | Buffer,
  uniqueName: string,
): Promise<ThumbnailResult> {
  const baseName = uniqueName.replace(path.extname(uniqueName), '');
  const metadata = await sharp(source).metadata();

  const thumbPath = path.join(THUMBNAIL_DIR, `thumb-${baseName}.webp`);
  await sharp(source)
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', position: 'centre' })
    .webp({ quality: 75 })
    .toFile(thumbPath);

  const previewPath = path.join(THUMBNAIL_DIR, `preview-${baseName}.webp`);
  await sharp(source)
    .resize(PREVIEW_WIDTH, undefined, { withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(previewPath);

  const largePath = path.join(THUMBNAIL_DIR, `large-${baseName}.webp`);
  await sharp(source)
    .resize(LARGE_WIDTH, undefined, { withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(largePath);

  return {
    thumbnailPath: thumbPath,
    previewPath,
    largePath,
    width: metadata.width,
    height: metadata.height,
  };
}

async function generateImageThumbnails(
  originalPath: string,
  uniqueName: string,
): Promise<ThumbnailResult> {
  const result = await renderDerivatives(originalPath, uniqueName);
  logger.debug({ originalPath, ...result }, 'Image derivatives generated');
  return result;
}

/**
 * Extract a poster frame with ffmpeg, then run it through the same sharp
 * pipeline as an image. `originalPath` may be a local file or an http(s) URL
 * (a presigned R2 GET) so ffmpeg can range-read instead of us buffering a
 * multi-hundred-MB video into the worker heap.
 *
 * Returns dimensions/duration from ffprobe even when frame extraction fails, so
 * a video with an unreadable first frame still gets its metadata backfilled.
 */
async function generateVideoThumbnail(
  originalPath: string,
  uniqueName: string,
): Promise<ThumbnailResult> {
  const meta = await probeVideo(originalPath);

  const frame = await extractVideoFrame(originalPath, meta?.duration);
  if (!frame) {
    logger.warn({ originalPath }, 'Video poster extraction produced no frame');
    return { ...EMPTY, width: meta?.width, height: meta?.height, duration: meta?.duration };
  }

  // sharp reads the JPEG from memory; only the single decoded frame is held.
  try {
    const result = await renderDerivatives(frame, uniqueName);
    logger.info({ originalPath, duration: meta?.duration }, 'Video poster generated');
    return {
      ...result,
      // Prefer the container's own dimensions — a rotated video reports
      // display dimensions in the stream that the raw frame doesn't carry.
      width: meta?.width ?? result.width,
      height: meta?.height ?? result.height,
      duration: meta?.duration,
    };
  } catch (err) {
    logger.warn({ originalPath, error: err }, 'Failed to render derivatives from video frame');
    return { ...EMPTY, width: meta?.width, height: meta?.height, duration: meta?.duration };
  }
}
