import type { APIRoute } from 'astro';
import { findNextQueueSlot } from '@lib/queue/scheduler';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET: APIRoute = async ({ locals, url }) => {
  const { user } = locals.auth;
  if (!user) {
    return json({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } }, 401);
  }

  const tz = url.searchParams.get('timezone') || 'UTC';

  try {
    const slot = await findNextQueueSlot(locals.auth.organizationId, tz);
    return json(slot);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to find queue slot';
    return json({ error: { message, code: 'QUEUE_FULL' } }, 422);
  }
};
