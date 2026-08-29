import type { APIRoute } from 'astro';
import { verifyAndRecordUpload } from '@/lib/media/finalize-object';
import { MAX_FILE_SIZE } from '@/lib/media/validate';
import { quotaExceededResponse } from '@/lib/quotas/errors';
import { captureApiError } from '@/lib/errors';

/**
 * POST /api/media/finalize
 *
 * Step 2 of the direct-to-R2 browser upload (single PUT path). The browser has
 * PUT the blob to R2; this records the DB row and queues thumbnail generation.
 * All verification (key capability, HEAD, magic bytes, quota) lives in
 * verifyAndRecordUpload, shared with the multipart complete endpoint.
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

  const num = (v: unknown) => (v != null && Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

  try {
    const result = await verifyAndRecordUpload({
      r2Key: typeof body?.r2Key === 'string' ? body.r2Key : '',
      fileName: typeof body?.fileName === 'string' ? body.fileName.slice(0, 255) : '',
      mimeType: typeof body?.mimeType === 'string' ? body.mimeType : '',
      claimedSize: Number(body?.sizeBytes),
      width: num(body?.width),
      height: num(body?.height),
      duration: num(body?.duration),
      userId: user.id,
      orgId,
      // Single-PUT uploads are capped at 100MB regardless of type; larger
      // videos must go through the multipart endpoints.
      maxSizeBytes: MAX_FILE_SIZE,
    });

    if (!result.ok) {
      if (result.status === 429) {
        return quotaExceededResponse(result.error as any, result.quotaPlan as any);
      }
      return json({ error: result.error }, result.status);
    }
    return json({ file: result.file }, 201);
  } catch (error) {
    captureApiError('POST /api/media/finalize', error);
    return json({ error: 'Failed to finalize upload' }, 500);
  }
};

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
