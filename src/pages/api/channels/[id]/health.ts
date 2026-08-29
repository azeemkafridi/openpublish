import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import '@/lib/platforms/init';
import { getPlatformHandler } from '@/lib/platforms/registry';
import { decrypt, encrypt } from '@/lib/auth/crypto';
import { refreshChannelToken } from '@/lib/oauth/refresh-lock';
import { getOrgPlan } from '@/lib/quotas/check';
import { checkXReadBudget, trackXApiCall, X_API_COSTS_DCENTS, isXLiveApiDisabled } from '@/lib/platforms/x-usage';
import { cached } from '@/lib/cache';
import { isReconnectError } from '@/lib/platforms/auth-errors';
import type { PlatformName } from '@/lib/platforms/types';

export const GET: APIRoute = async ({ locals, params }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const id = Number(params.id);
  if (isNaN(id)) return json({ error: 'Invalid channel ID' }, 400);

  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, id), eq(channels.organizationId, locals.auth.organizationId)));

  if (!channel) return json({ error: 'Channel not found' }, 404);

  // A prior publish failure or the validation sweep already proved this token
  // dead — report it without burning a platform call.
  if (channel.needsReconnect) {
    return json({
      healthy: false,
      tokenStatus: 'expired',
      message: 'Access was revoked or expired. Please reconnect this channel.',
    });
  }

  // Access token past its expiry — for channels holding a refresh credential this is
  // routine (e.g. Google tokens live 1 hour), so renew in place instead of reporting
  // the channel dead; only a channel with no way to renew is truly expired.
  let accessToken = channel.accessToken;
  if (channel.tokenExpiresAt && new Date(channel.tokenExpiresAt) <= new Date()) {
    const refreshed = channel.refreshToken ? await refreshChannelToken(channel.id) : null;
    if (!refreshed) {
      return json({
        healthy: false,
        tokenStatus: 'expired',
        message: 'Access token has expired. Please reconnect this channel.',
      });
    }
    accessToken = encrypt(refreshed);
  }

  if (!accessToken) {
    return json({
      healthy: false,
      tokenStatus: 'error',
      message: 'No access token stored for this channel.',
    });
  }

  // Global kill switch — skip the (paid) live X read while traffic is paused. Bypasses the cache
  // so re-enabling takes effect immediately.
  if (channel.platform === 'x' && isXLiveApiDisabled()) {
    return json({ healthy: true, tokenStatus: 'unknown', message: 'X health checks are temporarily paused.' });
  }

  // For X, getAccountInfo is a paid GET /users/me read — cache the result ~60s (so repeated
  // "Check health" clicks don't re-spend) and gate it by the org’s monthly X budget (paid plans only). Other
  // platforms (free reads) compute a fresh result each call.
  const computeHealth = async (): Promise<Record<string, unknown>> => {
    if (channel.platform === 'x') {
      const plan = await getOrgPlan(locals.auth.organizationId);
      if (!(await checkXReadBudget(locals.auth.organizationId, plan, X_API_COSTS_DCENTS.user_read))) {
        return {
          healthy: true,
          tokenStatus: 'unknown',
          message: 'X read budget unavailable. Token re-verification needs a paid plan with remaining monthly X budget.',
        };
      }
    }
    try {
      const handler = getPlatformHandler(channel.platform as PlatformName);
      await handler.getAccountInfo(decrypt(accessToken!));
      if (channel.platform === 'x') {
        trackXApiCall(locals.auth.organizationId, 'user_read', X_API_COSTS_DCENTS.user_read);
      }
      return { healthy: true, tokenStatus: 'valid' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error checking channel health';
      // The live check just proved the token dead — persist it so /api/channels
      // and publishing agree with this result (matches the publish worker's flag).
      if (isReconnectError(message)) {
        await db
          .update(channels)
          .set({ needsReconnect: true, updatedAt: new Date() })
          .where(eq(channels.id, channel.id));
      }
      return { healthy: false, tokenStatus: 'error', message };
    }
  };

  const result = channel.platform === 'x'
    ? await cached(`cache:x-health:${id}`, 60, computeHealth)
    : await computeHealth();

  return json(result);
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
