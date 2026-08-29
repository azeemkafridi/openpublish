/**
 * Tests for the Mastodon platform handler.
 *
 * Covers:
 *   - publishPost: text, with images, with video, visibility settings
 *   - Media upload flow (FormData + fetchWithFile)
 *   - No access token / missing instanceUrl errors
 *   - Media validation: mixed, >4 images, >1 video
 *   - Platform-specific options: visibility, spoilerText, language
 *   - publishThread: chained replies with in_reply_to_id
 *   - refreshToken: returns null (Mastodon tokens don't expire)
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
  default: { readFileSync: vi.fn(() => Buffer.from('fake-file-content')) },
  readFileSync: vi.fn(() => Buffer.from('fake-file-content')),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { MastodonHandler } = await import('@/lib/platforms/mastodon');
import type { PostData, ChannelData, MediaFileData } from '@/lib/platforms/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(overrides: Partial<ChannelData> = {}): ChannelData {
  return {
    id: 1,
    platform: 'mastodon',
    accountId: 'masto_user_1',
    accountName: 'mastouser',
    accessToken: 'masto-access-token',
    metadata: { instanceUrl: 'mastodon.social' },
    ...overrides,
  };
}

function makePost(overrides: Partial<PostData> = {}): PostData {
  return {
    content: 'Hello Mastodon!',
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

/** Mock media upload response */
function mockMediaUpload(mediaId: string) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({ id: mediaId, url: `https://mastodon.social/media/${mediaId}` }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MastodonHandler', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new MastodonHandler();

  describe('config', () => {
    it('has correct platform config', () => {
      expect(handler.config.name).toBe('mastodon');
      expect(handler.config.displayName).toBe('Mastodon');
      expect(handler.config.postTypes).toHaveLength(1);
      expect(handler.config.mediaRules.image?.maxSizeMB).toBe(16);
    });
  });

  describe('publishPost', () => {
    it('returns error when missing instanceUrl', async () => {
      const result = await handler.publishPost(
        makePost(),
        makeChannel({ metadata: {} }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing Mastodon instance URL');
    });

    it('returns error when no access token', async () => {
      const result = await handler.publishPost(makePost(), makeChannel({ accessToken: '' }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('No access token');
    });

    it('publishes text-only toot', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ id: 'toot_1', url: 'https://mastodon.social/@mastouser/toot_1' }),
      );

      const result = await handler.publishPost(makePost(), makeChannel());
      expect(result.success).toBe(true);
      expect(result.postId).toBe('toot_1');
      expect(result.url).toContain('mastodon.social');

      // Verify API call
      expect(mockFetch.mock.calls[0][0]).toContain('mastodon.social/api/v1/statuses');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.status).toBe('Hello Mastodon!');
    });

    it('publishes toot with images', async () => {
      // Upload 2 images
      mockMediaUpload('media_1');
      mockMediaUpload('media_2');
      // Create status
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ id: 'toot_img', url: 'https://mastodon.social/@mastouser/toot_img' }),
      );

      const post = makePost({
        mediaFiles: [makeImage('https://a.jpg'), makeImage('https://b.jpg')],
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);

      const body = JSON.parse(mockFetch.mock.calls[2][1].body);
      expect(body.media_ids).toEqual(['media_1', 'media_2']);
    });

    it('publishes toot with video', async () => {
      mockMediaUpload('vid_1');
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ id: 'toot_vid', url: 'https://mastodon.social/@mastouser/toot_vid' }),
      );

      const post = makePost({ mediaFiles: [makeVideo()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
    });

    it('sends visibility setting', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ id: 'toot_vis', url: 'https://mastodon.social/@mastouser/toot_vis' }),
      );

      const post = makePost({
        platformSpecific: { visibility: 'unlisted' },
      });
      await handler.publishPost(post, makeChannel());

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.visibility).toBe('unlisted');
    });

    it('sends spoiler text (content warning)', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ id: 'toot_cw', url: 'https://mastodon.social/@mastouser/toot_cw' }),
      );

      const post = makePost({
        platformSpecific: { spoilerText: 'Sensitive content', visibility: 'private' },
      });
      await handler.publishPost(post, makeChannel());

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.spoiler_text).toBe('Sensitive content');
      expect(body.visibility).toBe('private');
    });

    it('sends language parameter', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ id: 'toot_lang', url: 'https://mastodon.social/@mastouser/toot_lang' }),
      );

      const post = makePost({
        platformSpecific: { language: 'de' },
      });
      await handler.publishPost(post, makeChannel());

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.language).toBe('de');
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

    it('handles media upload failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () => 'Unprocessable entity',
      });

      const post = makePost({ mediaFiles: [makeImage()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('upload');
    });

    it('handles status creation API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: 'Unauthorized' }),
      });

      const result = await handler.publishPost(makePost(), makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unauthorized');
    });
  });

  describe('publishThread', () => {
    it('publishes multi-post thread with in_reply_to_id chain', async () => {
      // Post 1
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ id: 'thread_1', url: 'https://mastodon.social/@m/1' }),
      );
      // Post 2
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ id: 'thread_2', url: 'https://mastodon.social/@m/2' }),
      );

      const segments = [
        { content: 'Part 1', mediaUrls: [] as string[], mediaFiles: [] as MediaFileData[], sequence: 0 },
        { content: 'Part 2', mediaUrls: [] as string[], mediaFiles: [] as MediaFileData[], sequence: 1 },
      ];

      const result = await handler.publishThread(segments, makeChannel());
      expect(result.success).toBe(true);
      expect(result.posts).toHaveLength(2);
      expect(result.posts![1].parentId).toBe('thread_1');

      // Second call should include in_reply_to_id
      const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(secondBody.in_reply_to_id).toBe('thread_1');
    });

    it('resumes a partially-posted thread without re-posting the live segments', async () => {
      // Only the two REMAINING segments are posted (Part 1 was already live from a prior run).
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ id: 'thread_2', url: 'https://mastodon.social/@m/2' }),
      );
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ id: 'thread_3', url: 'https://mastodon.social/@m/3' }),
      );

      const segments = [
        { content: 'Part 1', mediaUrls: [] as string[], mediaFiles: [] as MediaFileData[], sequence: 0 },
        { content: 'Part 2', mediaUrls: [] as string[], mediaFiles: [] as MediaFileData[], sequence: 1 },
        { content: 'Part 3', mediaUrls: [] as string[], mediaFiles: [] as MediaFileData[], sequence: 2 },
      ];
      const alreadyPosted = [{ sequence: 0, postId: 'thread_1', url: 'https://mastodon.social/@m/1' }];

      const result = await handler.publishThread(segments, makeChannel(), alreadyPosted);

      expect(result.success).toBe(true);
      // Only the 2 remaining segments hit the API — Part 1 was NOT re-posted (no duplicate).
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // The first newly-posted segment replies to the last already-live segment.
      const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(firstBody.in_reply_to_id).toBe('thread_1');
      expect(firstBody.status).toBe('Part 2');
      // Result includes all three (the live one + the two new), root first.
      expect(result.posts).toHaveLength(3);
      expect(result.posts!.map((p) => p.postId)).toEqual(['thread_1', 'thread_2', 'thread_3']);
    });

    it('returns error when missing instanceUrl', async () => {
      const result = await handler.publishThread([], makeChannel({ metadata: {} }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing Mastodon instance URL');
    });

    it('returns error when no access token', async () => {
      const result = await handler.publishThread([], makeChannel({ accessToken: '' }));
      expect(result.success).toBe(false);
    });

    it('handles partial thread failure', async () => {
      // Post 1 succeeds
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ id: 'thread_ok', url: 'https://mastodon.social/@m/ok' }),
      );
      // Post 2 fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: 'Server error' }),
      });

      const segments = [
        { content: 'Part 1', mediaUrls: [] as string[], mediaFiles: [] as MediaFileData[], sequence: 0 },
        { content: 'Part 2', mediaUrls: [] as string[], mediaFiles: [] as MediaFileData[], sequence: 1 },
      ];

      const result = await handler.publishThread(segments, makeChannel());
      expect(result.success).toBe(false);
      expect(result.posts).toHaveLength(1);
      expect(result.error).toContain('Part 2 failed');
    });
  });

  describe('refreshToken', () => {
    it('returns null (Mastodon tokens do not expire)', async () => {
      const result = await handler.refreshToken('any-token');
      expect(result).toBeNull();
    });
  });
});
