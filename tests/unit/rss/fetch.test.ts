/**
 * Tests for the SSRF-guarded, size-capped RSS feed fetch.
 * The size cap must be enforced WHILE streaming (decompression-bomb guard),
 * not after buffering the whole body.
 */

const mockValidateHostname = vi.fn();
const mockFetch = vi.fn();
vi.mock('@/lib/security/url-guard', () => ({
  ssrfSafeDispatcher: {},
  validateHostname: (...a: any[]) => mockValidateHostname(...a),
  ssrfSafeFetch: (...a: any[]) => mockFetch(...a),
}));

import { fetchFeedXml, MAX_FEED_BYTES } from '@/lib/rss/fetch';

function streamResponse(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let i = 0;
  const cancel = vi.fn(async () => {});
  return {
    res: {
      ok: true,
      headers: { get: (h: string) => headers[h.toLowerCase()] ?? null },
      body: {
        getReader: () => ({
          read: async () =>
            i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined },
          cancel,
        }),
      },
    },
    cancel,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockValidateHostname.mockResolvedValue(true);
});

describe('fetchFeedXml', () => {
  it('returns the decoded body for a normal feed', async () => {
    const xml = '<?xml version="1.0"?><rss><channel><title>ünïcode</title></channel></rss>';
    mockFetch.mockResolvedValue(streamResponse([new TextEncoder().encode(xml)]).res);
    await expect(fetchFeedXml('https://ex.com/feed.xml')).resolves.toBe(xml);
  });

  it('decodes multi-byte characters split across chunk boundaries', async () => {
    const bytes = new TextEncoder().encode('<t>é</t>'); // é is 2 bytes
    const split = bytes.findIndex((b) => b > 127) + 1; // cut inside the é
    mockFetch.mockResolvedValue(streamResponse([bytes.slice(0, split), bytes.slice(split)]).res);
    await expect(fetchFeedXml('https://ex.com/feed.xml')).resolves.toBe('<t>é</t>');
  });

  it('rejects up front on a declared content-length over the cap', async () => {
    mockFetch.mockResolvedValue(
      streamResponse([], { 'content-length': String(MAX_FEED_BYTES + 1) }).res,
    );
    await expect(fetchFeedXml('https://ex.com/feed.xml')).rejects.toThrow(/too large/);
  });

  it('aborts mid-stream once the byte cap is exceeded (no content-length)', async () => {
    // 3 chunks of 1 MB — the third pushes past the 2 MB cap; the stream must be
    // cancelled without reading to the end.
    const mb = new Uint8Array(1024 * 1024).fill(120);
    const { res, cancel } = streamResponse([mb, mb, mb, mb, mb]);
    mockFetch.mockResolvedValue(res);
    await expect(fetchFeedXml('https://ex.com/feed.xml')).rejects.toThrow(/too large/);
    expect(cancel).toHaveBeenCalled();
  });

  it('throws on non-http(s) URLs and SSRF-blocked hosts', async () => {
    await expect(fetchFeedXml('ftp://ex.com/feed')).rejects.toThrow(/http/);
    mockValidateHostname.mockResolvedValue(false);
    await expect(fetchFeedXml('https://internal/feed')).rejects.toThrow(/not allowed/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws on HTTP error status', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, headers: { get: () => null } });
    await expect(fetchFeedXml('https://ex.com/feed.xml')).rejects.toThrow(/HTTP 404/);
  });
});

export {};
