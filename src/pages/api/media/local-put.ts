import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { storageMode } from '@/lib/media/r2';
import { localKeyPath } from '@/lib/media/local-store';

// Direct-upload target for STORAGE=local — the counterpart of an S3 presigned
// PUT. The auth middleware has already required a session (or API key) for
// every /api route, so any authenticated member of the instance can PUT here;
// keys are random server-generated names handed out by presign/multipart
// endpoints, which also enforced validation and quota.
const MAX_PUT_BYTES = 1024 * 1024 * 1024; // 1GB, same ceiling as multipart

export const PUT: APIRoute = async ({ request, url, locals }) => {
  if (!locals.auth?.user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }
  if (storageMode() !== 'local') {
    return new Response(JSON.stringify({ error: 'Local storage is not active' }), { status: 400 });
  }
  const key = url.searchParams.get('key');
  if (!key) {
    return new Response(JSON.stringify({ error: 'Missing key' }), { status: 400 });
  }

  let dest: string;
  try {
    dest = localKeyPath(key);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid key' }), { status: 400 });
  }

  const body = Buffer.from(await request.arrayBuffer());
  if (body.length === 0) {
    return new Response(JSON.stringify({ error: 'Empty body' }), { status: 400 });
  }
  if (body.length > MAX_PUT_BYTES) {
    return new Response(JSON.stringify({ error: 'File too large' }), { status: 413 });
  }

  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(dest, body);
  const contentType = request.headers.get('content-type') || 'application/octet-stream';
  await fs.promises.writeFile(dest + '.meta.json', JSON.stringify({ contentType }));

  // S3-compatible ETag so the multipart upload client can collect part etags.
  const etag = `"${createHash('md5').update(body).digest('hex')}"`;
  return new Response(null, { status: 200, headers: { ETag: etag } });
};
