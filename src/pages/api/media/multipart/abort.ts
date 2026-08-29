import type { APIRoute } from 'astro';
import { abortMultipartUpload } from '@/lib/media/r2';
import { orgFromKey } from '@/lib/media/finalize-object';

/**
 * POST /api/media/multipart/abort
 *
 * Cancel an in-progress chunked upload so R2 doesn't keep billing the
 * already-uploaded parts. Called by the client on user cancel or fatal error.
 * (R2 also expires incomplete multipart uploads automatically as a backstop.)
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

  const r2Key = typeof body?.r2Key === 'string' ? body.r2Key : '';
  const uploadId = typeof body?.uploadId === 'string' ? body.uploadId : '';
  if (!uploadId || orgFromKey(r2Key) !== locals.auth.organizationId) {
    return json({ error: 'Invalid upload key' }, 400);
  }

  await abortMultipartUpload(r2Key, uploadId);
  return json({ success: true });
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
