/**
 * Tests for the YouTube platform handler.
 *
 * Covers:
 *   - publishPost: video upload with metadata, Short detection (#Shorts tag)
 *   - Privacy status, category, tags
 *   - Playlist insertion
 *   - Custom thumbnail upload
 *   - No access token / missing video errors
 *   - checkPublishStatus: processed, uploaded, failed, rejected
 *   - refreshToken: success and failure
 *   - getPostMetrics: batched statistics fetch
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

vi.mock('fs', () => ({
  default: {
    statSync: vi.fn(() => ({ size: 10000 })),
    createReadStream: vi.fn(() => 'fake-stream'),
  },
  statSync: vi.fn(() => ({ size: 10000 })),
  createReadStream: vi.fn(() => 'fake-stream'),
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

const { YouTubeHandler } = await import('@/lib/platforms/youtube');
import type { PostData, ChannelData, MediaFileData } from '@/lib/platforms/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(overrides: Partial<ChannelData> = {}): ChannelData {
  return {
    id: 1,
    platform: 'youtube',
    accountId: 'yt_channel_1',
    accountName: 'TestChannel',
    accessToken: 'yt-access-token',
    ...overrides,
  };
}

function makePost(overrides: Partial<PostData> = {}): PostData {
  return {
    content: 'My video description',
    mediaUrls: [],
    mediaFiles: [],
    ...overrides,
  };
}

function makeVideo(url = 'https://cdn.test/vid.mp4'): MediaFileData {
  return {
    url,
    localPath: '/tmp/vid.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 10000,
  };
}

function mockFetchJson(data: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
    json: async () => data,
    headers: new Map([['Location', 'https://upload.googleapis.com/session123']]),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('YouTubeHandler', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new YouTubeHandler();

  beforeAll(() => {
    process.env.YOUTUBE_CLIENT_ID = 'test-yt-id';
    process.env.YOUTUBE_CLIENT_SECRET = 'test-yt-secret';
  });

  describe('config', () => {
    it('has correct platform config', () => {
      expect(handler.config.name).toBe('youtube');
      expect(handler.config.displayName).toBe('YouTube');
      expect(handler.config.postTypes).toHaveLength(2);
      expect(handler.config.postTypes[0].value).toBe('video');
      expect(handler.config.postTypes[1].value).toBe('short');
    });
  });

  describe('getOAuthUrl scope gating', () => {
    // Google forbids deploying unverified scopes to a public app's production
    // traffic; force-ssl (comment reading) must stay out of the request until
    // YOUTUBE_COMMENTS_SCOPE=on is set post-verification.
    afterEach(() => {
      delete process.env.YOUTUBE_COMMENTS_SCOPE;
    });

    it('requests exactly the three verified scopes by default', async () => {
      delete process.env.YOUTUBE_COMMENTS_SCOPE;
      const url = new URL(await handler.getOAuthUrl('https://app.test/cb', 'st'));
      expect(url.searchParams.get('scope')).toBe(
        'https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
      );
    });

    it('adds force-ssl only when YOUTUBE_COMMENTS_SCOPE=on', async () => {
      process.env.YOUTUBE_COMMENTS_SCOPE = 'on';
      const url = new URL(await handler.getOAuthUrl('https://app.test/cb', 'st'));
      expect(url.searchParams.get('scope')).toBe(
        'https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl',
      );
    });

    it('does not treat other values as opt-in', async () => {
      process.env.YOUTUBE_COMMENTS_SCOPE = 'true';
      const url = new URL(await handler.getOAuthUrl('https://app.test/cb', 'st'));
      expect(url.searchParams.get('scope')).not.toContain('force-ssl');
    });
  });

  describe('publishPost', () => {
    it('returns error when no access token', async () => {
      const post = makePost({ mediaFiles: [makeVideo()] });
      const result = await handler.publishPost(post, makeChannel({ accessToken: '' }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('No access token');
    });

    it('returns error when no video file', async () => {
      const result = await handler.publishPost(makePost(), makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('No video file');
    });

    it('returns error when no local path', async () => {
      const vid = makeVideo();
      vid.localPath = '';
      const result = await handler.publishPost(makePost({ mediaFiles: [vid] }), makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('No local video');
    });

    it('returns error when no title', async () => {
      const post = makePost({
        content: '',
        mediaFiles: [makeVideo()],
        platformSpecific: { title: '' },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('requires a title');
    });

    it('uploads video with correct metadata', async () => {
      // Resumable upload init
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: (h: string) => h === 'Location' ? 'https://upload.youtube.com/session1' : null },
      });
      // Upload video
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'vid_abc' }),
      });

      const post = makePost({
        content: 'My cool video',
        mediaFiles: [makeVideo()],
        platformSpecific: { title: 'Cool Title', categoryId: '24', tags: ['tag1', 'tag2'] },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(result.postId).toBe('vid_abc');
      expect(result.url).toContain('youtube.com/watch?v=vid_abc');
      expect(result.processing).toBe(true);

      // Verify metadata in init request
      const initBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(initBody.snippet.title).toBe('Cool Title');
      expect(initBody.snippet.categoryId).toBe('24');
      expect(initBody.snippet.tags).toEqual(['tag1', 'tag2']);
      expect(initBody.status.privacyStatus).toBe('public');
    });

    it('appends #Shorts for short post type', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'https://upload.youtube.com/session2' },
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'short_abc' }),
      });

      const post = makePost({
        content: 'Short video',
        postType: 'short',
        mediaFiles: [makeVideo()],
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(result.url).toContain('youtube.com/shorts/');

      const initBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(initBody.snippet.title).toContain('#Shorts');
      expect(initBody.snippet.description).toContain('#Shorts');
    });

    it('adds video to playlist when specified', async () => {
      // Upload init
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'https://upload.youtube.com/session3' },
      });
      // Upload video
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'pl_vid' }),
      });
      // Playlist insert
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const post = makePost({
        content: 'Playlist video',
        mediaFiles: [makeVideo()],
        platformSpecific: { playlistId: 'PLtest123' },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);

      // Verify playlist insert call
      expect(mockFetch).toHaveBeenCalledTimes(3);
      const plBody = JSON.parse(mockFetch.mock.calls[2][1].body);
      expect(plBody.snippet.playlistId).toBe('PLtest123');
    });

    it('uploads thumbnail when provided', async () => {
      // Upload init
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'https://upload.youtube.com/session4' },
      });
      // Upload video
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'thumb_vid' }),
      });
      // Fetch thumbnail image
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => new ArrayBuffer(100),
      });
      // Upload thumbnail
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const post = makePost({
        content: 'With thumb',
        mediaFiles: [makeVideo()],
        platformSpecific: { thumbnailUrl: 'https://cdn.test/thumb.jpg' },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('handles upload init failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad request',
      });

      const post = makePost({ content: 'Error video', mediaFiles: [makeVideo()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('initialization failed');
    });
  });

  describe('checkPublishStatus', () => {
    it('returns published for processed', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [{ id: 'v1', status: { uploadStatus: 'processed', privacyStatus: 'public' } }],
          }),
      });

      const result = await handler.checkPublishStatus(makeChannel(), 'v1');
      expect(result.status).toBe('published');
    });

    it('returns processing for uploaded', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [{ id: 'v2', status: { uploadStatus: 'uploaded' } }],
          }),
      });

      const result = await handler.checkPublishStatus(makeChannel(), 'v2');
      expect(result.status).toBe('processing');
    });

    it('returns failed for rejected', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [{ id: 'v3', status: { uploadStatus: 'rejected', rejectionReason: 'copyright' } }],
          }),
      });

      const result = await handler.checkPublishStatus(makeChannel(), 'v3');
      expect(result.status).toBe('failed');
      expect(result.message).toContain('copyright');
    });

    it('returns failed when video not found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ items: [] }),
      });

      const result = await handler.checkPublishStatus(makeChannel(), 'v4');
      expect(result.status).toBe('failed');
      expect(result.message).toContain('not found');
    });
  });

  describe('refreshToken', () => {
    it('refreshes token successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: 'new_yt_access',
            refresh_token: 'new_yt_refresh',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
      });

      const result = await handler.refreshToken('old_refresh');
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe('new_yt_access');
    });

    it('preserves original refresh token if not returned', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: 'new_access',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
      });

      const result = await handler.refreshToken('original_refresh');
      expect(result!.refreshToken).toBe('original_refresh');
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

  describe('getPostMetrics', () => {
    it('fetches video statistics', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [
              {
                id: 'vid1',
                statistics: {
                  viewCount: '10000',
                  likeCount: '500',
                  commentCount: '100',
                  favoriteCount: '50',
                },
              },
            ],
          }),
      });

      const result = await handler.getPostMetrics(makeChannel(), ['vid1']);
      const m = result.get('vid1')!;
      expect(m.videoViews).toBe(10000);
      expect(m.likes).toBe(500);
      expect(m.comments).toBe(100);
      // favoriteCount has been a documented always-0 since the feature was
      // removed in 2015 — it must not be stored as if it were a measurement.
      expect(m.extra?.favorites).toBeUndefined();
    });
  });
});
