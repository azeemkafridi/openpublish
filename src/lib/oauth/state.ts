import { randomBytes } from 'node:crypto';
import { getRedisConnection } from '../jobs/queue';

const STATE_TTL = 600; // 10 minutes in seconds
const KEY_PREFIX = 'oauth_state:';

export interface OAuthStateData {
  userId: string;
  platform: string;
  organizationId: number;
  metadata?: Record<string, string>;
}

export function generateOAuthState(userId: string, platform: string, organizationId: number, metadata?: Record<string, string>): string {
  const state = randomBytes(32).toString('hex');
  const data: OAuthStateData = { userId, platform, organizationId, ...(metadata ? { metadata } : {}) };

  // Store in Redis (fire-and-forget)
  try {
    const redis = getRedisConnection();
    redis
      .set(
        `${KEY_PREFIX}${state}`,
        JSON.stringify(data),
        'EX',
        STATE_TTL,
      )
      .catch(() => {});
  } catch {
    // Redis not available, memory-only
  }

  // Always store in memory as backup
  memoryStore.set(state, { ...data, createdAt: Date.now() });

  return state;
}

export async function validateOAuthState(
  state: string,
): Promise<OAuthStateData | null> {
  // Try Redis first
  try {
    const redis = getRedisConnection();
    const raw = await redis.get(`${KEY_PREFIX}${state}`);
    if (raw) {
      await redis.del(`${KEY_PREFIX}${state}`);
      return JSON.parse(raw);
    }
  } catch {
    // Fall through to memory
  }

  // Fallback to memory store
  const entry = memoryStore.get(state);
  if (!entry) return null;

  memoryStore.delete(state);

  if (Date.now() - entry.createdAt > STATE_TTL * 1000) return null;

  return { userId: entry.userId, platform: entry.platform, organizationId: entry.organizationId, ...(entry.metadata ? { metadata: entry.metadata } : {}) };
}

// In-memory fallback
const memoryStore = new Map<
  string,
  { userId: string; platform: string; organizationId: number; metadata?: Record<string, string>; createdAt: number }
>();
