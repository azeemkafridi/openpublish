import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { storageMode } from '@/lib/media/r2';
import { localKeyPath } from '@/lib/media/local-store';
import { isAllowedMimeType } from '@/lib/media/validate';

// Direct-upload target for STORAGE=local — the counterpart of an S3 presigned
// PUT. The auth middleware has already required a session (or API key) for
// every /api route; on top of that this route enforces:
//  - the key must live under the caller's own org prefix (cross-org overwrite
//    is refused even if another org's random key leaks), and
//  - for whole objects, the declared Content-Type must pass the same media
//    allowlist as the presign path. Without that check a member could store
//    text/html and have the public /uploads route serve it on the app origin —
//    stored XSS riding the session cookie.
const MAX_PUT_BYTES = 1024 * 1024 * 1024; // 1GB, same ceiling as multipart

// Multipart part files: `<key>.<12-hex uploadId>.part<N>` — raw byte chunks,
// concatenated on complete. Their bytes carry no Content-Type of their own
// (the final object's type was validated + stored at multipart-create).
const PART_KEY_RE = /\.[0-9a-f]{24}\.part\d+$/;

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

  // Only keys under the caller's own org prefix are writable.
  const orgPrefix = `original/${locals.auth.organizationId}/`;
  if (!key.startsWith(orgPrefix)) {
    return new Response(JSON.stringify({ error: 'Invalid key' }), { status: 403 });
  }

  let dest: string;
  try {
    dest = localKeyPath(key);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid key' }), { status: 400 });
  }

  const isPart = PART_KEY_RE.test(key);
  const contentType = request.headers.get('content-type') || 'application/octet-stream';
  if (!isPart && !isAllowedMimeType(contentType)) {
    return new Response(
      JSON.stringify({ error: `Content type not allowed: ${contentType}` }),
      { status: 415 },
    );
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
  if (!isPart) {
    await fs.promises.writeFile(dest + '.meta.json', JSON.stringify({ contentType }));
  }

  // S3-compatible ETag so the multipart upload client can collect part etags.
  const etag = `"${createHash('md5').update(body).digest('hex')}"`;
  return new Response(null, { status: 200, headers: { ETag: etag } });
};
