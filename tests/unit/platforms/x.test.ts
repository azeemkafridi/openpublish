/**
 * Tests for the X (Twitter) platform handler.
 *
 * Covers:
 *   - publishPost: text-only, with media, reply settings
 *   - Media validation: mixed, >4 images, >1 video
 *   - Simple upload and chunked upload paths
 *   - publishThread: multi-tweet chain with reply_to
 *   - refreshToken: success and failure
 *   - getPostMetrics: batched metric fetching
 *   - API error handling
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

const fakeFsRead = (_fd: number, buf: Buffer) => {
  Buffer.from('fake-file-content').copy(buf);
  return Math.min(buf.length, 17);
};
vi.mock('node:fs', () => ({
  default: {
    readFileSync: vi.fn(() => Buffer.from('fake-file-content')),
    openSync: vi.fn(() => 7),
    readSync: vi.fn(fakeFsRead),
    closeSync: vi.fn(),
    // Throwing statSync keeps chunkedUpload on the caller-provided sizeBytes.
    statSync: vi.fn(() => { throw new Error('no real fs in tests'); }),
  },
  readFileSync: vi.fn(() => Buffer.from('fake-file-content')),
  openSync: vi.fn(() => 7),
  readSync: vi.fn(fakeFsRead),
  closeSync: vi.fn(),
  statSync: vi.fn(() => { throw new Error('no real fs in tests'); }),
}));

vi.mock('node:crypto', () => ({
  default: {
    randomBytes: vi.fn(() => Buffer.from('a'.repeat(32))),
    createHash: vi.fn(() => ({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn(() => 'test-code-challenge'),
    })),
  },
  randomBytes: vi.fn(() => Buffer.from('a'.repeat(32))),
  createHash: vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn(() => 'test-code-challenge'),
  })),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Budget gate: mock the org-plan lookup + budget check so we can assert the EXACT cost a reply
// reserves (15 dcents plain vs 200 with a URL) and that an exhausted budget blocks before any
// network call. detectUrlInContent + X_API_COSTS_DCENTS stay REAL (importActual) so the
// action→cost mapping under test is the production one; trackXApiCall is stubbed to avoid Redis.
const { checkXBudgetMock, getOrgPlanMock } = vi.hoisted(() => ({
  checkXBudgetMock: vi.fn(),
  getOrgPlanMock: vi.fn(),
}));
vi.mock('@/lib/quotas/check', () => ({ getOrgPlan: getOrgPlanMock }));
vi.mock('@/lib/platforms/x-usage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platforms/x-usage')>();
  return { ...actual, checkXBudget: checkXBudgetMock, trackXApiCall: vi.fn() };
});

const { XHandler } = await import('@/lib/platforms/x');
import type { PostData, ChannelData, MediaFileData } from '@/lib/platforms/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(overrides: Partial<ChannelData> = {}): ChannelData {
  return {
    id: 1,
    platform: 'x',
    accountId: 'user_123',
    accountName: 'testuser',
    accessToken: 'x-access-token',
    ...overrides,
  };
}

function makePost(overrides: Partial<PostData> = {}): PostData {
  return {
    content: 'Hello X!',
    mediaUrls: [],
    mediaFiles: [],
    ...overrides,
  };
}

function makeImage(url = 'https://cdn.test/img.jpg'): MediaFileData {
  return { url, localPath: '/tmp/img.jpg', mimeType: 'image/jpeg', sizeBytes: 1000 };
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

describe('XHandler', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new XHandler();

  beforeAll(() => {
    process.env.X_CLIENT_ID = 'test-x-client-id';
    process.env.X_CLIENT_SECRET = 'test-x-secret';
  });

  describe('config', () => {
    it('has correct platform config', () => {
      expect(handler.config.name).toBe('x');
      expect(handler.config.displayName).toBe('X');
      expect(handler.config.authType).toBe('oauth');
    });
  });

  describe('publishPost', () => {
    it('returns error when no access token', async () => {
      const result = await handler.publishPost(makePost(), makeChannel({ accessToken: '' }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('No access token');
    });

    it('blocks publishing when the global kill switch (X_DISABLE_LIVE_API) is set', async () => {
      process.env.X_DISABLE_LIVE_API = '1';
      try {
        const result = await handler.publishPost(makePost(), makeChannel({ organizationId: 7 }));
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/disabled|temporarily/i);
        expect(mockFetch).not.toHaveBeenCalled(); // short-circuits before any X call
      } finally {
        delete process.env.X_DISABLE_LIVE_API;
      }
    });

    it('publishes text-only tweet', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ data: { id: 'tweet_1', text: 'Hello X!' } }),
      );

      const result = await handler.publishPost(makePost(), makeChannel());
      expect(result.success).toBe(true);
      expect(result.postId).toBe('tweet_1');
      expect(result.url).toContain('x.com/testuser/status/tweet_1');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.text).toBe('Hello X!');
      expect(body.media).toBeUndefined();
    });

    it('publishes tweet with image (simple upload)', async () => {
      // v2 one-shot upload response: media id at data.id
      mockFetch.mockResolvedValueOnce(mockFetchJson({ data: { id: 'media_1' } }));
      // Tweet create
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ data: { id: 'tweet_2', text: 'With image' } }),
      );

      const post = makePost({ mediaFiles: [makeImage()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);

      // Uploaded via the v2 endpoint as a multipart form (not v1.1 base64 urlencoded)
      expect(mockFetch.mock.calls[0][0]).toBe('https://api.x.com/2/media/upload');
      const uploadForm = mockFetch.mock.calls[0][1].body as FormData;
      expect(uploadForm.get('media_category')).toBe('tweet_image');
      expect(uploadForm.get('media')).toBeTruthy();

      const tweetBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(tweetBody.media.media_ids).toEqual(['media_1']);
    });

    it('publishes tweet with reply settings', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ data: { id: 'tweet_3', text: 'Limited replies' } }),
      );

      const post = makePost({
        platformSpecific: { x: { replySettings: 'mentionedUsers' } },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.reply_settings).toBe('mentionedUsers');
    });

    it('does not set reply_settings when everyone', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ data: { id: 'tweet_4', text: 'Open replies' } }),
      );

      const post = makePost({
        platformSpecific: { x: { replySettings: 'everyone' } },
      });
      await handler.publishPost(post, makeChannel());

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.reply_settings).toBeUndefined();
    });

    // X's full "who can reply" enum (docs.x.com/x-api/posts/create-post):
    // following | mentionedUsers | verified | subscribers (everyone = omit the field).
    it.each(['following', 'verified', 'subscribers'])(
      'passes the "%s" reply audience straight through to reply_settings',
      async (setting) => {
        mockFetch.mockResolvedValueOnce(
          mockFetchJson({ data: { id: 'tweet_rs', text: 'Limited replies' } }),
        );

        const post = makePost({ platformSpecific: { x: { replySettings: setting } } });
        const result = await handler.publishPost(post, makeChannel());
        expect(result.success).toBe(true);

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.reply_settings).toBe(setting);
      },
    );

    // Regression: in production the publish worker passes the per-platform SLICE
    // (post.platformSpecific?.[platform]) — i.e. { replySettings } with no `x` wrapper.
    // The handler previously read post.platformSpecific?.x and silently dropped the setting.
    it('applies reply settings from the sliced platformSpecific shape the worker passes', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ data: { id: 'tweet_sliced', text: 'Limited replies' } }),
      );

      const post = makePost({
        platformSpecific: { replySettings: 'mentionedUsers' },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.reply_settings).toBe('mentionedUsers');
    });

    it('uses chunked upload for video (v2 INIT/APPEND/FINALIZE)', async () => {
      // INIT — media id at data.id
      mockFetch.mockResolvedValueOnce(mockFetchJson({ data: { id: 'chunked_1' } }));
      // APPEND — 2xx, no body consumed on success
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' });
      // FINALIZE — no processing_info → no STATUS poll
      mockFetch.mockResolvedValueOnce(mockFetchJson({ data: { id: 'chunked_1' } }));
      // Tweet create
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ data: { id: 'tweet_vid', text: 'Video tweet' } }),
      );

      const post = makePost({ mediaFiles: [makeVideo()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      // 4 calls: INIT, APPEND, FINALIZE, tweet create
      expect(mockFetch).toHaveBeenCalledTimes(4);
      // all media calls hit the v2 endpoint
      expect(mockFetch.mock.calls[0][0]).toBe('https://api.x.com/2/media/upload');
    });

    it('surfaces a clear error when media upload returns an empty body (no JSON crash)', async () => {
      // Regression: the retired v1.1 endpoint returned empty bodies and response.json() threw
      // the opaque "Unexpected end of JSON input". The defensive parser must report the status.
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' });

      const post = makePost({ mediaFiles: [makeImage()] });
      const result = await handler.publishPost(post, makeChannel());

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/empty\/non-JSON response/i);
      expect(result.error).not.toMatch(/Unexpected end of JSON input/);
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

    it('handles tweet API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: 'Forbidden' }),
      });

      const result = await handler.publishPost(makePost(), makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Forbidden');
    });
  });

  describe('publishThread', () => {
    it('publishes multi-tweet thread with reply chain', async () => {
      // Tweet 1
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ data: { id: 'thread_1', text: 'Part 1' } }),
      );
      // Tweet 2 (reply to tweet 1)
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ data: { id: 'thread_2', text: 'Part 2' } }),
      );

      const segments = [
        { content: 'Part 1', mediaUrls: [] as string[], mediaFiles: [] as MediaFileData[], sequence: 0 },
        { content: 'Part 2', mediaUrls: [] as string[], mediaFiles: [] as MediaFileData[], sequence: 1 },
      ];

      const result = await handler.publishThread(segments, makeChannel());
      expect(result.success).toBe(true);
      expect(result.posts).toHaveLength(2);
      expect(result.posts![0].postId).toBe('thread_1');
      expect(result.posts![1].postId).toBe('thread_2');
      expect(result.posts![1].parentId).toBe('thread_1');

      // Second tweet should include reply.in_reply_to_tweet_id
      const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(secondBody.reply.in_reply_to_tweet_id).toBe('thread_1');
    });

    it('returns error when no access token', async () => {
      const result = await handler.publishThread([], makeChannel({ accessToken: '' }));
      expect(result.success).toBe(false);
    });
  });

  describe('refreshToken', () => {
    it('refreshes token successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: 'new_access',
            refresh_token: 'new_refresh',
            expires_in: 7200,
            token_type: 'bearer',
          }),
      });

      const result = await handler.refreshToken('old_refresh');
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe('new_access');
      expect(result!.refreshToken).toBe('new_refresh');
    });

    it('returns null on failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'invalid_grant' }),
      });

      const result = await handler.refreshToken('bad_token');
      expect(result).toBeNull();
    });
  });

  describe('getPostMetrics', () => {
    it('returns empty map when no post IDs', async () => {
      const result = await handler.getPostMetrics(makeChannel(), []);
      expect(result.size).toBe(0);
    });

    it('fetches metrics for tweets', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: [
              {
                id: 'tweet_1',
                public_metrics: {
                  impression_count: 1000,
                  like_count: 50,
                  retweet_count: 10,
                  reply_count: 5,
                  quote_count: 2,
                  bookmark_count: 3,
                },
              },
            ],
          }),
      });

      const result = await handler.getPostMetrics(makeChannel(), ['tweet_1']);
      expect(result.size).toBe(1);
      const metrics = result.get('tweet_1')!;
      expect(metrics.impressions).toBe(1000);
      expect(metrics.likes).toBe(50);
      expect(metrics.shares).toBe(10);
      expect(metrics.comments).toBe(5);
      expect(metrics.extra!.quotes).toBe(2);
      // bookmark_count is X's save figure — a first-class metric, not extra.
      expect(metrics.saves).toBe(3);
    });
  });

  describe('publishComment (reply billing)', () => {
    const okStatus = (creditDcents: number) => ({
      allowed: true,
      usedDcents: 0,
      limitDcents: 0,
      remainingDcents: 0,
      creditDcents,
      totalAvailableDcents: creditDcents,
      resetsAt: new Date('2026-06-01').toISOString(),
    });

    beforeEach(() => {
      getOrgPlanMock.mockReset().mockResolvedValue('free');
      checkXBudgetMock.mockReset();
    });

    it('reserves the no-URL rate (15 dcents) for a plain reply and posts it', async () => {
      checkXBudgetMock.mockResolvedValue(okStatus(5000));
      mockFetch.mockResolvedValueOnce(mockFetchJson({ data: { id: 'reply_1' } }));

      const result = await handler.publishComment(makeChannel({ organizationId: 7 }), 'parent_99', 'great thread!');

      expect(result.success).toBe(true);
      expect(checkXBudgetMock).toHaveBeenCalledWith(7, 'free', 15);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.text).toBe('great thread!');
      expect(body.reply.in_reply_to_tweet_id).toBe('parent_99');
    });

    it('reserves the with-URL rate (200 dcents) for a reply containing a URL', async () => {
      checkXBudgetMock.mockResolvedValue(okStatus(5000));
      mockFetch.mockResolvedValueOnce(mockFetchJson({ data: { id: 'reply_2' } }));

      const result = await handler.publishComment(
        makeChannel({ organizationId: 7 }),
        'parent_99',
        'more details here https://example.com/post',
      );

      expect(result.success).toBe(true);
      expect(checkXBudgetMock).toHaveBeenCalledWith(7, 'free', 200);
    });

    it('blocks a URL reply when the budget cannot cover 200 dcents — before any network call', async () => {
      // Free org with only 15 dcents of credit: enough for a plain reply, NOT for a URL reply.
      checkXBudgetMock.mockResolvedValue({
        allowed: false,
        usedDcents: 0,
        limitDcents: 0,
        remainingDcents: 0,
        creditDcents: 15,
        totalAvailableDcents: 15,
        resetsAt: new Date('2026-06-01').toISOString(),
      });

      const result = await handler.publishComment(
        makeChannel({ organizationId: 7 }),
        'parent_99',
        'check this link https://example.com',
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/budget|credit/i);
      expect(checkXBudgetMock).toHaveBeenCalledWith(7, 'free', 200);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
