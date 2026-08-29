/**
 * Shared channel-deactivation core, used by the user-facing disconnect route
 * (DELETE /api/channels/[id]) and the channel-slots expiry worker.
 *
 * Two modes, one difference — what happens to the tokens:
 *  - 'disconnect' (user clicked Disconnect): wipes access/refresh tokens and
 *    scrubs sensitive metadata. That's the actual revocation; reconnecting later
 *    is a full OAuth round-trip.
 *  - 'suspend' (paid slot expired): flips isActive off but KEEPS tokens, so a
 *    re-purchase or plan upgrade can revive the channel without the user
 *    re-authorizing on the platform.
 *
 * Both modes soft-delete (the row survives so post_platforms/account_metrics
 * history does too) and deactivate any recurring schedule left with no active
 * channel.
 */
import { db } from '../db';
import { channels, recurringSchedules } from '../db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';

const SENSITIVE_METADATA_KEYS = ['pageAccessToken', 'access_token', 'clientSecret'];

export function sanitizeChannelMetadata(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== 'object') return metadata;
  const clean = { ...(metadata as Record<string, unknown>) };
  for (const key of SENSITIVE_METADATA_KEYS) delete clean[key];
  return clean;
}

export async function deactivateChannel(opts: {
  channelId: number;
  organizationId: number;
  mode: 'disconnect' | 'suspend';
}): Promise<boolean> {
  const { channelId, organizationId, mode } = opts;

  if (mode === 'disconnect') {
    const [channel] = await db
      .select({ id: channels.id, metadata: channels.metadata })
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.organizationId, organizationId)))
      .limit(1);
    if (!channel) return false;

    const scrubbedMetadata = sanitizeChannelMetadata(channel.metadata);
    await db
      .update(channels)
      .set({
        isActive: false,
        needsReconnect: false,
        accessToken: null,
        refreshToken: null,
        tokenExpiresAt: null,
        metadata: scrubbedMetadata as Record<string, unknown> | null,
        updatedAt: new Date(),
      })
      .where(eq(channels.id, channel.id));
  } else {
    const updated = await db
      .update(channels)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(channels.id, channelId), eq(channels.organizationId, organizationId)))
      .returning({ id: channels.id });
    if (updated.length === 0) return false;
  }

  await deactivateOrphanedSchedules(organizationId, channelId);
  return true;
}

/** Deactivate recurring schedules that reference `channelId` and now have no active channel left. */
async function deactivateOrphanedSchedules(organizationId: number, channelId: number): Promise<void> {
  const schedulesWithChannel = await db
    .select()
    .from(recurringSchedules)
    .where(
      and(
        eq(recurringSchedules.organizationId, organizationId),
        eq(recurringSchedules.isActive, true),
        sql`${recurringSchedules.channelIds} @> ${JSON.stringify([channelId])}::jsonb`,
      ),
    );

  for (const schedule of schedulesWithChannel) {
    const remainingIds = ((schedule.channelIds || []) as number[]).filter((cid) => cid !== channelId);
    let hasActiveChannel = false;
    if (remainingIds.length > 0) {
      const [active] = await db
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.isActive, true), inArray(channels.id, remainingIds)))
        .limit(1);
      hasActiveChannel = !!active;
    }
    if (!hasActiveChannel) {
      await db
        .update(recurringSchedules)
        .set({ isActive: false })
        .where(eq(recurringSchedules.id, schedule.id));
    }
  }
}
