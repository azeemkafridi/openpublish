import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { channelSets } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { logActivity } from '@/lib/activity/log';
import { validateOwnedChannels } from '@/lib/channels/validate';

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
  if (isNaN(id)) return json({ error: 'Invalid set ID' }, 400);

  const body = await request.json().catch(() => null);
  const name = body?.name !== undefined ? String(body.name).trim() : undefined;
  const rawChannelIds = body?.channelIds;

  if (name === undefined && rawChannelIds === undefined) {
    return json({ error: 'At least one of name or channelIds is required' }, 400);
  }
  if (name !== undefined && (!name || name.length > 100)) {
    return json({ error: 'Name must be 1-100 characters' }, 400);
  }

  const existing = await db
    .select()
    .from(channelSets)
    .where(and(eq(channelSets.id, id), eq(channelSets.organizationId, locals.auth.organizationId)))
    .limit(1);
  if (existing.length === 0) return json({ error: 'Set not found' }, 404);

  const updateData: Record<string, unknown> = { updatedAt: new Date() };

  if (name !== undefined && name !== existing[0].name) {
    const duplicate = await db
      .select({ id: channelSets.id })
      .from(channelSets)
      .where(and(eq(channelSets.organizationId, locals.auth.organizationId), eq(channelSets.name, name)))
      .limit(1);
    if (duplicate.length > 0) {
      return json({
        error: {
          message: `A set named "${name}" already exists.`,
          hint: 'Choose a different name.',
          code: 'DUPLICATE_NAME',
        },
      }, 409);
    }
  }
  if (name !== undefined) updateData.name = name;

  if (rawChannelIds !== undefined) {
    const ids = await validateOwnedChannels(locals.auth.organizationId, rawChannelIds);
    if (!ids) {
      return json({ error: 'channelIds must be a non-empty array of your channel ids' }, 400);
    }
    updateData.channelIds = ids;
  }

  const [updated] = await db
    .update(channelSets)
    .set(updateData)
    .where(and(eq(channelSets.id, id), eq(channelSets.organizationId, locals.auth.organizationId)))
    .returning();

  logActivity({
    userId: user.id,
    organizationId: locals.auth.organizationId,
    action: 'channel_set.updated',
    resource: 'channel_set',
    resourceId: id,
    details: { name: updated.name },
  });

  return json(updated);
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const id = Number(params.id);
  if (isNaN(id)) return json({ error: 'Invalid set ID' }, 400);

  const existing = await db
    .select()
    .from(channelSets)
    .where(and(eq(channelSets.id, id), eq(channelSets.organizationId, locals.auth.organizationId)))
    .limit(1);
  if (existing.length === 0) return json({ error: 'Set not found' }, 404);

  await db.delete(channelSets).where(and(eq(channelSets.id, id), eq(channelSets.organizationId, locals.auth.organizationId)));

  logActivity({
    userId: user.id,
    organizationId: locals.auth.organizationId,
    action: 'channel_set.deleted',
    resource: 'channel_set',
    resourceId: id,
    details: { name: existing[0].name },
  });

  return json({ success: true });
};
