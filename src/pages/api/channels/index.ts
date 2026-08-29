import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { computeTokenStatus } from '@/lib/channels/token-status';
import { getPlatformAvailabilityFor } from '@/lib/platforms/availability';

const SENSITIVE_METADATA_KEYS = ['pageAccessToken', 'access_token', 'clientSecret'];
function sanitizeChannelMetadata(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== 'object') return metadata;
  const clean = { ...(metadata as Record<string, unknown>) };
  for (const key of SENSITIVE_METADATA_KEYS) delete clean[key];
  return clean;
}

export const GET: APIRoute = async ({ locals, url }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const activeOnly = url.searchParams.get('active') !== 'false';

  const conditions = [eq(channels.organizationId, locals.auth.organizationId)];
  if (activeOnly) {
    conditions.push(eq(channels.isActive, true));
  }

  const rows = await db
    .select()
    .from(channels)
    .where(and(...conditions));

  // Resolve availability once per (platform, accountType) pair rather than per
  // row — the accountType matters because variants like LinkedIn company pages
  // are gated separately from personal profiles.
  const availabilityCache = new Map<string, ReturnType<typeof getPlatformAvailabilityFor>>();
  const availabilityOf = (platform: string, accountType: string | null) => {
    const key = JSON.stringify([platform, accountType]);
    let hit = availabilityCache.get(key);
    if (!hit) {
      hit = getPlatformAvailabilityFor(platform, accountType);
      availabilityCache.set(key, hit);
    }
    return hit;
  };

  const result = rows.map((ch) => {
    const { tokenStatus, autoRenews } = computeTokenStatus(ch);
    const availability = availabilityOf(ch.platform, ch.accountType ?? null);

    return {
      id: ch.id,
      platform: ch.platform,
      accountName: ch.accountName,
      accountId: ch.accountId,
      accountType: ch.accountType,
      profileImage: ch.profileImage,
      isActive: ch.isActive,
      needsReconnect: ch.needsReconnect ?? false,
      tokenStatus,
      autoRenews,
      tokenExpiresAt: ch.tokenExpiresAt,
      metadata: sanitizeChannelMetadata(ch.metadata),
      createdAt: ch.createdAt,
      updatedAt: ch.updatedAt,
      // Availability for this channel specifically — the `PLATFORM_<NAME>` kill
      // switch, narrowed by any variant flag matching its accountType
      // (`PLATFORM_LINKEDIN_PAGES`). A channel can
      // be perfectly healthy while its platform is switched off — clients use this
      // to show "temporarily unavailable" and explain why posts are being held.
      platformAvailable: availability.canPublish,
      platformState: availability.state,
      platformMessage: availability.message,
    };
  });

  // No HTTP caching: the channel list changes on connect/disconnect and is read
  // across the app (channels page, Compose, etc.). A 30s browser cache made newly
  // connected channels vanish on navigation until it expired. SWR's dedupingInterval
  // still prevents redundant refetches within a session.
  return json({ channels: result }, 200, { 'Cache-Control': 'no-store' });
};

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
