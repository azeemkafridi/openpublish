import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { mediaFiles, mediaLabels, labels } from '@/lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** GET — fetch labels for a media file */
export const GET: APIRoute = async ({ locals, params }) => {
  const { user, organizationId } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const mediaFileId = Number(params.id);
  if (!mediaFileId) return json({ error: 'Invalid media ID' }, 400);

  const rows = await db
    .select({ labelId: mediaLabels.labelId, name: labels.name, color: labels.color })
    .from(mediaLabels)
    .innerJoin(labels, eq(labels.id, mediaLabels.labelId))
    .innerJoin(mediaFiles, eq(mediaFiles.id, mediaLabels.mediaFileId))
    .where(
      and(
        eq(mediaLabels.mediaFileId, mediaFileId),
        eq(mediaFiles.organizationId, organizationId),
      ),
    );

  return json(rows.map((r) => ({ id: r.labelId, name: r.name, color: r.color })));
};

/** PUT — set labels for a media file (replaces all) */
export const PUT: APIRoute = async ({ locals, params, request }) => {
  const { user, organizationId } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const mediaFileId = Number(params.id);
  if (!mediaFileId) return json({ error: 'Invalid media ID' }, 400);

  // Verify media file belongs to org
  const [file] = await db
    .select({ id: mediaFiles.id })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.id, mediaFileId), eq(mediaFiles.organizationId, organizationId)));

  if (!file) return json({ error: 'Media not found' }, 404);

  const body = await request.json();
  const labelIds: number[] = Array.isArray(body.labelIds) ? body.labelIds : [];

  // Validate all labels belong to this org
  if (labelIds.length > 0) {
    const validLabels = await db
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.organizationId, organizationId), inArray(labels.id, labelIds)));

    if (validLabels.length !== labelIds.length) {
      return json({ error: 'Some labels not found' }, 400);
    }
  }

  // Replace: delete all existing, insert new
  await db.delete(mediaLabels).where(eq(mediaLabels.mediaFileId, mediaFileId));

  if (labelIds.length > 0) {
    await db.insert(mediaLabels).values(
      labelIds.map((labelId) => ({ mediaFileId, labelId })),
    );
  }

  return json({ ok: true });
};
