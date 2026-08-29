import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '@/lib/db';
import { mediaFiles } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { getMediaPublicUrl } from '@/lib/media/upload';
import { isR2Key } from '@/lib/media/r2';

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

export const GET: APIRoute = async ({ locals, params }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const id = Number(params.id);
  if (isNaN(id)) return json({ error: 'Invalid media ID' }, 400);

  const [file] = await db
    .select()
    .from(mediaFiles)
    .where(and(eq(mediaFiles.id, id), eq(mediaFiles.organizationId, locals.auth.organizationId)));

  if (!file) return json({ error: 'Media file not found' }, 404);

  if (!file.thumbnailPath) {
    return json({ error: 'No thumbnail available for this media file' }, 404);
  }

  // R2-stored thumbnails: redirect to public CDN URL
  if (isR2Key(file.thumbnailPath)) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: getMediaPublicUrl(file.thumbnailPath),
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  // Legacy: serve from local disk
  if (!fs.existsSync(file.thumbnailPath)) {
    return json({ error: 'Thumbnail file not found on disk' }, 404);
  }

  const buffer = fs.readFileSync(file.thumbnailPath);
  const ext = path.extname(file.thumbnailPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'image/jpeg';

  return new Response(buffer, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': buffer.length.toString(),
      'Cache-Control': 'public, max-age=86400',
    },
  });
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
