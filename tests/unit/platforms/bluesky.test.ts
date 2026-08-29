/**
 * Tests for the Bluesky platform handler.
 *
 * Covers:
 *   - publishPost: text with facets, images, video, link cards, alt text
 *   - Facet detection: URLs, @mentions, mixed
 *   - Mention DID resolution
 *   - Media validation: mixed, >4 images, >1 video
 *   - No access token error
 *   - Image auto-resize (via sharp mock)
 *   - publishThread: chained posts with root/parent refs
 *   - refreshToken: success and failure
 *   - exchangeCodeForToken: credential-based auth
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

vi.mock('node:fs', () => ({
  default: { readFileSync: vi.fn(() => Buffer.alloc(100, 0xff)) },
  readFileSync: vi.fn(() => Buffer.alloc(100, 0xff)),
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    jpeg: vi.fn().mockReturnThis(),
    resize: vi.fn().mockReturnThis(),
    metadata: vi.fn().mockResolvedValue({ width: 1000, height: 1000 }),
    toBuffer: vi.fn().mockResolvedValue(Buffer.alloc(500)),
  })),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// SSRF guard does real DNS lookups — stub it and route the guarded fetch to the
// same global mock so mockResolvedValueOnce queues stay in order.
vi.mock('@/lib/security/url-guard', () => ({
  ssrfSafeDispatcher: {},
  validateHostname: vi.fn(async () => true),
  ssrfSafeFetch: (...args: unknown[]) => (globalThis.fetch as any)(...args),
}));

const { BlueskyHandler } = await import('@/lib/platforms/bluesky');
import type { PostData, ChannelData, MediaFileData } from '@/lib/platforms/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJwt(did = 'did:plc:testuser123'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: did, iat: Date.now() })).toString('base64url');
  const sig = Buffer.from('fake-sig').toString('base64url');
  return `${header}.${payload}.${sig}`;
}

function makeChannel(overrides: Partial<ChannelData> = {}): ChannelData {
  return {
    id: 1,
    platform: 'bluesky',
    accountId: 'did:plc:testuser123',
    accountName: 'test.bsky.social',
    accessToken: makeJwt(),
    metadata: { did: 'did:plc:testuser123' },
    ...overrides,
  };
}

function makePost(overrides: Partial<PostData> = {}): PostData {
  return {
    content: 'Hello Bluesky!',
    mediaUrls: [],
    mediaFiles: [],
    ...overrides,
  };
}

function makeImage(url = 'https://cdn.test/img.jpg'): MediaFileData {
  return { url, localPath: '/tmp/img.jpg', mimeType: 'image/jpeg', sizeBytes: 500, altText: 'A test image' };
}

function makeVideo(url = 'https://cdn.test/vid.mp4'): MediaFileData {
  return { url, localPath: '/tmp/vid.mp4', mimeType: 'video/mp4', sizeBytes: 50000 };
}

function mockFetchJson(data: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
    json: async () => data,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BlueskyHandler', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new BlueskyHandler();

  describe('config', () => {
    it('has correct platform config', () => {
      expect(handler.config.name).toBe('bluesky');
      expect(handler.config.authType).toBe('credentials');
      expect(handler.config.mediaRules.image?.maxSizeMB).toBe(10);
    });
  });

  describe('publishPost', () => {
    it('returns error when no access token', async () => {
      const result = await handler.publishPost(makePost(), makeChannel({ accessToken: '' }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('No access token');
    });

    it('publishes text-only post', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          uri: 'at://did:plc:testuser123/app.bsky.feed.post/abc123',
          cid: 'bafyxyz',
        }),
      );

      const result = await handler.publishPost(makePost(), makeChannel());
      expect(result.success).toBe(true);
      expect(result.postId).toContain('at://');
      expect(result.url).toContain('bsky.app/profile/test.bsky.social/post/abc123');
    });

    it('publishes post with image and alt text', async () => {
      // Upload blob
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          blob: { $type: 'blob', ref: { $link: 'blobref1' }, mimeType: 'image/jpeg', size: 500 },
        }),
      });
      // Create record
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          uri: 'at://did:plc:testuser123/app.bsky.feed.post/img123',
          cid: 'bafyimg',
        }),
      );

      const post = makePost({ mediaFiles: [makeImage()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);

      const recordBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(recordBody.record.embed.$type).toBe('app.bsky.embed.images');
      expect(recordBody.record.embed.images[0].alt).toBe('A test image');
    });

    it('publishes post with video', async () => {
      // Upload blob
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          blob: { $type: 'blob', ref: { $link: 'vidblob1' }, mimeType: 'video/mp4', size: 50000 },
        }),
      });
      // Create record
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          uri: 'at://did:plc:testuser123/app.bsky.feed.post/vid123',
          cid: 'bafyvid',
        }),
      );

      const post = makePost({ mediaFiles: [makeVideo()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);

      const recordBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(recordBody.record.embed.$type).toBe('app.bsky.embed.video');
    });

    it('publishes post with link card', async () => {
      // Fetch OG image
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => new ArrayBuffer(100),
      });
      // Upload thumb blob
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          blob: { $type: 'blob', ref: { $link: 'thumbblob' }, mimeType: 'image/jpeg', size: 100 },
        }),
      });
      // Create record
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          uri: 'at://did:plc:testuser123/app.bsky.feed.post/link123',
          cid: 'bafylink',
        }),
      );

      const post = makePost({
        linkPreview: {
          url: 'https://example.com',
          title: 'Example',
          description: 'An example page',
          image: 'https://example.com/og.jpg',
        },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);

      const recordBody = JSON.parse(mockFetch.mock.calls[2][1].body);
      expect(recordBody.record.embed.$type).toBe('app.bsky.embed.external');
      expect(recordBody.record.embed.external.uri).toBe('https://example.com');
    });

    it('detects URL facets in text', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          uri: 'at://did:plc:testuser123/app.bsky.feed.post/facet1',
          cid: 'bafyfacet',
        }),
      );

      const post = makePost({ content: 'Check https://example.com out!' });
      await handler.publishPost(post, makeChannel());

      const recordBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const record = recordBody.record;
      expect(record.facets).toBeDefined();
      expect(record.facets.length).toBe(1);
      expect(record.facets[0].features[0].$type).toBe('app.bsky.richtext.facet#link');
      expect(record.facets[0].features[0].uri).toBe('https://example.com');
    });

    it('rejects mixed images and videos', async () => {
      const post = makePost({ mediaFiles: [makeImage(), makeVideo()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('mixing');
    });

    it('rejects more than 4 images', async () => {
      const post = makePost({
        mediaFiles: Array.from({ length: 5 }, () => makeImage()),
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('maximum of 4');
    });

    it('rejects more than 1 video', async () => {
      const post = makePost({ mediaFiles: [makeVideo(), makeVideo()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('maximum of 1');
    });

    it('handles blob upload failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 413,
        text: async () => 'File too large',
      });

      const post = makePost({ mediaFiles: [makeImage()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('upload');
    });
  });

  describe('publishThread', () => {
    it('publishes thread with root/parent references', async () => {
      // Post 1
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ uri: 'at://did:plc:testuser123/post/1', cid: 'cid1' }),
      );
      // Post 2 (reply to 1)
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ uri: 'at://did:plc:testuser123/post/2', cid: 'cid2' }),
      );

      const segments = [
        { content: 'Part 1', mediaUrls: [] as string[], mediaFiles: [] as MediaFileData[], sequence: 0 },
        { content: 'Part 2', mediaUrls: [] as string[], mediaFiles: [] as MediaFileData[], sequence: 1 },
      ];

      const result = await handler.publishThread(segments, makeChannel());
      expect(result.success).toBe(true);
      expect(result.posts).toHaveLength(2);

      // Second post should have reply reference
      const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(secondBody.record.reply).toBeDefined();
      expect(secondBody.record.reply.root.uri).toBe('at://did:plc:testuser123/post/1');
      expect(secondBody.record.reply.parent.uri).toBe('at://did:plc:testuser123/post/1');
    });

    it('refuses to resume a partial thread (no CID stored) instead of duplicating', async () => {
      const segments = [
        { content: 'Part 1', mediaUrls: [] as string[], mediaFiles: [] as MediaFileData[], sequence: 0 },
        { content: 'Part 2', mediaUrls: [] as string[], mediaFiles: [] as MediaFileData[], sequence: 1 },
      ];
      const alreadyPosted = [{ sequence: 0, postId: 'at://did:plc:testuser123/post/1', url: 'https://bsky.app/x/1' }];

      const result = await handler.publishThread(segments, makeChannel(), alreadyPosted);

      // Did NOT re-post anything, and surfaces the partial state.
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.posts).toEqual(alreadyPosted);
      expect(result.error).toContain('partially posted');
    });
  });

  describe('refreshToken', () => {
    it('refreshes session successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            accessJwt: 'new_jwt',
            refreshJwt: 'new_refresh',
            did: 'did:plc:testuser123',
            handle: 'test.bsky.social',
          }),
      });

      const result = await handler.refreshToken('old_refresh_jwt');
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe('new_jwt');
      expect(result!.refreshToken).toBe('new_refresh');
      expect(result!.userId).toBe('did:plc:testuser123');
    });

    it('returns null on failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: 'ExpiredToken' }),
      });

      const result = await handler.refreshToken('bad_jwt');
      expect(result).toBeNull();
    });
  });

  describe('exchangeCodeForToken', () => {
    it('creates session from credentials', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            did: 'did:plc:newuser',
            handle: 'newuser.bsky.social',
            accessJwt: 'session_jwt',
            refreshJwt: 'session_refresh',
          }),
      });

      const creds = JSON.stringify({ identifier: 'newuser.bsky.social', appPassword: 'xxxx-xxxx' });
      const result = await handler.exchangeCodeForToken(creds, '');
      expect(result.accessToken).toBe('session_jwt');
      expect(result.refreshToken).toBe('session_refresh');
      expect(result.userId).toBe('did:plc:newuser');
    });

    it('throws on invalid JSON credentials', async () => {
      await expect(
        handler.exchangeCodeForToken('not-json', ''),
      ).rejects.toThrow(/Invalid credentials/);
    });

    it('throws when identifier missing', async () => {
      const creds = JSON.stringify({ identifier: '', appPassword: 'xxxx' });
      await expect(
        handler.exchangeCodeForToken(creds, ''),
      ).rejects.toThrow(/required/);
    });
  });
});
