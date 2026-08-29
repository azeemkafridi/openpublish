import type { APIRoute } from 'astro';
import { randomBytes } from 'node:crypto';
import { createMultipartUpload, getPresignedPartUrl } from '@/lib/media/r2';
import { checkMediaStorageQuota, getOrgPlan } from '@/lib/quotas/check';
import { quotaExceededResponse } from '@/lib/quotas/errors';
import { isAllowedMimeType, extForMime, maxSizeForMime, maxSizeLabel } from '@/lib/media/validate';
import { captureApiError } from '@/lib/errors';

/** 10MB parts — small enough that a retry is cheap, large enough to keep part
 * counts sane. The real size bound is maxSizeForMime (1GB → max 103 parts). */
const PART_SIZE = 10 * 1024 * 1024;
const PART_URL_TTL_SECONDS = 3600;

/**
 * POST /api/media/multipart/create
 *
 * Step 1 of the chunked direct-to-R2 upload for large files (videos up to 1GB).
 * Auth + quota checks mirror /api/media/presign; returns the multipart uploadId
 * plus a presigned URL per part. A dropped connection only costs the part in
 * flight — the client retries that part against its URL instead of restarting
 * the whole file.
 */
export const POST: APIRoute = async ({ locals, request }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const contentType = typeof body?.contentType === 'string' ? body.contentType : '';
  const sizeBytes = Number(body?.sizeBytes);

  if (!isAllowedMimeType(contentType)) {
    return json({ error: `File type not allowed: ${contentType || 'unknown'}` }, 400);
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return json({ error: 'Invalid file size' }, 400);
  }
  if (sizeBytes > maxSizeForMime(contentType)) {
    return json({ error: `File too large (max ${maxSizeLabel(contentType)})` }, 400);
  }

  const partCount = Math.ceil(sizeBytes / PART_SIZE);

  const storageQuota = await checkMediaStorageQuota(locals.auth.organizationId);
  if (!storageQuota.allowed) {
    const plan = await getOrgPlan(locals.auth.organizationId);
    return quotaExceededResponse(storageQuota, plan);
  }

  const ext = extForMime(contentType);
  const r2Key = `original/${locals.auth.organizationId}/${Date.now()}-${randomBytes(16).toString('hex')}.${ext}`;

  try {
    const uploadId = await createMultipartUpload(r2Key, contentType);
    const partUrls = await Promise.all(
      Array.from({ length: partCount }, (_, i) => getPresignedPartUrl(r2Key, uploadId, i + 1, PART_URL_TTL_SECONDS)),
    );
    return json(
      { r2Key, uploadId, partSize: PART_SIZE, partUrls, expiresIn: PART_URL_TTL_SECONDS },
      200,
      { 'Cache-Control': 'private, no-store' },
    );
  } catch (error) {
    captureApiError('POST /api/media/multipart/create', error);
    return json({ error: 'Failed to start upload' }, 500);
  }
};

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
