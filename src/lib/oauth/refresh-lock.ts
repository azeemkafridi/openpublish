import { getRedisConnection } from '../jobs/queue';
import { db } from '../db';
import { channels } from '../db/schema';
import { eq } from 'drizzle-orm';
import { encrypt, decrypt } from '../auth/crypto';
import { getPlatformHandler } from '../platforms/registry';
import type { PlatformName } from '../platforms/types';

/**
 * Per-channel single-flight lock for OAuth token refresh.
 *
 * Three uncoordinated paths can refresh the same channel: the token-refresh sweep, the
 * publish-worker's on-demand 401/ExpiredToken retry, and (for Bluesky) the metrics sync.
 * For platforms with rotating refresh tokens (X, TikTok, Bluesky, Pinterest) two concurrent
 * refreshes mean the loser gets `invalid_grant` and the channel is falsely flagged
 * needsReconnect. This Redis lock serialises refresh per channel.
 *
 * Fail-open by design: if Redis is unavailable the lock is treated as acquired so a Redis
 * blip never blocks token refresh (the race is a minor, self-healing concern by comparison).
 */

const LOCK_TTL_S = 30; // refresh is a couple of HTTP calls; 30s is ample and self-clears on a crash

/** Try to take the refresh lock for a channel. Returns true if acquired (or Redis is down). */
export async function acquireRefreshLock(channelId: number): Promise<boolean> {
  try {
    const res = await getRedisConnection().set(`refresh-lock:${channelId}`, '1', 'EX', LOCK_TTL_S, 'NX');
    return res === 'OK';
  } catch {
    return true; // fail open
  }
}

/** Release the refresh lock (best-effort; it also TTL-expires). */
export async function releaseRefreshLock(channelId: number): Promise<void> {
  try {
    await getRedisConnection().del(`refresh-lock:${channelId}`);
  } catch {
    // ignore — the lock will expire on its own
  }
}

/** Wait (bounded) for an in-flight refresh of this channel to finish, then return. */
export async function waitForRefreshLock(channelId: number, maxWaitMs = 12000): Promise<void> {
  try {
    const redis = getRedisConnection();
    const key = `refresh-lock:${channelId}`;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (!(await redis.exists(key))) return;
    }
  } catch {
    // ignore — caller proceeds with whatever token it can re-read
  }
}

/**
 * Refresh a channel's token under the single-flight lock AND persist the rotated tokens,
 * returning the fresh decrypted access token (or the current one if it couldn't be
 * refreshed, or null if there's nothing). If another path holds the lock, waits for it and
 * returns the freshly-persisted token. Used by the metrics sync so reading stale-token
 * metrics doesn't burn a rotating refresh token without saving the new one (e.g. Bluesky).
 */
export async function refreshChannelToken(channelId: number): Promise<string | null> {
  if (await acquireRefreshLock(channelId)) {
    try {
      const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
      if (!channel) return null;
      if (!channel.refreshToken) return channel.accessToken ? decrypt(channel.accessToken) : null;

      const handler = getPlatformHandler(channel.platform as PlatformName);
      const result = await handler
        .refreshToken(decrypt(channel.refreshToken), channel.accountType ?? undefined)
        .catch(() => null);
      // Refresh failed — return the existing (possibly stale) token; don't flag here, the
      // caller decides. Importantly we did NOT lose a rotated token.
      if (!result) return channel.accessToken ? decrypt(channel.accessToken) : null;

      const updates: Record<string, unknown> = {
        accessToken: encrypt(result.accessToken),
        updatedAt: new Date(),
        needsReconnect: false,
      };
      if (result.refreshToken) updates.refreshToken = encrypt(result.refreshToken);
      if (result.expiresIn) updates.tokenExpiresAt = new Date(Date.now() + result.expiresIn * 1000);
      await db.update(channels).set(updates).where(eq(channels.id, channelId));
      return result.accessToken;
    } finally {
      await releaseRefreshLock(channelId);
    }
  }

  // Busy — another path is refreshing; wait then return the freshly-persisted token.
  await waitForRefreshLock(channelId);
  const [row] = await db.select({ accessToken: channels.accessToken }).from(channels).where(eq(channels.id, channelId)).limit(1);
  return row?.accessToken ? decrypt(row.accessToken) : null;
}
