import { getRedisConnection } from './jobs/queue';
import { createLogger } from './logger';

const logger = createLogger('cache');

/**
 * Cache-through helper: returns cached value if available, otherwise computes,
 * stores, and returns the result. Gracefully falls back to compute() if Redis
 * is unavailable.
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<T> {
  try {
    const redis = getRedisConnection();
    const raw = await redis.get(key);
    if (raw !== null) {
      return JSON.parse(raw) as T;
    }
  } catch {
    // Redis unavailable — fall through to compute
  }

  const result = await compute();

  try {
    const redis = getRedisConnection();
    await redis.set(key, JSON.stringify(result), 'EX', ttlSeconds);
  } catch {
    // Redis unavailable — result still returned, just not cached
  }

  return result;
}

/**
 * Invalidate all cache keys matching a glob pattern (e.g. "cache:analytics:5:*").
 * Uses SCAN (cursor) rather than KEYS — KEYS is O(N) over the whole keyspace and blocks
 * single-threaded Redis (which also backs BullMQ), so a user hammering "refresh" could
 * stall job processing. Silently ignores Redis errors.
 */
export async function invalidateCache(pattern: string): Promise<void> {
  try {
    const redis = getRedisConnection();
    let cursor = '0';
    let total = 0;
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) {
        await redis.del(...keys);
        total += keys.length;
      }
    } while (cursor !== '0');
    if (total > 0) {
      logger.info({ pattern, count: total }, 'Cache invalidated');
    }
  } catch {
    // Redis unavailable — nothing to invalidate
  }
}
