/**
 * TikTok content control tests.
 *
 * Verifies that TikTok publish payloads include the correct content
 * interaction controls (duet/stitch/comment), AI disclosure, brand
 * content flags, and privacy level from platformSpecific.tiktok.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

function mockFetchJsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
  };
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const { TikTokHandler } = await import('@/lib/platforms/tiktok');

import type { ChannelData, PostData } from '@/lib/platforms/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(): ChannelData {
  return {
    id: 1,
    platform: 'tiktok',
    accountId: 'tiktok-user-123',
    accountName: 'testuser',
    accessToken: 'test-access-token',
  };
}

function makeVideoPost(platformSpecific?: Record<string, unknown>): PostData {
  return {
    content: 'Test TikTok video',
    mediaUrls: ['https://example.com/video.mp4'],
    mediaFiles: [
      {
        url: 'https://example.com/video.mp4',
        localPath: '/tmp/video.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 5000000,
      },
    ],
    postType: 'video',
    platformSpecific,
  };
}

function makePhotoPost(platformSpecific?: Record<string, unknown>): PostData {
  return {
    content: 'Test TikTok slideshow',
    mediaUrls: ['https://example.com/img1.jpg'],
    mediaFiles: [
      {
        url: 'https://example.com/img1.jpg',
        localPath: '/tmp/img1.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 500000,
      },
    ],
    postType: 'photo_slideshow',
    platformSpecific,
  };
}

function getLastPublishPayload(): Record<string, unknown> {
  const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
  const opts = lastCall[1];
  return JSON.parse(opts.body);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TikTok content controls', () => {
  beforeEach(() => {
    process.env.TIKTOK_CLIENT_KEY = 'test-key';
    process.env.TIKTOK_CLIENT_SECRET = 'test-secret';
  });

  afterEach(() => mockFetch.mockReset());

  const handler = new TikTokHandler();
  const channel = makeChannel();

  it('defaults privacy to PUBLIC_TO_EVERYONE when no options set', async () => {
    // API/MCP/bulk-created posts without explicit privacy default to Public, matching the
    // composer. Private (SELF_ONLY) posts get no public URL and no per-post analytics.
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: { publish_id: 'pub-1' },
        error: { code: 'ok', message: '' },
      }),
    );

    await handler.publishPost(makeVideoPost(), channel);

    const payload = getLastPublishPayload();
    expect(payload.post_info).toBeDefined();
    expect((payload.post_info as any).privacy_level).toBe('PUBLIC_TO_EVERYONE');
  });

  it('passes privacy level from platformSpecific.tiktok', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: { publish_id: 'pub-2' },
        error: { code: 'ok', message: '' },
      }),
    );

    const post = makeVideoPost({
      tiktok: { privacyLevel: 'PUBLIC_TO_EVERYONE' },
    });
    await handler.publishPost(post, channel);

    const payload = getLastPublishPayload();
    expect((payload.post_info as any).privacy_level).toBe('PUBLIC_TO_EVERYONE');
  });

  it('includes disable_duet flag when set', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: { publish_id: 'pub-3' },
        error: { code: 'ok', message: '' },
      }),
    );

    const post = makeVideoPost({
      tiktok: { disableDuet: true },
    });
    await handler.publishPost(post, channel);

    const payload = getLastPublishPayload();
    expect((payload.post_info as any).disable_duet).toBe(true);
  });

  it('includes disable_stitch flag when set', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: { publish_id: 'pub-4' },
        error: { code: 'ok', message: '' },
      }),
    );

    const post = makeVideoPost({
      tiktok: { disableStitch: true },
    });
    await handler.publishPost(post, channel);

    const payload = getLastPublishPayload();
    expect((payload.post_info as any).disable_stitch).toBe(true);
  });

  it('includes disable_comment flag when set', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: { publish_id: 'pub-5' },
        error: { code: 'ok', message: '' },
      }),
    );

    const post = makeVideoPost({
      tiktok: { disableComment: true },
    });
    await handler.publishPost(post, channel);

    const payload = getLastPublishPayload();
    expect((payload.post_info as any).disable_comment).toBe(true);
  });

  it('includes is_aigc flag for AI-generated content', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: { publish_id: 'pub-6' },
        error: { code: 'ok', message: '' },
      }),
    );

    const post = makeVideoPost({
      tiktok: { isAigc: true },
    });
    await handler.publishPost(post, channel);

    const payload = getLastPublishPayload();
    expect((payload.post_info as any).is_aigc).toBe(true);
  });

  it('includes brand content flags', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: { publish_id: 'pub-7' },
        error: { code: 'ok', message: '' },
      }),
    );

    const post = makeVideoPost({
      tiktok: { brandContentToggle: true, brandOrganicToggle: true },
    });
    await handler.publishPost(post, channel);

    const payload = getLastPublishPayload();
    expect((payload.post_info as any).brand_content_toggle).toBe(true);
    expect((payload.post_info as any).brand_organic_toggle).toBe(true);
  });

  it('passes all controls together for video', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: { publish_id: 'pub-all' },
        error: { code: 'ok', message: '' },
      }),
    );

    const post = makeVideoPost({
      tiktok: {
        privacyLevel: 'FOLLOWER_OF_CREATOR',
        disableDuet: true,
        disableStitch: true,
        disableComment: true,
        isAigc: true,
        brandContentToggle: true,
        brandOrganicToggle: false,
      },
    });
    await handler.publishPost(post, channel);

    const payload = getLastPublishPayload();
    const postInfo = payload.post_info as any;
    expect(postInfo.privacy_level).toBe('FOLLOWER_OF_CREATOR');
    expect(postInfo.disable_duet).toBe(true);
    expect(postInfo.disable_stitch).toBe(true);
    expect(postInfo.disable_comment).toBe(true);
    expect(postInfo.is_aigc).toBe(true);
    expect(postInfo.brand_content_toggle).toBe(true);
    // brandOrganicToggle is false, so it should NOT be included
    expect(postInfo.brand_organic_toggle).toBeUndefined();
  });

  it('passes controls to photo slideshow endpoint', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: { publish_id: 'pub-photo' },
        error: { code: 'ok', message: '' },
      }),
    );

    const post = makePhotoPost({
      tiktok: {
        privacyLevel: 'PUBLIC_TO_EVERYONE',
        disableComment: true,
        isAigc: true,
      },
    });
    await handler.publishPost(post, channel);

    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain('/post/publish/content/init/');

    const payload = getLastPublishPayload();
    const postInfo = payload.post_info as any;
    expect(postInfo.privacy_level).toBe('PUBLIC_TO_EVERYONE');
    expect(postInfo.disable_comment).toBe(true);
    expect(postInfo.is_aigc).toBe(true);
    // Music is opt-in — no unexpected background track on photo posts.
    expect(postInfo.auto_add_music).toBeUndefined();
  });

  it('sets auto_add_music on photo posts only when the user opted in', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: { publish_id: 'pub-photo-music' },
        error: { code: 'ok', message: '' },
      }),
    );

    const post = makePhotoPost({
      tiktok: {
        privacyLevel: 'PUBLIC_TO_EVERYONE',
        autoAddMusic: true,
      },
    });
    await handler.publishPost(post, channel);

    const payload = getLastPublishPayload();
    expect((payload.post_info as any).auto_add_music).toBe(true);
  });

  it('does not include false boolean flags in payload', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: { publish_id: 'pub-false' },
        error: { code: 'ok', message: '' },
      }),
    );

    const post = makeVideoPost({
      tiktok: {
        disableDuet: false,
        disableStitch: false,
        disableComment: false,
        isAigc: false,
        brandContentToggle: false,
        brandOrganicToggle: false,
      },
    });
    await handler.publishPost(post, channel);

    const payload = getLastPublishPayload();
    const postInfo = payload.post_info as any;
    // False values should not be present (only true values are set)
    expect(postInfo.disable_duet).toBeUndefined();
    expect(postInfo.disable_stitch).toBeUndefined();
    expect(postInfo.disable_comment).toBeUndefined();
    expect(postInfo.is_aigc).toBeUndefined();
    expect(postInfo.brand_content_toggle).toBeUndefined();
  });

  it('supports legacy privacy_level key for backward compatibility', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: { publish_id: 'pub-legacy' },
        error: { code: 'ok', message: '' },
      }),
    );

    const post = makeVideoPost({
      privacy_level: 'MUTUAL_FOLLOW_FRIENDS',
    });
    await handler.publishPost(post, channel);

    const payload = getLastPublishPayload();
    expect((payload.post_info as any).privacy_level).toBe('MUTUAL_FOLLOW_FRIENDS');
  });
});
