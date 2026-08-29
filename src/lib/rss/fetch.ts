import { validateHostname, ssrfSafeFetch } from '../security/url-guard';

/**
 * SSRF-guarded feed download shared by the RSS worker and the mapping preview
 * endpoint: http(s) only, blocked internal hosts, size + time caps.
 */

export const MAX_FEED_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/** Conditional-GET validators persisted per feed (rss_feeds.etag/last_modified). */
export interface FeedValidators {
  etag?: string | null;
  lastModified?: string | null;
}

export type FeedFetchResult =
  | { status: 'ok'; xml: string; etag: string | null; lastModified: string | null }
  | { status: 'not_modified' };

/** Plain fetch used by the preview endpoint — no conditional-GET state. */
export async function fetchFeedXml(feedUrl: string): Promise<string> {
  const result = await fetchFeedXmlConditional(feedUrl);
  // Without validators a server cannot legally 304, but be defensive.
  if (result.status === 'not_modified') throw new Error('Feed returned HTTP 304');
  return result.xml;
}

export async function fetchFeedXmlConditional(
  feedUrl: string,
  validators?: FeedValidators,
): Promise<FeedFetchResult> {
  const parsed = new URL(feedUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Feed URL must be http(s)');
  }
  if (!(await validateHostname(parsed.hostname))) {
    throw new Error('Feed host is not allowed');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await ssrfSafeFetch(feedUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'openPublish/1.0 RSS',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
        ...(validators?.etag ? { 'If-None-Match': validators.etag } : {}),
        ...(validators?.lastModified ? { 'If-Modified-Since': validators.lastModified } : {}),
      },
    });
    if (res.status === 304) return { status: 'not_modified' };
    if (!res.ok) throw new Error(`Feed returned HTTP ${res.status}`);

    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) {
      throw new Error('Feed is too large');
    }
    // Stream with a running byte counter and abort at the cap. content-length
    // alone is not enough: chunked responses have none, and fetch transparently
    // decompresses, so a small gzip can expand far past the declared size —
    // buffering first (res.text()) would let a hostile feed OOM the worker.
    const outEtag = res.headers.get('etag');
    const outLastModified = res.headers.get('last-modified');
    const reader = res.body?.getReader();
    if (!reader) return { status: 'ok', xml: '', etag: outEtag, lastModified: outLastModified };
    const decoder = new TextDecoder('utf-8');
    let xml = '';
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_FEED_BYTES) {
        await reader.cancel();
        throw new Error('Feed is too large');
      }
      xml += decoder.decode(value, { stream: true });
    }
    xml += decoder.decode();
    return { status: 'ok', xml, etag: outEtag, lastModified: outLastModified };
  } finally {
    clearTimeout(timeout);
  }
}
