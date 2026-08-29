import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { rssFeeds } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { logActivity } from '@/lib/activity/log';
import { validateFeedUrl, validateOwnedChannels } from '@/lib/rss/validate';
import { normalizeFieldMapping } from '@/lib/rss/mapping';
import { checkRssFeedQuota, getOrgPlan, getUserLimits } from '@/lib/quotas/check';
import { quotaExceededResponse } from '@/lib/quotas/errors';

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export const GET: APIRoute = async ({ locals }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const feeds = await db
    .select()
    .from(rssFeeds)
    .where(eq(rssFeeds.organizationId, locals.auth.organizationId))
    .orderBy(rssFeeds.name);

  return json(feeds, 200, { 'Cache-Control': 'private, max-age=15' });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 100) return json({ error: 'Name is required (max 100 characters)' }, 400);

  const feedUrl = await validateFeedUrl(body?.feedUrl);
  if (!feedUrl) return json({ error: 'feedUrl must be a valid, publicly reachable http(s) URL' }, 400);

  const channelIds = await validateOwnedChannels(locals.auth.organizationId, body?.channelIds);
  if (!channelIds) return json({ error: 'channelIds must be a non-empty array of your channel ids' }, 400);

  const mode = body?.mode === 'publish' ? 'publish' : 'draft';

  const fieldMapping = normalizeFieldMapping(body?.fieldMapping);
  if (fieldMapping === null && body?.fieldMapping !== null) {
    return json({ error: 'fieldMapping is not a valid mapping object' }, 400);
  }

  // Plan gate: feed count (0 = feature disabled on this plan).
  const orgId = locals.auth.organizationId;
  const plan = await getOrgPlan(orgId);
  const limits = getUserLimits(plan);
  const quota = await checkRssFeedQuota(orgId);
  if (!quota.allowed) {
    return quotaExceededResponse(quota, plan);
  }

  // Plan gate: auto-publish mode is a paid feature; lower tiers are draft-only.
  if (mode === 'publish' && !limits.rssAutoPublish) {
    return json(
      { error: { message: 'Auto-publish mode is not available on your plan, so feeds run in draft mode. Upgrade to enable auto-publish.', code: 'FEATURE_DISABLED', resource: 'rss_auto_publish' } },
      403,
    );
  }

  const [feed] = await db
    .insert(rssFeeds)
    .values({
      userId: user.id,
      organizationId: locals.auth.organizationId,
      name,
      feedUrl,
      channelIds,
      mode,
      // Approval-gated feed: auto-published items park for an approver.
      requireApproval: body?.requireApproval === true,
      ...(fieldMapping !== undefined ? { fieldMapping } : {}),
    })
    .returning();

  logActivity({
    userId: user.id,
    organizationId: locals.auth.organizationId,
    action: 'rss_feed.created',
    resource: 'rss_feed',
    resourceId: feed.id,
    details: { name, mode, channels: channelIds.length },
  });

  return json(feed, 201);
};
