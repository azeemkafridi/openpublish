import { randomBytes } from 'node:crypto';
import { getRedisConnection } from '../jobs/queue';
import { encrypt, decrypt } from '../auth/crypto';

/**
 * Short-lived store for the LinkedIn company-page OAuth flow.
 *
 * After the user consents on the Community Management app (App B), the callback holds an
 * org-scoped access token but cannot create a channel yet — the user still has to pick
 * which administered organization to connect. We stash the token here keyed by a random
 * handle, redirect the browser to the picker, list the orgs, then finalize the channel.
 *
 * Tokens are encrypted at rest and the entry self-expires, so abandoned flows leave no
 * trace (unlike persisting a half-built channel row). Mirrors oauth/state.ts: Redis with
 * an in-memory fallback for single-process / Redis-down scenarios.
 */

const SESSION_TTL = 900; // 15 minutes in seconds
const KEY_PREFIX = 'li_page_session:';

export interface LinkedInPageSession {
  userId: string;
  organizationId: number;
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

interface StoredSession {
  userId: string;
  organizationId: number;
  accessToken: string; // encrypted
  refreshToken?: string; // encrypted
  expiresIn?: number;
}

const memoryStore = new Map<string, StoredSession & { createdAt: number }>();

export async function storeLinkedInPageSession(session: LinkedInPageSession): Promise<string> {
  const key = randomBytes(32).toString('hex');
  const stored: StoredSession = {
    userId: session.userId,
    organizationId: session.organizationId,
    accessToken: encrypt(session.accessToken),
    refreshToken: session.refreshToken ? encrypt(session.refreshToken) : undefined,
    expiresIn: session.expiresIn,
  };

  try {
    const redis = getRedisConnection();
    await redis.set(`${KEY_PREFIX}${key}`, JSON.stringify(stored), 'EX', SESSION_TTL);
  } catch {
    // Redis not available — rely on the in-memory backup below
  }

  memoryStore.set(key, { ...stored, createdAt: Date.now() });
  return key;
}

/** Read a session without deleting it (used by the org-listing step). */
export async function peekLinkedInPageSession(key: string): Promise<LinkedInPageSession | null> {
  return readSession(key, false);
}

/** Read and delete a session (used when finalizing the chosen page). */
export async function consumeLinkedInPageSession(key: string): Promise<LinkedInPageSession | null> {
  return readSession(key, true);
}

async function readSession(key: string, remove: boolean): Promise<LinkedInPageSession | null> {
  let stored: StoredSession | null = null;

  try {
    const redis = getRedisConnection();
    const raw = await redis.get(`${KEY_PREFIX}${key}`);
    if (raw) {
      stored = JSON.parse(raw) as StoredSession;
      if (remove) await redis.del(`${KEY_PREFIX}${key}`);
    }
  } catch {
    // Fall through to memory store
  }

  if (!stored) {
    const entry = memoryStore.get(key);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > SESSION_TTL * 1000) {
      memoryStore.delete(key);
      return null;
    }
    stored = entry;
  }

  if (remove) memoryStore.delete(key);

  return {
    userId: stored.userId,
    organizationId: stored.organizationId,
    accessToken: decrypt(stored.accessToken),
    refreshToken: stored.refreshToken ? decrypt(stored.refreshToken) : undefined,
    expiresIn: stored.expiresIn,
  };
}
