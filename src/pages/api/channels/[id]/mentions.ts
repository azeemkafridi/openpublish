import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { decrypt } from '@/lib/auth/crypto';
import { getPlatformHandler } from '@/lib/platforms/registry';
import '@/lib/platforms/init';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { cached } from '@/lib/cache';
import type { PlatformName, ChannelData } from '@/lib/platforms/types';

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export const GET: APIRoute = async ({ locals, params, url }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const id = Number(params.id);
  if (!id || isNaN(id)) return json({ error: 'Invalid channel ID' }, 400);

  const query = url.searchParams.get('q')?.trim();
  // Each provider user-search is a paid read (X charges up to $0.05/call). Don't search on
  // 0–1 chars — return empty so per-keystroke autocomplete can't drain credits.
  if (!query || query.length < 2) {
    return json({ users: [] }, 200, { 'Cache-Control': 'private, max-age=5' });
  }
  if (query.length > 100) return json({ error: 'Query too long (max 100 characters)' }, 400);

  // Per-user rate limit — bounds the cost of scripted/abusive mention lookups.
  const rl = await checkRateLimit(`rl:mentions:${user.id}`, 10, 60);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter ?? 60);

  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, id), eq(channels.organizationId, locals.auth.organizationId)))
    .limit(1);

  if (!channel) return json({ error: 'Channel not found' }, 404);
  if (!channel.accessToken) return json({ error: 'No access token for this channel' }, 400);

  try {
    const handler = getPlatformHandler(channel.platform as PlatformName);
    const channelData: ChannelData = {
      id: channel.id,
      platform: channel.platform as PlatformName,
      accountId: channel.accountId,
      accountName: channel.accountName,
      accountType: channel.accountType ?? undefined,
      accessToken: decrypt(channel.accessToken),
      refreshToken: channel.refreshToken ? decrypt(channel.refreshToken) : undefined,
      metadata: channel.metadata ?? undefined,
      organizationId: locals.auth.organizationId,
    };

    // Cache the result ~60s so repeated/identical lookups (a re-typed handle, several users
    // searching the same name) don't re-spend the X read budget. On a cache miss, searchUsers
    // still applies the org's monthly X budget. X user search is public, so the channel+query key is safe.
    const cacheKey = `cache:x-mentions:${channel.platform}:${id}:${query.toLowerCase()}`;
    const users = await cached(cacheKey, 60, () => handler.searchUsers(channelData, query));
    return json({ users }, 200, { 'Cache-Control': 'private, max-age=5' });
  } catch (error) {
    console.error('GET /api/channels/[id]/mentions failed:', error);
    return json({ error: 'Search failed. Please try again.' }, 500);
  }
};
