import { getRedisConnection } from './queue';
import { createLogger } from '../logger';

const logger = createLogger('platform-semaphore');

/**
 * Redis-backed per-platform publish concurrency cap.
 *
 * The BullMQ worker's `concurrency` is per-process, so it stops bounding
 * anything the moment a second worker replica runs — and it can't distinguish
 * a strict platform (X) from a generous one (Mastodon). This semaphore is
 * global across all worker processes: INCR the platform's counter, run if
 * within the cap, otherwise poll until a slot frees.
 *
 * Fail-open by design: if Redis is unreachable, or the wait exceeds
 * MAX_WAIT_MS, the publish proceeds anyway — a rate-limit error from the
 * platform is retryable (classifyPublishError), a silently stuck post is
 * worse. The key carries a TTL so a crashed process can't leak slots forever.
 */

const POLL_MS = 1000;
const MAX_WAIT_MS = 60_000;
const SLOT_TTL_S = 15 * 60;

/** Platforms stricter than the default cap. X's per-app write quota is tiny. */
const PLATFORM_MAX_CONCURRENT: Record<string, number> = {
  x: 1,
  linkedin: 2,
  pinterest: 2,
};
const DEFAULT_MAX_CONCURRENT = 5;

export function platformConcurrencyCap(platform: string): number {
  return PLATFORM_MAX_CONCURRENT[platform] ?? DEFAULT_MAX_CONCURRENT;
}

function slotKey(platform: string): string {
  return `publish:sem:${platform}`;
}

export async function withPlatformSlot<T>(platform: string, fn: () => Promise<T>): Promise<T> {
  const max = platformConcurrencyCap(platform);
  const key = slotKey(platform);
  const redis = getRedisConnection();
  let held = false;

  try {
    const deadline = Date.now() + MAX_WAIT_MS;
    for (;;) {
      const count = await redis.incr(key);
      // The increment is live from here — mark held BEFORE any other Redis call
      // so a failed expire/decr can't leak it (the finally below releases it).
      held = true;
      if (count === 1) {
        // TTL only on key creation: refreshing it on every poll would keep a
        // slot leaked by a crashed holder alive forever under steady traffic.
        // Expiry while slots are briefly held just resets the counter (fail-open).
        await redis.expire(key, SLOT_TTL_S);
      }
      if (count <= max) break;
      await redis.decr(key);
      held = false;
      if (Date.now() >= deadline) {
        logger.warn({ platform, max }, 'Platform slot wait exceeded — proceeding without slot');
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } catch (err) {
    // Redis hiccup — publish anyway rather than stranding the post. `held`
    // reflects whether an increment is still outstanding.
    logger.warn({ platform, error: String(err) }, 'Platform semaphore unavailable — proceeding');
  }

  try {
    return await fn();
  } finally {
    if (held) {
      try {
        const remaining = await redis.decr(key);
        if (remaining < 0) await redis.del(key);
      } catch {
        // TTL cleans up a leaked slot.
      }
    }
  }
}
