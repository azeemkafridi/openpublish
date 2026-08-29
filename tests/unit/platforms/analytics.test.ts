/**
 * Platform analytics (getPostMetrics + getAccountAnalytics) tests.
 *
 * Tests per-post metric fetching for all platforms that implement it:
 *   - Instagram: feed/reel/story metrics with fallback logic
 *   - Threads: views, reach, likes, replies, reposts, quotes + account analytics
 *   - Pinterest: lifetime metrics including video pin metrics
 *   - Facebook: basic + insights (reactions, video views)
 *   - X: batch metrics via public_metrics
 *   - YouTube: batch statistics
 *   - Bluesky: batch via AT Protocol getPosts + account analytics
 *   - Mastodon: per-status metrics + account analytics
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

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockFetchJsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
  };
}

function mockFetchErrorResponse(status: number, data: unknown) {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify(data),
  };
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const { InstagramHandler } = await import('@/lib/platforms/instagram');
const { ThreadsHandler } = await import('@/lib/platforms/threads');
const { PinterestHandler } = await import('@/lib/platforms/pinterest');
const { FacebookHandler } = await import('@/lib/platforms/facebook');
const { XHandler } = await import('@/lib/platforms/x');
const { YouTubeHandler } = await import('@/lib/platforms/youtube');
const { BlueskyHandler } = await import('@/lib/platforms/bluesky');
const { MastodonHandler } = await import('@/lib/platforms/mastodon');
const { TikTokHandler } = await import('@/lib/platforms/tiktok');

import type { ChannelData } from '@/lib/platforms/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(platform: string, overrides?: Partial<ChannelData>): ChannelData {
  return {
    id: 1,
    platform: platform as any,
    accountId: 'test-account-id',
    accountName: 'test-account',
    accessToken: 'test-access-token',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Instagram Analytics
// ---------------------------------------------------------------------------

describe('Instagram getPostMetrics', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new InstagramHandler();
  const channel = makeChannel('instagram');

  it('returns empty map for no post IDs', async () => {
    const result = await handler.getPostMetrics(channel, []);
    expect(result.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns empty map when no access token', async () => {
    const noTokenChannel = makeChannel('instagram', { accessToken: '' });
    const result = await handler.getPostMetrics(noTokenChannel, ['123']);
    expect(result.size).toBe(0);
  });

  it('fetches feed photo/carousel metrics (impressions-based)', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: [
          { name: 'impressions', values: [{ value: 1500 }] },
          { name: 'reach', values: [{ value: 1200 }] },
          { name: 'saved', values: [{ value: 45 }] },
          { name: 'likes', values: [{ value: 200 }] },
          { name: 'comments', values: [{ value: 30 }] },
          { name: 'shares', values: [{ value: 15 }] },
          { name: 'total_interactions', total_value: { value: 290 } },
        ],
      }),
    );

    const result = await handler.getPostMetrics(channel, ['post-123']);
    expect(result.size).toBe(1);

    const metrics = result.get('post-123')!;
    expect(metrics.impressions).toBe(1500);
    expect(metrics.reach).toBe(1200);
    expect(metrics.saves).toBe(45);
    expect(metrics.likes).toBe(200);
    expect(metrics.comments).toBe(30);
    expect(metrics.shares).toBe(15);
    expect(metrics.extra?.totalInteractions).toBe(290);
  });

  it('falls back to reel metrics (views-based) when feed metrics return empty', async () => {
    // First call (feed metrics) returns error → empty
    mockFetch.mockResolvedValueOnce(
      mockFetchErrorResponse(400, { error: { message: 'Invalid metric' } }),
    );
    // Second call (reel metrics) succeeds
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: [
          { name: 'views', values: [{ value: 5000 }] },
          { name: 'reach', values: [{ value: 3000 }] },
          { name: 'plays', values: [{ value: 4500 }] },
          { name: 'likes', values: [{ value: 800 }] },
          { name: 'comments', values: [{ value: 50 }] },
          { name: 'shares', values: [{ value: 120 }] },
        ],
      }),
    );

    const result = await handler.getPostMetrics(channel, ['reel-456']);
    expect(result.size).toBe(1);

    const metrics = result.get('reel-456')!;
    expect(metrics.impressions).toBe(5000); // mapped from 'views'
    expect(metrics.reach).toBe(3000);
    expect(metrics.videoViews).toBe(4500); // mapped from 'plays'
    expect(metrics.likes).toBe(800);
    expect(metrics.comments).toBe(50);
    expect(metrics.shares).toBe(120);
  });

  it('falls back to story metrics when feed and reel both fail', async () => {
    // Feed metrics fail
    mockFetch.mockResolvedValueOnce(
      mockFetchErrorResponse(400, { error: { message: 'Invalid metric' } }),
    );
    // Reel metrics fail
    mockFetch.mockResolvedValueOnce(
      mockFetchErrorResponse(400, { error: { message: 'Invalid metric' } }),
    );
    // Story metrics succeed
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: [
          { name: 'views', values: [{ value: 2000 }] },
          { name: 'reach', values: [{ value: 1800 }] },
          { name: 'replies', values: [{ value: 10 }] },
          { name: 'exits', values: [{ value: 150 }] },
          { name: 'taps_forward', values: [{ value: 300 }] },
          { name: 'taps_back', values: [{ value: 50 }] },
        ],
      }),
    );

    const result = await handler.getPostMetrics(channel, ['story-789']);
    expect(result.size).toBe(1);

    const metrics = result.get('story-789')!;
    expect(metrics.impressions).toBe(2000);
    expect(metrics.reach).toBe(1800);
    expect(metrics.comments).toBe(10); // mapped from 'replies'
    expect(metrics.extra?.exits).toBe(150);
    expect(metrics.extra?.taps_forward).toBe(300);
    expect(metrics.extra?.taps_back).toBe(50);
  });

  it('handles total_value format (Instagram API alternate response)', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: [
          { name: 'impressions', total_value: { value: 999 } },
          { name: 'likes', total_value: { value: 50 } },
        ],
      }),
    );

    const result = await handler.getPostMetrics(channel, ['post-tv']);
    const metrics = result.get('post-tv')!;
    expect(metrics.impressions).toBe(999);
    expect(metrics.likes).toBe(50);
  });

  it('handles multiple posts', async () => {
    // Post 1
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: [{ name: 'impressions', values: [{ value: 100 }] }],
      }),
    );
    // Post 2
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: [{ name: 'impressions', values: [{ value: 200 }] }],
      }),
    );

    const result = await handler.getPostMetrics(channel, ['p1', 'p2']);
    expect(result.size).toBe(2);
    expect(result.get('p1')!.impressions).toBe(100);
    expect(result.get('p2')!.impressions).toBe(200);
  });

  it('gracefully skips posts that fail entirely', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const result = await handler.getPostMetrics(channel, ['fail-post']);
    expect(result.size).toBe(0);
  });

  it('falls back to basic media fields when all insights calls fail with 403', async () => {
    // Insights are attempted across several metric sets (modern feed/reel, legacy
    // feed, modern story, legacy story) — each 403s without instagram_manage_insights.
    for (let i = 0; i < 4; i++) {
      mockFetch.mockResolvedValueOnce(
        mockFetchErrorResponse(403, { error: { message: 'Application does not have permission', code: 10 } }),
      );
    }
    // Basic media fields fallback → succeeds
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({ like_count: 150, comments_count: 25 }),
    );

    const result = await handler.getPostMetrics(channel, ['no-insights-post']);
    expect(result.size).toBe(1);

    const metrics = result.get('no-insights-post')!;
    expect(metrics.likes).toBe(150);
    expect(metrics.comments).toBe(25);
    // No impressions/reach/saves without insights — just basic counts
    expect(metrics.impressions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Threads Analytics
// ---------------------------------------------------------------------------

describe('Threads getPostMetrics', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new ThreadsHandler();
  const channel = makeChannel('threads');

  it('returns empty map for no post IDs', async () => {
    const result = await handler.getPostMetrics(channel, []);
    expect(result.size).toBe(0);
  });

  // `reach` is a USER-level Threads metric, never a media-level one. Requesting
  // it made Meta reject the whole insights call, so Threads posts got no metrics
  // at all — the old version of this test asserted the broken shape because its
  // mock returned a `reach` row the real API never sends.
  it('fetches all media-level Threads metrics, summing reposts and shares', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: [
          { name: 'views', values: [{ value: 3000 }] },
          { name: 'likes', values: [{ value: 150 }] },
          { name: 'replies', values: [{ value: 25 }] },
          { name: 'reposts', values: [{ value: 40 }] },
          { name: 'shares', values: [{ value: 5 }] },
          { name: 'quotes', values: [{ value: 10 }] },
        ],
      }),
    );

    const result = await handler.getPostMetrics(channel, ['thread-1']);
    expect(result.size).toBe(1);

    const metrics = result.get('thread-1')!;
    expect(metrics.impressions).toBe(3000);  // mapped from views
    expect(metrics.reach).toBeUndefined();   // Threads reports no media reach
    expect(metrics.likes).toBe(150);
    expect(metrics.comments).toBe(25);       // mapped from replies
    expect(metrics.shares).toBe(45);         // reposts + off-platform shares
    expect(metrics.extra?.quotes).toBe(10);
  });

  it('handles total_value response format', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: [
          { name: 'views', total_value: { value: 500 } },
          { name: 'likes', total_value: { value: 20 } },
        ],
      }),
    );

    const result = await handler.getPostMetrics(channel, ['t-tv']);
    const m = result.get('t-tv')!;
    expect(m.impressions).toBe(500);
    expect(m.likes).toBe(20);
  });

  it('requests insights with correct URL', async () => {
    mockFetch.mockResolvedValueOnce(mockFetchJsonResponse({ data: [] }));

    await handler.getPostMetrics(channel, ['12345']);

    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain('graph.threads.net/v1.0/12345/insights');
    expect(calledUrl).toContain('metric=views,likes,replies,reposts,quotes,shares');
    // Guard the regression directly: `reach` here rejects the entire call.
    expect(calledUrl).not.toContain('reach');
    expect(calledUrl).toContain('access_token=test-access-token');
  });

  it('gracefully handles API errors', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchErrorResponse(403, { error: { message: 'Permission denied' } }),
    );

    const result = await handler.getPostMetrics(channel, ['no-perm']);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pinterest Analytics
// ---------------------------------------------------------------------------

describe('Pinterest getPostMetrics', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new PinterestHandler();
  const channel = makeChannel('pinterest');

  it('returns empty map for no post IDs', async () => {
    const result = await handler.getPostMetrics(channel, []);
    expect(result.size).toBe(0);
  });

  // Since 2026-07-30 the batch endpoint (GET /pins/analytics) is granted to our
  // app and is the primary path, so responses here are keyed by pin id. The
  // per-pin object nested under each key is byte-identical to what the
  // single-pin endpoint returns — verified live the same day.
  it('fetches image pin lifetime metrics', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        'pin-1': {
          all: {
            summary_metrics: {
              IMPRESSION: 10000,
              PIN_CLICK: 500,
              OUTBOUND_CLICK: 200,
              SAVE: 300,
            },
          },
        },
      }),
    );

    const result = await handler.getPostMetrics(channel, ['pin-1']);
    expect(result.size).toBe(1);

    const metrics = result.get('pin-1')!;
    expect(metrics.impressions).toBe(10000);
    expect(metrics.clicks).toBe(500);
    expect(metrics.saves).toBe(300);
    expect(metrics.extra?.outboundClicks).toBe(200);
    expect(metrics.videoViews).toBeUndefined(); // not a video pin
  });

  it('includes video pin metrics when present', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        'video-pin-1': {
          all: {
            summary_metrics: {
              IMPRESSION: 5000,
              PIN_CLICK: 100,
              OUTBOUND_CLICK: 50,
              SAVE: 80,
              VIDEO_MRC_VIEW: 3000,
              VIDEO_V50_WATCH_TIME: 12000,
            },
          },
        },
      }),
    );

    const result = await handler.getPostMetrics(channel, ['video-pin-1']);
    const metrics = result.get('video-pin-1')!;
    expect(metrics.videoViews).toBe(3000);
    expect(metrics.extra?.videoWatchTime).toBe(12000);
    expect(metrics.impressions).toBe(5000);
  });

  // Pinterest's metric_types enum is a oneOf: a standard set and a video set.
  // Video names are only valid for video pins, so an image pin may reject the
  // video-inclusive list. Prod has 1672 working pin metric rows — losing them
  // to a 400 would be a self-inflicted outage on the largest platform here.
  it('falls back to the standard metric set when the video set is rejected', async () => {
    mockFetch
      .mockResolvedValueOnce(mockFetchErrorResponse(400, { message: 'Invalid pins analytics parameters.' }))
      .mockResolvedValueOnce(
        mockFetchJsonResponse({
          'pin-img': {
            all: { summary_metrics: { IMPRESSION: 500, PIN_CLICK: 12, SAVE: 4, TOTAL_REACTIONS: 9, TOTAL_COMMENTS: 2 } },
          },
        }),
      );

    const result = await handler.getPostMetrics(channel, ['pin-img']);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const second = mockFetch.mock.calls[1][0] as string;
    expect(second).not.toContain('VIDEO_MRC_VIEW');
    expect(second).toContain('metric_types=IMPRESSION,PIN_CLICK,OUTBOUND_CLICK,SAVE,TOTAL_REACTIONS,TOTAL_COMMENTS');

    const m = result.get('pin-img')!;
    expect(m.impressions).toBe(500);
    expect(m.clicks).toBe(12);
    expect(m.saves).toBe(4);
    expect(m.likes).toBe(9);      // TOTAL_REACTIONS — never requested before
    expect(m.comments).toBe(2);   // TOTAL_COMMENTS  — never requested before
  });

  it('prefers lifetime_metrics over summary_metrics when both are present', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        'pin-life': {
          all: {
            lifetime_metrics: { IMPRESSION: 900 },
            summary_metrics: { IMPRESSION: 100 },
          },
        },
      }),
    );

    const result = await handler.getPostMetrics(channel, ['pin-life']);
    expect(result.get('pin-life')!.impressions).toBe(900);
  });

  it('uses 90-day lookback date range', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({ 'pin-date': { all: { summary_metrics: { IMPRESSION: 1 } } } }),
    );

    await handler.getPostMetrics(channel, ['pin-date']);

    const calledUrl = mockFetch.mock.calls[0][0];
    // metric_types is an enum array of concrete metric names; `LIFETIME` is in
    // neither the standard nor the video set, so it could never request
    // TOTAL_REACTIONS / TOTAL_COMMENTS (hence 0 likes and comments on every pin).
    expect(calledUrl).not.toContain('metric_types=LIFETIME');
    expect(calledUrl).toContain('metric_types=IMPRESSION,PIN_CLICK,OUTBOUND_CLICK,SAVE,TOTAL_REACTIONS,TOTAL_COMMENTS,VIDEO_MRC_VIEW,VIDEO_V50_WATCH_TIME');
    expect(calledUrl).toContain('app_types=ALL');
    expect(calledUrl).toContain('split_field=NO_SPLIT');

    // Verify date range start_date is within ~90 days back
    const startDateMatch = calledUrl.match(/start_date=(\d{4}-\d{2}-\d{2})/);
    expect(startDateMatch).not.toBeNull();
    const startDate = new Date(startDateMatch![1]);
    const today = new Date();
    const diffDays = Math.round((today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
    expect(diffDays).toBeGreaterThanOrEqual(88);
    expect(diffDays).toBeLessThanOrEqual(90);
  });

  it('gracefully handles API errors per pin', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchErrorResponse(404, { error: { message: 'Pin not found' } }),
    );

    const result = await handler.getPostMetrics(channel, ['deleted-pin']);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Facebook Analytics
// ---------------------------------------------------------------------------

describe('Facebook getPostMetrics', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new FacebookHandler();
  const channel = makeChannel('facebook');

  it('fetches basic engagement + insights with media views', async () => {
    // Basic engagement call
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        id: 'fb-post-1',
        likes: { summary: { total_count: 50 } },
        comments: { summary: { total_count: 10 } },
        shares: { count: 5 },
      }),
    );
    // Insights call (with read_insights)
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: [
          { name: 'post_total_media_view_unique', values: [{ value: 2000 }] },
          { name: 'post_clicks', values: [{ value: 100 }] },
          {
            name: 'post_reactions_by_type_total',
            values: [{ value: { like: 30, love: 15, wow: 3, haha: 2 } }],
          },
        ],
      }),
    );

    const result = await handler.getPostMetrics(channel, ['fb-post-1']);
    const metrics = result.get('fb-post-1')!;

    expect(metrics.likes).toBe(50);
    expect(metrics.comments).toBe(10);
    expect(metrics.shares).toBe(5);
    expect(metrics.impressions).toBe(2000);
    expect(metrics.reach).toBe(2000); // unique media views serve as both impressions and reach
    expect(metrics.clicks).toBe(100);
    expect(metrics.extra?.like).toBe(30);
    expect(metrics.extra?.love).toBe(15);
    expect(metrics.extra?.wow).toBe(3);
    expect(metrics.extra?.haha).toBe(2);
  });

  it('still returns basic metrics when insights permission is missing', async () => {
    // Basic engagement succeeds
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        id: 'fb-post-2',
        likes: { summary: { total_count: 20 } },
        comments: { summary: { total_count: 3 } },
        shares: { count: 1 },
      }),
    );
    // Insights call fails (no permission)
    mockFetch.mockResolvedValueOnce(
      mockFetchErrorResponse(403, { error: { message: 'Permission denied' } }),
    );

    const result = await handler.getPostMetrics(channel, ['fb-post-2']);
    const metrics = result.get('fb-post-2')!;
    expect(metrics.likes).toBe(20);
    expect(metrics.comments).toBe(3);
    expect(metrics.shares).toBe(1);
    expect(metrics.impressions).toBeUndefined(); // no insights
  });

  it('retries without shares field when Reel returns 400', async () => {
    // First call with shares fails (Reel — shares field not supported)
    mockFetch.mockResolvedValueOnce(
      mockFetchErrorResponse(400, { error: { message: 'Tried accessing nonexisting field (shares)' } }),
    );
    // Retry without shares succeeds
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        id: 'fb-reel-1',
        likes: { summary: { total_count: 75 } },
        comments: { summary: { total_count: 12 } },
      }),
    );
    // Insights call (optional)
    mockFetch.mockResolvedValueOnce(
      mockFetchErrorResponse(403, { error: { message: 'Permission denied' } }),
    );

    const result = await handler.getPostMetrics(channel, ['fb-reel-1']);
    expect(result.size).toBe(1);

    const metrics = result.get('fb-reel-1')!;
    expect(metrics.likes).toBe(75);
    expect(metrics.comments).toBe(12);
    expect(metrics.shares).toBe(0); // no shares field available
  });
});

// ---------------------------------------------------------------------------
// X (Twitter) Analytics
// ---------------------------------------------------------------------------

describe('X getPostMetrics', () => {
  afterEach(() => mockFetch.mockReset());

  process.env.X_CLIENT_ID = 'test';
  process.env.X_CLIENT_SECRET = 'test';
  const handler = new XHandler();
  const channel = makeChannel('x');

  it('fetches tweet public_metrics in batch', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: [
          {
            id: 'tweet-1',
            public_metrics: {
              impression_count: 5000,
              like_count: 100,
              retweet_count: 30,
              reply_count: 15,
              quote_count: 5,
              bookmark_count: 20,
            },
          },
          {
            id: 'tweet-2',
            public_metrics: {
              impression_count: 3000,
              like_count: 50,
              retweet_count: 10,
              reply_count: 5,
              quote_count: 2,
              bookmark_count: 8,
            },
          },
        ],
      }),
    );

    const result = await handler.getPostMetrics(channel, ['tweet-1', 'tweet-2']);
    expect(result.size).toBe(2);

    const m1 = result.get('tweet-1')!;
    expect(m1.impressions).toBe(5000);
    expect(m1.likes).toBe(100);
    expect(m1.shares).toBe(30);
    expect(m1.comments).toBe(15);
    expect(m1.extra?.quotes).toBe(5);
    // bookmark_count is X's save figure — a first-class metric, not extra.
    expect(m1.saves).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// YouTube Analytics
// ---------------------------------------------------------------------------

describe('YouTube getPostMetrics', () => {
  afterEach(() => mockFetch.mockReset());

  process.env.YOUTUBE_CLIENT_ID = 'test';
  process.env.YOUTUBE_CLIENT_SECRET = 'test';
  const handler = new YouTubeHandler();
  const channel = makeChannel('youtube');

  it('fetches video statistics in batch', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        items: [
          {
            id: 'vid-1',
            statistics: {
              viewCount: '10000',
              likeCount: '500',
              commentCount: '100',
              favoriteCount: '50',
            },
          },
        ],
      }),
    );

    const result = await handler.getPostMetrics(channel, ['vid-1']);
    const m = result.get('vid-1')!;
    expect(m.impressions).toBe(10000);
    expect(m.videoViews).toBe(10000);
    expect(m.likes).toBe(500);
    expect(m.comments).toBe(100);
    // favoriteCount is a documented always-0 since 2015 — not stored.
    expect(m.extra?.favorites).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Bluesky Analytics
// ---------------------------------------------------------------------------

describe('Bluesky getPostMetrics', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new BlueskyHandler();
  const channel = makeChannel('bluesky', {
    metadata: { pdsUrl: 'https://bsky.social' },
  });

  it('returns empty map for no post IDs', async () => {
    const result = await handler.getPostMetrics(channel, []);
    expect(result.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns empty map when no access token', async () => {
    const noToken = makeChannel('bluesky', { accessToken: '' });
    const result = await handler.getPostMetrics(noToken, ['at://did:plc:abc/app.bsky.feed.post/123']);
    expect(result.size).toBe(0);
  });

  it('fetches post metrics via AT Protocol getPosts', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        posts: [
          {
            uri: 'at://did:plc:abc/app.bsky.feed.post/1',
            likeCount: 42,
            replyCount: 5,
            repostCount: 10,
            quoteCount: 3,
            // postView carries bookmarkCount — the atproto equivalent of a save.
            bookmarkCount: 7,
          },
          {
            uri: 'at://did:plc:abc/app.bsky.feed.post/2',
            likeCount: 100,
            replyCount: 20,
            repostCount: 30,
            quoteCount: 8,
          },
        ],
      }),
    );

    const uris = [
      'at://did:plc:abc/app.bsky.feed.post/1',
      'at://did:plc:abc/app.bsky.feed.post/2',
    ];
    const result = await handler.getPostMetrics(channel, uris);
    expect(result.size).toBe(2);

    const m1 = result.get(uris[0])!;
    expect(m1.likes).toBe(42);
    expect(m1.comments).toBe(5);
    expect(m1.shares).toBe(10);
    expect(m1.saves).toBe(7);   // bookmarkCount
    expect(m1.extra?.quotes).toBe(3);

    const m2 = result.get(uris[1])!;
    expect(m2.likes).toBe(100);
    expect(m2.comments).toBe(20);
    expect(m2.shares).toBe(30);
    expect(m2.extra?.quotes).toBe(8);
  });

  it('batches URIs in groups of 25', async () => {
    const uris = Array.from({ length: 30 }, (_, i) =>
      `at://did:plc:abc/app.bsky.feed.post/${i}`,
    );

    // Batch 1 (25 URIs)
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        posts: uris.slice(0, 25).map((uri) => ({
          uri,
          likeCount: 1,
          replyCount: 0,
          repostCount: 0,
          quoteCount: 0,
        })),
      }),
    );
    // Batch 2 (5 URIs)
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        posts: uris.slice(25).map((uri) => ({
          uri,
          likeCount: 2,
          replyCount: 0,
          repostCount: 0,
          quoteCount: 0,
        })),
      }),
    );

    const result = await handler.getPostMetrics(channel, uris);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(30);
    expect(result.get(uris[0])!.likes).toBe(1);
    expect(result.get(uris[25])!.likes).toBe(2);
  });

  it('uses correct AT Protocol URL', async () => {
    mockFetch.mockResolvedValueOnce(mockFetchJsonResponse({ posts: [] }));

    const uri = 'at://did:plc:abc/app.bsky.feed.post/test';
    await handler.getPostMetrics(channel, [uri]);

    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain('bsky.social/xrpc/app.bsky.feed.getPosts');
    expect(calledUrl).toContain(encodeURIComponent(uri));
  });

  it('gracefully handles API errors', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchErrorResponse(401, { error: 'AuthenticationRequired' }),
    );

    const result = await handler.getPostMetrics(channel, ['at://did:plc:abc/app.bsky.feed.post/x']);
    expect(result.size).toBe(0);
  });
});

describe('Bluesky getAccountAnalytics', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new BlueskyHandler();
  const channel = makeChannel('bluesky', {
    metadata: { pdsUrl: 'https://bsky.social' },
  });

  it('returns null when no access token', async () => {
    const noToken = makeChannel('bluesky', { accessToken: '' });
    const result = await handler.getAccountAnalytics(noToken);
    expect(result).toBeNull();
  });

  it('fetches follower and following counts', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        followersCount: 1500,
        followsCount: 200,
        postsCount: 500,
      }),
    );

    const result = await handler.getAccountAnalytics(channel);
    expect(result).not.toBeNull();
    expect(result!.followers).toBe(1500);
    expect(result!.following).toBe(200);
    expect(result!.platformSpecific?.postsCount).toBe(500);
  });

  it('uses correct profile URL', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({ followersCount: 0, followsCount: 0 }),
    );

    await handler.getAccountAnalytics(channel);

    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain('app.bsky.actor.getProfile');
    expect(calledUrl).toContain('actor=test-account-id');
  });

  it('returns null on API error', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchErrorResponse(401, { error: 'AuthenticationRequired' }),
    );

    const result = await handler.getAccountAnalytics(channel);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mastodon Analytics
// ---------------------------------------------------------------------------

describe('Mastodon getPostMetrics', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new MastodonHandler();
  const channel = makeChannel('mastodon', {
    metadata: { instanceUrl: 'mastodon.social' },
  });

  it('returns empty map for no post IDs', async () => {
    const result = await handler.getPostMetrics(channel, []);
    expect(result.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns empty map when no access token', async () => {
    const noToken = makeChannel('mastodon', { accessToken: '', metadata: { instanceUrl: 'mastodon.social' } });
    const result = await handler.getPostMetrics(noToken, ['111']);
    expect(result.size).toBe(0);
  });

  it('returns empty map when missing instanceUrl', async () => {
    const noInstance = makeChannel('mastodon', { metadata: {} });
    const result = await handler.getPostMetrics(noInstance, ['111']);
    expect(result.size).toBe(0);
  });

  it('fetches individual status metrics', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        favourites_count: 42,
        reblogs_count: 10,
        replies_count: 5,
      }),
    );

    const result = await handler.getPostMetrics(channel, ['status-1']);
    expect(result.size).toBe(1);

    const m = result.get('status-1')!;
    expect(m.likes).toBe(42);
    expect(m.shares).toBe(10);
    expect(m.comments).toBe(5);
  });

  it('fetches multiple posts individually (no batch)', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({ favourites_count: 10, reblogs_count: 2, replies_count: 1 }),
    );
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({ favourites_count: 20, reblogs_count: 5, replies_count: 3 }),
    );

    const result = await handler.getPostMetrics(channel, ['s1', 's2']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(2);
    expect(result.get('s1')!.likes).toBe(10);
    expect(result.get('s2')!.likes).toBe(20);
  });

  it('uses correct Mastodon API URL', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({ favourites_count: 0, reblogs_count: 0, replies_count: 0 }),
    );

    await handler.getPostMetrics(channel, ['12345']);

    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toBe('https://mastodon.social/api/v1/statuses/12345');
  });

  it('isolates per-post errors (one failure does not block others)', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchErrorResponse(404, { error: 'Record not found' }),
    );
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({ favourites_count: 30, reblogs_count: 8, replies_count: 4 }),
    );

    const result = await handler.getPostMetrics(channel, ['gone', 'alive']);
    expect(result.size).toBe(1);
    expect(result.has('gone')).toBe(false);
    expect(result.get('alive')!.likes).toBe(30);
  });
});

describe('Mastodon getAccountAnalytics', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new MastodonHandler();
  const channel = makeChannel('mastodon', {
    metadata: { instanceUrl: 'mastodon.social' },
  });

  it('returns null when no access token', async () => {
    const noToken = makeChannel('mastodon', { accessToken: '', metadata: { instanceUrl: 'mastodon.social' } });
    const result = await handler.getAccountAnalytics(noToken);
    expect(result).toBeNull();
  });

  it('returns null when missing instanceUrl', async () => {
    const noInstance = makeChannel('mastodon', { metadata: {} });
    const result = await handler.getAccountAnalytics(noInstance);
    expect(result).toBeNull();
  });

  it('fetches account metrics via verify_credentials', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        followers_count: 500,
        following_count: 120,
        statuses_count: 3000,
      }),
    );

    const result = await handler.getAccountAnalytics(channel);
    expect(result).not.toBeNull();
    expect(result!.followers).toBe(500);
    expect(result!.following).toBe(120);
    expect(result!.platformSpecific?.statusesCount).toBe(3000);
  });

  it('returns null on API error', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchErrorResponse(401, { error: 'Unauthorized' }),
    );

    const result = await handler.getAccountAnalytics(channel);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Threads Account Analytics
// ---------------------------------------------------------------------------

describe('Threads getAccountAnalytics', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new ThreadsHandler();
  const channel = makeChannel('threads');

  it('returns null when no access token', async () => {
    const noToken = makeChannel('threads', { accessToken: '' });
    const result = await handler.getAccountAnalytics(noToken);
    expect(result).toBeNull();
  });

  it('fetches account-level insights', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: [
          { name: 'followers_count', total_value: { value: 5000 } },
          { name: 'views', total_value: { value: 25000 } },
          { name: 'likes', total_value: { value: 800 } },
          { name: 'replies', total_value: { value: 120 } },
          { name: 'reposts', total_value: { value: 60 } },
          { name: 'quotes', total_value: { value: 15 } },
        ],
      }),
    );

    const result = await handler.getAccountAnalytics(channel);
    expect(result).not.toBeNull();
    expect(result!.followers).toBe(5000);
    expect(result!.impressions).toBe(25000);
    expect(result!.platformSpecific?.likes).toBe(800);
    expect(result!.platformSpecific?.replies).toBe(120);
    expect(result!.platformSpecific?.reposts).toBe(60);
    expect(result!.platformSpecific?.quotes).toBe(15);
  });

  it('uses correct insights URL with period=day', async () => {
    mockFetch.mockResolvedValueOnce(mockFetchJsonResponse({ data: [] }));

    await handler.getAccountAnalytics(channel);

    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain('graph.threads.net/v1.0/test-account-id/threads_insights');
    expect(calledUrl).toContain('metric=views,likes,replies,reposts,quotes,followers_count');
    expect(calledUrl).toContain('period=day');
  });

  it('returns null on API error', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchErrorResponse(400, { error: { message: 'Invalid metric' } }),
    );

    const result = await handler.getAccountAnalytics(channel);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TikTok Analytics (video.list per-post metrics + user.info.stats account)
// ---------------------------------------------------------------------------

describe('TikTok getPostMetrics', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new TikTokHandler();
  const channel = makeChannel('tiktok');

  it('returns empty map for no post IDs', async () => {
    const result = await handler.getPostMetrics(channel, []);
    expect(result.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns empty map when no access token', async () => {
    const noToken = makeChannel('tiktok', { accessToken: '' });
    const result = await handler.getPostMetrics(noToken, ['70000000001']);
    expect(result.size).toBe(0);
  });

  it('skips non-numeric IDs (publish_ids from private/unaudited posts) without calling the API', async () => {
    // SELF_ONLY posts get no public video id, so we store the publish_id; TikTok's
    // /video/query/ rejects it ("must be an integer"), so we never query it.
    const result = await handler.getPostMetrics(channel, ['v_pub_url~v2-1.7643162333644294160']);
    expect(result.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches per-video metrics via /video/query/ filtered by video_ids', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: {
          videos: [
            { id: '70000000001', view_count: 1000, like_count: 80, comment_count: 12, share_count: 5 },
            { id: '70000000002', view_count: 250, like_count: 9, comment_count: 1, share_count: 0 },
          ],
        },
      }),
    );

    const result = await handler.getPostMetrics(channel, ['70000000001', '70000000002']);
    expect(result.size).toBe(2);

    const m1 = result.get('70000000001')!;
    expect(m1.impressions).toBe(1000);
    expect(m1.videoViews).toBe(1000);
    expect(m1.likes).toBe(80);
    expect(m1.comments).toBe(12);
    expect(m1.shares).toBe(5);

    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain('open.tiktokapis.com/v2/video/query/');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.filters.video_ids).toEqual(['70000000001', '70000000002']);
  });

  it('batches video IDs in groups of 20', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => String(70000000000 + i));
    mockFetch
      .mockResolvedValueOnce(
        mockFetchJsonResponse({
          data: { videos: ids.slice(0, 20).map((id) => ({ id, view_count: 1, like_count: 0, comment_count: 0, share_count: 0 })) },
        }),
      )
      .mockResolvedValueOnce(
        mockFetchJsonResponse({
          data: { videos: ids.slice(20).map((id) => ({ id, view_count: 2, like_count: 0, comment_count: 0, share_count: 0 })) },
        }),
      );

    const result = await handler.getPostMetrics(channel, ids);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(25);
    expect(result.get(String(70000000000))!.videoViews).toBe(1);
    expect(result.get(String(70000000020))!.videoViews).toBe(2);
  });

  it('gracefully handles API errors (returns empty map)', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchErrorResponse(401, { error: { code: 'access_token_invalid' } }),
    );
    const result = await handler.getPostMetrics(channel, ['70000000001']);
    expect(result.size).toBe(0);
  });
});

describe('TikTok getAccountAnalytics', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new TikTokHandler();
  const channel = makeChannel('tiktok');

  it('returns null when no access token', async () => {
    const noToken = makeChannel('tiktok', { accessToken: '' });
    const result = await handler.getAccountAnalytics(noToken);
    expect(result).toBeNull();
  });

  it('fetches followers/following + total likes & video count (user.info.stats)', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        data: { user: { follower_count: 12000, following_count: 180, likes_count: 95000, video_count: 42 } },
      }),
    );

    const result = await handler.getAccountAnalytics(channel);
    expect(result).not.toBeNull();
    expect(result!.followers).toBe(12000);
    expect(result!.following).toBe(180);
    expect(result!.platformSpecific?.likesCount).toBe(95000);
    expect(result!.platformSpecific?.videoCount).toBe(42);

    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain('open.tiktokapis.com/v2/user/info/');
    expect(calledUrl).toContain('follower_count');
  });

  it('returns null on API error (e.g. scope not authorized)', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchErrorResponse(401, { error: { code: 'scope_not_authorized' } }),
    );
    const result = await handler.getAccountAnalytics(channel);
    expect(result).toBeNull();
  });
});
