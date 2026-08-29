import { validateHostname, ssrfSafeFetch } from './security/url-guard';
import { fetchOEmbed, isOEmbedHost } from './oembed';

/**
 * Open-Graph link unfurling shared by the compose link-preview API and the
 * publish worker (so a link card rendered in the composer/RSS preview matches
 * the card platforms actually publish — Bluesky's external embed and
 * Facebook's link attachment both read these fields).
 */

export interface LinkPreview {
  title: string;
  description: string;
  image: string;
  siteName: string;
  domain: string;
  url: string;
}

/** Thrown by fetchLinkPreview; carries the HTTP status the API should return. */
export class LinkPreviewError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'LinkPreviewError';
  }
}

/**
 * Parse a <meta> tag's attributes, tolerating quoted OR unquoted values in any
 * order. Minified pages (e.g. Postmedia/Financial Post) emit
 * `<meta content=https://…jpg property=og:image>` with no quotes, which a
 * quote-anchored regex misses.
 */
function metaContent(html: string, matcher: (attrs: Record<string, string>) => boolean): string {
  const tags = html.match(/<meta\b[^>]*>/gi);
  if (!tags) return '';
  for (const tag of tags) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[m[1].toLowerCase()] = (m[3] ?? m[4] ?? m[5] ?? '').trim();
    }
    if (matcher(attrs) && attrs.content) return attrs.content;
  }
  return '';
}

function extractMeta(html: string, property: string): string {
  return metaContent(html, (a) => a.property === property);
}

function extractMetaName(html: string, name: string): string {
  return metaContent(html, (a) => a.name === name);
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : '';
}

const MAX_REDIRECTS = 5;
const MAX_BYTES = 50_000;

/**
 * Unfurl an oEmbed-capable URL (YouTube, TikTok, SoundCloud…) into a preview.
 *
 * Those hosts gate their Open Graph tags on the user-agent, so scraping them
 * returns a 200 with no metadata at all — see lib/oembed.ts for the measured
 * evidence. Returns null on any failure so the caller falls back to the HTML
 * path: channel and playlist pages have no oEmbed record.
 */
async function previewFromOEmbed(
  rawUrl: string,
  parsedUrl: URL,
  signal: AbortSignal,
): Promise<LinkPreview | null> {
  const data = await fetchOEmbed(rawUrl, { signal });
  if (!data?.title) return null;
  return {
    title: data.title,
    // oEmbed carries no description; the channel/artist name is the most useful
    // stand-in and matches what other unfurlers show for these hosts.
    description: data.authorName || '',
    image: data.thumbnailUrl || '',
    siteName: data.providerName || '',
    domain: parsedUrl.hostname.replace(/^www\./, ''),
    url: rawUrl,
  };
}

/**
 * Fetch and parse Open-Graph metadata for a URL. SSRF-guarded (http(s) only,
 * private hosts blocked with per-redirect re-validation, size + time caps).
 * Throws a LinkPreviewError (carrying an HTTP status) on any failure.
 */
export async function fetchLinkPreview(rawUrl: string, timeoutMs = 5000): Promise<LinkPreview> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new LinkPreviewError(400, 'Invalid URL');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new LinkPreviewError(400, 'Only HTTP/HTTPS URLs are supported');
  }
  if (!(await validateHostname(parsedUrl.hostname))) {
    throw new LinkPreviewError(400, 'URL not allowed');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // oEmbed hosts first: scraping cannot work there (see lib/oembed.ts). A
    // null falls through to the HTML path for pages oEmbed doesn't cover.
    if (isOEmbedHost(rawUrl)) {
      const oembed = await previewFromOEmbed(rawUrl, parsedUrl, controller.signal);
      if (oembed) return oembed;
    }

    let currentUrl = rawUrl;
    let response!: Response;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      response = await ssrfSafeFetch(currentUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'openPublish/1.0 LinkPreview Bot', Accept: 'text/html,application/xhtml+xml' },
        redirect: 'manual',
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (!location) break;
      const redirectUrl = new URL(location, currentUrl);
      if (!['http:', 'https:'].includes(redirectUrl.protocol)) throw new LinkPreviewError(400, 'URL not allowed');
      if (!(await validateHostname(redirectUrl.hostname))) throw new LinkPreviewError(400, 'URL not allowed');
      currentUrl = redirectUrl.href;
      if (i === MAX_REDIRECTS) throw new LinkPreviewError(400, 'Too many redirects');
    }

    if (!response.ok) throw new LinkPreviewError(502, 'Failed to fetch URL');
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      throw new LinkPreviewError(422, 'URL does not return HTML');
    }

    const reader = response.body?.getReader();
    if (!reader) throw new LinkPreviewError(502, 'No response body');
    let html = '';
    const decoder = new TextDecoder();
    let bytesRead = 0;
    while (bytesRead < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      bytesRead += value.length;
    }
    reader.cancel();

    return {
      title: extractMeta(html, 'og:title') || extractTitle(html),
      description: extractMeta(html, 'og:description') || extractMetaName(html, 'description'),
      image: extractMeta(html, 'og:image'),
      siteName: extractMeta(html, 'og:site_name'),
      domain: parsedUrl.hostname.replace(/^www\./, ''),
      url: rawUrl,
    };
  } catch (err) {
    if (err instanceof LinkPreviewError) throw err;
    if (err instanceof Error && err.name === 'AbortError') throw new LinkPreviewError(504, 'Request timed out');
    throw new LinkPreviewError(502, 'Failed to fetch URL');
  } finally {
    clearTimeout(timeout);
  }
}

// Short-TTL in-memory cache so publishing a post to several platforms only
// unfurls its link once. Link OG data is public, so caching by URL is safe.
const cache = new Map<string, { at: number; data: LinkPreview | null }>();
const TTL_MS = 60_000;

export async function fetchLinkPreviewCached(rawUrl: string, timeoutMs = 5000): Promise<LinkPreview | null> {
  const hit = cache.get(rawUrl);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.data;
  // Best-effort for the publish worker: any failure yields null (bare card).
  const data = await fetchLinkPreview(rawUrl, timeoutMs).catch(() => null);
  cache.set(rawUrl, { at: now, data });
  // Bound the cache.
  if (cache.size > 500) {
    for (const [k, v] of cache) if (now - v.at >= TTL_MS) cache.delete(k);
  }
  return data;
}
