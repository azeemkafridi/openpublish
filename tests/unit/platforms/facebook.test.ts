/**
 * Tests for the Facebook platform handler.
 *
 * Covers:
 *   - publishPost: text post, photo, video, multiple photos, reel, story (photo + video)
 *   - Mixed media rejection
 *   - Multiple videos rejection
 *   - No access token error
 *   - API error handling with user-friendly messages
 *   - refreshToken: success and failure
 *   - getPostMetrics: basic metrics and insights
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

const { FacebookHandler } = await import('@/lib/platforms/facebook');
import type { PostData, ChannelData, MediaFileData } from '@/lib/platforms/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Matches this file's existing inline shape: fetchJson reads .text(). */
function fbJson(data: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(data) };
}

function makeChannel(overrides: Partial<ChannelData> = {}): ChannelData {
  return {
    id: 1,
    platform: 'facebook',
    accountId: 'page123',
    accountName: 'Test Page',
    accessToken: 'fb-access-token',
    ...overrides,
  };
}

function makePost(overrides: Partial<PostData> = {}): PostData {
  return {
    content: 'Hello Facebook!',
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

function mockFetchOk(data: unknown) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

function mockFetchError(status: number, data: unknown) {
  return { ok: false, status, json: async () => data, text: async () => JSON.stringify(data) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FacebookHandler', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new FacebookHandler();

  describe('config', () => {
    it('has correct platform config', () => {
      expect(handler.config.name).toBe('facebook');
      expect(handler.config.displayName).toBe('Facebook');
      expect(handler.config.authType).toBe('sdk');
      expect(handler.config.postTypes.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('publishPost', () => {
    it('returns error when no access token', async () => {
      const result = await handler.publishPost(makePost(), makeChannel({ accessToken: '' }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('No access token');
    });

    it('flags authExpired on an access-token error (Graph code 190)', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchError(400, { error: { message: 'Error validating access token: Session has expired', code: 190 } }),
      );
      const result = await handler.publishPost(makePost(), makeChannel());
      expect(result.success).toBe(false);
      expect(result.authExpired).toBe(true);
      expect(result.error).toContain('reconnect');
    });

    it('does NOT flag authExpired on a permission error (Graph code 200)', async () => {
      // Code 200 = missing/removed permission — fix permissions, not the token.
      mockFetch.mockResolvedValueOnce(
        mockFetchError(403, { error: { message: 'Requires pages_manage_posts permission', code: 200 } }),
      );
      const result = await handler.publishPost(makePost(), makeChannel());
      expect(result.success).toBe(false);
      expect(result.authExpired).toBeFalsy();
    });

    it('does NOT flag authExpired on a content error (code 100)', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchError(400, { error: { message: 'Invalid parameter', code: 100 } }),
      );
      const result = await handler.publishPost(makePost(), makeChannel());
      expect(result.success).toBe(false);
      expect(result.authExpired).toBeFalsy();
    });

    // Real prod failure, 2026-07-28: a Facebook video post stored
    // "Please reduce the amount of data you're asking for, then retry your
    // request Videos must be MP4/MOV format, under 2GB." Graph code 1 is a
    // throttle; the file was fine, and the post should have been retried.
    it('reports Graph code 1 as a temporary platform fault, not a media problem', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchError(400, {
          error: {
            message: "Please reduce the amount of data you're asking for, then retry your request",
            code: 1,
          },
        }),
      );
      const result = await handler.publishPost(makePost(), makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('temporarily unavailable');
      // The whole point: no advice about the user's file.
      expect(result.error).not.toContain('MP4/MOV');
      expect(result.error).not.toContain('2GB');
    });

    it('does not append format guidance to unrelated errors', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchError(400, { error: { message: 'Requires extended permissions', code: 100 } }),
      );
      const result = await handler.publishPost(makePost(), makeChannel());
      expect(result.error).toBe('Requires extended permissions');
    });

    it('publishes text post', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchOk({ id: 'post_123' }));

      const result = await handler.publishPost(makePost(), makeChannel());
      expect(result.success).toBe(true);
      expect(result.postId).toBe('post_123');

      // Verify it called the feed endpoint
      expect(mockFetch.mock.calls[0][0]).toContain('/page123/feed');
    });

    it('publishes text post with link preview', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchOk({ id: 'link_post_123' }));

      const post = makePost({
        linkPreview: { url: 'https://example.com', title: 'Ex', description: 'Desc', image: '' },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);

      const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
      expect(body.get('link')).toBe('https://example.com');
    });

    it('publishes single photo', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchOk({ id: 'photo_123' }));

      const post = makePost({ mediaFiles: [makeImage()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(mockFetch.mock.calls[0][0]).toContain('/page123/photos');
    });

    it('publishes single video', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchOk({ id: 'video_123' }));

      const post = makePost({ mediaFiles: [makeVideo()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(mockFetch.mock.calls[0][0]).toContain('/page123/videos');
    });

    it('publishes multiple photos (2 unpublished uploads + 1 feed post)', async () => {
      // Upload photo 1
      mockFetch.mockResolvedValueOnce(mockFetchOk({ id: 'photo_a' }));
      // Upload photo 2
      mockFetch.mockResolvedValueOnce(mockFetchOk({ id: 'photo_b' }));
      // Create multi-photo post
      mockFetch.mockResolvedValueOnce(mockFetchOk({ id: 'multi_post_123' }));

      const post = makePost({
        mediaFiles: [makeImage('https://cdn.test/1.jpg'), makeImage('https://cdn.test/2.jpg')],
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(result.postId).toBe('multi_post_123');
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('publishes reel via the 3-phase flow (start → upload → finish)', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchOk({ video_id: 'reel_vid_1' })); // start
      mockFetch.mockResolvedValueOnce(mockFetchOk({ success: true })); // rupload
      mockFetch.mockResolvedValueOnce(mockFetchOk({ status: { video_status: 'upload_complete' } })); // poll
      mockFetch.mockResolvedValueOnce(mockFetchOk({ success: true })); // finish

      const post = makePost({
        postType: 'reel',
        mediaFiles: [makeVideo()],
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(result.postId).toBe('reel_vid_1');
      expect(result.url).toBe('https://www.facebook.com/reel/reel_vid_1');

      // start phase
      expect(mockFetch.mock.calls[0][0]).toContain('/page123/video_reels');
      const startBody = mockFetch.mock.calls[0][1].body as URLSearchParams;
      expect(startBody.get('upload_phase')).toBe('start');
      // upload phase — hosted-file variant against rupload
      expect(mockFetch.mock.calls[1][0]).toBe('https://rupload.facebook.com/video-reels/reel_vid_1');
      expect(mockFetch.mock.calls[1][1].headers.file_url).toBe('https://cdn.test/vid.mp4');
      // finish phase carries the video_id — the missing param in the old
      // single-request implementation ("(#100) Missing parameter: video_id")
      const finishBody = mockFetch.mock.calls[3][1].body as URLSearchParams;
      expect(finishBody.get('upload_phase')).toBe('finish');
      expect(finishBody.get('video_id')).toBe('reel_vid_1');
      expect(finishBody.get('video_state')).toBe('PUBLISHED');
    });

    it('surfaces a start-phase error for reel', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchError(400, { error: { message: 'Invalid parameter', code: 100 } }),
      );
      const post = makePost({ postType: 'reel', mediaFiles: [makeVideo()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('surfaces an upload-phase failure for reel', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchOk({ video_id: 'reel_vid_2' }));
      mockFetch.mockResolvedValueOnce(
        mockFetchError(500, { debug_info: { message: 'Fetch of source failed' } }),
      );
      const post = makePost({ postType: 'reel', mediaFiles: [makeVideo()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Fetch of source failed');
    });

    it('fails reel when video processing errors', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchOk({ video_id: 'reel_vid_3' }));
      mockFetch.mockResolvedValueOnce(mockFetchOk({ success: true }));
      mockFetch.mockResolvedValueOnce(mockFetchOk({ status: { video_status: 'error' } }));
      const post = makePost({ postType: 'reel', mediaFiles: [makeVideo()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('processing failed');
    });

    it('flags auth expiry on a code-190 reel finish error', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchOk({ video_id: 'reel_vid_4' }));
      mockFetch.mockResolvedValueOnce(mockFetchOk({ success: true }));
      mockFetch.mockResolvedValueOnce(mockFetchOk({ status: { video_status: 'ready' } }));
      mockFetch.mockResolvedValueOnce(
        mockFetchError(400, { error: { message: 'Session has expired', code: 190 } }),
      );
      const post = makePost({ postType: 'reel', mediaFiles: [makeVideo()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.authExpired).toBe(true);
    });

    it('returns error for reel without video', async () => {
      const post = makePost({ postType: 'reel', mediaFiles: [] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Reel requires a video');
    });

    it('publishes photo story and captures post_id from the real response shape', async () => {
      // Upload unpublished photo
      mockFetch.mockResolvedValueOnce(mockFetchOk({ id: 'photo_story_id' }));
      // Create photo story — /photo_stories returns { success, post_id }, NOT { id }
      mockFetch.mockResolvedValueOnce(mockFetchOk({ success: true, post_id: 'story_123' }));

      const post = makePost({
        postType: 'story',
        mediaFiles: [makeImage()],
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(result.postId).toBe('story_123');
    });

    it('publishes photo story gracefully when no post_id is returned', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchOk({ id: 'photo_story_id' }));
      mockFetch.mockResolvedValueOnce(mockFetchOk({ success: true }));

      const post = makePost({
        postType: 'story',
        mediaFiles: [makeImage()],
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(result.postId).toBeUndefined();
    });

    it('publishes video story and captures post_id from the real response shape', async () => {
      // Upload unpublished video
      mockFetch.mockResolvedValueOnce(mockFetchOk({ id: 'vid_id' }));
      // Processing-status poll before the story is created
      mockFetch.mockResolvedValueOnce(mockFetchOk({ status: { video_status: 'ready' } }));
      // Create video story — /video_stories returns { success, post_id }, NOT { id }
      mockFetch.mockResolvedValueOnce(mockFetchOk({ success: true, post_id: 'story_vid_123' }));

      const post = makePost({
        postType: 'story',
        mediaFiles: [makeVideo()],
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(result.postId).toBe('story_vid_123');
    });

    it('fails the video story when video processing errors', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchOk({ id: 'vid_id' }));
      mockFetch.mockResolvedValueOnce(mockFetchOk({ status: { video_status: 'error' } }));

      const post = makePost({
        postType: 'story',
        mediaFiles: [makeVideo()],
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('processing failed');
    });

    it('returns error for story without media', async () => {
      const post = makePost({ postType: 'story', mediaFiles: [] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Story requires');
    });

    it('rejects mixed images and videos', async () => {
      const post = makePost({
        mediaFiles: [makeImage(), makeVideo()],
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('mixing');
    });

    it('rejects multiple videos', async () => {
      const post = makePost({
        mediaFiles: [makeVideo(), makeVideo()],
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('multiple videos');
    });

    it('handles API error with user-friendly message', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchError(400, { error: { message: 'Invalid token', code: 190 } }),
      );

      const result = await handler.publishPost(makePost(), makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('expired');
    });

    it('handles error code 200 (permission denied)', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchError(403, { error: { message: 'Requires permission', code: 200 } }),
      );

      const result = await handler.publishPost(makePost(), makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');
    });

    it('handles network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await handler.publishPost(makePost(), makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
    });
  });

  describe('refreshToken', () => {
    it('exchanges token successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'new_token', expires_in: 5184000 }),
      });

      process.env.FACEBOOK_APP_ID = 'fb-app-id';
      process.env.FACEBOOK_APP_SECRET = 'fb-app-secret';

      const result = await handler.refreshToken('old_token');
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe('new_token');
      expect(result!.expiresIn).toBe(5184000);
    });

    it('returns null on failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'Invalid token' }),
      });

      const result = await handler.refreshToken('bad_token');
      expect(result).toBeNull();
    });
  });

  describe('getPostMetrics', () => {
    it('addresses insights by the PAGE-QUALIFIED post id', async () => {
      // A bare post id resolves as an object but has no insights edge:
      //   400 (#100) "Tried accessing nonexisting field (insights)"
      // Prefixing with the page id returns real data. 34 of 39 production rows
      // stored the bare form, which is why Facebook impressions/reach/clicks
      // were ~0 while likes and comments worked.
      mockFetch
        .mockResolvedValueOnce(fbJson({ likes: { summary: { total_count: 3 } }, comments: { summary: { total_count: 1 } } }))
        .mockResolvedValueOnce(fbJson({ data: [{ name: 'post_total_media_view_unique', values: [{ value: 218 }] }] }));

      const result = await handler.getPostMetrics(makeChannel(), ['1547022313824575']);

      const insightsUrl = mockFetch.mock.calls[1][0] as string;
      expect(insightsUrl).toContain('/page123_1547022313824575/insights');
      expect(result.get('1547022313824575')).toMatchObject({ reach: 218, likes: 3 });
    });

    it('does not double-prefix an id that is already qualified', async () => {
      mockFetch
        .mockResolvedValueOnce(fbJson({ likes: { summary: { total_count: 0 } } }))
        .mockResolvedValueOnce(fbJson({ data: [] }));

      await handler.getPostMetrics(makeChannel(), ['page123_999']);

      const insightsUrl = mockFetch.mock.calls[1][0] as string;
      expect(insightsUrl).toContain('/page123_999/insights');
      expect(insightsUrl).not.toContain('page123_page123');
    });

    it('keys the result by the id the caller passed, not the qualified one', async () => {
      // The worker looks metrics up by the stored platform_post_id.
      mockFetch
        .mockResolvedValueOnce(fbJson({ likes: { summary: { total_count: 7 } } }))
        .mockResolvedValueOnce(fbJson({ data: [] }));

      const result = await handler.getPostMetrics(makeChannel(), ['bare1']);
      expect(result.has('bare1')).toBe(true);
      expect(result.has('page123_bare1')).toBe(false);
    });

    it('keeps the lifetime metric when the same metric also arrives as a day series', async () => {
      // Verified live: Facebook returns post_total_media_view_unique twice —
      // period=lifetime value=474, then period=day value=0 for a post with no
      // traffic in the last 48h. A plain loop let the day entry win and zeroed
      // impressions/reach on posts whose insights were otherwise fine.
      mockFetch
        .mockResolvedValueOnce(fbJson({ likes: { summary: { total_count: 43 } } }))
        .mockResolvedValueOnce(
          fbJson({
            data: [
              { name: 'post_total_media_view_unique', period: 'lifetime', values: [{ value: 474 }] },
              { name: 'post_clicks', period: 'lifetime', values: [{ value: 2 }] },
              {
                name: 'post_total_media_view_unique',
                period: 'day',
                values: [{ value: 0 }, { value: 0 }],
              },
            ],
          }),
        );

      const result = await handler.getPostMetrics(makeChannel(), ['p1']);

      expect(result.get('p1')).toMatchObject({
        impressions: 474,
        reach: 474,
        clicks: 2,
        likes: 43,
      });
    });

    it('still reads a metric that only ever arrives as a day series', async () => {
      mockFetch
        .mockResolvedValueOnce(fbJson({ likes: { summary: { total_count: 0 } } }))
        .mockResolvedValueOnce(
          fbJson({
            data: [{ name: 'post_clicks', period: 'day', values: [{ value: 9 }] }],
          }),
        );

      const result = await handler.getPostMetrics(makeChannel(), ['p1']);
      expect(result.get('p1')).toMatchObject({ clicks: 9 });
    });

    it('returns empty map when no post IDs', async () => {
      const result = await handler.getPostMetrics(makeChannel(), []);
      expect(result.size).toBe(0);
    });

    it('returns empty map when no access token', async () => {
      const result = await handler.getPostMetrics(makeChannel({ accessToken: '' }), ['post1']);
      expect(result.size).toBe(0);
    });

    it('fetches basic metrics and insights', async () => {
      // Basic metrics call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 'post1',
            likes: { summary: { total_count: 42 } },
            comments: { summary: { total_count: 10 } },
            shares: { count: 5 },
          }),
      });

      // Insights call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: [
              { name: 'post_total_media_view_unique', values: [{ value: 1000 }] },
              { name: 'post_clicks', values: [{ value: 50 }] },
            ],
          }),
      });

      const result = await handler.getPostMetrics(makeChannel(), ['post1']);
      expect(result.size).toBe(1);

      const metrics = result.get('post1')!;
      expect(metrics.likes).toBe(42);
      expect(metrics.comments).toBe(10);
      expect(metrics.shares).toBe(5);
      expect(metrics.impressions).toBe(1000);
      expect(metrics.reach).toBe(1000); // unique media views serve as both impressions and reach
      expect(metrics.clicks).toBe(50);
    });
  });

  describe('getPostEngagement (pages_read_user_content)', () => {
    it('requests replies as well as top-level comments', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchOk({ data: [] }));   // comments
      mockFetch.mockResolvedValueOnce(mockFetchOk({ data: [] }));   // reactions

      await handler.getPostEngagement(makeChannel(), 'post_1');

      const url = mockFetch.mock.calls[0][0] as string;
      // Without filter=stream the Graph API returns only top-level comments,
      // so a reply to a comment silently never appeared in the thread.
      expect(url).toContain('filter=stream');
      expect(url).toContain('parent{id}');
    });

    it('carries parentId through so replies can be threaded', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchOk({
        data: [
          { id: 'c1', message: 'Top level', created_time: '2026-07-27T10:00:00Z', from: { id: 'u1', name: 'Page' } },
          { id: 'c2', message: 'A reply', created_time: '2026-07-27T10:05:00Z', from: { id: 'u2', name: 'Visitor' }, parent: { id: 'c1' } },
        ],
      }));
      mockFetch.mockResolvedValueOnce(mockFetchOk({ data: [] }));

      const result = await handler.getPostEngagement(makeChannel(), 'post_1');

      expect(result.comments).toHaveLength(2);
      expect(result.comments[0].parentId).toBeUndefined();
      expect(result.comments[1].parentId).toBe('c1');
      expect(result.comments[1].actor.name).toBe('Visitor');
    });
  });
});
