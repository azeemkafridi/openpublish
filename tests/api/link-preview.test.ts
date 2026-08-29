/**
 * Tests for the Link Preview API.
 *
 *   GET /api/link-preview — fetch Open Graph metadata for a URL
 */

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock node:dns — resolve hostnames to IPs for SSRF validation
const mockDnsLookup = vi.fn();
vi.mock('node:dns', () => ({
  default: { promises: { lookup: (...args: any[]) => mockDnsLookup(...args) } },
  promises: {
    lookup: (...args: any[]) => mockDnsLookup(...args),
  },
}));

// ---------------------------------------------------------------------------
// Import handlers AFTER mocks
// ---------------------------------------------------------------------------
import { GET } from '@/pages/api/link-preview';
import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A } from '../helpers/fixtures';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createHtmlResponse(html: string, contentType = 'text/html; charset=utf-8') {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(html);
  let read = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (!read) {
        controller.enqueue(encoded);
        read = true;
      } else {
        controller.close();
      }
    },
  });

  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': contentType }),
    body: stream,
  };
}

// ---------------------------------------------------------------------------
// GET /api/link-preview
// ---------------------------------------------------------------------------

describe('GET /api/link-preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: resolve all hostnames to a public IP
    mockDnsLookup.mockImplementation((hostname: string) => {
      const privateHosts: Record<string, string> = {
        'localhost': '127.0.0.1',
        '127.0.0.1': '127.0.0.1',
        '0.0.0.0': '0.0.0.0',
        '10.0.0.1': '10.0.0.1',
        '192.168.1.1': '192.168.1.1',
        '172.16.0.1': '172.16.0.1',
        '169.254.169.254': '169.254.169.254',
      };
      const ip = privateHosts[hostname] || '93.184.216.34'; // example.com public IP
      // validateHostname() now uses dns.lookup(host, { all: true }) → array form.
      return Promise.resolve([{ address: ip, family: 4 }]);
    });
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null, searchParams: { url: 'https://example.com' } });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns 400 when url parameter is missing', async () => {
    const ctx = createMockContext({ user: USER_A });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('Missing url');
  });

  it('returns 400 for invalid URL', async () => {
    const ctx = createMockContext({ user: USER_A, searchParams: { url: 'not-a-url' } });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('Invalid URL');
  });

  it('returns 400 for non-HTTP/HTTPS protocols', async () => {
    const ctx = createMockContext({ user: USER_A, searchParams: { url: 'ftp://example.com' } });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('HTTP/HTTPS');
  });

  it('returns 400 for localhost (SSRF prevention)', async () => {
    const ctx = createMockContext({ user: USER_A, searchParams: { url: 'http://localhost/admin' } });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('not allowed');
  });

  it('returns 400 for 127.0.0.1 (SSRF prevention)', async () => {
    const ctx = createMockContext({ user: USER_A, searchParams: { url: 'http://127.0.0.1/admin' } });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('not allowed');
  });

  it('returns 400 for private IP ranges (SSRF prevention)', async () => {
    for (const ip of ['10.0.0.1', '192.168.1.1', '172.16.0.1']) {
      const ctx = createMockContext({ user: USER_A, searchParams: { url: `http://${ip}/` } });
      const res = await GET(ctx as any);
      const { status } = await parseResponse(res);
      expect(status).toBe(400);
    }
  });

  it('returns 400 for AWS metadata endpoint (SSRF prevention)', async () => {
    const ctx = createMockContext({ user: USER_A, searchParams: { url: 'http://169.254.169.254/latest/meta-data/' } });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it('returns 502 when fetch fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    const ctx = createMockContext({ user: USER_A, searchParams: { url: 'https://example.com' } });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(502);
    expect(data.error).toContain('Failed to fetch');
  });

  it('returns 422 when response is not HTML', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
    });
    const ctx = createMockContext({ user: USER_A, searchParams: { url: 'https://api.example.com/data' } });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(422);
    expect(data.error).toContain('not return HTML');
  });

  it('returns 200 with extracted OG metadata', async () => {
    const html = `
      <html>
        <head>
          <title>Example Page</title>
          <meta property="og:title" content="OG Title" />
          <meta property="og:description" content="OG Description" />
          <meta property="og:image" content="https://example.com/image.jpg" />
          <meta property="og:site_name" content="Example" />
        </head>
      </html>
    `;
    mockFetch.mockResolvedValue(createHtmlResponse(html));

    const ctx = createMockContext({ user: USER_A, searchParams: { url: 'https://www.example.com/page' } });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.title).toBe('OG Title');
    expect(data.description).toBe('OG Description');
    expect(data.image).toBe('https://example.com/image.jpg');
    expect(data.siteName).toBe('Example');
    expect(data.domain).toBe('example.com');
    expect(data.url).toBe('https://www.example.com/page');
  });

  it('falls back to <title> when og:title is missing', async () => {
    const html = `<html><head><title>Fallback Title</title></head></html>`;
    mockFetch.mockResolvedValue(createHtmlResponse(html));

    const ctx = createMockContext({ user: USER_A, searchParams: { url: 'https://example.com' } });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.title).toBe('Fallback Title');
  });

  it('falls back to meta name="description" when og:description is missing', async () => {
    const html = `<html><head><meta name="description" content="Meta Description" /></head></html>`;
    mockFetch.mockResolvedValue(createHtmlResponse(html));

    const ctx = createMockContext({ user: USER_A, searchParams: { url: 'https://example.com' } });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.description).toBe('Meta Description');
  });

  it('strips www. from domain', async () => {
    const html = `<html><head><title>Test</title></head></html>`;
    mockFetch.mockResolvedValue(createHtmlResponse(html));

    const ctx = createMockContext({ user: USER_A, searchParams: { url: 'https://www.example.com' } });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.domain).toBe('example.com');
  });

  it('sets Cache-Control: private, max-age=3600 header', async () => {
    const html = `<html><head><title>Test</title></head></html>`;
    mockFetch.mockResolvedValue(createHtmlResponse(html));

    const ctx = createMockContext({ user: USER_A, searchParams: { url: 'https://example.com' } });
    const res = await GET(ctx as any);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=3600');
  });

  it('returns 504 on timeout', async () => {
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValue(abortError);

    const ctx = createMockContext({ user: USER_A, searchParams: { url: 'https://slow-site.com' } });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(504);
    expect(data.error).toContain('timed out');
  });

  it('returns 502 on generic fetch error', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const ctx = createMockContext({ user: USER_A, searchParams: { url: 'https://example.com' } });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(502);
  });
});
