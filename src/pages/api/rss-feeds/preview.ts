import type { APIRoute } from 'astro';
import { validateFeedUrl, validateOwnedChannels } from '@/lib/rss/validate';
import { fetchFeedXml } from '@/lib/rss/fetch';
import { parseFeed, FeedParseError } from '@/lib/rss/parse';
import {
  DEFAULT_FIELD_MAPPING,
  normalizeFieldMapping,
  renderItemForChannels,
  stripHtmlToText,
  availableTokens,
} from '@/lib/rss/mapping';
import { fetchLinkPreviewCached, type LinkPreview } from '@/lib/link-preview';
import { platformLength } from '@/lib/url';
import { checkRateLimit } from '@/lib/rate-limit';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Live mapping preview: fetch the feed, take its newest item, and render it
 * for each requested channel with the supplied (unsaved) field mapping.
 * Read-only — nothing is stored. Internal to the app UI (not in openapi.json,
 * same as bulk-create).
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  // Each call triggers outbound fetches (feed + link unfurl) — rate-limit per
  // user so the endpoint can't be used as a fetch proxy / origin hammer.
  const rl = await checkRateLimit(`rl:rss-preview:${user.id}`, 10, 60);
  if (!rl.allowed) {
    return json({ error: 'Too many preview requests. Wait a moment and try again.' }, 429);
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'Invalid body' }, 400);

  const feedUrl = await validateFeedUrl(body.feedUrl);
  if (!feedUrl) return json({ error: 'feedUrl must be a valid, publicly reachable http(s) URL' }, 400);

  const channelIds = await validateOwnedChannels(locals.auth.organizationId, body.channelIds);
  if (!channelIds) return json({ error: 'channelIds must be a non-empty array of your channel ids' }, 400);

  // Validate BEFORE defaulting — an invalid mapping must 400 (matching the
  // save endpoints), not silently preview with the built-in default.
  const normalized = normalizeFieldMapping(body.fieldMapping);
  if (normalized === null && body.fieldMapping != null) {
    return json({ error: 'fieldMapping is not a valid mapping object' }, 400);
  }
  const mapping = normalized ?? DEFAULT_FIELD_MAPPING;

  let xml: string;
  try {
    xml = await fetchFeedXml(feedUrl);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Could not fetch the feed' }, 422);
  }

  let parsed;
  try {
    parsed = parseFeed(xml, feedUrl);
  } catch (err) {
    if (err instanceof FeedParseError) return json({ error: err.message }, 422);
    throw err;
  }
  if (parsed.items.length === 0) return json({ error: 'The feed has no items to preview' }, 422);

  // Newest item — what the next poll would publish.
  const item = [...parsed.items].sort(
    (a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
  )[0];

  const targetChannels = await db
    .select({ id: channels.id, platform: channels.platform, accountName: channels.accountName })
    .from(channels)
    .where(and(
      eq(channels.organizationId, locals.auth.organizationId),
      inArray(channels.id, channelIds),
    ));

  const feedName = typeof body.feedName === 'string' && body.feedName.trim()
    ? body.feedName.trim().slice(0, 100)
    : parsed.title || 'Feed';

  const { media, renders } = renderItemForChannels(mapping, { item, feedName }, targetChannels);
  const nameById = new Map(targetChannels.map((c) => [c.id, c.accountName]));

  // Unfurl the item link so the preview's link card shows the same
  // title/description/image the publish worker will attach (Open Graph from the
  // article page). Best-effort; fall back to the feed item's own fields.
  const itemDescription = stripHtmlToText(item.description || item.content).slice(0, 200);
  let linkPreview: LinkPreview | null = null;
  if (item.link) {
    const og = await fetchLinkPreviewCached(item.link).catch(() => null);
    let domain = '';
    try { domain = new URL(item.link).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    linkPreview = {
      url: item.link,
      title: og?.title || item.title || domain,
      description: og?.description || itemDescription || '',
      image: og?.image || item.image?.url || '',
      siteName: og?.siteName || parsed.title || domain,
      domain: og?.domain || domain,
    };
  }

  return json({
    feedTitle: parsed.title,
    // The tokens this feed's newest item actually offers — drives the editor's
    // pills so they mirror the real feed (populated standard fields + customs).
    availableFields: availableTokens(item, feedName),
    linkPreview,
    item: {
      title: item.title,
      link: item.link,
      publishedAt: item.publishedAt?.toISOString() ?? null,
      author: item.author,
      categories: item.categories,
      description: itemDescription,
      hasDescription: Boolean(item.description),
      hasContent: Boolean(item.content),
      image: item.image,
      video: item.video,
    },
    media,
    previews: renders.map((r) => ({
      channelId: r.channelId,
      platform: r.platform,
      accountName: nameById.get(r.channelId) ?? '',
      text: r.text,
      charCount: platformLength(r.text, r.platform),
      charLimit: r.charLimit,
      truncated: r.truncated,
      overridden: r.overridden,
      skipped: r.skipped,
      skipReason: r.skipReason,
    })),
  });
};
