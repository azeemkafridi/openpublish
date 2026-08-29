/**
 * Tests for the shared link-preview lib used by the publish worker:
 *   - fetchLinkPreview throws typed LinkPreviewError with an HTTP status
 *   - fetchLinkPreviewCached is best-effort (null on failure) and caches by URL
 */

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockDnsLookup = vi.fn();
vi.mock('node:dns', () => ({
  default: { promises: { lookup: (...args: any[]) => mockDnsLookup(...args) } },
  promises: { lookup: (...args: any[]) => mockDnsLookup(...args) },
}));

import { fetchLinkPreview, fetchLinkPreviewCached, LinkPreviewError } from '@/lib/link-preview';

function htmlResponse(html: string, contentType = 'text/html; charset=utf-8') {
  const encoded = new TextEncoder().encode(html);
  let read = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (!read) { controller.enqueue(encoded); read = true; } else { controller.close(); }
    },
  });
  return { ok: true, status: 200, headers: new Headers({ 'content-type': contentType }), body: stream };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('fetchLinkPreview', () => {
  it('parses OG metadata', async () => {
    mockFetch.mockResolvedValue(htmlResponse(
      '<meta property="og:title" content="T"><meta property="og:image" content="https://x.com/i.jpg">',
    ));
    const lp = await fetchLinkPreview('https://www.example.com/a');
    expect(lp).toMatchObject({ title: 'T', image: 'https://x.com/i.jpg', domain: 'example.com', url: 'https://www.example.com/a' });
  });

  it('parses UNQUOTED meta attributes in any order (e.g. Postmedia/Financial Post)', async () => {
    // Minified HTML: content before property, no quotes on either.
    mockFetch.mockResolvedValue(htmlResponse(
      '<meta content=https://cdn.example/pic.jpg property=og:image>' +
      '<meta content="Real Title" property=og:title>' +
      '<meta name=description content="Unquoted desc">',
    ));
    const lp = await fetchLinkPreview('https://www.example.com/a');
    expect(lp.image).toBe('https://cdn.example/pic.jpg');
    expect(lp.title).toBe('Real Title');
    expect(lp.description).toBe('Unquoted desc');
  });

  it('unfurls YouTube via oEmbed, not scraping (YouTube hides og tags from unknown UAs)', async () => {
    // Regression: YouTube returns a 200 with zero og:* tags to any UA it does
    // not recognise as a crawler (verified from the prod VPS), so the scrape
    // path produced an all-blank card in the composer and on published embeds.
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        title: 'Video Title',
        author_name: 'Channel Name',
        thumbnail_url: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
        provider_name: 'YouTube',
      }),
    });

    const lp = await fetchLinkPreview('https://www.youtube.com/watch?v=abc');
    expect(lp).toMatchObject({
      title: 'Video Title',
      description: 'Channel Name',
      image: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
      siteName: 'YouTube',
      domain: 'youtube.com',
      url: 'https://www.youtube.com/watch?v=abc',
    });

    // Exactly one fetch, aimed at the oEmbed endpoint with the URL encoded.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toBe(
      'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabc&format=json',
    );
  });

  it('routes youtu.be through oEmbed too', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ title: 'T', thumbnail_url: '', provider_name: 'YouTube' }),
    });
    const lp = await fetchLinkPreview('https://youtu.be/abc');
    expect(lp.title).toBe('T');
    expect(String(mockFetch.mock.calls[0][0])).toContain('/oembed?url=https%3A%2F%2Fyoutu.be%2Fabc');
  });

  it('falls back to the HTML scrape when oEmbed fails (channels/playlists have none)', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 404, headers: new Headers(), body: null })
      .mockResolvedValueOnce(htmlResponse('<meta property="og:title" content="Channel Page">'));

    const lp = await fetchLinkPreview('https://www.youtube.com/@somechannel');
    expect(lp.title).toBe('Channel Page');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not touch oEmbed for non-YouTube hosts', async () => {
    mockFetch.mockResolvedValue(htmlResponse('<meta property="og:title" content="T">'));
    await fetchLinkPreview('https://www.example.com/a');
    expect(String(mockFetch.mock.calls[0][0])).not.toContain('oembed');
  });

  it('throws 400 for a blocked host', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(fetchLinkPreview('http://localhost/')).rejects.toMatchObject({ status: 400 });
  });

  it('throws 422 when the response is not HTML', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), body: new ReadableStream() });
    await expect(fetchLinkPreview('https://example.com/a.json')).rejects.toMatchObject({ status: 422 });
  });

  it('throws a LinkPreviewError instance', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, headers: new Headers(), body: null });
    await expect(fetchLinkPreview('https://example.com/err')).rejects.toBeInstanceOf(LinkPreviewError);
  });
});

describe('fetchLinkPreviewCached', () => {
  it('returns null instead of throwing, and caches (one fetch per URL)', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const url = 'http://localhost/blocked';
    expect(await fetchLinkPreviewCached(url)).toBeNull();
    expect(await fetchLinkPreviewCached(url)).toBeNull();
    // Blocked at DNS before fetch — but the null result is cached either way.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('caches a successful unfurl so repeat calls do not re-fetch', async () => {
    mockFetch.mockResolvedValue(htmlResponse('<meta property="og:title" content="Cached">'));
    const url = 'https://www.example.com/cache-me';
    const first = await fetchLinkPreviewCached(url);
    const second = await fetchLinkPreviewCached(url);
    expect(first?.title).toBe('Cached');
    expect(second?.title).toBe('Cached');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

export {};
