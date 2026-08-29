/**
 * Tests for the PlatformHandler abstract base class.
 *
 * Covers:
 *   - Config structure and name getter
 *   - Abstract method signatures
 *   - Default implementations of publishThread, checkPublishStatus, refreshToken, getPostMetrics
 *   - fetchJson: success, API error, non-JSON response
 *   - fetchWithFile: delegates to global fetch
 */

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { PlatformHandler } from '@/lib/platforms/base';
import type {
  PlatformConfig,
  PostData,
  ChannelData,
  TokenData,
  AccountInfo,
  PublishResult,
} from '@/lib/platforms/types';

// Concrete subclass for testing the abstract class
class TestHandler extends PlatformHandler {
  constructor(cfg?: Partial<PlatformConfig>) {
    super({
      name: 'facebook',
      displayName: 'Test Platform',
      icon: 'test',
      color: '#000',
      authType: 'oauth',
      postTypes: [{ value: 'post', label: 'Post' }],
      mediaRules: { image: { maxSizeMB: 5 } },
      ...cfg,
    } as PlatformConfig);
  }

  async getOAuthUrl(): Promise<string> {
    return 'https://test.com/oauth';
  }
  async exchangeCodeForToken(): Promise<TokenData> {
    return { accessToken: 'test' };
  }
  async getAccountInfo(): Promise<AccountInfo> {
    return { id: '1', name: 'test' };
  }
  async publishPost(): Promise<PublishResult> {
    return { success: true, postId: '123' };
  }

  // Expose protected methods for testing
  public testFetchJson<T>(url: string, opts?: RequestInit): Promise<T> {
    return this.fetchJson<T>(url, opts);
  }

  public testFetchWithFile(
    url: string,
    body: FormData | Buffer | ArrayBuffer,
    headers?: Record<string, string>,
  ): Promise<Response> {
    return this.fetchWithFile(url, body, headers);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlatformHandler base class', () => {
  afterEach(() => mockFetch.mockReset());

  describe('config and name', () => {
    it('exposes config passed in constructor', () => {
      const handler = new TestHandler();
      expect(handler.config.displayName).toBe('Test Platform');
      expect(handler.config.authType).toBe('oauth');
      expect(handler.config.postTypes).toHaveLength(1);
    });

    it('name getter returns config.name', () => {
      const handler = new TestHandler({ name: 'x' } as any);
      expect(handler.name).toBe('x');
    });
  });

  describe('default implementations', () => {
    it('publishThread returns not-supported by default', async () => {
      const handler = new TestHandler();
      const result = await handler.publishThread([], {} as ChannelData);
      expect(result.success).toBe(false);
      expect(result.error).toContain('does not support threads');
    });

    it('checkPublishStatus returns published by default', async () => {
      const handler = new TestHandler();
      const result = await handler.checkPublishStatus({} as ChannelData, 'abc');
      expect(result.status).toBe('published');
    });

    it('refreshToken returns null by default', async () => {
      const handler = new TestHandler();
      const result = await handler.refreshToken('some-token');
      expect(result).toBeNull();
    });

    it('getPostMetrics returns empty map by default', async () => {
      const handler = new TestHandler();
      const result = await handler.getPostMetrics({} as ChannelData, ['id1']);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });
  });

  describe('fetchJson', () => {
    it('parses JSON response on success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: '42', name: 'test' }),
      });

      const handler = new TestHandler();
      const result = await handler.testFetchJson<{ id: string; name: string }>(
        'https://api.test.com/data',
      );

      expect(result).toEqual({ id: '42', name: 'test' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/data',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('throws on non-JSON response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '<html>Not JSON</html>',
      });

      const handler = new TestHandler();
      await expect(
        handler.testFetchJson('https://api.test.com/data'),
      ).rejects.toThrow(/Non-JSON response/);
    });

    it('throws with friendly message on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: 'Unauthorized' }),
      });

      const handler = new TestHandler();
      await expect(
        handler.testFetchJson('https://api.test.com/data'),
      ).rejects.toThrow(/API error.*401.*Unauthorized/);
    });

    it('extracts nested error message', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({ error: { message: 'Bad request details' } }),
      });

      const handler = new TestHandler();
      await expect(
        handler.testFetchJson('https://api.test.com/data'),
      ).rejects.toThrow('Bad request details');
    });

    it('extracts error_description for OAuth errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({ error_description: 'Invalid grant' }),
      });

      const handler = new TestHandler();
      await expect(
        handler.testFetchJson('https://api.test.com/token'),
      ).rejects.toThrow('Invalid grant');
    });
  });

  describe('fetchJson transient retry', () => {
    const resp = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
      ok: status < 400,
      status,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      text: async () => JSON.stringify(body),
    });

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('retries a 429 honoring Retry-After and succeeds', async () => {
      mockFetch
        .mockResolvedValueOnce(resp(429, { error: 'rate limited' }, { 'retry-after': '1' }))
        .mockResolvedValueOnce(resp(200, { ok: true }));

      const handler = new TestHandler();
      const promise = handler.testFetchJson('https://api.test.com/data');
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('retries a 503 on GET and succeeds', async () => {
      mockFetch
        .mockResolvedValueOnce(resp(503, { error: 'unavailable' }))
        .mockResolvedValueOnce(resp(200, { ok: true }));

      const handler = new TestHandler();
      const promise = handler.testFetchJson('https://api.test.com/data');
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry a 500 on POST (duplicate-post risk)', async () => {
      mockFetch.mockResolvedValueOnce(resp(500, { error: 'boom' }));

      const handler = new TestHandler();
      const promise = handler.testFetchJson('https://api.test.com/data', { method: 'POST' });
      const assertion = expect(promise).rejects.toThrow(/500/);
      await vi.runAllTimersAsync();
      await assertion;
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('gives up after 3 attempts on persistent 429', async () => {
      mockFetch.mockResolvedValue(resp(429, { error: 'rate limited' }));

      const handler = new TestHandler();
      const promise = handler.testFetchJson('https://api.test.com/data', { method: 'POST' });
      const assertion = expect(promise).rejects.toThrow(/429/);
      await vi.runAllTimersAsync();
      await assertion;
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('fetchWithFile', () => {
    it('sends POST request with buffer body', async () => {
      const fakeResponse = { ok: true, status: 200 };
      mockFetch.mockResolvedValueOnce(fakeResponse);

      const handler = new TestHandler();
      const buf = Buffer.from('test-file-content');
      const result = await handler.testFetchWithFile(
        'https://upload.test.com/blob',
        buf,
        { 'Content-Type': 'image/jpeg', Authorization: 'Bearer tok' },
      );

      expect(result).toBe(fakeResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://upload.test.com/blob',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'image/jpeg', Authorization: 'Bearer tok' },
        }),
      );
    });
  });
});
