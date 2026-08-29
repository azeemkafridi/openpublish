import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { labels, postLabels, mediaLabels } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { logActivity } from '@/lib/activity/log';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const PUT: APIRoute = async ({ request, locals, params }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const id = Number(params.id);
  if (isNaN(id)) return json({ error: 'Invalid label ID' }, 400);

  const body = await request.json();
  const { name, color } = body;

  if (!name && !color) {
    return json({ error: 'At least one of name or color is required' }, 400);
  }

  const existing = await db
    .select()
    .from(labels)
    .where(and(eq(labels.id, id), eq(labels.organizationId, locals.auth.organizationId)))
    .limit(1);

  if (existing.length === 0) {
    return json({ error: 'Label not found' }, 404);
  }

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (color !== undefined) updateData.color = color;

  // Check for duplicate name within same type (skip if name unchanged)
  if (name !== undefined && name !== existing[0].name) {
    const duplicate = await db
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.organizationId, locals.auth.organizationId), eq(labels.name, name), eq(labels.type, existing[0].type)))
      .limit(1);

    if (duplicate.length > 0) {
      return json({
        error: {
          message: `A label named "${name}" already exists.`,
          hint: 'Choose a different name or edit the existing label instead.',
          code: 'DUPLICATE_NAME',
        },
      }, 409);
    }
  }

  const [updated] = await db
    .update(labels)
    .set(updateData)
    .where(and(eq(labels.id, id), eq(labels.organizationId, locals.auth.organizationId)))
    .returning();

  logActivity({
    userId: user.id,
    organizationId: locals.auth.organizationId,
    action: 'label.updated',
    resource: 'label',
    resourceId: id,
    details: { name, color },
  });

  return json(updated);
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const id = Number(params.id);
  if (isNaN(id)) return json({ error: 'Invalid label ID' }, 400);

  const existing = await db
    .select()
    .from(labels)
    .where(and(eq(labels.id, id), eq(labels.organizationId, locals.auth.organizationId)))
    .limit(1);

  if (existing.length === 0) {
    return json({ error: 'Label not found' }, 404);
  }

  await db.delete(postLabels).where(eq(postLabels.labelId, id));
  await db.delete(mediaLabels).where(eq(mediaLabels.labelId, id));
  await db.delete(labels).where(and(eq(labels.id, id), eq(labels.organizationId, locals.auth.organizationId)));

  logActivity({
    userId: user.id,
    organizationId: locals.auth.organizationId,
    action: 'label.deleted',
    resource: 'label',
    resourceId: id,
    details: { name: existing[0].name },
  });

  return json({ success: true });
};
