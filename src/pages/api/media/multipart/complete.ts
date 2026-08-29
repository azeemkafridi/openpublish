import type { APIRoute } from 'astro';
import { completeMultipartUpload, abortMultipartUpload } from '@/lib/media/r2';
import { verifyAndRecordUpload, orgFromKey } from '@/lib/media/finalize-object';
import { quotaExceededResponse } from '@/lib/quotas/errors';
import { captureApiError } from '@/lib/errors';

/**
 * POST /api/media/multipart/complete
 *
 * Step 2 of the chunked upload: assemble the parts, then run the exact same
 * verification + DB record as the single-PUT finalize (key capability, HEAD,
 * magic bytes, quota). A failed assembly or verification aborts/deletes the
 * upload so no stray bytes are left billed in R2.
 */
export const POST: APIRoute = async ({ locals, request }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const orgId = locals.auth.organizationId;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const r2Key = typeof body?.r2Key === 'string' ? body.r2Key : '';
  const uploadId = typeof body?.uploadId === 'string' ? body.uploadId : '';
  const rawParts = Array.isArray(body?.parts) ? body.parts : [];

  // Ownership gate BEFORE any R2 call — the key must be one we issued this org.
  if (!uploadId || orgFromKey(r2Key) !== orgId) {
    return json({ error: 'Invalid upload key' }, 400);
  }

  const parts = rawParts
    .map((p: any) => ({ partNumber: Number(p?.partNumber), etag: String(p?.etag || '') }))
    .filter((p: any) => Number.isInteger(p.partNumber) && p.partNumber > 0 && p.etag);
  if (parts.length === 0 || parts.length !== rawParts.length) {
    return json({ error: 'Invalid parts list' }, 400);
  }
  parts.sort((a: any, b: any) => a.partNumber - b.partNumber);

  try {
    await completeMultipartUpload(r2Key, uploadId, parts);
  } catch (error) {
    captureApiError('POST /api/media/multipart/complete (assembly)', error);
    await abortMultipartUpload(r2Key, uploadId);
    return json({ error: 'Failed to assemble upload. Please retry.' }, 400);
  }

  const num = (v: unknown) => (v != null && Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

  try {
    const result = await verifyAndRecordUpload({
      r2Key,
      fileName: typeof body?.fileName === 'string' ? body.fileName.slice(0, 255) : '',
      mimeType: typeof body?.mimeType === 'string' ? body.mimeType : '',
      claimedSize: Number(body?.sizeBytes),
      width: num(body?.width),
      height: num(body?.height),
      duration: num(body?.duration),
      userId: user.id,
      orgId,
    });

    if (!result.ok) {
      if (result.status === 429) {
        return quotaExceededResponse(result.error as any, result.quotaPlan as any);
      }
      return json({ error: result.error }, result.status);
    }
    return json({ file: result.file }, 201);
  } catch (error) {
    captureApiError('POST /api/media/multipart/complete', error);
    return json({ error: 'Failed to finalize upload' }, 500);
  }
};

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
