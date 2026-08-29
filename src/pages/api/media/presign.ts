import type { APIRoute } from 'astro';
import { randomBytes } from 'node:crypto';
import { getPresignedUploadUrl } from '@/lib/media/r2';
import { checkMediaStorageQuota, getOrgPlan } from '@/lib/quotas/check';
import { quotaExceededResponse } from '@/lib/quotas/errors';
import { MAX_FILE_SIZE, isAllowedMimeType, extForMime } from '@/lib/media/validate';
import { captureApiError } from '@/lib/errors';

/** How long a presigned upload URL stays valid. */
const PRESIGN_TTL_SECONDS = 300;

/**
 * POST /api/media/presign
 *
 * Step 1 of the direct-to-R2 browser upload. Authenticates, checks the storage
 * quota, and returns a presigned PUT URL the browser uploads the (already
 * client-compressed) blob to — no SSR relay. The returned r2Key is org-namespaced
 * with a random component, so it doubles as a capability token that finalize
 * verifies. content-type is baked into the signature; the PUT must echo it.
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
  if (sizeBytes > MAX_FILE_SIZE) {
    // Large videos go through /api/media/multipart/* (chunked, up to 1GB);
    // the single-PUT path stays capped so one request can't stream 1GB
    // through an unresumable PUT.
    return json({ error: 'File too large for direct upload (max 100MB). Use the multipart upload endpoints for videos up to 1GB.' }, 400);
  }

  // Check storage quota BEFORE granting an upload URL.
  const storageQuota = await checkMediaStorageQuota(locals.auth.organizationId);
  if (!storageQuota.allowed) {
    const plan = await getOrgPlan(locals.auth.organizationId);
    return quotaExceededResponse(storageQuota, plan);
  }

  // original/<orgId>/<ts>-<32 hex>.<ext> — the org segment + random token let
  // finalize confirm ownership and that this key really came from presign.
  const ext = extForMime(contentType);
  const r2Key = `original/${locals.auth.organizationId}/${Date.now()}-${randomBytes(16).toString('hex')}.${ext}`;

  try {
    const uploadUrl = await getPresignedUploadUrl(r2Key, contentType, PRESIGN_TTL_SECONDS);
    return json(
      { uploadUrl, r2Key, expiresIn: PRESIGN_TTL_SECONDS },
      200,
      { 'Cache-Control': 'private, no-store' },
    );
  } catch (error) {
    captureApiError('POST /api/media/presign', error);
    return json({ error: 'Failed to create upload URL' }, 500);
  }
};

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
