import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { apiKeys } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { logActivity } from '@/lib/activity/log';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const DELETE: APIRoute = async ({ locals, params }) => {
  const { user, organizationId } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const id = Number(params.id);
  if (isNaN(id)) return json({ error: 'Invalid API key ID' }, 400);

  const existing = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.organizationId, organizationId)))
    .limit(1);

  if (existing.length === 0) {
    return json({ error: 'API key not found' }, 404);
  }

  await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.organizationId, organizationId)));

  logActivity({
    userId: user.id,
    organizationId,
    action: 'api_key.deleted',
    resource: 'api_key',
    resourceId: id,
    details: { name: existing[0].name },
  });

  return json({ success: true });
};
