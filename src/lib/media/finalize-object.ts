import { db } from '../db';
import { mediaFiles } from '../db/schema';
import { getMediaPublicUrl } from './upload';
import { headR2Object, getR2ObjectRange, getR2ObjectTail, deleteFromR2 } from './r2';
import { addMediaThumbnailJob } from '../jobs/queue';
import { logActivity } from '../activity/log';
import { checkMediaStorageQuota, getOrgPlan } from '../quotas/check';
import { isAllowedMimeType, magicBytesMatch, maxSizeForMime, isMp4Like, moovFourccInWindows } from './validate';

/** Matches a key issued by presign/multipart-create: original/<orgId>/<ts>-<32 hex>.<ext> */
const KEY_PATTERN = /^original\/(\d+)\/\d+-[0-9a-f]{32}\.[a-z0-9]+$/i;

export function orgFromKey(r2Key: string): number | null {
  const m = KEY_PATTERN.exec(r2Key);
  return m ? Number(m[1]) : null;
}

export interface FinalizeInput {
  r2Key: string;
  fileName: string;
  mimeType: string;
  claimedSize: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  userId: string;
  orgId: number;
  /** Override the per-mime cap — the single-PUT finalize path passes the 100MB
   *  PUT cap so a 1GB video can't bypass the multipart contract. */
  maxSizeBytes?: number;
}

export type FinalizeResult =
  | { ok: true; file: Record<string, unknown> }
  | { ok: false; status: number; error: unknown; quotaPlan?: string };

/**
 * Shared server-side verification + DB record for a browser-uploaded R2 object.
 * Used by both the single-PUT finalize and the multipart complete endpoints, so
 * the trust model stays identical: verify the key was issued for this org, HEAD
 * for existence/size, magic-byte the stored bytes, re-check quota — anything
 * bad deletes the stray object.
 */
export async function verifyAndRecordUpload(input: FinalizeInput): Promise<FinalizeResult> {
  const { r2Key, fileName, mimeType, claimedSize, width, height, duration, userId, orgId } = input;

  if (!fileName) return { ok: false, status: 400, error: 'Missing fileName' };
  if (!isAllowedMimeType(mimeType)) {
    return { ok: false, status: 400, error: `File type not allowed: ${mimeType || 'unknown'}` };
  }
  const maxSize = input.maxSizeBytes ?? maxSizeForMime(mimeType);
  if (!Number.isFinite(claimedSize) || claimedSize <= 0 || claimedSize > maxSize) {
    return { ok: false, status: 400, error: 'Invalid file size' };
  }

  if (orgFromKey(r2Key) !== orgId) {
    return { ok: false, status: 400, error: 'Invalid upload key' };
  }

  const head = await headR2Object(r2Key);
  if (!head) {
    return { ok: false, status: 400, error: 'Uploaded object not found' };
  }
  if (head.contentLength > maxSize) {
    await deleteFromR2(r2Key);
    return { ok: false, status: 400, error: 'Uploaded object too large' };
  }
  const realSize = head.contentLength || claimedSize;

  const header = await getR2ObjectRange(r2Key, 15);
  if (!header || !magicBytesMatch(new Uint8Array(header), mimeType)) {
    await deleteFromR2(r2Key);
    return { ok: false, status: 400, error: 'File content does not match declared type' };
  }

  // MP4/MOV moov-atom check via two ranged reads (the whole file never leaves
  // R2): moov is near the start (faststart) or at the end. An unfinalized
  // ftyp+mdat file — grabbed mid-encode or a cut-off upload — has it nowhere,
  // and would otherwise only fail at publish time with an opaque platform error.
  if (isMp4Like(mimeType)) {
    const windowBytes = 256 * 1024;
    const needTail = realSize > windowBytes;
    const [head256, tail256] = await Promise.all([
      getR2ObjectRange(r2Key, windowBytes - 1),
      needTail ? getR2ObjectTail(r2Key, windowBytes) : Promise.resolve(null),
    ]);
    // Fail OPEN on read errors: both range helpers return null on a transient
    // R2 failure, and treating that as "no moov" would delete a valid upload.
    // Only reject when every window we needed was actually read and none
    // contains the fourcc.
    const readsComplete = head256 !== null && (!needTail || tail256 !== null);
    if (readsComplete && !moovFourccInWindows(head256 ?? undefined, tail256 ?? undefined)) {
      await deleteFromR2(r2Key);
      return {
        ok: false,
        status: 400,
        error: 'This video file is incomplete (no moov atom) — it was likely still encoding or the upload was cut off. Re-export and upload again.',
      };
    }
  }

  const storageQuota = await checkMediaStorageQuota(orgId);
  if (!storageQuota.allowed) {
    await deleteFromR2(r2Key);
    const plan = await getOrgPlan(orgId);
    return { ok: false, status: 429, error: storageQuota, quotaPlan: plan };
  }

  const [record] = await db
    .insert(mediaFiles)
    .values({
      userId,
      organizationId: orgId,
      originalPath: r2Key,
      thumbnailPath: null,
      previewPath: null,
      fileName,
      mimeType,
      sizeBytes: realSize,
      width: width && width > 0 ? width : null,
      height: height && height > 0 ? height : null,
      duration: duration && duration > 0 ? duration : null,
    })
    .returning();

  // Videos included: the job extracts a poster frame with ffmpeg and backfills
  // width/height/duration from ffprobe (the client-side probe can silently fail).
  if (mimeType.startsWith('image/') || mimeType.startsWith('video/')) {
    await addMediaThumbnailJob(record.id).catch(() => {});
  }

  logActivity({
    userId,
    organizationId: orgId,
    action: 'media.uploaded',
    resource: 'media',
    resourceId: record.id,
    details: { fileName, mimeType },
  });

  return {
    ok: true,
    file: {
      id: record.id,
      fileName,
      mimeType,
      sizeBytes: realSize,
      width: record.width ?? null,
      height: record.height ?? null,
      duration: record.duration ?? null,
      originalUrl: getMediaPublicUrl(r2Key),
      // Derivatives are produced asynchronously by the media job — the client
      // re-reads them from /api/media once the job lands.
      thumbnailUrl: null,
      previewUrl: null,
      largeUrl: null,
    },
  };
}
