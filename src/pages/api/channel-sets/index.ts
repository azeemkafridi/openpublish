import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { channelSets } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { logActivity } from '@/lib/activity/log';
import { validateOwnedChannels } from '@/lib/channels/validate';

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

const MAX_SETS_PER_ORG = 50;

export const GET: APIRoute = async ({ locals }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const sets = await db
    .select()
    .from(channelSets)
    .where(eq(channelSets.organizationId, locals.auth.organizationId))
    .orderBy(channelSets.name);

  return json(sets, 200, { 'Cache-Control': 'private, max-age=30' });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 100) {
    return json({ error: 'Name is required (max 100 characters)' }, 400);
  }

  const channelIds = await validateOwnedChannels(locals.auth.organizationId, body?.channelIds);
  if (!channelIds) {
    return json({ error: 'channelIds must be a non-empty array of your channel ids' }, 400);
  }

  // One query serves both the per-org cap and the duplicate-name check.
  const existing = await db
    .select({ id: channelSets.id, name: channelSets.name })
    .from(channelSets)
    .where(eq(channelSets.organizationId, locals.auth.organizationId));
  if (existing.length >= MAX_SETS_PER_ORG) {
    return json({ error: `You can have at most ${MAX_SETS_PER_ORG} channel sets` }, 400);
  }
  if (existing.some((s) => s.name === name)) {
    return json({
      error: {
        message: `A set named "${name}" already exists.`,
        hint: 'Choose a different name or update the existing set instead.',
        code: 'DUPLICATE_NAME',
      },
    }, 409);
  }

  const [set] = await db
    .insert(channelSets)
    .values({
      userId: user.id,
      organizationId: locals.auth.organizationId,
      name,
      channelIds,
    })
    .returning();

  logActivity({
    userId: user.id,
    organizationId: locals.auth.organizationId,
    action: 'channel_set.created',
    resource: 'channel_set',
    resourceId: set.id,
    details: { name, channels: channelIds.length },
  });

  return json(set, 201);
};
