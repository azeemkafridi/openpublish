import { db } from '../db';
import { channels } from '../db/schema';
import { eq, and, inArray } from 'drizzle-orm';

/**
 * Validate a user-supplied channel-id list: a non-empty array of unique
 * positive integers, every one owned by the org. Returns the ids or null.
 * Shared by channel Sets and RSS feeds (and any future channel-targeting
 * feature) so the tenant-isolation check lives in exactly one place.
 */
export async function validateOwnedChannels(organizationId: number, channelIds: unknown): Promise<number[] | null> {
  if (!Array.isArray(channelIds) || channelIds.length === 0) return null;
  const ids = [...new Set(channelIds)].filter((id): id is number => Number.isInteger(id) && id > 0);
  if (ids.length !== channelIds.length) return null;
  const owned = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(inArray(channels.id, ids), eq(channels.organizationId, organizationId)));
  return owned.length === ids.length ? ids : null;
}

/**
 * True when every entry is a positive integer — the only shape channels.id
 * (bigint) can bind. Anything else must be rejected with a 400 BEFORE the
 * query: Postgres rejects e.g. "sk_evo05" at parse time, which surfaces as an
 * opaque 500 (prod regression e04d7d6e, 2026-08-18 — a REST client sent the
 * account handle where the numeric channelId belongs).
 */
export function isChannelIdList(ids: unknown[]): ids is number[] {
  return ids.every((id) => Number.isInteger(id) && (id as number) > 0);
}
