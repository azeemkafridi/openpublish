import type { APIRoute } from 'astro';
import { addMetricsSyncJob, getRedisConnection } from '@/lib/jobs/queue';
import { invalidateCache } from '@/lib/cache';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const THROTTLE_SECONDS = 5 * 60;
const FORCE_FLOOR_SECONDS = 60; // even ?force=1 can't re-sync more than once a minute

export const POST: APIRoute = async ({ locals, request }) => {
  const { user, organizationId } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  // `?force=1` bypasses the 5-min throttle (manual refresh button)…
  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';

  const redis = getRedisConnection();
  const throttleKey = `analytics:refresh:throttle:${organizationId}`;
  const floorKey = `analytics:refresh:force-floor:${organizationId}`;
  const lastSynced = await redis.get(throttleKey);

  if (force) {
    // …but NOT the hard per-minute floor. Each sync re-reads up to 30 days of metrics, and on
    // X every read is paid, so an unbounded force loop could drain credits for the whole org.
    if (await redis.get(floorKey)) {
      return json({ status: 'throttled', reason: 'force_floor', lastSyncedAt: lastSynced });
    }
  } else if (lastSynced) {
    return json({ status: 'throttled', lastSyncedAt: lastSynced });
  }

  const now = new Date().toISOString();
  await redis.set(throttleKey, now, 'EX', THROTTLE_SECONDS);
  await redis.set(floorKey, now, 'EX', FORCE_FLOOR_SECONDS);

  await addMetricsSyncJob(organizationId);
  await invalidateCache(`cache:analytics:${organizationId}:*`);

  return json({ status: 'queued', lastSyncedAt: now });
};
