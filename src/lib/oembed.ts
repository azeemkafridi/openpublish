/**
 * oEmbed unfurling for hosts whose HTML cannot be scraped.
 *
 * Shared by the compose/publish link-preview path and by Collect, deliberately:
 * both need the same answer for the same URLs, and a second copy of this logic
 * is how the publish paths drifted apart before (one lost its short-URL mapping
 * and started unfurling the redirector).
 *
 * WHY THIS EXISTS. Media sites gate their Open Graph tags on the user-agent.
 * Verified byte-for-byte from the production VPS: YouTube serves `og:title` at
 * byte ~2,400 to `facebookexternalhit`, while our own UA — and even a plain
 * desktop-browser UA — get a 200 with ZERO `og:*` tags anywhere in the ~1.2 MB
 * page. No parser can recover metadata that was never sent. Their oEmbed
 * endpoints carry no such gate and are a documented, stable contract, so we ask
 * the sanctioned endpoint instead of impersonating a crawler.
 *
 * Every provider below was probed from the production egress IP before being
 * added. Do not add one on the strength of its documentation alone — Vimeo's
 * endpoint is documented and returned 404 for us.
 */

export interface OEmbedResult {
  title: string | null;
  /** Channel / uploader / artist. oEmbed has no description field. */
  authorName: string | null;
  thumbnailUrl: string | null;
  providerName: string | null;
  /** oEmbed type: 'video' | 'photo' | 'rich' | 'link'. */
  type: string | null;
}

interface OEmbedProvider {
  name: string;
  /** Registrable hosts; subdomains match too. */
  hosts: string[];
  /** Builds the endpoint URL. The target is always an encoded query param. */
  endpoint: (targetUrl: string) => string;
}

const PROVIDERS: OEmbedProvider[] = [
  {
    name: 'YouTube',
    hosts: ['youtube.com', 'youtu.be'],
    endpoint: (u) => `https://www.youtube.com/oembed?url=${encodeURIComponent(u)}&format=json`,
  },
  {
    name: 'TikTok',
    hosts: ['tiktok.com'],
    endpoint: (u) => `https://www.tiktok.com/oembed?url=${encodeURIComponent(u)}`,
  },
  {
    name: 'SoundCloud',
    hosts: ['soundcloud.com'],
    endpoint: (u) => `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(u)}`,
  },
  {
    name: 'Dailymotion',
    hosts: ['dailymotion.com', 'dai.ly'],
    endpoint: (u) =>
      `https://www.dailymotion.com/services/oembed?url=${encodeURIComponent(u)}&format=json`,
  },
  {
    name: 'Spotify',
    hosts: ['open.spotify.com', 'spotify.com'],
    endpoint: (u) => `https://open.spotify.com/oembed?url=${encodeURIComponent(u)}`,
  },
];

/** The provider for a URL's host, or null when it is an ordinary page. */
export function findOEmbedProvider(rawUrl: string): OEmbedProvider | null {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  return (
    PROVIDERS.find((p) =>
      p.hosts.some((h) => {
        const bare = h.replace(/^www\./, '');
        return host === bare || host.endsWith(`.${bare}`);
      }),
    ) ?? null
  );
}

/** True when this URL should be unfurled via oEmbed rather than scraped. */
export function isOEmbedHost(rawUrl: string): boolean {
  return findOEmbedProvider(rawUrl) !== null;
}

interface RawOEmbed {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
  provider_name?: string;
  type?: string;
}

/**
 * Ask a provider's oEmbed endpoint about a URL.
 *
 * Returns null on ANY failure — a non-provider host, a 404 (channel and
 * playlist pages have no oEmbed record), a timeout, malformed JSON, or a
 * response with no title. Callers treat null as "fall back to scraping".
 *
 * No new SSRF surface: the request goes to a hardcoded provider origin with the
 * target URL only as an encoded query parameter, never as the request host.
 */
export async function fetchOEmbed(
  rawUrl: string,
  options: { signal?: AbortSignal; timeoutMs?: number; userAgent?: string } = {},
): Promise<OEmbedResult | null> {
  const provider = findOEmbedProvider(rawUrl);
  if (!provider) return null;

  const { signal, timeoutMs = 5000, userAgent = 'openPublish/1.0 LinkPreview Bot' } = options;

  // Own timeout when the caller supplied none, so a hung provider cannot pin a
  // publish or a capture open indefinitely.
  const controller = signal ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(provider.endpoint(rawUrl), {
      signal: signal ?? controller!.signal,
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as RawOEmbed;
    if (!data?.title) return null;

    return {
      title: data.title,
      authorName: data.author_name || null,
      thumbnailUrl: data.thumbnail_url || null,
      providerName: data.provider_name || provider.name,
      type: data.type || null,
    };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
