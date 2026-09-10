/**
 * Tests for the Instagram platform handler.
 *
 * Covers:
 *   - publishPost: feed photo, feed video, reel, story (image & video), carousel
 *   - Container creation + polling flow
 *   - No access token error
 *   - Missing media errors
 *   - Carousel min/max validation
 *   - checkPublishStatus: FINISHED, ERROR, EXPIRED, IN_PROGRESS
 *   - getPostMetrics: feed, reel, and story metrics
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

const { InstagramHandler } = await import('@/lib/platforms/instagram');
import type { PostData, ChannelData, MediaFileData } from '@/lib/platforms/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(overrides: Partial<ChannelData> = {}): ChannelData {
  return {
    id: 1,
    platform: 'instagram',
    accountId: 'ig_user_123',
    accountName: 'testuser',
    accessToken: 'ig-access-token',
    ...overrides,
  };
}

function makePost(overrides: Partial<PostData> = {}): PostData {
  return {
    content: 'Hello Instagram!',
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

/**
 * Mock createMediaContainer only. publishPost now returns processing:true
 * after container creation and defers the poll + publishContainer + permalink
 * dance to the status-check worker. Pass a container ID so tests can assert
 * processingId.
 */
function mockContainerCreate(containerId = 'container_1') {
  mockFetch.mockResolvedValueOnce(mockFetchJson({ id: containerId }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InstagramHandler', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new InstagramHandler();

  describe('config', () => {
    it('has correct platform config', () => {
      expect(handler.config.name).toBe('instagram');
      expect(handler.config.displayName).toBe('Instagram');
      expect(handler.config.postTypes.length).toBe(5);
    });
  });

  describe('publishPost', () => {
    it('returns error when no access token', async () => {
      const result = await handler.publishPost(
        makePost({ postType: 'feed_photo', mediaFiles: [makeImage()] }),
        makeChannel({ accessToken: '' }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('No access token');
    });

    it('defers feed photo — returns processing with container ID', async () => {
      mockContainerCreate('container_photo');

      const post = makePost({ postType: 'feed_photo', mediaFiles: [makeImage()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(result.processing).toBe(true);
      expect(result.processingId).toBe('container_photo');
    });

    it('returns error when feed photo has no image', async () => {
      const post = makePost({ postType: 'feed_photo', mediaFiles: [] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('requires an image');
    });

    it('defers feed video — returns processing with container ID', async () => {
      mockContainerCreate('container_video');

      const post = makePost({ postType: 'feed_video', mediaFiles: [makeVideo()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(result.processing).toBe(true);
      expect(result.processingId).toBe('container_video');
    });

    it('returns error when feed video has no video', async () => {
      const post = makePost({ postType: 'feed_video', mediaFiles: [] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('requires a video');
    });

    it('defers reel — returns processing with container ID', async () => {
      mockContainerCreate('container_reel');

      const post = makePost({ postType: 'reel', mediaFiles: [makeVideo()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(result.processing).toBe(true);
      expect(result.processingId).toBe('container_reel');
    });

    it('defers story with image — returns processing with container ID', async () => {
      mockContainerCreate('container_story_img');

      const post = makePost({ postType: 'story', mediaFiles: [makeImage()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(result.processing).toBe(true);
      expect(result.processingId).toBe('container_story_img');
    });

    it('defers story with video — returns processing with container ID', async () => {
      mockContainerCreate('container_story_vid');

      const post = makePost({ postType: 'story', mediaFiles: [makeVideo()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(result.processing).toBe(true);
      expect(result.processingId).toBe('container_story_vid');
    });

    it('returns error when story has no media', async () => {
      const post = makePost({ postType: 'story', mediaFiles: [] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('requires a photo or video');
    });

    it('a carousel child stuck IN_PROGRESS fails as a retry, not an unknown outcome', async () => {
      vi.useFakeTimers();
      try {
        const { classifyPublishError } = await import('@/lib/platforms/auth-errors');
        mockFetch.mockResolvedValueOnce(mockFetchJson({ id: 'child_0' }));
        mockFetch.mockResolvedValue(mockFetchJson({ id: 'child_0', status_code: 'IN_PROGRESS' }));

        const pending = handler.publishPost(makePost({ postType: 'carousel', mediaFiles: [makeImage('https://a.jpg'), makeImage('https://b.jpg')] }), makeChannel());
        await vi.advanceTimersByTimeAsync(120_000);
        const result = await pending;
        expect(result.success).toBe(false);
        // Nothing was published, so this must retry rather than go unconfirmed.
        expect(classifyPublishError(result.error!)).toBe('retry');
      } finally {
        vi.useRealTimers();
        mockFetch.mockReset();
      }
    });

    it('publishes carousel with 3 images', async () => {
      const images = [makeImage('https://a.jpg'), makeImage('https://b.jpg'), makeImage('https://c.jpg')];

      // For each child: createContainer + poll
      for (let i = 0; i < 3; i++) {
        mockFetch.mockResolvedValueOnce(mockFetchJson({ id: `child_${i}` }));
        mockFetch.mockResolvedValueOnce(mockFetchJson({ id: `child_${i}`, status_code: 'FINISHED' }));
      }
      // Carousel parent: create + poll + publish
      mockFetch.mockResolvedValueOnce(mockFetchJson({ id: 'carousel_parent' }));
      mockFetch.mockResolvedValueOnce(mockFetchJson({ id: 'carousel_parent', status_code: 'FINISHED' }));
      mockFetch.mockResolvedValueOnce(mockFetchJson({ id: 'pub_carousel_1' }));

      const post = makePost({ postType: 'carousel', mediaFiles: images });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(result.postId).toBe('pub_carousel_1');
    });

    it('returns error when carousel has fewer than 2 items', async () => {
      const post = makePost({ postType: 'carousel', mediaFiles: [makeImage()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('at least 2');
    });

    it('returns error when carousel has more than 10 items', async () => {
      const post = makePost({
        postType: 'carousel',
        mediaFiles: Array.from({ length: 11 }, (_, i) => makeImage(`https://cdn.test/${i}.jpg`)),
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('maximum of 10');
    });

    it('returns unsupported post type error', async () => {
      const post = makePost({ postType: 'unknown_type' });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported');
    });

    it('handles API error during publish', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: 'Bad media' } }),
      });

      const post = makePost({ postType: 'feed_photo', mediaFiles: [makeImage()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Bad media');
    });
  });

  describe('checkPublishStatus', () => {
    it('finalizes FINISHED container via publishContainer and returns real post ID', async () => {
      // pollContainerStatus -> FINISHED
      mockFetch.mockResolvedValueOnce(mockFetchJson({ id: 'c1', status_code: 'FINISHED' }));
      // publishContainer -> real post ID
      mockFetch.mockResolvedValueOnce(mockFetchJson({ id: 'final_post_99' }));
      // getPermalink
      mockFetch.mockResolvedValueOnce(mockFetchJson({ permalink: 'https://www.instagram.com/p/final_post_99/' }));

      const result = await handler.checkPublishStatus(makeChannel(), 'c1');
      expect(result.status).toBe('published');
      expect(result.postId).toBe('final_post_99');
      expect(result.url).toContain('instagram.com/p/final_post_99');
    });

    it('returns published for PUBLISHED (already finalized)', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ id: 'c1', status_code: 'PUBLISHED' }),
      );

      const result = await handler.checkPublishStatus(makeChannel(), 'c1');
      expect(result.status).toBe('published');
    });

    it('returns failed for ERROR', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ id: 'c1', status_code: 'ERROR' }),
      );

      const result = await handler.checkPublishStatus(makeChannel(), 'c1');
      expect(result.status).toBe('failed');
    });

    it('returns processing for IN_PROGRESS', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ id: 'c1', status_code: 'IN_PROGRESS' }),
      );

      const result = await handler.checkPublishStatus(makeChannel(), 'c1');
      expect(result.status).toBe('processing');
    });
  });

  describe('getPostMetrics', () => {
    it('returns empty map for empty post IDs', async () => {
      const result = await handler.getPostMetrics(makeChannel(), []);
      expect(result.size).toBe(0);
    });

    it('fetches feed metrics', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          data: [
            { name: 'impressions', values: [{ value: 500 }] },
            { name: 'reach', values: [{ value: 300 }] },
            { name: 'likes', values: [{ value: 50 }] },
            { name: 'comments', values: [{ value: 10 }] },
            { name: 'shares', values: [{ value: 5 }] },
            { name: 'saved', values: [{ value: 20 }] },
          ],
        }),
      );

      const result = await handler.getPostMetrics(makeChannel(), ['post1']);
      expect(result.size).toBe(1);
      const metrics = result.get('post1')!;
      expect(metrics.impressions).toBe(500);
      expect(metrics.reach).toBe(300);
      expect(metrics.likes).toBe(50);
      expect(metrics.saves).toBe(20);
    });
  });

  describe('publishComment', () => {
    it('comments via graph.instagram.com with the IG token for IG-Login accounts (no Page token)', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'comment_1' }) });

      const result = await handler.publishComment(makeChannel(), 'ig_media_1', 'Nice!');

      expect(result.success).toBe(true);
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('graph.instagram.com/ig_media_1/comments');
      expect(mockFetch.mock.calls[0][1].body.toString()).toContain('access_token=ig-access-token');
    });
  });

  describe('refreshToken', () => {
    it('refreshes the long-lived token and returns it as both access and refresh token', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchJson({ access_token: 'fresh-ig-token', expires_in: 5184000 }));

      const result = await handler.refreshToken('old-ig-token');

      expect(result).toEqual({
        accessToken: 'fresh-ig-token',
        refreshToken: 'fresh-ig-token',
        expiresIn: 5184000,
      });
      expect(mockFetch.mock.calls[0][0]).toContain('refresh_access_token');
      expect(mockFetch.mock.calls[0][0]).toContain('grant_type=ig_refresh_token');
    });

    it('returns null when the refresh call fails', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => '{"error":"x"}', json: async () => ({ error: 'x' }) });
      expect(await handler.refreshToken('old')).toBeNull();
    });
  });
});
