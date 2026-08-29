/**
 * Tests for the TikTok platform handler.
 *
 * Covers:
 *   - publishPost: video upload (PULL_FROM_URL), photo slideshow, privacy settings
 *   - Content interaction controls (disable duet/stitch/comment)
 *   - Content disclosure flags (isAigc, brandContentToggle)
 *   - No access token / missing video errors
 *   - API error handling
 *   - checkPublishStatus: PUBLISH_COMPLETE, FAILED, SEND_TO_USER_INBOX, processing
 *   - refreshToken: success and failure
 *   - getPostMetrics: batched video query
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

const { TikTokHandler, describeTikTokFailure } = await import('@/lib/platforms/tiktok');
import type { PostData, ChannelData, MediaFileData } from '@/lib/platforms/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(overrides: Partial<ChannelData> = {}): ChannelData {
  return {
    id: 1,
    platform: 'tiktok',
    accountId: 'tt_user_123',
    accountName: 'ttuser',
    accessToken: 'tt-access-token',
    ...overrides,
  };
}

function makePost(overrides: Partial<PostData> = {}): PostData {
  return {
    content: 'Hello TikTok!',
    mediaUrls: [],
    mediaFiles: [],
    ...overrides,
  };
}

function makeVideo(url = 'https://cdn.test/vid.mp4'): MediaFileData {
  return { url, localPath: '/tmp/vid.mp4', mimeType: 'video/mp4', sizeBytes: 50000 };
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

/**
 * Responds with RAW body text rather than a stringified object.
 *
 * Required to reproduce the video-id bug: TikTok sends ids as bare JSON
 * numbers, and any fixture built from a JS object has already lost the digits
 * before the handler runs — JSON.stringify(JSON.parse(...)) cannot round-trip
 * a 19-digit integer. Only raw text exercises the real parse path.
 */
function mockFetchRaw(body: string) {
  return {
    ok: true,
    status: 200,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TikTokHandler', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new TikTokHandler();

  beforeAll(() => {
    process.env.TIKTOK_CLIENT_KEY = 'test-tt-key';
    process.env.TIKTOK_CLIENT_SECRET = 'test-tt-secret';
  });

  describe('config', () => {
    it('has correct platform config', () => {
      expect(handler.config.name).toBe('tiktok');
      expect(handler.config.displayName).toBe('TikTok');
      expect(handler.config.postTypes).toHaveLength(2);
    });
  });

  describe('getOAuthUrl', () => {
    it('requests all approved scopes including analytics (profile/stats/video.list)', async () => {
      const url = await handler.getOAuthUrl('https://app.test/callback', 'state-123');
      const parsed = new URL(url);

      expect(url).toContain('https://www.tiktok.com/v2/auth/authorize/');
      expect(parsed.searchParams.get('client_key')).toBe('test-tt-key');
      expect(parsed.searchParams.get('redirect_uri')).toBe('https://app.test/callback');
      expect(parsed.searchParams.get('state')).toBe('state-123');
      expect(parsed.searchParams.get('response_type')).toBe('code');

      // scope is comma-joined; searchParams.get() decodes the %2C separators
      const scopes = (parsed.searchParams.get('scope') ?? '').split(',');
      expect(scopes).toEqual(
        expect.arrayContaining([
          'user.info.basic',
          'user.info.profile',
          'user.info.stats',
          'video.publish',
          'video.upload',
          'video.list',
        ]),
      );
    });
  });

  describe('getAccountInfo', () => {
    it('labels the channel with the creator @username when user.info.profile is granted', async () => {
      // Basic info call
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          data: { user: { open_id: 'oid', union_id: 'uid', avatar_url: 'http://a/x.jpg', display_name: 'Display' } },
        }),
      );
      // user.info.profile username call
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ data: { user: { username: 'creator' } } }),
      );

      const info = await handler.getAccountInfo('tt-token');
      expect(info.id).toBe('oid');
      expect(info.name).toBe('@creator');
    });

    it('falls back to display_name when the username fetch fails (older token, scope not granted)', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          data: { user: { open_id: 'oid', union_id: 'uid', avatar_url: 'http://a/x.jpg', display_name: 'Display Name' } },
        }),
      );
      // username call rejected — pre-analytics token without user.info.profile
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { code: 'scope_not_authorized' } }),
      });

      const info = await handler.getAccountInfo('old-token');
      expect(info.name).toBe('Display Name');
    });
  });

  describe('publishPost', () => {
    it('returns error when no access token', async () => {
      const result = await handler.publishPost(
        makePost({ mediaFiles: [makeVideo()] }),
        makeChannel({ accessToken: '' }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('No access token');
    });

    it('publishes video via PULL_FROM_URL', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          data: { publish_id: 'pub_123' },
          error: { code: 'ok', message: '' },
        }),
      );

      const post = makePost({ mediaFiles: [makeVideo()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(result.processing).toBe(true);
      expect(result.processingId).toBe('pub_123');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.source_info.source).toBe('PULL_FROM_URL');
      expect(body.source_info.video_url).toBe('https://cdn.test/vid.mp4');
    });

    it('sends privacy level from platformSpecific', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          data: { publish_id: 'pub_priv' },
          error: { code: 'ok', message: '' },
        }),
      );

      const post = makePost({
        mediaFiles: [makeVideo()],
        platformSpecific: { tiktok: { privacyLevel: 'PUBLIC_TO_EVERYONE' } },
      });
      await handler.publishPost(post, makeChannel());

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.post_info.privacy_level).toBe('PUBLIC_TO_EVERYONE');
    });

    it('sends disable flags when set', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          data: { publish_id: 'pub_disable' },
          error: { code: 'ok', message: '' },
        }),
      );

      const post = makePost({
        mediaFiles: [makeVideo()],
        platformSpecific: {
          tiktok: {
            disableDuet: true,
            disableStitch: true,
            disableComment: true,
          },
        },
      });
      await handler.publishPost(post, makeChannel());

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.post_info.disable_duet).toBe(true);
      expect(body.post_info.disable_stitch).toBe(true);
      expect(body.post_info.disable_comment).toBe(true);
    });

    it('sends content disclosure flags', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          data: { publish_id: 'pub_aigc' },
          error: { code: 'ok', message: '' },
        }),
      );

      const post = makePost({
        mediaFiles: [makeVideo()],
        platformSpecific: { tiktok: { isAigc: true, brandContentToggle: true } },
      });
      await handler.publishPost(post, makeChannel());

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.post_info.is_aigc).toBe(true);
      expect(body.post_info.brand_content_toggle).toBe(true);
    });

    it('returns error when no video file for video post', async () => {
      const post = makePost({ postType: 'video', mediaFiles: [] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('No video file');
    });

    it('publishes photo slideshow', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          data: { publish_id: 'pub_photos' },
          error: { code: 'ok', message: '' },
        }),
      );

      const post = makePost({
        postType: 'photo_slideshow',
        mediaFiles: [makeImage('https://a.jpg'), makeImage('https://b.jpg')],
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.media_type).toBe('PHOTO');
      expect(body.source_info.photo_images).toEqual(['https://a.jpg', 'https://b.jpg']);
    });

    it('returns error when photo slideshow exceeds 35 images', async () => {
      const post = makePost({
        postType: 'photo_slideshow',
        mediaFiles: Array.from({ length: 36 }, (_, i) => makeImage(`https://img${i}.jpg`)),
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('maximum of 35');
    });

    it('handles TikTok API error response', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          data: { publish_id: '' },
          error: { code: 'spam_risk_too_many_pending_share', message: 'Too many pending shares' },
        }),
      );

      const post = makePost({ mediaFiles: [makeVideo()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Too many pending shares');
    });
  });

  describe('64-bit video ids (JSON.parse rounding)', () => {
    // The id from the production report:
    // https://www.tiktok.com/@surah.pk/video/7667872114598333716
    const REAL_ID = '7667872114598333716';
    const ROUNDED_ID = '7667872114598333000';

    it('keeps every digit of a bare-number video id through checkPublishStatus', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchRaw(
          `{"data":{"status":"PUBLISH_COMPLETE","publish_id":"p1","publicaly_available_post_id":[${REAL_ID}]},"error":{"code":"ok","message":""}}`,
        ),
      );

      const result = await handler.checkPublishStatus(makeChannel(), 'p1');

      expect(result.status).toBe('published');
      expect(result.postId).toBe(REAL_ID);
      expect(result.postId).not.toBe(ROUNDED_ID);
      expect(result.url).toBe(`https://www.tiktok.com/@ttuser/video/${REAL_ID}`);
    });

    it('builds a single-@ url when the stored handle already has one', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchRaw(
          `{"data":{"status":"PUBLISH_COMPLETE","publish_id":"p1","publicaly_available_post_id":[${REAL_ID}]},"error":{"code":"ok","message":""}}`,
        ),
      );

      const result = await handler.checkPublishStatus(
        makeChannel({ accountName: '@surah.pk' }),
        'p1',
      );

      expect(result.url).toBe(`https://www.tiktok.com/@surah.pk/video/${REAL_ID}`);
      expect(result.url).not.toContain('@@');
    });

    it('keys getPostMetrics by the exact id so the lookup matches', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchRaw(
          `{"data":{"videos":[{"id":${REAL_ID},"like_count":12,"comment_count":3,"share_count":1,"view_count":900}]},"error":{"code":"ok","message":""}}`,
        ),
      );

      const map = await handler.getPostMetrics(makeChannel(), [REAL_ID]);

      // The whole failure mode was a map keyed by the rounded id while the
      // caller looked up the real one, yielding undefined -> all metrics 0.
      expect(map.has(REAL_ID)).toBe(true);
      expect(map.has(ROUNDED_ID)).toBe(false);
      expect(map.get(REAL_ID)).toMatchObject({
        impressions: 900,
        videoViews: 900,
        likes: 12,
        comments: 3,
        shares: 1,
      });
    });

    it('resolvePublishId returns the exact id, not a rounded one', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchRaw(
          `{"data":{"publicaly_available_post_id":[${REAL_ID}]},"error":{"code":"ok","message":""}}`,
        ),
      );

      const id = await handler.resolvePublishId(makeChannel(), 'v_pub_url~v2-abc');
      expect(id).toBe(REAL_ID);
    });

    it('still accepts an id sent as a JSON string', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchRaw(
          `{"data":{"status":"PUBLISH_COMPLETE","publish_id":"p1","publicaly_available_post_id":["${REAL_ID}"]},"error":{"code":"ok","message":""}}`,
        ),
      );

      const result = await handler.checkPublishStatus(makeChannel(), 'p1');
      expect(result.postId).toBe(REAL_ID);
    });
  });

  describe('checkPublishStatus', () => {
    it('returns published for PUBLISH_COMPLETE', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          data: { status: 'PUBLISH_COMPLETE', publish_id: 'p1', publicaly_available_post_id: ['vid_abc'] },
          error: { code: 'ok', message: '' },
        }),
      );

      const result = await handler.checkPublishStatus(makeChannel(), 'p1');
      expect(result.status).toBe('published');
      expect(result.postId).toBe('vid_abc');
      expect(result.url).toContain('tiktok.com');
    });

    it('returns failed for FAILED status', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          data: { status: 'FAILED', publish_id: 'p2', fail_reason: 'Video too short' },
          error: { code: 'ok', message: '' },
        }),
      );

      const result = await handler.checkPublishStatus(makeChannel(), 'p2');
      expect(result.status).toBe('failed');
    });

    it('marks fail_reason "internal" retryable with a human message', async () => {
      // Regression: TikTok's own transient ingest error was surfaced verbatim
      // ("TikTok processing failed: internal") and terminally failed the post,
      // even though TikTok documents `internal` as retryable. The same media
      // published fine on a later manual retry.
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          data: { status: 'FAILED', publish_id: 'p8', fail_reason: 'internal' },
          error: { code: 'ok', message: '' },
        }),
      );

      const result = await handler.checkPublishStatus(makeChannel(), 'p8');
      expect(result.status).toBe('failed');
      expect(result.retryable).toBe(true);
      expect(result.message).not.toContain('internal');
      expect(result.message).toContain('temporary');
    });

    it('marks a media pull timeout retryable', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          data: { status: 'FAILED', publish_id: 'p9', fail_reason: 'video_pull_failed' },
          error: { code: 'ok', message: '' },
        }),
      );

      const result = await handler.checkPublishStatus(makeChannel(), 'p9');
      expect(result.retryable).toBe(true);
      expect(result.message).toContain('could not download');
    });

    it('keeps content rejections terminal with actionable text', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          data: { status: 'FAILED', publish_id: 'p10', fail_reason: 'file_format_check_failed' },
          error: { code: 'ok', message: '' },
        }),
      );

      const result = await handler.checkPublishStatus(makeChannel(), 'p10');
      expect(result.status).toBe('failed');
      expect(result.retryable).toBe(false);
      expect(result.message).toContain('MP4');
    });

    it('treats an unknown fail_reason as terminal but keeps the raw value', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          data: { status: 'FAILED', publish_id: 'p11', fail_reason: 'brand_new_reason' },
          error: { code: 'ok', message: '' },
        }),
      );

      const result = await handler.checkPublishStatus(makeChannel(), 'p11');
      expect(result.retryable).toBe(false);
      expect(result.message).toContain('brand_new_reason');
    });

    it('returns failed for SEND_TO_USER_INBOX', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          data: { status: 'SEND_TO_USER_INBOX', publish_id: 'p3' },
          error: { code: 'ok', message: '' },
        }),
      );

      const result = await handler.checkPublishStatus(makeChannel(), 'p3');
      expect(result.status).toBe('failed');
      expect(result.message).toContain('inbox');
    });

    it('returns processing for intermediate status', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          data: { status: 'PROCESSING_UPLOAD', publish_id: 'p4' },
          error: { code: 'ok', message: '' },
        }),
      );

      const result = await handler.checkPublishStatus(makeChannel(), 'p4');
      expect(result.status).toBe('processing');
    });

    it('rethrows on a 5xx from the status endpoint so the worker retries', async () => {
      // Regression: TikTok's status/fetch 500'd during a poll and the post was
      // marked terminally failed even though the video had published. A thrown
      // transient error must propagate — the status-check worker owns retries.
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () =>
          JSON.stringify({ error: { code: 'internal_error', message: 'Something went wrong. Please try again later.' } }),
        headers: new Headers(),
      });

      await expect(handler.checkPublishStatus(makeChannel(), 'p5')).rejects.toThrow('500');
    });

    it('rethrows on a network failure so the worker retries', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(handler.checkPublishStatus(makeChannel(), 'p6')).rejects.toThrow('fetch failed');
    });

    it('returns failed (terminal) on a 4xx from the status endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () =>
          JSON.stringify({ error: { code: 'access_token_invalid', message: 'The access token is invalid.' } }),
        headers: new Headers(),
      });

      const result = await handler.checkPublishStatus(makeChannel(), 'p7');
      expect(result.status).toBe('failed');
      expect(result.message).toContain('401');
    });
  });

  describe('describeTikTokFailure', () => {
    // Exactly the reasons TikTok documents as transient:
    // https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
    it.each(['internal', 'video_pull_failed', 'photo_pull_failed'])(
      'treats %s as retryable',
      (reason) => {
        expect(describeTikTokFailure(reason).retryable).toBe(true);
      },
    );

    it.each([
      'file_format_check_failed',
      'duration_check_failed',
      'frame_rate_check_failed',
      'picture_size_check_failed',
      'publish_cancelled',
      'auth_removed',
      'spam_risk',
      'spam_risk_text',
      'spam_risk_too_many_posts',
      'spam_risk_user_banned_from_posting',
    ])('treats %s as terminal', (reason) => {
      expect(describeTikTokFailure(reason).retryable).toBe(false);
    });

    it('never leaks a raw snake_case reason as the whole message', () => {
      // The user-facing text is what lands in the failure email.
      const { message } = describeTikTokFailure('spam_risk_text');
      expect(message).not.toBe('spam_risk_text');
      expect(message).toMatch(/^[A-Z]/);
      expect(message).toMatch(/\.$/);
    });

    it('handles a missing fail_reason', () => {
      const { message, retryable } = describeTikTokFailure(undefined);
      expect(retryable).toBe(false);
      expect(message).toContain('unknown reason');
    });
  });

  describe('getCreatorInfo', () => {
    it('queries creator_info and maps the response', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchJson({
        data: {
          creator_nickname: 'Test Creator',
          creator_avatar_url: 'https://cdn.test/avatar.jpg',
          creator_username: 'testcreator',
          privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
          comment_disabled: false,
          duet_disabled: true,
          stitch_disabled: false,
          max_video_post_duration_sec: 600,
        },
        error: { code: 'ok', message: '' },
      }));

      const info = await handler.getCreatorInfo('tt-access-token');

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain('/post/publish/creator_info/query/');
      expect((init as RequestInit).method).toBe('POST');
      expect(info).toEqual({
        nickname: 'Test Creator',
        avatarUrl: 'https://cdn.test/avatar.jpg',
        privacyLevelOptions: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
        commentDisabled: false,
        duetDisabled: true,
        stitchDisabled: false,
        maxVideoPostDurationSec: 600,
      });
    });

    it('surfaces the try-again-later message when the posting limit is reached', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchJson({
        data: {},
        error: { code: 'spam_risk_too_many_posts', message: 'daily post cap' },
      }));

      await expect(handler.getCreatorInfo('tt-access-token')).rejects.toThrow(
        /not accepting new posts.*try again later/i,
      );
    });
  });

  describe('refreshToken', () => {
    it('refreshes token successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            open_id: 'openid_1',
            access_token: 'new_access',
            refresh_token: 'new_refresh',
            expires_in: 86400,
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
        text: async () => JSON.stringify({ error: 'invalid_token' }),
      });

      const result = await handler.refreshToken('bad_token');
      expect(result).toBeNull();
    });
  });

  describe('getPostMetrics', () => {
    it('returns empty map for no post IDs', async () => {
      const result = await handler.getPostMetrics(makeChannel(), []);
      expect(result.size).toBe(0);
    });

    it('fetches video metrics', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: {
              videos: [
                {
                  id: '70000000001',
                  view_count: 5000,
                  like_count: 200,
                  comment_count: 30,
                  share_count: 15,
                },
              ],
            },
            error: { code: 'ok' },
          }),
      });

      const result = await handler.getPostMetrics(makeChannel(), ['70000000001']);
      expect(result.size).toBe(1);
      const m = result.get('70000000001')!;
      expect(m.videoViews).toBe(5000);
      expect(m.likes).toBe(200);
      expect(m.comments).toBe(30);
      expect(m.shares).toBe(15);
    });
  });

  describe('resolvePublishId', () => {
    it('resolves a publish_id to the public numeric video id via status/fetch', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['70000000123'] },
          error: { code: 'ok', message: '' },
        }),
      );

      const videoId = await handler.resolvePublishId(makeChannel(), 'v_pub_url~v2-1.999');
      expect(videoId).toBe('70000000123');

      const calledUrl = mockFetch.mock.calls[0][0];
      expect(calledUrl).toContain('/post/publish/status/fetch/');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.publish_id).toBe('v_pub_url~v2-1.999');
    });

    it('returns null when no public id is available yet (e.g. private post)', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          data: { status: 'PUBLISH_COMPLETE' },
          error: { code: 'ok', message: '' },
        }),
      );

      const videoId = await handler.resolvePublishId(makeChannel(), 'v_pub_url~v2-1.999');
      expect(videoId).toBeNull();
    });

    it('returns null on API error (e.g. expired publish_id)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { code: 'access_token_invalid' } }),
      });

      const videoId = await handler.resolvePublishId(makeChannel(), 'v_pub_url~v2-1.999');
      expect(videoId).toBeNull();
    });

    it('returns null (no API call) when the channel has no access token', async () => {
      const videoId = await handler.resolvePublishId(makeChannel({ accessToken: '' }), 'v_pub_url~v2-1.999');
      expect(videoId).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
