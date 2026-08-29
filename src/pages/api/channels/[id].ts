import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { logActivity } from '@/lib/activity/log';
import { computeTokenStatus } from '@/lib/channels/token-status';
import { deactivateChannel, sanitizeChannelMetadata } from '@/lib/channels/deactivate';

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

  const { tokenStatus, autoRenews } = computeTokenStatus(channel);

  return json({
    channel: {
      id: channel.id,
      platform: channel.platform,
      accountName: channel.accountName,
      accountId: channel.accountId,
      accountType: channel.accountType,
      profileImage: channel.profileImage,
      isActive: channel.isActive,
      needsReconnect: channel.needsReconnect ?? false,
      tokenStatus,
      autoRenews,
      tokenExpiresAt: channel.tokenExpiresAt,
      metadata: sanitizeChannelMetadata(channel.metadata),
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
    },
  });
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const id = Number(params.id);
  if (isNaN(id)) return json({ error: 'Invalid channel ID' }, 400);

  // Soft delete: keep the channel row so published posts and metrics survive a
  // disconnect (post_platforms/account_metrics cascade on hard delete). Tokens are
  // wiped — that's the actual revocation — and reconnecting the same account
  // revives this row via the connect paths' existing-channel upsert.
  // (Core lives in lib/channels/deactivate.ts, shared with the slot-expiry worker.)
  const found = await deactivateChannel({
    channelId: id,
    organizationId: locals.auth.organizationId,
    mode: 'disconnect',
  });

  if (!found) {
    return json({ error: 'Channel not found or not owned by user' }, 404);
  }

  logActivity({
    userId: user.id,
    organizationId: locals.auth.organizationId,
    action: 'channel.disconnected',
    resource: 'channel',
    resourceId: id,
  });

  return json({ success: true, deletedId: id });
};

export const PATCH: APIRoute = async ({ locals, params, request }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const id = Number(params.id);
  if (isNaN(id)) return json({ error: 'Invalid channel ID' }, 400);

  let body: { metricsSyncEnabled?: unknown };
  try {
    body = (await request.json()) as { metricsSyncEnabled?: unknown };
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, id), eq(channels.organizationId, locals.auth.organizationId)))
    .limit(1);
  if (!channel) return json({ error: 'Channel not found' }, 404);

  const updates: Record<string, unknown> = {};

  // X metrics sync opt-in. X charges per read, so analytics sync is off by default and must be
  // explicitly enabled per channel (see metrics-sync.worker — also throttled to once/7 days).
  if (typeof body.metricsSyncEnabled === 'boolean') {
    const meta = { ...((channel.metadata as Record<string, unknown> | null) ?? {}) };
    meta.metricsSyncEnabled = body.metricsSyncEnabled;
    updates.metadata = meta;
  }

  if (Object.keys(updates).length === 0) {
    return json({ error: 'No supported fields to update' }, 400);
  }

  updates.updatedAt = new Date();
  await db.update(channels).set(updates).where(eq(channels.id, id));

  return json({ success: true });
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
