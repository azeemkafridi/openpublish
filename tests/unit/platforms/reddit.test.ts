/**
 * Tests for the Reddit platform handler.
 *
 * Covers:
 *   - config (name / displayName / authType)
 *   - getOAuthUrl: authorize URL with duration=permanent + submit scope, and the
 *     not-configured throw
 *   - exchangeCodeForToken: token parsing + Basic auth header
 *   - getAccountInfo: id/name/icon mapping (strips ?query)
 *   - refreshToken: reuses the same refresh token / null on failure
 *   - publishPost: no token, self-post success, missing subreddit, auth-expired error
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

// SSRF guard does real DNS lookups — stub it and route the guarded fetch to the
// same global mock so mockResolvedValueOnce queues stay in order.
vi.mock('@/lib/security/url-guard', () => ({
  ssrfSafeDispatcher: {},
  validateHostname: vi.fn(async () => true),
  ssrfSafeFetch: (...args: unknown[]) => (globalThis.fetch as any)(...args),
}));

const { RedditHandler } = await import('@/lib/platforms/reddit');
import type { PostData, ChannelData, MediaFileData } from '@/lib/platforms/types';

export {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(overrides: Partial<ChannelData> = {}): ChannelData {
  return {
    id: 1,
    platform: 'reddit',
    accountId: 'reddit_user',
    accountName: 'reddituser',
    accessToken: 'reddit-access-token',
    metadata: {},
    ...overrides,
  };
}

function makePost(overrides: Partial<PostData> = {}): PostData {
  return {
    content: 'Hello Reddit!',
    mediaUrls: [],
    mediaFiles: [],
    ...overrides,
  };
}

function makeImage(url = 'https://cdn.test/img.jpg'): MediaFileData {
  return { url, localPath: '/tmp/img.jpg', mimeType: 'image/jpeg', sizeBytes: 1000 };
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

describe('RedditHandler', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new RedditHandler();

  beforeAll(() => {
    process.env.REDDIT_CLIENT_ID = 'test-reddit-id';
    process.env.REDDIT_CLIENT_SECRET = 'test-reddit-secret';
  });

  describe('config', () => {
    it('has correct platform config', () => {
      expect(handler.config.name).toBe('reddit');
      expect(handler.config.displayName).toBe('Reddit');
      expect(handler.config.authType).toBe('oauth');
    });
  });

  describe('getOAuthUrl', () => {
    it('builds the authorize URL with duration=permanent, submit scope, state, and redirect_uri', async () => {
      const url = await handler.getOAuthUrl('https://app.test/callback', 'state-123');
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe('https://www.reddit.com/api/v1/authorize');
      expect(parsed.searchParams.get('duration')).toBe('permanent');
      expect(parsed.searchParams.get('scope')).toContain('submit');
      expect(parsed.searchParams.get('state')).toBe('state-123');
      expect(parsed.searchParams.get('redirect_uri')).toBe('https://app.test/callback');
      expect(parsed.searchParams.get('response_type')).toBe('code');
    });

    it('throws when REDDIT_CLIENT_ID is not configured', async () => {
      const saved = process.env.REDDIT_CLIENT_ID;
      delete process.env.REDDIT_CLIENT_ID;
      await expect(handler.getOAuthUrl('https://app.test/callback', 's')).rejects.toThrow(
        'REDDIT_CLIENT_ID not configured',
      );
      process.env.REDDIT_CLIENT_ID = saved;
    });
  });

  describe('exchangeCodeForToken', () => {
    it('parses tokens and sends the Basic auth header', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          access_token: 'acc-tok',
          refresh_token: 'ref-tok',
          expires_in: 3600,
          token_type: 'bearer',
        }),
      );

      const result = await handler.exchangeCodeForToken('the-code', 'https://app.test/callback');
      expect(result.accessToken).toBe('acc-tok');
      expect(result.refreshToken).toBe('ref-tok');
      expect(result.expiresIn).toBe(3600);

      const [tokenUrl, opts] = mockFetch.mock.calls[0];
      expect(tokenUrl).toBe('https://www.reddit.com/api/v1/access_token');
      expect(opts.headers.Authorization).toMatch(/^Basic /);
      expect(opts.headers['User-Agent']).toContain('openpublish');
    });
  });

  describe('getAccountInfo', () => {
    it('maps id/name and strips the signed query from the avatar URL', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          id: 'u1',
          name: 'reddituser',
          icon_img: 'https://styles.redditmedia.com/avatar.png?width=256&s=abc',
        }),
      );

      const info = await handler.getAccountInfo('acc-tok');
      expect(info.id).toBe('u1');
      expect(info.name).toBe('reddituser');
      expect(info.profileImage).toBe('https://styles.redditmedia.com/avatar.png');
    });
  });

  describe('refreshToken', () => {
    it('returns the same refresh token on success', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ access_token: 'new-acc', expires_in: 3600, token_type: 'bearer' }),
      );

      const result = await handler.refreshToken('keep-this-refresh');
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe('new-acc');
      // Reddit does not rotate refresh tokens.
      expect(result!.refreshToken).toBe('keep-this-refresh');
    });

    it('returns null on failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'invalid_grant' }),
      });

      const result = await handler.refreshToken('bad');
      expect(result).toBeNull();
    });
  });

  describe('publishPost', () => {
    it('returns error when no access token', async () => {
      const result = await handler.publishPost(makePost(), makeChannel({ accessToken: '' }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('No access token');
    });

    it('publishes a self (text) post and resolves the id immediately', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          json: {
            data: { id: 'abc1', url: 'https://www.reddit.com/r/test/comments/abc1/hi' },
          },
        }),
      );

      const post = makePost({
        platformSpecific: { 1: { subreddit: '/r/test', title: 'Hi' } },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(result.postId).toBe('abc1');
      expect(result.url).toBe('https://www.reddit.com/r/test/comments/abc1/hi');

      const [submitUrl, opts] = mockFetch.mock.calls[0];
      expect(submitUrl).toBe('https://oauth.reddit.com/api/submit');
      const body = new URLSearchParams(opts.body as string);
      expect(body.get('sr')).toBe('test');
      expect(body.get('kind')).toBe('self');
      expect(body.get('title')).toBe('Hi');
    });

    it('fails instead of fake-succeeding when submit returns no confirmable id', async () => {
      // Reddit returned only a websocket_url (no id). With WebSocket unavailable
      // the handler must report failure rather than success with an empty postId
      // (which the worker would otherwise seal as a blank "published" post).
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ json: { data: { websocket_url: 'wss://reddit/confirm' } } }),
      );

      const g = globalThis as { WebSocket?: unknown };
      const originalWs = g.WebSocket;
      g.WebSocket = undefined;
      try {
        const post = makePost({ platformSpecific: { 1: { subreddit: 'test', title: 'Hi' } } });
        const result = await handler.publishPost(post, makeChannel());
        expect(result.success).toBe(false);
        expect(result.error).toContain('did not confirm');
      } finally {
        g.WebSocket = originalWs;
      }
    });

    it('returns error when no subreddit is provided', async () => {
      const post = makePost({ platformSpecific: { 1: { title: 'Hi' } } });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('subreddit');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('sets authExpired on a 401 API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ message: 'Unauthorized' }),
      });

      const post = makePost({
        platformSpecific: { 1: { subreddit: 'test', title: 'Hi' } },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.authExpired).toBe(true);
    });
  });

  describe('video posts (thumbnail resolution)', () => {
    function makeVideo(posterUrl?: string): MediaFileData {
      return { url: 'https://cdn.test/vid.mp4', localPath: '/tmp/vid.mp4', mimeType: 'video/mp4', sizeBytes: 50000, posterUrl };
    }

    /** One uploadAsset = register lease + fetch media bytes + S3 POST. */
    const mockAssetUpload = (location: string) => {
      mockFetch
        .mockResolvedValueOnce(mockFetchJson({ args: { action: '//reddit-uploads.s3.example/bucket', fields: [{ name: 'key', value: 'k' }] } }))
        .mockResolvedValueOnce({ ok: true, status: 200, blob: async () => new Blob(['bytes']) })
        .mockResolvedValueOnce({ ok: true, status: 201, text: async () => `<Location>${location}</Location>` });
    };

    it('fails clearly when a video has no thumbnail and no poster frame', async () => {
      mockAssetUpload('https://reddit-uploads.example/video');
      const post = makePost({
        mediaFiles: [makeVideo()],
        platformSpecific: { 1: { subreddit: 'test', title: 'Video post' } },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/thumbnail/i);
    });

    it('falls back to the video poster frame as the thumbnail', async () => {
      mockAssetUpload('https://reddit-uploads.example/video');
      mockAssetUpload('https://reddit-uploads.example/poster');
      mockFetch.mockResolvedValueOnce(mockFetchJson({ json: { errors: [], data: { id: 'vid123', url: 'https://www.reddit.com/r/test/comments/vid123' } } }));

      const post = makePost({
        mediaFiles: [makeVideo('https://cdn.test/poster.webp')],
        platformSpecific: { 1: { subreddit: 'test', title: 'Video post' } },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);

      // Poster register lease carries the webp mimetype inferred from the URL.
      const posterRegisterForm = mockFetch.mock.calls[3][1].body as FormData;
      expect(posterRegisterForm.get('mimetype')).toBe('image/webp');
      // Submit body carries the uploaded poster location.
      const submitBody = mockFetch.mock.calls[6][1].body as string;
      expect(submitBody).toContain(encodeURIComponent('https://reddit-uploads.example/poster'));
    });

    it('prefers an explicit thumbnailUrl over the poster frame', async () => {
      mockAssetUpload('https://reddit-uploads.example/video');
      mockAssetUpload('https://reddit-uploads.example/custom-thumb');
      mockFetch.mockResolvedValueOnce(mockFetchJson({ json: { errors: [], data: { id: 'vid456' } } }));

      const post = makePost({
        mediaFiles: [makeVideo('https://cdn.test/poster.webp')],
        platformSpecific: { 1: { subreddit: 'test', title: 'Video post', thumbnailUrl: 'https://cdn.test/custom.png' } },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);

      // The poster-asset fetch (call index 4) reads the explicit URL, not the poster frame.
      expect(String(mockFetch.mock.calls[4][0])).toBe('https://cdn.test/custom.png');
      const posterRegisterForm = mockFetch.mock.calls[3][1].body as FormData;
      expect(posterRegisterForm.get('mimetype')).toBe('image/png');
    });
  });

  describe('searchSubreddits', () => {
    it('returns normalized public subreddit names', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          data: {
            children: [
              { data: { id: 's1', url: '/r/test/', subreddit_type: 'public' } },
              { data: { id: 's2', url: '/r/secret/', subreddit_type: 'private' } },
            ],
          },
        }),
      );

      const items = await handler.searchSubreddits('tok', 'test');
      expect(items).toEqual([{ id: 's1', name: 'test' }]);
      expect(mockFetch.mock.calls[0][0]).toContain('/subreddits/search?');
    });

    it('returns [] for an empty query without calling the API', async () => {
      const items = await handler.searchSubreddits('tok', '   ');
      expect(items).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('getFlairs', () => {
    it('maps flair text to a name and normalizes the subreddit', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson([
          { id: 'f1', text: 'Discussion' },
          { id: 'f2', text: 'News' },
        ]),
      );

      const flairs = await handler.getFlairs('tok', '/r/test');
      expect(flairs).toEqual([{ id: 'f1', name: 'Discussion' }, { id: 'f2', name: 'News' }]);
      expect(mockFetch.mock.calls[0][0]).toContain('/r/test/api/link_flair_v2');
    });

    it('returns [] when the subreddit exposes no flairs', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'Forbidden' });
      const flairs = await handler.getFlairs('tok', 'test');
      expect(flairs).toEqual([]);
    });
  });

  describe('publishComment', () => {
    it('comments on a post using a t3_ thing id', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ json: { data: { things: [{ data: { id: 'cmt1' } }] } } }),
      );

      const result = await handler.publishComment(makeChannel(), 'abc1', 'Nice post!');
      expect(result.success).toBe(true);

      const [commentUrl, opts] = mockFetch.mock.calls[0];
      expect(commentUrl).toBe('https://oauth.reddit.com/api/comment');
      const body = new URLSearchParams(opts.body as string);
      expect(body.get('thing_id')).toBe('t3_abc1');
      expect(body.get('text')).toBe('Nice post!');
    });
  });
});
