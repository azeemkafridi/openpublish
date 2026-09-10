/**
 * Tests for the Pinterest platform handler.
 *
 * Covers:
 *   - publishPost: image pin, video pin, carousel
 *   - Board ID resolution (platformSpecific, channel metadata, auto-create)
 *   - Title and description extraction
 *   - Dominant color support
 *   - No access token / missing image errors
 *   - Carousel min/max validation
 *   - refreshToken: success and failure
 *   - getPostMetrics: batch endpoint, chunking, summary+lifetime merge,
 *     per-pin fallback when the beta batch endpoint is not granted
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

// Drop the analytics pacing delay; the real 1100ms gap is a rate-limit
// concern, not behaviour under test, and it would add seconds per chunk.
process.env.PINTEREST_ANALYTICS_MIN_INTERVAL_MS = '0';

const { PinterestHandler } = await import('@/lib/platforms/pinterest');
import type { PostData, ChannelData, MediaFileData } from '@/lib/platforms/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(overrides: Partial<ChannelData> = {}): ChannelData {
  return {
    id: 1,
    platform: 'pinterest',
    accountId: 'pin_user',
    accountName: 'pinuser',
    accessToken: 'pin-access-token',
    metadata: { defaultBoardId: 'board_123' },
    ...overrides,
  };
}

function makePost(overrides: Partial<PostData> = {}): PostData {
  return {
    content: 'My awesome pin',
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

describe('PinterestHandler', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new PinterestHandler();

  beforeAll(() => {
    process.env.PINTEREST_APP_ID = 'test-pin-id';
    process.env.PINTEREST_APP_SECRET = 'test-pin-secret';
  });

  describe('config', () => {
    it('has correct platform config', () => {
      expect(handler.config.name).toBe('pinterest');
      expect(handler.config.displayName).toBe('Pinterest');
      expect(handler.config.postTypes).toHaveLength(3);
    });
  });

  describe('publishPost', () => {
    it('returns error when no access token', async () => {
      const result = await handler.publishPost(
        makePost({ mediaFiles: [makeImage()] }),
        makeChannel({ accessToken: '' }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('No access token');
    });

    it('publishes image pin with board from metadata', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ id: 'pin_123' }),
      );

      const post = makePost({
        postType: 'pin',
        mediaFiles: [makeImage()],
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      expect(result.postId).toBe('pin_123');
      expect(result.url).toContain('pinterest.com/pin/pin_123');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.board_id).toBe('board_123');
      expect(body.media_source.source_type).toBe('image_url');
    });

    it('uses boardId from platformSpecific', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchJson({ id: 'pin_ps' }));

      const post = makePost({
        mediaFiles: [makeImage()],
        platformSpecific: { boardId: 'custom_board' },
      });
      const result = await handler.publishPost(post, makeChannel({ metadata: {} }));
      expect(result.success).toBe(true);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.board_id).toBe('custom_board');
    });

    it('sends dominant color when provided', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchJson({ id: 'pin_color' }));

      const post = makePost({
        mediaFiles: [makeImage()],
        platformSpecific: { dominantColor: '#FF5733' },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.dominant_color).toBe('#FF5733');
    });

    it('returns error when no image for pin', async () => {
      const post = makePost({ postType: 'pin', mediaFiles: [], mediaUrls: [] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('requires an image');
    });

    it('returns error for video pin without video', async () => {
      const post = makePost({ postType: 'video_pin', mediaFiles: [], mediaUrls: [] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('requires a video');
    });

    it('publishes carousel with multiple images', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchJson({ id: 'carousel_pin' }));

      const post = makePost({
        postType: 'carousel',
        mediaFiles: [makeImage('https://a.jpg'), makeImage('https://b.jpg'), makeImage('https://c.jpg')],
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // v5 multi-image pin; the old carousel_data_json shape published one image.
      expect(body.carousel_data_json).toBeUndefined();
      expect(body.media_source.source_type).toBe('multiple_image_urls');
      expect(body.media_source.items.map((i: any) => i.url)).toEqual(['https://a.jpg', 'https://b.jpg', 'https://c.jpg']);
    });

    it('returns error for carousel with fewer than 2 images', async () => {
      const post = makePost({
        postType: 'carousel',
        mediaFiles: [makeImage()],
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('at least 2');
    });

    it('returns error for carousel with more than 5 images', async () => {
      const post = makePost({
        postType: 'carousel',
        mediaFiles: Array.from({ length: 6 }, () => makeImage()),
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('up to 5');
    });

    it('auto-creates default board when none available', async () => {
      // getBoards returns empty
      mockFetch.mockResolvedValueOnce(mockFetchJson({ items: [] }));
      // Create board
      mockFetch.mockResolvedValueOnce(mockFetchJson({ id: 'new_board_id' }));
      // Create pin
      mockFetch.mockResolvedValueOnce(mockFetchJson({ id: 'pin_with_new_board' }));

      const post = makePost({ mediaFiles: [makeImage()] });
      const result = await handler.publishPost(
        post,
        makeChannel({ metadata: {} }),
      );
      expect(result.success).toBe(true);
    });

    it('handles API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: 'Invalid board' } }),
      });

      const post = makePost({ mediaFiles: [makeImage()] });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid board');
    });
  });

  describe('video pins (v5 register + upload + poll)', () => {
    it('registers, uploads, polls, then creates the pin with the numeric media_id', async () => {
      mockFetch
        // 1. register media
        .mockResolvedValueOnce(mockFetchJson({ media_id: 'vid_media_1', upload_url: 'https://s3.example/upload', upload_parameters: { key: 'k' } }))
        // 2. fetch the video bytes
        .mockResolvedValueOnce({ ok: true, status: 200, blob: async () => new Blob(['video-bytes']) })
        // 3. upload to S3
        .mockResolvedValueOnce({ ok: true, status: 204, text: async () => '' })
        // 4. poll status -> succeeded
        .mockResolvedValueOnce(mockFetchJson({ status: 'succeeded' }))
        // 5. create the pin
        .mockResolvedValueOnce(mockFetchJson({ id: 'pin_vid_1' }));

      const post = makePost({
        postType: 'video_pin',
        mediaFiles: [makeVideo()],
        platformSpecific: { boardId: 'board_1', coverImageUrl: 'https://cdn.test/cover.jpg' },
      });
      const result = await handler.publishPost(post, makeChannel());

      expect(result.success).toBe(true);
      expect(result.postId).toBe('pin_vid_1');
      // The pin must reference the registered numeric media_id, NOT the raw video URL.
      const createPinBody = JSON.parse(mockFetch.mock.calls[4][1].body);
      expect(createPinBody.media_source.source_type).toBe('video_id');
      expect(createPinBody.media_source.media_id).toBe('vid_media_1');
    });

    it('fails clearly when no cover image can be resolved (no explicit URL, no attached image, no poster)', async () => {
      const post = makePost({
        postType: 'video_pin',
        mediaFiles: [makeVideo()],
        platformSpecific: { boardId: 'board_1' },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/cover image/i);
      // No media was registered.
      expect(mockFetch).not.toHaveBeenCalled();
    });

    const mockVideoUploadFlow = (pinId: string) => {
      mockFetch
        .mockResolvedValueOnce(mockFetchJson({ media_id: 'vid_media_x', upload_url: 'https://s3.example/upload', upload_parameters: {} }))
        .mockResolvedValueOnce({ ok: true, status: 200, blob: async () => new Blob(['bytes']) })
        .mockResolvedValueOnce({ ok: true, status: 204, text: async () => '' })
        .mockResolvedValueOnce(mockFetchJson({ status: 'succeeded' }))
        .mockResolvedValueOnce(mockFetchJson({ id: pinId }));
    };

    it('falls back to the video poster frame when no explicit cover is set', async () => {
      mockVideoUploadFlow('pin_poster_cover');
      const post = makePost({
        postType: 'video_pin',
        mediaFiles: [{ ...makeVideo(), posterUrl: 'https://cdn.test/poster.webp' }],
        platformSpecific: { boardId: 'board_1' },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      const createPinBody = JSON.parse(mockFetch.mock.calls[4][1].body);
      expect(createPinBody.media_source.cover_image_url).toBe('https://cdn.test/poster.webp');
    });

    it('prefers an explicit coverImageUrl over the poster frame', async () => {
      mockVideoUploadFlow('pin_explicit_cover');
      const post = makePost({
        postType: 'video_pin',
        mediaFiles: [{ ...makeVideo(), posterUrl: 'https://cdn.test/poster.webp' }],
        platformSpecific: { boardId: 'board_1', coverImageUrl: '  https://cdn.test/custom-cover.jpg  ' },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      const createPinBody = JSON.parse(mockFetch.mock.calls[4][1].body);
      expect(createPinBody.media_source.cover_image_url).toBe('https://cdn.test/custom-cover.jpg');
    });

    it('uses an attached image as cover before the poster frame', async () => {
      mockVideoUploadFlow('pin_attached_cover');
      const post = makePost({
        postType: 'video_pin',
        mediaFiles: [{ ...makeVideo(), posterUrl: 'https://cdn.test/poster.webp' }, makeImage('https://cdn.test/attached.jpg')],
        platformSpecific: { boardId: 'board_1' },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(true);
      const createPinBody = JSON.parse(mockFetch.mock.calls[4][1].body);
      expect(createPinBody.media_source.cover_image_url).toBe('https://cdn.test/attached.jpg');
    });

    it('fails when Pinterest reports the video processing failed', async () => {
      mockFetch
        .mockResolvedValueOnce(mockFetchJson({ media_id: 'vid_media_2', upload_url: 'https://s3.example/upload', upload_parameters: {} }))
        .mockResolvedValueOnce({ ok: true, status: 200, blob: async () => new Blob(['bytes']) })
        .mockResolvedValueOnce({ ok: true, status: 204, text: async () => '' })
        .mockResolvedValueOnce(mockFetchJson({ status: 'failed' }));

      const post = makePost({
        postType: 'video_pin',
        mediaFiles: [makeVideo()],
        platformSpecific: { boardId: 'board_1', coverImageUrl: 'https://cdn.test/cover.jpg' },
      });
      const result = await handler.publishPost(post, makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/could not process/i);
    });
  });

  describe('refreshToken', () => {
    it('refreshes token successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: 'new_pin_access',
            refresh_token: 'new_pin_refresh',
            expires_in: 86400,
            token_type: 'bearer',
          }),
      });

      const result = await handler.refreshToken('old_refresh');
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe('new_pin_access');
    });

    it('returns null on failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'expired' }),
      });

      const result = await handler.refreshToken('bad');
      expect(result).toBeNull();
    });
  });

  describe('getPostMetrics', () => {
    /** One pin's analytics object, in the shape both endpoints return. */
    function pinAnalytics(
      summary: Record<string, number>,
      lifetime?: Record<string, number>,
    ) {
      return {
        all: {
          summary_metrics: summary,
          ...(lifetime ? { lifetime_metrics: lifetime } : {}),
        },
      };
    }

    function ok(body: unknown) {
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    }

    function err(status: number, message: string) {
      return { ok: false, status, text: async () => JSON.stringify({ code: 3, message }) };
    }

    const RESTRICTED = 'Your application does not have access to this restricted feature.';

    it('reads all pins from one batch request', async () => {
      mockFetch.mockResolvedValueOnce(
        ok({
          pin1: pinAnalytics({
            IMPRESSION: 5000,
            PIN_CLICK: 200,
            OUTBOUND_CLICK: 50,
            SAVE: 30,
            VIDEO_MRC_VIEW: 1000,
          }),
          pin2: pinAnalytics({ IMPRESSION: 7 }),
        }),
      );

      const result = await handler.getPostMetrics(makeChannel(), ['pin1', 'pin2']);

      // One request for two pins — the whole point of the batch endpoint.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/pins/analytics?');
      expect(url).toContain('pin_ids=pin1,pin2');

      const m = result.get('pin1')!;
      expect(m.impressions).toBe(5000);
      expect(m.clicks).toBe(200);
      expect(m.saves).toBe(30);
      expect(m.videoViews).toBe(1000);
      expect(m.extra!.outboundClicks).toBe(50);
      expect(result.get('pin2')!.impressions).toBe(7);
    });

    // The 2026-07-29 zeroing bug: engagement lives in lifetime_metrics while
    // impressions/clicks/saves live in summary_metrics. Reading either alone
    // silently zeroes the other half.
    it('merges summary and lifetime metrics rather than picking one', async () => {
      mockFetch.mockResolvedValueOnce(
        ok({
          pin1: pinAnalytics(
            { IMPRESSION: 50, PIN_CLICK: 1, SAVE: 2, OUTBOUND_CLICK: 3 },
            { TOTAL_REACTIONS: 9, TOTAL_COMMENTS: 4 },
          ),
        }),
      );

      const m = (await handler.getPostMetrics(makeChannel(), ['pin1'])).get('pin1')!;
      expect(m.impressions).toBe(50);
      expect(m.clicks).toBe(1);
      expect(m.saves).toBe(2);
      expect(m.likes).toBe(9);
      expect(m.comments).toBe(4);
    });

    it('splits more than 100 pins across chunked requests', async () => {
      const ids = Array.from({ length: 150 }, (_, i) => `pin${i}`);
      mockFetch
        .mockResolvedValueOnce(ok({ pin0: pinAnalytics({ IMPRESSION: 1 }) }))
        .mockResolvedValueOnce(ok({ pin100: pinAnalytics({ IMPRESSION: 2 }) }));

      const result = await handler.getPostMetrics(makeChannel(), ids);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const first = mockFetch.mock.calls[0][0] as string;
      const second = mockFetch.mock.calls[1][0] as string;
      expect(decodeURIComponent(first).split('pin_ids=')[1].split('&')[0].split(',')).toHaveLength(100);
      expect(decodeURIComponent(second).split('pin_ids=')[1].split('&')[0].split(',')).toHaveLength(50);
      expect(result.get('pin0')!.impressions).toBe(1);
      expect(result.get('pin100')!.impressions).toBe(2);
    });

    // Pinterest omits pins it has no data for; those must not appear as zeros.
    it('skips pins the batch response omits', async () => {
      mockFetch.mockResolvedValueOnce(ok({ pin1: pinAnalytics({ IMPRESSION: 5 }) }));

      const result = await handler.getPostMetrics(makeChannel(), ['pin1', 'pin2']);
      expect(result.has('pin1')).toBe(true);
      expect(result.has('pin2')).toBe(false);
    });

    // The batch endpoint is beta and granted per app. If the grant is absent we
    // must still collect metrics, not lose the account's data.
    it('falls back to per-pin requests when the batch endpoint is restricted', async () => {
      mockFetch
        .mockResolvedValueOnce(err(401, RESTRICTED))
        .mockResolvedValueOnce(ok(pinAnalytics({ IMPRESSION: 11 })))
        .mockResolvedValueOnce(ok(pinAnalytics({ IMPRESSION: 22 })));

      const result = await handler.getPostMetrics(makeChannel(), ['pin1', 'pin2']);

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch.mock.calls[1][0]).toContain('/pins/pin1/analytics?');
      expect(mockFetch.mock.calls[2][0]).toContain('/pins/pin2/analytics?');
      expect(result.get('pin1')!.impressions).toBe(11);
      expect(result.get('pin2')!.impressions).toBe(22);
    });

    // Any first-chunk failure means the endpoint isn't working for this
    // account, not just the documented beta gate.
    it('falls back to per-pin when the first batch chunk fails outright', async () => {
      mockFetch
        .mockResolvedValueOnce(err(500, 'internal error'))
        .mockResolvedValueOnce(err(500, 'internal error'))
        .mockResolvedValueOnce(ok(pinAnalytics({ IMPRESSION: 44 })));

      const result = await handler.getPostMetrics(makeChannel(), ['pin1']);

      expect(mockFetch.mock.calls.at(-1)![0]).toContain('/pins/pin1/analytics?');
      expect(result.get('pin1')!.impressions).toBe(44);
    });

    // A 200 that parses to nothing is how the 2026-07-29 regression zeroed 732
    // rows — treat it as a broken batch path, not as "no data".
    it('falls back to per-pin when the first batch chunk yields no usable metrics', async () => {
      mockFetch
        .mockResolvedValueOnce(ok({ pin1: { unexpected: 'shape' } }))
        .mockResolvedValueOnce(ok(pinAnalytics({ IMPRESSION: 8 })));

      const result = await handler.getPostMetrics(makeChannel(), ['pin1']);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[1][0]).toContain('/pins/pin1/analytics?');
      expect(result.get('pin1')!.impressions).toBe(8);
    });

    // A later chunk is an isolated blip: keep the batch results already
    // collected rather than re-running everything one pin at a time.
    it('keeps earlier chunks when a later chunk fails', async () => {
      const ids = Array.from({ length: 150 }, (_, i) => `pin${i}`);
      mockFetch
        .mockResolvedValueOnce(ok({ pin0: pinAnalytics({ IMPRESSION: 1 }) }))
        .mockResolvedValueOnce(err(500, 'internal error'))
        .mockResolvedValueOnce(err(500, 'internal error'));

      const result = await handler.getPostMetrics(makeChannel(), ids);

      expect(result.get('pin0')!.impressions).toBe(1);
      // No per-pin retry storm for the 149 others.
      expect(mockFetch.mock.calls.every((c) => String(c[0]).includes('/pins/analytics?'))).toBe(true);
    });

    // Video metric names are invalid for image pins, so a mixed chunk can 400.
    it('retries a chunk with the standard metric set when the video set fails', async () => {
      mockFetch
        .mockResolvedValueOnce(err(400, 'invalid metric_types'))
        .mockResolvedValueOnce(ok({ pin1: pinAnalytics({ IMPRESSION: 3 }) }));

      const result = await handler.getPostMetrics(makeChannel(), ['pin1']);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toContain('VIDEO_MRC_VIEW');
      expect(mockFetch.mock.calls[1][0]).not.toContain('VIDEO_MRC_VIEW');
      expect(result.get('pin1')!.impressions).toBe(3);
    });

    it('returns empty map for no post IDs', async () => {
      const result = await handler.getPostMetrics(makeChannel(), []);
      expect(result.size).toBe(0);
    });
  });
});
