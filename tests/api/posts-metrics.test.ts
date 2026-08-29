/**
 * Tests for the Post Metrics API.
 *
 *   GET /api/posts/[id]/metrics — get metrics for a post across platforms
 */

// ---------------------------------------------------------------------------
// Chainable Drizzle mock
// ---------------------------------------------------------------------------
const mockQueryResult: any[] = [];
const queryChain: Record<string, any> = {};
const chainMethods = [
  'select', 'from', 'where', 'orderBy', 'limit', 'offset',
  'insert', 'values', 'returning', 'update', 'set', 'delete',
  'innerJoin', 'leftJoin', 'groupBy', 'having',
];
for (const m of chainMethods) {
  queryChain[m] = vi.fn().mockReturnValue(queryChain);
}
queryChain.returning = vi.fn().mockResolvedValue(mockQueryResult);
queryChain.limit = vi.fn().mockImplementation(() => {
  return queryChain;
});
queryChain.then = (resolve: any) => resolve(mockQueryResult);

// ---------------------------------------------------------------------------
// vi.mock (hoisted)
// ---------------------------------------------------------------------------
vi.mock('@/lib/db', () => ({
  db: {
    select: () => queryChain,
    update: () => queryChain,
    insert: () => queryChain,
    delete: () => queryChain,
  },
}));

vi.mock('@/lib/db/schema', () => ({
  posts: {
    id: 'posts.id',
    organizationId: 'posts.organization_id',
  },
  postPlatforms: {
    id: 'post_platforms.id',
    postId: 'post_platforms.post_id',
    platform: 'post_platforms.platform',
    platformPostId: 'post_platforms.platform_post_id',
    platformUrl: 'post_platforms.platform_url',
    status: 'post_platforms.status',
    channelId: 'post_platforms.channel_id',
  },
  // Joined for accountType — LinkedIn per-post metrics are organization-only.
  channels: {
    id: 'channels.id',
    accountType: 'channels.account_type',
  },
  postMetrics: {
    id: 'post_metrics.id',
    postPlatformId: 'post_metrics.post_platform_id',
    impressions: 'post_metrics.impressions',
    reach: 'post_metrics.reach',
    likes: 'post_metrics.likes',
    comments: 'post_metrics.comments',
    shares: 'post_metrics.shares',
    saves: 'post_metrics.saves',
    clicks: 'post_metrics.clicks',
    videoViews: 'post_metrics.video_views',
    engagementRate: 'post_metrics.engagement_rate',
    platformSpecificMetrics: 'post_metrics.platform_specific_metrics',
    fetchedAt: 'post_metrics.fetched_at',
  },
  // Shortlink clicks are summed per post_platform alongside the snapshots.
  shortLinks: {
    postId: 'short_links.post_id',
    postPlatformId: 'short_links.post_platform_id',
    clicks: 'short_links.clicks',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ type: 'eq', args: a })),
  and: vi.fn((...a: any[]) => ({ type: 'and', args: a })),
  desc: vi.fn((c: any) => ({ type: 'desc', col: c })),
  sql: vi.fn((...a: any[]) => ({ type: 'sql', args: a })),
}));

// ---------------------------------------------------------------------------
// Import handlers AFTER mocks
// ---------------------------------------------------------------------------
import { GET } from '@/pages/api/posts/[id]/metrics';
import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A } from '../helpers/fixtures';

const SAMPLE_PLATFORM = {
  id: 1,
  platform: 'facebook',
  platformPostId: 'fb-post-123',
  platformUrl: 'https://facebook.com/123',
  status: 'published',
};

const SAMPLE_METRIC = {
  id: 1,
  postPlatformId: 1,
  impressions: 1000,
  reach: 800,
  likes: 50,
  comments: 10,
  shares: 5,
  saves: 2,
  clicks: 25,
  videoViews: 0,
  engagementRate: 325,
  platformSpecificMetrics: {},
  fetchedAt: new Date('2026-02-01'),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resetChain(result: any[] = []) {
  for (const [key, fn] of Object.entries(queryChain)) {
    if (typeof fn === 'function' && key !== 'then') {
      (fn as any).mockReturnValue(queryChain);
    }
  }
  mockQueryResult.length = 0;
  result.forEach((r) => mockQueryResult.push(r));

  queryChain.returning = vi.fn().mockResolvedValue(mockQueryResult);
  queryChain.limit = vi.fn().mockImplementation(() => {
    return queryChain;
  });
  queryChain.then = (resolve: any) => resolve(mockQueryResult);
}

// ---------------------------------------------------------------------------
// GET /api/posts/[id]/metrics
// ---------------------------------------------------------------------------

describe('GET /api/posts/[id]/metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([]);
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null, params: { id: '1' } });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns 400 for invalid post ID', async () => {
    const ctx = createMockContext({ user: USER_A, params: { id: '0' } });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it('returns 404 when post does not belong to org', async () => {
    queryChain.then = (resolve: any) => resolve([]);
    const ctx = createMockContext({ user: USER_A, params: { id: '999' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it('returns metrics with totals for a post with metrics', async () => {
    // 1st: post ownership; 2nd: postPlatforms; 3rd: metrics
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([{ id: 1 }]); // post found
      if (callCount === 2) return resolve([SAMPLE_PLATFORM]); // platforms
      if (callCount === 3) return resolve([SAMPLE_METRIC]); // metrics
      return resolve([]);
    };

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.postId).toBe(1);
    expect(data).toHaveProperty('platforms');
    expect(data).toHaveProperty('totals');
    expect(data.totals.impressions).toBe(1000);
    expect(data.totals.likes).toBe(50);
    expect(data.totals.comments).toBe(10);
    expect(data.totals.shares).toBe(5);
    expect(data.totals.clicks).toBe(25);
  });

  it('returns null latest when platform has no metrics', async () => {
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([{ id: 1 }]);
      if (callCount === 2) return resolve([SAMPLE_PLATFORM]);
      if (callCount === 3) return resolve([]); // no metrics
      return resolve([]);
    };

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.platforms[0].latest).toBeNull();
    expect(data.platforms[0].history).toEqual([]);
    expect(data.totals.impressions).toBe(0);
  });

  it('returns zero totals when post has no platforms', async () => {
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([{ id: 1 }]);
      if (callCount === 2) return resolve([]); // no platforms
      return resolve([]);
    };

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.platforms).toEqual([]);
    expect(data.totals.impressions).toBe(0);
    expect(data.totals.likes).toBe(0);
  });

  it('sets Cache-Control: private, no-store header', async () => {
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([{ id: 1 }]);
      if (callCount === 2) return resolve([]);
      return resolve([]);
    };

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=60');
  });

  it('includes history snapshots in the response', async () => {
    const metrics = [
      SAMPLE_METRIC,
      { ...SAMPLE_METRIC, id: 2, impressions: 500, fetchedAt: new Date('2026-01-30') },
    ];
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([{ id: 1 }]);
      if (callCount === 2) return resolve([SAMPLE_PLATFORM]);
      if (callCount === 3) return resolve(metrics);
      return resolve([]);
    };

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.platforms[0].history).toHaveLength(2);
  });
});
