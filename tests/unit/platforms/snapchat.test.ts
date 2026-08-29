/**
 * Tests for the Snapchat platform handler (Public Profile API).
 *
 * Covers:
 *   - config (name / post types / media rules)
 *   - getOAuthUrl: authorize URL, snapchat-profile-api scope, missing-cred throw
 *   - exchangeCodeForToken / refreshToken: token parsing, refresh-token carry-over
 *   - getAccountInfo: my_profile parsing (both wrapper shapes) + no-profile error
 *   - publishPost: exactly-one-media enforcement, spotlight video-only and
 *     duration gates, the encrypt→container→ADD→FINALIZE upload flow, story /
 *     saved story / spotlight request bodies, title and description truncation,
 *     and error mapping (auth-expired, rate limit)
 *   - getPostMetrics: snap→spotlight fallback and metric-name mapping
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

vi.mock('node:fs/promises', () => ({
  default: { readFile: vi.fn().mockResolvedValue(Buffer.from('fake-bytes')) },
  readFile: vi.fn().mockResolvedValue(Buffer.from('fake-bytes')),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { SnapchatHandler } = await import('@/lib/platforms/snapchat');
import type { PostData, ChannelData, MediaFileData } from '@/lib/platforms/types';

export {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(overrides: Partial<ChannelData> = {}): ChannelData {
  return {
    id: 1,
    platform: 'snapchat',
    accountId: 'profile-uuid-1',
    accountName: 'My Profile',
    accessToken: 'snap-access-token',
    metadata: {},
    ...overrides,
  };
}

function makePost(overrides: Partial<PostData> = {}): PostData {
  return {
    content: 'Hello Snapchat!',
    mediaUrls: [],
    mediaFiles: [],
    ...overrides,
  };
}

function makeVideo(overrides: Partial<MediaFileData> = {}): MediaFileData {
  return {
    url: 'https://cdn.example.com/a.mp4',
    localPath: '/tmp/a.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 1234,
    duration: 12,
    ...overrides,
  };
}

function makeImage(overrides: Partial<MediaFileData> = {}): MediaFileData {
  return {
    url: 'https://cdn.example.com/a.jpg',
    localPath: '/tmp/a.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1234,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

const CONTAINER_OK = {
  media: [
    {
      media: {
        id: 'media-123',
        add_path: '/us/v1/media/media-123/multipart-upload-v2?action=ADD',
        finalize_path: '/us/v1/media/media-123/multipart-upload-v2?action=FINALIZE',
      },
    },
  ],
};

/** Queue the container + ADD + FINALIZE responses, then the create response. */
function queueUploadFlow(createResponse: unknown) {
  mockFetch
    .mockResolvedValueOnce(jsonResponse(CONTAINER_OK)) // media container
    .mockResolvedValueOnce(jsonResponse({}))           // ADD
    .mockResolvedValueOnce(jsonResponse({}))           // FINALIZE
    .mockResolvedValueOnce(jsonResponse(createResponse));
}

function requestBodyOfCall(index: number): any {
  return JSON.parse(mockFetch.mock.calls[index][1].body);
}

beforeEach(() => {
  mockFetch.mockReset();
  process.env.SNAPCHAT_CLIENT_ID = 'client-id';
  process.env.SNAPCHAT_CLIENT_SECRET = 'client-secret';
});

// ---------------------------------------------------------------------------

describe('SnapchatHandler config', () => {
  it('declares the platform identity', () => {
    const { config } = new SnapchatHandler();
    expect(config.name).toBe('snapchat');
    expect(config.displayName).toBe('Snapchat');
    expect(config.authType).toBe('oauth');
  });

  it('offers story, saved_story and spotlight — spotlight video-only', () => {
    const { config } = new SnapchatHandler();
    const values = config.postTypes.map((t) => t.value);
    expect(values).toEqual(['story', 'saved_story', 'spotlight']);
    const spotlight = config.postTypes.find((t) => t.value === 'spotlight')!;
    expect(spotlight.allowedMediaTypes).toEqual(['video']);
    for (const t of config.postTypes) {
      expect(t.maxMedia).toBe(1);
      expect(t.mediaRequired).toBe(true);
    }
  });
});

describe('SnapchatHandler OAuth', () => {
  it('builds the accounts.snapchat.com authorize URL with the profile scope', async () => {
    const url = await new SnapchatHandler().getOAuthUrl('https://app.test/cb', 'state123');
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://accounts.snapchat.com/login/oauth2/authorize',
    );
    expect(parsed.searchParams.get('scope')).toBe('snapchat-profile-api');
    expect(parsed.searchParams.get('client_id')).toBe('client-id');
    expect(parsed.searchParams.get('state')).toBe('state123');
    expect(parsed.searchParams.get('response_type')).toBe('code');
  });

  it('throws when SNAPCHAT_CLIENT_ID is missing', async () => {
    delete process.env.SNAPCHAT_CLIENT_ID;
    await expect(
      new SnapchatHandler().getOAuthUrl('https://app.test/cb', 's'),
    ).rejects.toThrow('SNAPCHAT_CLIENT_ID not configured');
  });

  it('exchanges the code and parses the token response', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    );
    const token = await new SnapchatHandler().exchangeCodeForToken('code1', 'https://app.test/cb');
    expect(token).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://accounts.snapchat.com/login/oauth2/access_token');
    const body = new URLSearchParams(init.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('code1');
  });

  it('throws (not undefined-interpolation) when the token response has no access_token', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ something_else: true }));
    await expect(
      new SnapchatHandler().exchangeCodeForToken('code1', 'https://app.test/cb'),
    ).rejects.toThrow(/access_token/);
  });

  it('keeps the old refresh token when the refresh response omits one', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ access_token: 'at2', expires_in: 3600 }));
    const token = await new SnapchatHandler().refreshToken('old-rt');
    expect(token).toEqual({ accessToken: 'at2', refreshToken: 'old-rt', expiresIn: 3600 });
  });

  it('returns null (never throws) when refresh fails', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, 400));
    const token = await new SnapchatHandler().refreshToken('dead-rt');
    expect(token).toBeNull();
  });
});

describe('SnapchatHandler getAccountInfo', () => {
  it('parses the my_profile wrapper shape', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        public_profiles: [
          {
            public_profile: {
              id: 'profile-uuid-1',
              display_name: 'BulkPublish',
              snap_user_name: 'bulkpublish',
              logo_urls: { '64': 'https://img.snap/64.png' },
            },
          },
        ],
      }),
    );
    const info = await new SnapchatHandler().getAccountInfo('at');
    expect(info.id).toBe('profile-uuid-1');
    expect(info.name).toBe('BulkPublish');
    expect(info.profileImage).toBe('https://img.snap/64.png');
    expect(info.accountType).toBe('public_profile');
  });

  it('explains a 403 as a client-id allowlist problem (empty body, like prod)', async () => {
    // Snap's businessapi 403s with NO body when the OAuth client id isn't
    // allowlisted — this must surface the allowlist explanation, not the old
    // "Non-JSON response from snapchat: " (seen in prod 2026-08-19).
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: { get: () => null },
      text: async () => '',
    });
    await expect(new SnapchatHandler().getAccountInfo('at')).rejects.toThrow(
      /allowlists the OAuth client id/i,
    );
  });

  it('errors clearly when the account has no public profile', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ public_profiles: [] }));
    await expect(new SnapchatHandler().getAccountInfo('at')).rejects.toThrow(
      /no Snapchat public profile/i,
    );
  });
});

describe('SnapchatHandler publishPost', () => {
  it('rejects a post with no media before any API call', async () => {
    const result = await new SnapchatHandler().publishPost(makePost(), makeChannel());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exactly one/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a post with two media files', async () => {
    const result = await new SnapchatHandler().publishPost(
      makePost({ mediaFiles: [makeImage(), makeImage()] }),
      makeChannel(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/only one media/i);
  });

  it('rejects an image Spotlight before any API call', async () => {
    const result = await new SnapchatHandler().publishPost(
      makePost({ postType: 'spotlight', mediaFiles: [makeImage()] }),
      makeChannel(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/requires a video/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a Spotlight video shorter than 6 seconds', async () => {
    const result = await new SnapchatHandler().publishPost(
      makePost({ postType: 'spotlight', mediaFiles: [makeVideo({ duration: 5 })] }),
      makeChannel(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/6–60 seconds/);
  });

  it('rejects a story video longer than 60 seconds', async () => {
    const result = await new SnapchatHandler().publishPost(
      makePost({ postType: 'story', mediaFiles: [makeVideo({ duration: 61 })] }),
      makeChannel(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/5–60 seconds/);
  });

  it('runs the container → ADD → FINALIZE → stories flow with encrypted bytes', async () => {
    queueUploadFlow({ snap_id: 'snap-1' });

    const result = await new SnapchatHandler().publishPost(
      makePost({ postType: 'story', mediaFiles: [makeVideo()] }),
      makeChannel(),
    );
    expect(result).toMatchObject({ success: true, postId: 'snap-1' });
    expect(mockFetch).toHaveBeenCalledTimes(4);

    // 1. container declares VIDEO plus a base64 AES key and IV
    const [containerUrl, containerInit] = mockFetch.mock.calls[0];
    expect(containerUrl).toBe(
      'https://businessapi.snapchat.com/v1/public_profiles/profile-uuid-1/media',
    );
    const containerBody = JSON.parse(containerInit.body);
    expect(containerBody.type).toBe('VIDEO');
    expect(Buffer.from(containerBody.key, 'base64')).toHaveLength(32);
    expect(Buffer.from(containerBody.iv, 'base64')).toHaveLength(16);

    // 2/3. ADD then FINALIZE, against the paths the container returned
    const addCall = mockFetch.mock.calls[1];
    expect(addCall[0]).toBe(
      'https://businessapi.snapchat.com/us/v1/media/media-123/multipart-upload-v2?action=ADD',
    );
    const addForm: FormData = addCall[1].body;
    expect(addForm.get('action')).toBe('ADD');
    expect(addForm.get('part_number')).toBe('1');
    // The uploaded chunk is AES-encrypted: same 16-byte block multiple, never the raw bytes.
    const uploaded = Buffer.from(await (addForm.get('file') as Blob).arrayBuffer());
    expect(uploaded.length % 16).toBe(0);
    expect(uploaded.equals(Buffer.from('fake-bytes'))).toBe(false);

    const finalizeForm: FormData = mockFetch.mock.calls[2][1].body;
    expect(finalizeForm.get('action')).toBe('FINALIZE');

    // 4. story create references the media container
    const [storyUrl, storyInit] = mockFetch.mock.calls[3];
    expect(storyUrl).toBe(
      'https://businessapi.snapchat.com/v1/public_profiles/profile-uuid-1/stories',
    );
    expect(JSON.parse(storyInit.body)).toEqual({ media_id: 'media-123' });
  });

  it('posts an image story with an IMAGE container', async () => {
    queueUploadFlow({ snap_id: 'snap-2' });
    const result = await new SnapchatHandler().publishPost(
      makePost({ mediaFiles: [makeImage()] }),
      makeChannel(),
    );
    expect(result.success).toBe(true);
    expect(requestBodyOfCall(0).type).toBe('IMAGE');
  });

  it('creates a saved story with a 45-char title from settings', async () => {
    queueUploadFlow({ saved_story_id: 'ss-1' });
    const longTitle = 'T'.repeat(60);
    const result = await new SnapchatHandler().publishPost(
      makePost({
        postType: 'saved_story',
        mediaFiles: [makeImage()],
        platformSpecific: { 1: { title: longTitle } },
      }),
      makeChannel(),
    );
    expect(result).toMatchObject({ success: true, postId: 'ss-1' });
    const body = requestBodyOfCall(3);
    expect(body.saved_stories).toHaveLength(1);
    expect(body.saved_stories[0].title).toBe('T'.repeat(45));
    expect(body.saved_stories[0].snap_sources).toEqual([{ media_id: 'media-123' }]);
  });

  it('falls back to the first content line for the saved story title', async () => {
    queueUploadFlow({ saved_story_id: 'ss-2' });
    await new SnapchatHandler().publishPost(
      makePost({
        postType: 'saved_story',
        content: 'My trip highlights\nSecond line ignored',
        mediaFiles: [makeImage()],
      }),
      makeChannel(),
    );
    expect(requestBodyOfCall(3).saved_stories[0].title).toBe('My trip highlights');
  });

  it('creates a spotlight with a truncated description, locale, and skip flag', async () => {
    queueUploadFlow({ spotlight_id: 'sp-1' });
    const result = await new SnapchatHandler().publishPost(
      makePost({
        postType: 'spotlight',
        content: 'x'.repeat(300),
        mediaFiles: [makeVideo({ duration: 30 })],
        platformSpecific: { 1: { locale: 'de_DE', saveToProfile: false } },
      }),
      makeChannel(),
    );
    expect(result).toMatchObject({ success: true, postId: 'sp-1' });
    const body = requestBodyOfCall(3);
    expect(body.media_id).toBe('media-123');
    expect(body.locale).toBe('de_DE');
    expect(body.description).toBe('x'.repeat(160));
    expect(body.skip_save_to_profile).toBe(true);
  });

  it('defaults the spotlight locale to en_US', async () => {
    queueUploadFlow({ spotlight_id: 'sp-2' });
    await new SnapchatHandler().publishPost(
      makePost({ postType: 'spotlight', mediaFiles: [makeVideo({ duration: 30 })] }),
      makeChannel(),
    );
    const body = requestBodyOfCall(3);
    expect(body.locale).toBe('en_US');
    expect(body.skip_save_to_profile).toBeUndefined();
  });

  it('maps a 401 to authExpired with a reconnect message', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401));
    const result = await new SnapchatHandler().publishPost(
      makePost({ mediaFiles: [makeImage()] }),
      makeChannel(),
    );
    expect(result.success).toBe(false);
    expect(result.authExpired).toBe(true);
    expect(result.error).toMatch(/reconnect/i);
  });

  it('maps a 429 to a retry message without authExpired', async () => {
    // fetchJson retries 429s in-band; exhaust all 3 attempts.
    mockFetch.mockResolvedValue(jsonResponse({ error: 'rate limited' }, 429));
    const result = await new SnapchatHandler().publishPost(
      makePost({ mediaFiles: [makeImage()] }),
      makeChannel(),
    );
    expect(result.success).toBe(false);
    expect(result.authExpired).toBeFalsy();
    expect(result.error).toMatch(/rate limit/i);
  }, 15000);

  it('waits and retries the create while Snap is still processing the media', async () => {
    vi.useFakeTimers();
    try {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(CONTAINER_OK)) // media container
        .mockResolvedValueOnce(jsonResponse({}))           // ADD
        .mockResolvedValueOnce(jsonResponse({}))           // FINALIZE
        .mockResolvedValueOnce(jsonResponse({ error: 'Media is still being processed' }, 400))
        .mockResolvedValueOnce(jsonResponse({ snap_id: 'snap-9' }));
      const promise = new SnapchatHandler().publishPost(
        makePost({ mediaFiles: [makeImage()] }),
        makeChannel(),
      );
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result).toMatchObject({ success: true, postId: 'snap-9' });
      // Container + ADD + FINALIZE + failed create + retried create = 5 calls,
      // i.e. the media was NOT re-uploaded.
      expect(mockFetch).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces the transient processing message once the in-handler waits run out', async () => {
    vi.useFakeTimers();
    try {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(CONTAINER_OK))
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse({}))
        // Every create attempt keeps failing with the transcode error.
        .mockResolvedValue(jsonResponse({ error: 'Media is still being processed' }, 400));
      const promise = new SnapchatHandler().publishPost(
        makePost({ mediaFiles: [makeImage()] }),
        makeChannel(),
      );
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.authExpired).toBeFalsy();
      expect(result.error).toBe('Snapchat is still processing the media. Try again shortly.');
      // 4 create attempts total (initial + 3 waits) after the 3 upload calls.
      expect(mockFetch).toHaveBeenCalledTimes(7);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SnapchatHandler getPostMetrics', () => {
  it('maps snap stats metric names onto normalized fields', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        timeseries_stats: [
          { stats: { VIEWS: 100, VIEWERS: 80, SHARES: 5, REPLIES: 3, FAVORITES: 7, SWIPE_UPS: 2, SCREENSHOTS: 1 } },
        ],
      }),
    );
    const metrics = await new SnapchatHandler().getPostMetrics(makeChannel(), ['snap-1']);
    expect(metrics.get('snap-1')).toMatchObject({
      impressions: 100,
      videoViews: 100,
      reach: 80,
      shares: 5,
      comments: 3,
      likes: 7,
      clicks: 2,
    });
    expect(metrics.get('snap-1')!.extra).toMatchObject({ SCREENSHOTS: 1 });
  });

  it('falls back to the spotlight stats endpoint when snap stats 404s', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ error: 'not found' }, 404))
      .mockResolvedValueOnce(jsonResponse({ stats: { VIEWS: 42 } }));
    const metrics = await new SnapchatHandler().getPostMetrics(makeChannel(), ['sp-1']);
    expect(metrics.get('sp-1')).toMatchObject({ impressions: 42 });
    expect(mockFetch.mock.calls[1][0]).toBe(
      'https://businessapi.snapchat.com/v1/public_profiles/profile-uuid-1/spotlights/sp-1/stats',
    );
  });

  it('returns an empty map when every endpoint fails', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'nope' }, 404));
    const metrics = await new SnapchatHandler().getPostMetrics(makeChannel(), ['x']);
    expect(metrics.size).toBe(0);
  });

  it('rethrows on 401 so the sync worker flags the channel instead of recording silence', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401));
    await expect(new SnapchatHandler().getPostMetrics(makeChannel(), ['snap-1', 'snap-2']))
      .rejects.toThrow(/401/);
  });

  it('returns partial results on 429 instead of hammering the remaining ids', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ stats: { VIEWS: 10 } })) // snap-1 first endpoint
      .mockResolvedValue(jsonResponse({ error: 'rate limited' }, 429)); // snap-2 (incl. fetchJson's internal retries)
    const metrics = await new SnapchatHandler().getPostMetrics(makeChannel(), ['snap-1', 'snap-2', 'snap-3']);
    expect(metrics.size).toBe(1);
    expect(metrics.get('snap-1')).toMatchObject({ impressions: 10 });
    // Once rate-limited, snap-2's fallback endpoints and all of snap-3 are skipped.
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('snap-3'))).toBe(false);
    expect(urls.some((u) => u.includes('spotlights'))).toBe(false);
    // fetchJson's internal 429 backoff sleeps for real in this test.
  }, 20000);

  it('still falls through to the next endpoint on a non-404 server error', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 400))
      .mockResolvedValueOnce(jsonResponse({ stats: { VIEWS: 7 } }));
    const metrics = await new SnapchatHandler().getPostMetrics(makeChannel(), ['sp-9']);
    expect(metrics.get('sp-9')).toMatchObject({ impressions: 7 });
  });
});
