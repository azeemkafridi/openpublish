import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { mediaFiles } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { getMediaPublicUrl } from '@/lib/media/upload';
import { addMediaDeleteJob } from '@/lib/jobs/queue';
import { logActivity } from '@/lib/activity/log';

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

  return json({
    file: {
      id: file.id,
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      width: file.width,
      height: file.height,
      duration: file.duration,
      isOriginalDeleted: file.isOriginalDeleted,
      originalUrl: getMediaPublicUrl(file.originalPath),
      thumbnailUrl: file.thumbnailPath ? getMediaPublicUrl(file.thumbnailPath) : null,
      previewUrl: file.previewPath ? getMediaPublicUrl(file.previewPath) : null,
      largeUrl: file.largePath ? getMediaPublicUrl(file.largePath) : null,
      createdAt: file.createdAt,
    },
  }, 200, { 'Cache-Control': 'private, no-store' });
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const id = Number(params.id);
  if (isNaN(id)) return json({ error: 'Invalid media ID' }, 400);

  const [file] = await db
    .select()
    .from(mediaFiles)
    .where(and(eq(mediaFiles.id, id), eq(mediaFiles.organizationId, locals.auth.organizationId)));

  if (!file) return json({ error: 'Media file not found' }, 404);

  // Delete DB record first (instant UI update)
  await db
    .delete(mediaFiles)
    .where(and(eq(mediaFiles.id, id), eq(mediaFiles.organizationId, locals.auth.organizationId)));

  // Queue R2 file cleanup in background (silent)
  const pathsToDelete = [
    file.originalPath,
    file.thumbnailPath,
    file.previewPath,
    file.largePath,
    ...Object.values((file as any).variants || {}).map((v: any) => v.path),
  ].filter(Boolean) as string[];
  await addMediaDeleteJob(pathsToDelete).catch(() => {});

  logActivity({
    userId: user.id,
    organizationId: locals.auth.organizationId,
    action: 'media.deleted',
    resource: 'media',
    resourceId: id,
    details: { fileName: file.fileName },
  });

  return json({ success: true, deletedId: id });
};

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
