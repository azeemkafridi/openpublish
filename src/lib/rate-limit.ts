import { getRedisConnection } from './jobs/queue';
import { createLogger } from './logger';
import { captureApiError } from './errors';

const logger = createLogger('rate-limit');

// Failing open is deliberate (a Redis blip must not 500 every request), but a
// sustained Redis outage silently removes ALL burst protection — alert once
// per window per process instead of only writing log lines nobody watches.
let lastFailOpenAlert = 0;
const FAIL_OPEN_ALERT_INTERVAL_MS = 5 * 60 * 1000;

function alertFailOpen(err: unknown): void {
  const now = Date.now();
  if (now - lastFailOpenAlert < FAIL_OPEN_ALERT_INTERVAL_MS) return;
  lastFailOpenAlert = now;
  captureApiError('rate-limit fail-open (Redis unreachable — burst protection disabled)', err);
}

/**
 * Sliding-window rate limiter backed by Redis.
 * Uses a sorted set per key with timestamps as scores.
 */
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number; retryAfter?: number }> {
  try {
    const redis = getRedisConnection();
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const windowStart = now - windowMs;

    const multi = redis.multi();
    // Remove expired entries
    multi.zremrangebyscore(key, 0, windowStart);
    // Count entries in current window
    multi.zcard(key);
    // Add current request
    multi.zadd(key, now, `${now}:${Math.random().toString(36).slice(2, 8)}`);
    // Set TTL on the key
    multi.expire(key, windowSeconds + 1);

    const results = await multi.exec();
    const currentCount = (results?.[1]?.[1] as number) ?? 0;

    if (currentCount >= maxRequests) {
      // Find oldest entry to calculate retry-after
      const oldest = await redis.zrange(key, 0, 0, 'WITHSCORES');
      const oldestTime = oldest.length >= 2 ? Number(oldest[1]) : now - windowMs;
      const retryAfter = Math.ceil((oldestTime + windowMs - now) / 1000);

      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(1, retryAfter),
      };
    }

    return {
      allowed: true,
      remaining: maxRequests - currentCount - 1,
    };
  } catch (err) {
    // Redis unavailable — fail OPEN. Burst protection is best-effort; a Redis blip must
    // not 500 every API request and login. (Plan/quota limits are recomputed from Postgres.)
    logger.error({ key, error: err instanceof Error ? err.message : String(err) }, 'Rate limit check failed — failing open');
    alertFailOpen(err);
    return { allowed: true, remaining: maxRequests };
  }
}

/**
 * Daily API quota check using a simple Redis counter per org per day.
 * Increments on each call and checks against the plan limit.
 */
export async function checkDailyApiQuota(
  organizationId: number,
  plan: 'free' | 'pro' | 'business',
): Promise<{ allowed: boolean; current: number; limit: number }> {
  const { PLAN_LIMITS } = await import('./quotas/plans');
  const limit = PLAN_LIMITS[plan].apiRequestsPerDay;
  if (limit === -1) return { allowed: true, current: 0, limit: -1 };

  const redis = getRedisConnection();
  const today = new Date().toISOString().slice(0, 10);
  const key = `rl:api:daily:${organizationId}:${today}`;

  try {
    const current = await redis.incr(key);
    // Set TTL on first increment (48h to cover timezone edge cases)
    if (current === 1) {
      await redis.expire(key, 172800);
    }

    return { allowed: current <= limit, current, limit };
  } catch (err) {
    // Redis unavailable — fail OPEN so a blip doesn't 500 every API request.
    logger.error({ organizationId, error: err instanceof Error ? err.message : String(err) }, 'Daily API quota check failed — failing open');
    return { allowed: true, current: 0, limit };
  }
}

/**
 * Increment per-key daily counter (fire-and-forget from auth middleware).
 */
export function trackApiKeyUsage(keyId: number): void {
  try {
    const redis = getRedisConnection();
    const today = new Date().toISOString().slice(0, 10);
    const key = `rl:api:key:${keyId}:${today}`;
    redis.incr(key).catch(() => {});
    redis.expire(key, 172800).catch(() => {});
  } catch {
    // Redis unavailable — skip tracking
  }
}

/**
 * Get daily usage count for an org or key.
 */
export async function getDailyApiUsage(
  organizationId: number,
  keyId?: number,
): Promise<number> {
  try {
    const redis = getRedisConnection();
    const today = new Date().toISOString().slice(0, 10);
    const key = keyId
      ? `rl:api:key:${keyId}:${today}`
      : `rl:api:daily:${organizationId}:${today}`;
    const count = await redis.get(key);
    return count ? parseInt(count, 10) : 0;
  } catch {
    return 0;
  }
}

export function rateLimitResponse(retryAfter: number): Response {
  return new Response(
    JSON.stringify({ error: { message: 'Too many requests', code: 'RATE_LIMITED' } }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
      },
    },
  );
}
