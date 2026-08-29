import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { rssFeeds } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { logActivity } from '@/lib/activity/log';
import { validateFeedUrl, validateOwnedChannels } from '@/lib/rss/validate';
import { normalizeFieldMapping } from '@/lib/rss/mapping';
import { getOrgPlan, getUserLimits } from '@/lib/quotas/check';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const PUT: APIRoute = async ({ request, locals, params }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const id = Number(params.id);
  if (isNaN(id)) return json({ error: 'Invalid feed ID' }, 400);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'Invalid body' }, 400);

  const existing = await db
    .select()
    .from(rssFeeds)
    .where(and(eq(rssFeeds.id, id), eq(rssFeeds.organizationId, locals.auth.organizationId)))
    .limit(1);
  if (existing.length === 0) return json({ error: 'Feed not found' }, 404);

  const updateData: Record<string, unknown> = { updatedAt: new Date() };

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name || name.length > 100) return json({ error: 'Name must be 1-100 characters' }, 400);
    updateData.name = name;
  }
  if (body.feedUrl !== undefined) {
    const feedUrl = await validateFeedUrl(body.feedUrl);
    if (!feedUrl) return json({ error: 'feedUrl must be a valid, publicly reachable http(s) URL' }, 400);
    updateData.feedUrl = feedUrl;
    // A different URL is effectively a new feed — re-baseline instead of
    // flooding channels with its backlog. lastSuccessAt is the baseline
    // sentinel the worker actually reads; the conditional-GET validators and
    // backoff state belong to the old URL.
    if (feedUrl !== existing[0].feedUrl) {
      updateData.lastCheckedAt = null;
      updateData.lastSuccessAt = null;
      updateData.etag = null;
      updateData.lastModified = null;
      updateData.consecutiveFailures = 0;
      updateData.nextPollAt = null;
    }
  }
  if (body.channelIds !== undefined) {
    const channelIds = await validateOwnedChannels(locals.auth.organizationId, body.channelIds);
    if (!channelIds) return json({ error: 'channelIds must be a non-empty array of your channel ids' }, 400);
    updateData.channelIds = channelIds;
  }
  if (body.mode !== undefined) {
    if (body.mode !== 'draft' && body.mode !== 'publish') return json({ error: "mode must be 'draft' or 'publish'" }, 400);
    // Plan gate: switching a feed to auto-publish is a paid feature.
    if (body.mode === 'publish') {
      const limits = getUserLimits(await getOrgPlan(locals.auth.organizationId));
      if (!limits.rssAutoPublish) {
        return json(
          { error: { message: 'Auto-publish mode is not available on your plan, so feeds run in draft mode. Upgrade to enable auto-publish.', code: 'FEATURE_DISABLED', resource: 'rss_auto_publish' } },
          403,
        );
      }
    }
    updateData.mode = body.mode;
  }
  if (body.fieldMapping !== undefined) {
    // null clears the mapping back to the built-in default.
    const fieldMapping = normalizeFieldMapping(body.fieldMapping);
    if (fieldMapping === null && body.fieldMapping !== null) {
      return json({ error: 'fieldMapping is not a valid mapping object' }, 400);
    }
    updateData.fieldMapping = fieldMapping;
  }
  if (body.requireApproval !== undefined) {
    updateData.requireApproval = Boolean(body.requireApproval);
  }
  if (body.enabled !== undefined) {
    updateData.enabled = Boolean(body.enabled);
    // Re-enabling (e.g. after the 20-failure auto-disable) must clear the
    // failure streak, or the next transient error instantly re-disables and
    // backoff starts at the 24h cap.
    if (updateData.enabled && !existing[0].enabled) {
      updateData.consecutiveFailures = 0;
      updateData.nextPollAt = null;
      updateData.lastError = null;
    }
  }

  const [updated] = await db
    .update(rssFeeds)
    .set(updateData)
    .where(and(eq(rssFeeds.id, id), eq(rssFeeds.organizationId, locals.auth.organizationId)))
    .returning();

  logActivity({
    userId: user.id,
    organizationId: locals.auth.organizationId,
    action: 'rss_feed.updated',
    resource: 'rss_feed',
    resourceId: id,
    details: { name: updated.name, enabled: updated.enabled, mode: updated.mode },
  });

  return json(updated);
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const id = Number(params.id);
  if (isNaN(id)) return json({ error: 'Invalid feed ID' }, 400);

  const existing = await db
    .select()
    .from(rssFeeds)
    .where(and(eq(rssFeeds.id, id), eq(rssFeeds.organizationId, locals.auth.organizationId)))
    .limit(1);
  if (existing.length === 0) return json({ error: 'Feed not found' }, 404);

  await db.delete(rssFeeds).where(and(eq(rssFeeds.id, id), eq(rssFeeds.organizationId, locals.auth.organizationId)));

  logActivity({
    userId: user.id,
    organizationId: locals.auth.organizationId,
    action: 'rss_feed.deleted',
    resource: 'rss_feed',
    resourceId: id,
    details: { name: existing[0].name },
  });

  return json({ success: true });
};
