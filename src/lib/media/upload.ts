import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { generateThumbnail } from './thumbnail';
import { uploadToR2, deleteFromR2, deleteMultipleFromR2, downloadFromR2, getR2PublicUrl, isR2Key, getPresignedDownloadUrl } from './r2';
import { db } from '../db';
import { mediaFiles } from '../db/schema';
import { createLogger } from '../logger';

const logger = createLogger('media-upload');

const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
const ORIGINAL_DIR = path.join(UPLOAD_DIR, 'original');
const THUMBNAIL_DIR = path.join(UPLOAD_DIR, 'thumbnails');
const CONVERTED_DIR = path.join(UPLOAD_DIR, 'converted');

// Ensure local temp directories exist (still needed for Sharp processing)
for (const dir of [ORIGINAL_DIR, THUMBNAIL_DIR, CONVERTED_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export interface UploadResult {
  id: number;
  originalPath: string;
  thumbnailPath: string | null;  // 160x160 square crop for cards
  previewPath: string | null;    // 400px wide for grids
  largePath: string | null;      // 1200px wide for lightboxes/preview panes
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  duration?: number;
}

/**
 * `media_files.file_name` is varchar(255) and this value is display-only — the
 * bytes are addressed by `originalPath`, which is a generated key. It is not
 * bounded at any caller: a browser upload carries whatever name the OS had, and
 * `rehostUrlToMedia` derives it from the last path segment of a remote URL,
 * which for signed CDN links (Telegram, Google) routinely runs 300–400 chars.
 *
 * Nothing caught that until Postgres did, at the very end of the work: the R2
 * original and all three derivatives upload first, so the overflow threw after
 * four successful writes, orphaning them. Worse, IFTTT treats a media failure
 * as non-fatal, so the post was created with no media and then failed to
 * publish with "requires an image (no media attached)" — telling the user they
 * had attached nothing when they had. Clamp here, at the one choke point every
 * upload path shares, and keep the extension so the name stays meaningful.
 */
const MAX_FILE_NAME = 255;

export function clampFileName(name: string, ext: string): string {
  const trimmed = (name || '').trim() || `media${ext}`;
  if (trimmed.length <= MAX_FILE_NAME) return trimmed;
  // Reserve room for the extension so "photo.jpg" never becomes "photo.j".
  const keep = Math.max(1, MAX_FILE_NAME - ext.length);
  return trimmed.slice(0, keep) + ext;
}

export async function saveUploadedFile(
  userId: string,
  file: File,
  organizationId: number,
): Promise<UploadResult> {
  const ext = path.extname(file.name).toLowerCase();
  const safeFileName = clampFileName(file.name, ext);
  const uniqueName = `${Date.now()}-${randomBytes(8).toString('hex')}${ext}`;
  const tempPath = path.join(ORIGINAL_DIR, uniqueName);

  // Write to local temp for Sharp processing
  const buffer = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(tempPath, buffer);

  // Upload original to R2
  const r2Key = `original/${uniqueName}`;
  await uploadToR2(r2Key, buffer, file.type);

  logger.info(
    { fileName: file.name, size: buffer.length, mimeType: file.type, r2Key },
    'File uploaded to R2',
  );

  // Generate derivatives locally (square thumb + medium preview + large).
  // For video this extracts a poster frame with ffmpeg first.
  let thumbnailR2Key: string | null = null;
  let previewR2Key: string | null = null;
  let largeR2Key: string | null = null;
  let width: number | undefined;
  let height: number | undefined;
  let duration: number | undefined;

  try {
    const thumbResult = await generateThumbnail(tempPath, file.type, uniqueName);
    width = thumbResult.width;
    height = thumbResult.height;
    duration = thumbResult.duration;

    const uploaded = await uploadDerivatives(thumbResult);
    thumbnailR2Key = uploaded.thumbnailR2Key;
    previewR2Key = uploaded.previewR2Key;
    largeR2Key = uploaded.largeR2Key;
  } catch (error) {
    logger.warn({ error, fileName: file.name }, 'Thumbnail generation failed');
  }

  // Clean up local temp original
  safeUnlink(tempPath);

  // Save R2 keys (not local paths) to database
  const [record] = await db
    .insert(mediaFiles)
    .values({
      userId,
      organizationId,
      originalPath: r2Key,
      thumbnailPath: thumbnailR2Key,
      previewPath: previewR2Key,
      largePath: largeR2Key,
      fileName: safeFileName,
      mimeType: file.type,
      sizeBytes: buffer.length,
      width,
      height,
      duration,
    })
    .returning();

  return {
    id: record.id,
    originalPath: r2Key,
    thumbnailPath: thumbnailR2Key,
    previewPath: previewR2Key,
    largePath: largeR2Key,
    fileName: safeFileName,
    mimeType: file.type,
    sizeBytes: buffer.length,
    width,
    height,
    duration,
  };
}

/**
 * Generate the 160px thumbnail + 400px preview for a media row whose original
 * was uploaded straight to R2 by the browser (presign/finalize flow), so the
 * SSR never had the bytes. Pulls the (now small, compressed) original from R2,
 * derives both sizes, uploads them, and backfills thumbnailPath/previewPath and
 * any missing dimensions. Safe to retry: it no-ops when the thumbnail already
 * exists, the file isn't an image, or the original is gone.
 */
export async function generateThumbnailsForMedia(mediaId: number): Promise<void> {
  const [media] = await db
    .select()
    .from(mediaFiles)
    .where(eq(mediaFiles.id, mediaId))
    .limit(1);

  if (!media) {
    logger.warn({ mediaId }, 'Media not found, skipping thumbnail generation');
    return;
  }
  // Regenerate when ANY derivative is missing, not just the thumbnail — this is
  // what lets the backfill add `large` (and video posters) to existing rows.
  if (media.thumbnailPath && media.previewPath && media.largePath) {
    logger.info({ mediaId }, 'All derivatives already exist, skipping');
    return;
  }
  const isImage = media.mimeType.startsWith('image/');
  const isVideo = media.mimeType.startsWith('video/');
  if (!isImage && !isVideo) {
    return;
  }
  if (media.isOriginalDeleted) {
    logger.info({ mediaId }, 'Original already deleted, skipping thumbnail generation');
    return;
  }

  let tempPath: string | null = null;
  try {
    const uniqueName = `${Date.now()}-${randomBytes(8).toString('hex')}${path.extname(media.originalPath) || '.img'}`;

    // Videos are read by ffmpeg over a presigned GET so it can range-request the
    // header and one frame. Buffering the object (as images do) would pull a
    // multi-hundred-MB upload into the worker heap.
    let source: string;
    if (isVideo && isR2Key(media.originalPath)) {
      source = await getPresignedDownloadUrl(media.originalPath);
    } else {
      const buffer = isR2Key(media.originalPath)
        ? await downloadFromR2(media.originalPath)
        : fs.readFileSync(media.originalPath);
      tempPath = path.join(ORIGINAL_DIR, uniqueName);
      fs.writeFileSync(tempPath, buffer);
      source = tempPath;
    }

    const thumbResult = await generateThumbnail(source, media.mimeType, uniqueName);
    const uploaded = await uploadDerivatives(thumbResult);

    // A video whose frame extraction failed still yields probe metadata — keep
    // any derivative we already had rather than nulling it out.
    await db
      .update(mediaFiles)
      .set({
        thumbnailPath: uploaded.thumbnailR2Key ?? media.thumbnailPath,
        previewPath: uploaded.previewR2Key ?? media.previewPath,
        largePath: uploaded.largeR2Key ?? media.largePath,
        width: media.width ?? thumbResult.width,
        height: media.height ?? thumbResult.height,
        duration: media.duration ?? thumbResult.duration,
      })
      .where(eq(mediaFiles.id, mediaId));

    // Derivative names are freshly randomised each run, so regenerating (the
    // backfill adding `large` to a row that already had thumb+preview) replaces
    // the keys and leaves the previous objects referenced by nothing. Sweep the
    // ones we just superseded — there is no R2-listing orphan collector.
    const superseded = [
      uploaded.thumbnailR2Key ? media.thumbnailPath : null,
      uploaded.previewR2Key ? media.previewPath : null,
      uploaded.largeR2Key ? media.largePath : null,
    ].filter((k): k is string => !!k);
    if (superseded.length > 0) {
      await deleteMultipleFromR2(superseded).catch(() => {});
    }

    logger.info({ mediaId, ...uploaded, isVideo, superseded: superseded.length }, 'Generated derivatives from R2 object');
  } finally {
    if (tempPath) safeUnlink(tempPath);
  }
}

/**
 * Upload whatever derivatives were produced to R2 and unlink the local temps.
 * Shared by the synchronous upload path and the background job.
 */
async function uploadDerivatives(result: {
  thumbnailPath: string | null;
  previewPath: string | null;
  largePath: string | null;
}): Promise<{ thumbnailR2Key: string | null; previewR2Key: string | null; largeR2Key: string | null }> {
  const locals = [result.thumbnailPath, result.previewPath, result.largePath];
  const uploaded: string[] = [];

  const put = async (localPath: string | null): Promise<string | null> => {
    if (!localPath) return null;
    const key = `thumbnails/${path.basename(localPath)}`;
    await uploadToR2(key, fs.readFileSync(localPath), 'image/webp');
    uploaded.push(key);
    return key;
  };

  try {
    return {
      thumbnailR2Key: await put(result.thumbnailPath),
      previewR2Key: await put(result.previewPath),
      largeR2Key: await put(result.largePath),
    };
  } catch (err) {
    // A partial upload leaves R2 objects no DB row will ever reference. Sweep
    // them rather than leaking storage on every transient R2 error.
    // Deleted directly rather than via the media-delete queue: this function
    // also runs in the SSR upload path, and reaching for BullMQ there would
    // put a Redis connection in the request path.
    if (uploaded.length > 0) {
      await deleteMultipleFromR2(uploaded).catch(() => {});
    }
    throw err;
  } finally {
    // Always unlink every temp — the `finally` in the caller only covers the
    // downloaded original, not these three derivative files.
    for (const p of locals) safeUnlink(p);
  }
}

/**
 * Convert a stored path (R2 key or legacy local path) to a public URL.
 */
export function getMediaPublicUrl(storedPath: string): string {
  // Already a full URL (e.g. seed data with external URLs)
  if (storedPath.startsWith('http://') || storedPath.startsWith('https://')) {
    return storedPath;
  }
  if (isR2Key(storedPath)) {
    return getR2PublicUrl(storedPath);
  }
  // Legacy: local filesystem path
  const baseUrl = process.env.BASE_URL || 'http://localhost:4321';
  const relativePath = path.relative(UPLOAD_DIR, storedPath);
  return `${baseUrl}/uploads/${relativePath}`;
}

/**
 * Delete a media file by its stored path (R2 key or legacy local path).
 */
export async function deleteMediaFile(storedPath: string): Promise<boolean> {
  if (isR2Key(storedPath)) {
    await deleteFromR2(storedPath);
    return true;
  }
  // Legacy: local filesystem
  try {
    if (fs.existsSync(storedPath)) {
      fs.unlinkSync(storedPath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Image format conversion for platform compatibility                 */
/* ------------------------------------------------------------------ */

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * Convert/resize an image if its format isn't accepted or it exceeds
 * maxDimension. Returns updated fields, or null if no changes needed.
 *
 * `localPath` can be either a local filesystem path or an R2 key.
 * If it's an R2 key, the file is downloaded to a temp location first.
 */
export async function convertImageIfNeeded(
  localPath: string,
  mimeType: string,
  acceptedFormats: string[],
  maxDimension?: number,
  knownDimensions?: { width?: number; height?: number },
): Promise<{ localPath: string; mimeType: string; url: string } | null> {
  const ext = MIME_TO_EXT[mimeType];
  if (!ext) return null; // unknown type, skip

  // Check if the current format is accepted
  const normalised = acceptedFormats.map((f) => f.toLowerCase());
  const formatOk = normalised.includes(ext) || (ext === 'jpg' && normalised.includes('jpeg')) || (ext === 'jpeg' && normalised.includes('jpg'));

  // Use known dimensions to check resize without downloading
  let needsResize = false;
  if (maxDimension && knownDimensions) {
    if ((knownDimensions.width && knownDimensions.width > maxDimension) ||
        (knownDimensions.height && knownDimensions.height > maxDimension)) {
      needsResize = true;
    }
  }

  // Early exit: no conversion or resize needed — skip the download entirely
  if (formatOk && !needsResize && (knownDimensions || !maxDimension)) {
    return null;
  }

  // Download from R2 / resolve local file for Sharp processing
  let sourcePath = localPath;
  let tempDownload: string | null = null;

  if (isR2Key(localPath)) {
    try {
      const downloadBuffer = await downloadFromR2(localPath);
      tempDownload = path.join(os.tmpdir(), `r2-${randomBytes(8).toString('hex')}${path.extname(localPath)}`);
      fs.writeFileSync(tempDownload, downloadBuffer);
      sourcePath = tempDownload;
      logger.info({ r2Key: localPath, tempPath: tempDownload, size: downloadBuffer.length }, 'Downloaded R2 file for conversion');
    } catch (downloadErr) {
      logger.error({ r2Key: localPath, error: downloadErr }, 'Failed to download from R2 for conversion');
      throw new Error(`R2 download failed for ${localPath}: ${downloadErr instanceof Error ? downloadErr.message : String(downloadErr)}`);
    }
  } else if (!fs.existsSync(sourcePath)) {
    throw new Error(`Local file not found: ${sourcePath}`);
  }

  // If we didn't have known dimensions, check with Sharp now
  if (maxDimension && !knownDimensions) {
    const meta = await sharp(sourcePath).metadata();
    if ((meta.width && meta.width > maxDimension) || (meta.height && meta.height > maxDimension)) {
      needsResize = true;
    }
    if (formatOk && !needsResize) {
      if (tempDownload) safeUnlink(tempDownload);
      return null;
    }
  }

  const baseName = path.basename(sourcePath, path.extname(sourcePath));
  const outExt = formatOk ? ext : 'jpg';
  const outName = `${baseName}-${randomBytes(4).toString('hex')}.${outExt}`;
  const tempOutPath = path.join(CONVERTED_DIR, outName);

  let pipeline = sharp(sourcePath);
  if (needsResize) {
    pipeline = pipeline.resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true });
  }

  if (outExt === 'jpg' || outExt === 'jpeg') {
    pipeline = pipeline.jpeg({ quality: 92 });
  } else if (outExt === 'webp') {
    pipeline = pipeline.webp({ quality: 92 });
  } else if (outExt === 'png') {
    pipeline = pipeline.png();
  }

  await pipeline.toFile(tempOutPath);

  // Upload converted file to R2
  const convertedBuffer = fs.readFileSync(tempOutPath);
  const r2Key = `converted/${outName}`;
  const outMime = EXT_TO_MIME[outExt] || 'image/jpeg';
  await uploadToR2(r2Key, convertedBuffer, outMime);

  // Clean up local temp files
  safeUnlink(tempOutPath);
  if (tempDownload) safeUnlink(tempDownload);

  logger.info({ from: mimeType, to: outMime, resized: needsResize, maxDimension, r2Key }, 'Processed image for platform compatibility');

  return {
    localPath: r2Key,
    mimeType: outMime,
    url: getR2PublicUrl(r2Key),
  };
}

function safeUnlink(filePath: string | null | undefined): void {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore cleanup errors
  }
}

/* ------------------------------------------------------------------ */
/*  Platform-format variants are generated on-publish (see the publish */
/*  worker / convertImageIfNeeded + composeStoryImage below), not       */
/*  pre-generated and stored at upload time. Saves ~50% media storage.  */
/* ------------------------------------------------------------------ */

/**
 * Compose a 1080×1920 (9:16) JPEG from any still image, matching the
 * visual language of Instagram's native "Share to Story":
 *   - Background: the source scaled to cover 1080×1920, then blurred
 *   - Foreground: the source scaled to fit inside 1080×1920, centered
 *
 * Used by the "Also share to Story" path so square/portrait/landscape
 * feed images don't get stretched or zoom-cropped when IG/FB Stories
 * render them. Returns null if the source is already ~9:16 (no work
 * needed), not a still image, or a GIF (would lose animation).
 */
export async function composeStoryImage(
  localPath: string,
  mimeType: string,
  knownDimensions?: { width?: number | null; height?: number | null },
): Promise<{ localPath: string; mimeType: string; url: string } | null> {
  if (!mimeType.startsWith('image/')) return null;
  const ext = MIME_TO_EXT[mimeType];
  if (!ext || ext === 'gif') return null;

  const STORY_WIDTH = 1080;
  const STORY_HEIGHT = 1920;
  const TARGET_ASPECT = STORY_WIDTH / STORY_HEIGHT; // 0.5625

  // Skip if the source is already within 2% of 9:16 — no compositing buys us anything.
  if (knownDimensions?.width && knownDimensions?.height) {
    const aspect = knownDimensions.width / knownDimensions.height;
    if (Math.abs(aspect - TARGET_ASPECT) < 0.02) return null;
  }

  // Resolve to a local file Sharp can read
  let sourcePath = localPath;
  let tempDownload: string | null = null;
  if (isR2Key(localPath)) {
    try {
      const downloadBuffer = await downloadFromR2(localPath);
      tempDownload = path.join(os.tmpdir(), `r2-${randomBytes(8).toString('hex')}${path.extname(localPath) || '.img'}`);
      fs.writeFileSync(tempDownload, downloadBuffer);
      sourcePath = tempDownload;
    } catch (downloadErr) {
      logger.error({ r2Key: localPath, error: downloadErr }, 'Failed to download R2 file for story composite');
      return null;
    }
  } else if (!fs.existsSync(sourcePath)) {
    logger.warn({ sourcePath }, 'Local file missing, cannot compose story image');
    return null;
  }

  try {
    // Background: cover-fit + heavy blur + slight darken so the foreground pops
    const background = await sharp(sourcePath)
      .resize(STORY_WIDTH, STORY_HEIGHT, { fit: 'cover', position: 'center' })
      .blur(40)
      .modulate({ brightness: 0.7 })
      .toBuffer();

    // Foreground: contain-fit (proportional, no crop); Sharp's `inside` never enlarges
    // a smaller source, so a 720×720 image stays 720×720 and ends up smaller in the
    // story — that's fine; it matches how the IG native app sizes small images.
    const foreground = await sharp(sourcePath)
      .resize(STORY_WIDTH, STORY_HEIGHT, { fit: 'inside' })
      .toBuffer();

    const baseName = path.basename(sourcePath, path.extname(sourcePath));
    const outName = `${baseName}-story-${randomBytes(4).toString('hex')}.jpg`;
    const tempOutPath = path.join(CONVERTED_DIR, outName);

    await sharp(background)
      .composite([{ input: foreground, gravity: 'center' }])
      .jpeg({ quality: 92 })
      .toFile(tempOutPath);

    const compositeBuffer = fs.readFileSync(tempOutPath);
    const r2Key = `converted/${outName}`;
    await uploadToR2(r2Key, compositeBuffer, 'image/jpeg');
    safeUnlink(tempOutPath);

    logger.info({ source: localPath, r2Key, width: STORY_WIDTH, height: STORY_HEIGHT }, 'Composed 9:16 story image');

    return {
      localPath: r2Key,
      mimeType: 'image/jpeg',
      url: getR2PublicUrl(r2Key),
    };
  } catch (err) {
    logger.error({ source: localPath, error: err }, 'Failed to compose story image');
    return null;
  } finally {
    if (tempDownload) safeUnlink(tempDownload);
  }
}