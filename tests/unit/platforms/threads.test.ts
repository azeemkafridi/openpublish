/**
 * Tests for the Threads platform handler.
 *
 * Covers:
 *   - publishPost: text, image, video, carousel
 *   - Quote post support
 *   - Container creation + polling flow
 *   - No access token / missing media errors
 *   - Content length validation (500 chars)
 *   - Carousel min/max validation
 *   - checkPublishStatus: FINISHED, ERROR, EXPIRED, IN_PROGRESS
 *   - publishThread: chained replies
 *   - getPostMetrics: views, reach, likes, reposts, quotes
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

const { ThreadsHandler } = await import('@/lib/platforms/threads');
import type { PostData, ChannelData, MediaFileData } from '@/lib/platforms/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(overrides: Partial<ChannelData> = {}): ChannelData {
  return {
    id: 1,
    platform: 'threads',
    accountId: 'threads_user_1',
    accountName: 'threaduser',
    accessToken: 'threads-access-token',
    ...overrides,
  };
}

function makePost(overrides: Partial<PostData> = {}): PostData {
  return {
    content: 'Hello Threads!',
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
 * Mock createThreadContainer only. publishPost (single post) now returns
 * processing:true after container creation and defers finalization to the
 * status-check worker. publishThread (multi-segment) still uses the old
 * sync path (create → wait → publish → next) via mockContainerFlow.
 */
function mockContainerCreate(containerId = 'container_1') {
  mockFetch.mockResolvedValueOnce(mockFetchJson({ id: containerId }));
}

/** Legacy: mock full create -> poll -> publish -> permalink flow.
 * Still used by the multi-segment `publishThread` path which remains synchronous. */
function mockContainerFlow(publishedId: string) {
  mockFetch.mockResolvedValueOnce(mockFetchJson({ id: 'container_1' }));
  mockFetch.mockResolvedValueOnce(mockFetchJson({ id: 'container_1', status: 'FINISHED' }));
  mockFetch.mockResolvedValueOnce(mockFetchJson({ id: publishedId }));
  // fetchThreadsPermalink call after publish
  mockFetch.mockResolvedValueOnce(mockFetchJson({ id: publishedId, permalink: `https://www.threads.net/@testuser/post/${publishedId}` }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ThreadsHandler', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new ThreadsHandler();

  describe('config', () => {
    it('has correct platform config', () => {
      expect(handler.config.name).toBe('threads');
      expect(handler.config.displayName).toBe('Threads');
      expect(handler.config.postTypes).toHaveLength(4);
    });
  });

  describe('publishPost', () => {
    it('returns error when no access token', async () => {
      const result = await handler.publishPost(makePost(), makeChannel({ accessToken: '' }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('No access token');
    });

    it('defers text post — returns processing with container ID', async () => {
      mockContainerCreate('container_text');

      const post = makePost({ postType: 'text', content: 'Just text' });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(result.processing).toBe(true);
      expect(result.processingId).toBe('container_text');
    });

    it('returns error when text post has no content', async () => {
      const post = makePost({ postType: 'text', content: '' });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('requires content');
    });

    it('returns error when text exceeds 500 chars', async () => {
      const post = makePost({ postType: 'text', content: 'a'.repeat(501) });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('500');
    });

    it('defers image post — returns processing with container ID', async () => {
      mockContainerCreate('container_img');

      const post = makePost({ postType: 'image', mediaFiles: [makeImage()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(result.processing).toBe(true);
      expect(result.processingId).toBe('container_img');
    });

    it('returns error when image post has no image', async () => {
      const post = makePost({ postType: 'image', mediaFiles: [] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('requires an image');
    });

    it('defers video post — returns processing with container ID', async () => {
      mockContainerCreate('container_vid');

      const post = makePost({ postType: 'video', mediaFiles: [makeVideo()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(result.processing).toBe(true);
      expect(result.processingId).toBe('container_vid');
    });

    it('defers text post with quote post ID', async () => {
      mockContainerCreate('container_quote');

      const post = makePost({
        postType: 'text',
        content: 'Quote this!',
        platformSpecific: { quotePostId: 'original_post_123' },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(result.processing).toBe(true);
      expect(result.processingId).toBe('container_quote');
    });

    it('publishes carousel', async () => {
      const images = [makeImage('https://a.jpg'), makeImage('https://b.jpg'), makeImage('https://c.jpg')];

      // Child containers: create + poll for each
      for (let i = 0; i < 3; i++) {
        mockFetch.mockResolvedValueOnce(mockFetchJson({ id: `child_${i}` }));
        mockFetch.mockResolvedValueOnce(mockFetchJson({ id: `child_${i}`, status: 'FINISHED' }));
      }
      // Carousel parent: create + poll + publish
      mockFetch.mockResolvedValueOnce(mockFetchJson({ id: 'carousel_parent' }));
      mockFetch.mockResolvedValueOnce(mockFetchJson({ id: 'carousel_parent', status: 'FINISHED' }));
      mockFetch.mockResolvedValueOnce(mockFetchJson({ id: 'pub_carousel' }));

      const post = makePost({ postType: 'carousel', mediaFiles: images });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(result.postId).toBe('pub_carousel');
    });

    it('returns error for carousel with fewer than 2 items', async () => {
      const post = makePost({ postType: 'carousel', mediaFiles: [makeImage()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('at least 2');
    });

    it('returns error for carousel with more than 20 items', async () => {
      const post = makePost({
        postType: 'carousel',
        mediaFiles: Array.from({ length: 21 }, () => makeImage()),
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('maximum of 20');
    });

    it('returns unsupported post type error', async () => {
      const post = makePost({ postType: 'unknown' });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported');
    });
  });

  describe('checkPublishStatus', () => {
    it('finalizes FINISHED container via publishThreadContainer and returns real post ID', async () => {
      // pollContainerStatus -> FINISHED
      mockFetch.mockResolvedValueOnce(mockFetchJson({ id: 'c1', status: 'FINISHED' }));
      // publishThreadContainer -> real post ID
      mockFetch.mockResolvedValueOnce(mockFetchJson({ id: 'threads_final_99' }));
      // fetchThreadsPermalink
      mockFetch.mockResolvedValueOnce(mockFetchJson({ id: 'threads_final_99', permalink: 'https://www.threads.net/@testuser/post/threads_final_99' }));

      const result = await handler.checkPublishStatus(makeChannel(), 'c1');
      expect(result.status).toBe('published');
      expect(result.postId).toBe('threads_final_99');
      expect(result.url).toContain('threads.net');
    });

    it('returns failed for ERROR with message', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ id: 'c2', status: 'ERROR', error_message: 'Media too large' }),
      );
      const result = await handler.checkPublishStatus(makeChannel(), 'c2');
      expect(result.status).toBe('failed');
      expect(result.message).toContain('Media too large');
    });

    it('returns processing for IN_PROGRESS', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ id: 'c3', status: 'IN_PROGRESS' }),
      );
      const result = await handler.checkPublishStatus(makeChannel(), 'c3');
      expect(result.status).toBe('processing');
    });
  });

  describe('publishThread', () => {
    it('publishes multi-post thread with reply chain', async () => {
      // Post 1: create + poll + publish
      mockContainerFlow('thread_post_1');
      // Post 2: create + poll + publish
      mockContainerFlow('thread_post_2');

      const segments = [
        { content: 'Part 1', mediaUrls: [] as string[], mediaFiles: [] as MediaFileData[], sequence: 0 },
        { content: 'Part 2', mediaUrls: [] as string[], mediaFiles: [] as MediaFileData[], sequence: 1 },
      ];

      const result = await handler.publishThread(segments, makeChannel());
      expect(result.success).toBe(true);
      expect(result.posts).toHaveLength(2);
      expect(result.posts![1].parentId).toBe('thread_post_1');
    });

    it('returns error when no access token', async () => {
      const result = await handler.publishThread([], makeChannel({ accessToken: '' }));
      expect(result.success).toBe(false);
    });
  });

  describe('getPostMetrics', () => {
    it('fetches Threads post metrics', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: [
              { name: 'views', values: [{ value: 1000 }] },
              { name: 'likes', values: [{ value: 50 }] },
              { name: 'replies', values: [{ value: 10 }] },
              { name: 'reposts', values: [{ value: 5 }] },
              { name: 'quotes', values: [{ value: 2 }] },
            ],
          }),
      });

      const result = await handler.getPostMetrics(makeChannel(), ['post1']);
      const m = result.get('post1')!;
      expect(m.impressions).toBe(1000);
      expect(m.likes).toBe(50);
      expect(m.comments).toBe(10);
      expect(m.shares).toBe(5);
      expect(m.extra!.quotes).toBe(2);
    });
  });

  describe('refreshToken', () => {
    it('refreshes the long-lived token and returns it as both access and refresh token', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'fresh-th-token', expires_in: 5184000 }),
      });

      const result = await handler.refreshToken('old-th-token');

      expect(result).toEqual({
        accessToken: 'fresh-th-token',
        refreshToken: 'fresh-th-token',
        expiresIn: 5184000,
      });
      expect(mockFetch.mock.calls[0][0]).toContain('refresh_access_token');
      expect(mockFetch.mock.calls[0][0]).toContain('grant_type=th_refresh_token');
    });

    it('returns null when the refresh call fails', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => '{"error":"x"}' });
      expect(await handler.refreshToken('old')).toBeNull();
    });
  });

  describe('getPostEngagement (threads_read_replies)', () => {
    it('maps replies to commenters with profile links', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchJson({
        data: [
          { id: 'r1', text: 'Great thread!', timestamp: '2026-07-27T10:00:00Z', username: 'jane', permalink: 'https://threads.net/p/1' },
        ],
      }));

      const result = await handler.getPostEngagement(makeChannel(), 'post_1');

      expect(result.comments).toHaveLength(1);
      expect(result.comments[0]).toMatchObject({ id: 'r1', text: 'Great thread!' });
      expect(result.comments[0].actor).toMatchObject({
        name: 'jane',
        handle: 'jane',
        profileUrl: 'https://www.threads.net/@jane',
      });
      const url = mockFetch.mock.calls[0][0] as string;
      // /conversation, not /replies — the latter returns only direct replies to
      // the post, so a reply to a reply was invisible.
      expect(url).toContain('/post_1/conversation');
    });

    it('keeps a media-only reply instead of dropping it', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchJson({
        data: [{ id: 'r2', timestamp: '2026-07-27T10:00:00Z', username: 'bob' }],
      }));

      const result = await handler.getPostEngagement(makeChannel(), 'post_1');

      // Previously `if (!r.text) continue` silently hid these.
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].text).toBe('(media reply)');
    });

    it('flags that Threads never exposes individual likers', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchJson({ data: [] }));

      const result = await handler.getPostEngagement(makeChannel(), 'post_1');

      // Drives the UI hiding an always-empty Reactors tab.
      expect(result.reactionsUnsupported).toBe(true);
      expect(result.reactions).toEqual([]);
      expect(result.notice).toMatch(/who replied, not who liked/);
    });

    it('surfaces a notice when the replies fetch fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('boom'));

      const result = await handler.getPostEngagement(makeChannel(), 'post_1');

      expect(result.notice).toBe('Replies unavailable');
      expect(result.comments).toEqual([]);
    });

    it('threads a reply-to-a-reply via replied_to', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchJson({
        data: [
          { id: 'r1', text: 'Top reply', timestamp: '2026-07-27T10:00:00Z', username: 'jane' },
          { id: 'r2', text: 'Nested reply', timestamp: '2026-07-27T10:05:00Z', username: 'bob', replied_to: { id: 'r1' } },
        ],
      }));

      const result = await handler.getPostEngagement(makeChannel(), 'post_1');

      expect(result.comments).toHaveLength(2);
      expect(result.comments[0].parentId).toBeUndefined();
      expect(result.comments[1].parentId).toBe('r1');
    });

    it('does not treat a direct reply to the post as nested', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchJson({
        data: [{ id: 'r1', text: 'Direct', timestamp: '2026-07-27T10:00:00Z', username: 'jane', replied_to: { id: 'post_1' } }],
      }));

      const result = await handler.getPostEngagement(makeChannel(), 'post_1');

      // The root post isn't rendered as a comment, so this must stay top level.
      expect(result.comments[0].parentId).toBeUndefined();
    });

    it('omits replies the user hid or that are blocked', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchJson({
        data: [
          { id: 'r1', text: 'Visible', timestamp: '2026-07-27T10:00:00Z', username: 'jane' },
          { id: 'r2', text: 'Hidden by the user', timestamp: '2026-07-27T10:01:00Z', username: 'troll', hide_status: 'HIDDEN' },
        ],
      }));

      const result = await handler.getPostEngagement(makeChannel(), 'post_1');

      // Re-surfacing a hidden reply would undo the user's moderation.
      expect(result.comments.map((c) => c.id)).toEqual(['r1']);
    });
  });
});
