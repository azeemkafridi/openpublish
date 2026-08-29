/**
 * Metrics sync worker tests.
 *
 * Tests webapp/src/lib/jobs/metrics-sync.worker.ts covering:
 *   - sync-all-metrics fans out per-org jobs
 *   - sync-metrics fetches platform analytics and saves to DB
 *   - Skips inactive channels
 *   - Calculates engagement rate correctly
 *   - Gracefully handles 401/403 auth errors
 *   - Groups post-platforms by channel for efficient API calls
 *   - Does nothing when no published posts exist
 *   - Skips posts with no metrics returned from platform
 */

// ---------------------------------------------------------------------------
// Mocks BEFORE importing the module
// ---------------------------------------------------------------------------

const mockDbSelectResults: any[][] = [];
const mockDbInsertValues: any[] = [];
const mockDbUpdateCalls: any[] = [];
let selectCallIdx = 0;

const mockDecrypt = vi.fn((v: string) => `dec_${v}`);
const mockGetPostMetrics = vi.fn();
const mockResolvePublishId = vi.fn();
const mockAddMetricsSyncJob = vi.fn().mockResolvedValue(undefined);
const mockQueueFanOutAdd = vi.fn();
const mockRedisGet = vi.fn().mockResolvedValue(null);
const mockRedisSet = vi.fn().mockResolvedValue('OK');
let capturedProcessor: ((job: any) => Promise<void>) | null = null;

function buildSelectChain() {
  const getResult = () => {
    const rows = mockDbSelectResults[selectCallIdx] || [];
    selectCallIdx++;
    return rows;
  };
  const makeThenable = (resolver: () => any[]) => ({
    limit: vi.fn().mockImplementation(() => Promise.resolve(resolver())),
    then: (resolve: any, reject?: any) => Promise.resolve(resolver()).then(resolve, reject),
  });
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(() => makeThenable(getResult)),
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => makeThenable(getResult)),
      }),
    }),
  };
}

function buildSelectDistinctChain() {
  return buildSelectChain();
}

function buildInsertChain() {
  return {
    values: vi.fn().mockImplementation((data: any) => {
      mockDbInsertValues.push(data);
      return Promise.resolve([]);
    }),
  };
}

function buildUpdateChain() {
  return {
    set: vi.fn().mockImplementation((data: any) => ({
      where: vi.fn().mockImplementation((cond: any) => {
        mockDbUpdateCalls.push({ data, cond });
        return Promise.resolve([]);
      }),
    })),
  };
}

vi.mock('bullmq', () => {
  class MockWorker {
    constructor(_name: string, processor: any, _opts: any) {
      capturedProcessor = processor;
    }
  }
  return { Worker: MockWorker };
});

vi.mock('@/lib/jobs/queue', () => ({
  getRedisConnection: () => ({ get: mockRedisGet, set: mockRedisSet }),
  QUEUE_NAMES: { METRICS_SYNC: 'metrics-sync' },
  addMetricsSyncJob: (...args: any[]) => mockAddMetricsSyncJob(...args),
  getQueue: () => ({ add: (...args: any[]) => mockQueueFanOutAdd(...args) }),
}));

vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn().mockImplementation(() => buildSelectChain()),
    selectDistinct: vi.fn().mockImplementation(() => buildSelectDistinctChain()),
    insert: vi.fn().mockImplementation(() => buildInsertChain()),
    update: vi.fn().mockImplementation(() => buildUpdateChain()),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  channels: { id: 'id', isActive: 'isActive' },
  postPlatforms: { id: 'id', status: 'status', platformPostId: 'platformPostId', platform: 'platform', postId: 'postId', channelId: 'channelId' },
  posts: { id: 'id', organizationId: 'organizationId', status: 'status', publishedAt: 'publishedAt', platformSpecific: 'platformSpecific' },
  postMetrics: {},
  organizations: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ _type: 'eq', a })),
  and: vi.fn((...a: any[]) => ({ _type: 'and', a })),
  gte: vi.fn((...a: any[]) => ({ _type: 'gte', a })),
  inArray: vi.fn((...a: any[]) => ({ _type: 'inArray', a })),
  isNotNull: vi.fn((c: any) => ({ _type: 'isNotNull', c })),
  sql: vi.fn(),
}));

vi.mock('@/lib/auth/crypto', () => ({
  decrypt: (v: string) => mockDecrypt(v),
}));

vi.mock('@/lib/platforms/registry', () => ({
  getPlatformHandler: () => ({
    getPostMetrics: (...args: any[]) => mockGetPostMetrics(...args),
    resolvePublishId: (...args: any[]) => mockResolvePublishId(...args),
  }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

export {};

const { createMetricsSyncWorker } = await import('@/lib/jobs/metrics-sync.worker');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetState() {
  selectCallIdx = 0;
  mockDbSelectResults.length = 0;
  mockDbInsertValues.length = 0;
  mockDbUpdateCalls.length = 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('metrics-sync worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue('OK');
    capturedProcessor = null;
    // Avoid actual setTimeout delays
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: any) => { fn(); return 0 as any; });
    createMetricsSyncWorker();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('sync-all-metrics fan-out', () => {
    it('fans out one staggered sync-metrics job per org with recent publishes', async () => {
      mockDbSelectResults.push([{ organizationId: 1 }, { organizationId: 2 }]);

      await capturedProcessor!({ name: 'sync-all-metrics', data: {} });

      expect(mockQueueFanOutAdd).toHaveBeenCalledTimes(2);
      const [name1, data1, opts1] = mockQueueFanOutAdd.mock.calls[0];
      const [, data2, opts2] = mockQueueFanOutAdd.mock.calls[1];
      expect(name1).toBe('sync-metrics');
      expect(data1).toEqual({ organizationId: 1 });
      expect(data2).toEqual({ organizationId: 2 });
      // Staggered 30s apart so orgs don't hit the platforms simultaneously.
      expect(opts1.delay).toBe(0);
      expect(opts2.delay).toBe(30_000);
      // Time-bucketed jobId: a bare per-org id would be blocked forever by the
      // retained completed job from the previous window.
      expect(opts1.jobId).toMatch(/^sync-metrics-1-\d+$/);
    });
  });

  describe('sync-metrics (per-org)', () => {
    it('fetches platform analytics and saves metrics to DB', async () => {
      mockDbSelectResults.push(
        // Published post platforms (joined query)
        [
          { ppId: 1, postId: 10, channelId: 5, platform: 'x', platformPostId: 'post-x-1' },
          { ppId: 2, postId: 11, channelId: 5, platform: 'x', platformPostId: 'post-x-2' },
        ],
        // Channel query
        [{
          id: 5, platform: 'x', accountId: 'acc-1', accountName: 'TestAccount',
          accountType: null, accessToken: 'enc_token', refreshToken: null,
          metadata: { metricsSyncEnabled: true }, isActive: true,
        }],
      );

      const metricsMap = new Map([
        ['post-x-1', { impressions: 1000, likes: 50, comments: 10, shares: 5, clicks: 20 }],
        ['post-x-2', { impressions: 500, likes: 25, comments: 3 }],
      ]);
      mockGetPostMetrics.mockResolvedValue(metricsMap);

      await capturedProcessor!({ name: 'sync-metrics', data: { organizationId: 1 } });

      expect(mockGetPostMetrics).toHaveBeenCalledTimes(1);
      expect(mockDbInsertValues).toHaveLength(2);

      // Verify engagement rate for first post
      // total = 50 + 10 + 5 + 20 = 85, rate = round((85/1000) * 10000) = 850
      const first = mockDbInsertValues[0];
      expect(first.impressions).toBe(1000);
      expect(first.likes).toBe(50);
      expect(first.engagementRate).toBe(850);
    });

    it('calculates engagement rate as 0 when impressions are 0', async () => {
      mockDbSelectResults.push(
        [{ ppId: 1, postId: 10, channelId: 5, platform: 'x', platformPostId: 'post-1' }],
        [{
          id: 5, platform: 'x', accountId: 'a', accountName: 'A',
          accessToken: 'enc', isActive: true, metadata: { metricsSyncEnabled: true },
        }],
      );

      mockGetPostMetrics.mockResolvedValue(
        new Map([['post-1', { impressions: 0, likes: 10 }]]),
      );

      await capturedProcessor!({ name: 'sync-metrics', data: { organizationId: 1 } });

      expect(mockDbInsertValues[0].engagementRate).toBe(0);
    });

    it('skips inactive channels', async () => {
      mockDbSelectResults.push(
        [{ ppId: 1, postId: 10, channelId: 5, platform: 'x', platformPostId: 'post-1' }],
        [], // channel not found / inactive
      );

      await capturedProcessor!({ name: 'sync-metrics', data: { organizationId: 1 } });

      expect(mockGetPostMetrics).not.toHaveBeenCalled();
      expect(mockDbInsertValues).toHaveLength(0);
    });

    it('gracefully handles 401 auth errors from platform', async () => {
      mockDbSelectResults.push(
        [{ ppId: 1, postId: 10, channelId: 5, platform: 'x', platformPostId: 'post-1' }],
        [{
          id: 5, platform: 'x', accountId: 'a', accountName: 'A',
          accessToken: 'enc', isActive: true, metadata: { metricsSyncEnabled: true },
        }],
      );

      mockGetPostMetrics.mockRejectedValue(new Error('401 Unauthorized'));

      // Should not throw
      await expect(
        capturedProcessor!({ name: 'sync-metrics', data: { organizationId: 1 } }),
      ).resolves.toBeUndefined();
    });

    it('does nothing when no published posts exist', async () => {
      mockDbSelectResults.push([]); // no published PPs

      await capturedProcessor!({ name: 'sync-metrics', data: { organizationId: 1 } });

      expect(mockGetPostMetrics).not.toHaveBeenCalled();
    });

    it('skips posts with no metrics returned from platform', async () => {
      mockDbSelectResults.push(
        [
          { ppId: 1, postId: 10, channelId: 5, platform: 'x', platformPostId: 'post-1' },
          { ppId: 2, postId: 11, channelId: 5, platform: 'x', platformPostId: 'post-2' },
        ],
        [{
          id: 5, platform: 'x', accountId: 'a', accountName: 'A',
          accessToken: 'enc', isActive: true, metadata: { metricsSyncEnabled: true },
        }],
      );

      // Only returns metrics for one post
      mockGetPostMetrics.mockResolvedValue(
        new Map([['post-1', { impressions: 100, likes: 5 }]]),
      );

      await capturedProcessor!({ name: 'sync-metrics', data: { organizationId: 1 } });

      expect(mockDbInsertValues).toHaveLength(1);
    });

    it('defaults undefined metric values to 0', async () => {
      mockDbSelectResults.push(
        [{ ppId: 1, postId: 10, channelId: 5, platform: 'x', platformPostId: 'post-1' }],
        [{
          id: 5, platform: 'x', accountId: 'a', accountName: 'A',
          accessToken: 'enc', isActive: true, metadata: { metricsSyncEnabled: true },
        }],
      );

      // Return metrics with mostly undefined values
      mockGetPostMetrics.mockResolvedValue(
        new Map([['post-1', { impressions: 50 }]]),
      );

      await capturedProcessor!({ name: 'sync-metrics', data: { organizationId: 1 } });

      const m = mockDbInsertValues[0];
      expect(m.impressions).toBe(50);
      expect(m.likes).toBe(0);
      expect(m.comments).toBe(0);
      expect(m.shares).toBe(0);
      expect(m.clicks).toBe(0);
      expect(m.saves).toBe(0);
      expect(m.videoViews).toBe(0);
    });

    // LinkedIn documents that likeCount can go NEGATIVE: a like on a sponsored
    // share isn't counted as organic, but a later unlike is. Stored raw, that
    // subtracts from org-wide totals and can render "-3 likes".
    it('clamps negative platform counts to 0', async () => {
      mockDbSelectResults.push(
        [{ ppId: 1, postId: 10, channelId: 5, platform: 'linkedin', platformPostId: 'urn:li:share:1' }],
        [{
          id: 5, platform: 'linkedin', accountId: 'a', accountName: 'A',
          accountType: 'organization', accessToken: 'enc', isActive: true, metadata: {},
        }],
      );

      mockGetPostMetrics.mockResolvedValue(
        new Map([['urn:li:share:1', {
          impressions: 1000, likes: -3, comments: 4, shares: -1, clicks: 2,
        }]]),
      );

      await capturedProcessor!({ name: 'sync-metrics', data: { organizationId: 1 } });

      const m = mockDbInsertValues[0];
      expect(m.likes).toBe(0);
      expect(m.shares).toBe(0);
      expect(m.comments).toBe(4);
      // The rate must be computed from the clamped values, not the raw ones —
      // otherwise the negatives silently drag it down too.
      expect(m.engagementRate).toBe(Math.round((6 / 1000) * 10000));
    });

    it('skips X metrics when the channel has not opted in (X charges per read)', async () => {
      mockDbSelectResults.push(
        [{ ppId: 1, postId: 10, channelId: 5, platform: 'x', platformPostId: 'post-1' }],
        [{
          id: 5, platform: 'x', accountId: 'a', accountName: 'A',
          accessToken: 'enc', isActive: true, metadata: {}, // not opted in
        }],
      );

      await capturedProcessor!({ name: 'sync-metrics', data: { organizationId: 1 } });

      expect(mockGetPostMetrics).not.toHaveBeenCalled();
      expect(mockDbInsertValues).toHaveLength(0);
    });

    it('skips X metrics when synced within the last 7 days (throttle key present)', async () => {
      mockRedisGet.mockResolvedValue('2026-05-20T00:00:00.000Z'); // throttle key already set
      mockDbSelectResults.push(
        [{ ppId: 1, postId: 10, channelId: 5, platform: 'x', platformPostId: 'post-1' }],
        [{
          id: 5, platform: 'x', accountId: 'a', accountName: 'A',
          accessToken: 'enc', isActive: true, metadata: { metricsSyncEnabled: true },
        }],
      );

      await capturedProcessor!({ name: 'sync-metrics', data: { organizationId: 1 } });

      expect(mockGetPostMetrics).not.toHaveBeenCalled();
    });

    it('sets the 7-day throttle key when an opted-in X sync proceeds', async () => {
      mockDbSelectResults.push(
        [{ ppId: 1, postId: 10, channelId: 5, platform: 'x', platformPostId: 'post-1' }],
        [{
          id: 5, platform: 'x', accountId: 'a', accountName: 'A',
          accessToken: 'enc', isActive: true, metadata: { metricsSyncEnabled: true },
        }],
      );
      mockGetPostMetrics.mockResolvedValue(new Map([['post-1', { impressions: 10 }]]));

      await capturedProcessor!({ name: 'sync-metrics', data: { organizationId: 1 } });

      expect(mockGetPostMetrics).toHaveBeenCalledTimes(1);
      const setKeys = mockRedisSet.mock.calls.map((c) => String(c[0]));
      expect(setKeys).toContain('x:metrics:lastsync:5');
    });
  });

  describe('TikTok publish_id re-resolution', () => {
    it('resolves a non-private publish_id to a video id, persists it, then fetches metrics', async () => {
      mockDbSelectResults.push(
        [{
          ppId: 7, postId: 70, channelId: 9, platform: 'tiktok',
          platformPostId: 'v_pub_url~v2-1.999',
          platformSpecific: { tiktok: { privacyLevel: 'PUBLIC_TO_EVERYONE' } },
        }],
        [{
          id: 9, platform: 'tiktok', accountId: 'tt', accountName: 'tt',
          accessToken: 'enc', isActive: true, metadata: {},
        }],
      );

      mockResolvePublishId.mockResolvedValue('70000000123');
      mockGetPostMetrics.mockResolvedValue(
        new Map([['70000000123', { impressions: 1000, videoViews: 1000, likes: 80 }]]),
      );

      await capturedProcessor!({ name: 'sync-metrics', data: { organizationId: 1 } });

      // Resolved the publish_id...
      expect(mockResolvePublishId).toHaveBeenCalledTimes(1);
      expect(mockResolvePublishId.mock.calls[0][1]).toBe('v_pub_url~v2-1.999');
      // ...persisted the numeric id AND backfilled the permalink (the row was
      // published from a publish_id, so platformUrl was never set)...
      expect(mockDbUpdateCalls).toHaveLength(1);
      expect(mockDbUpdateCalls[0].data).toEqual({
        platformPostId: '70000000123',
        platformUrl: 'https://www.tiktok.com/@tt/video/70000000123',
      });
      // ...queried metrics with the resolved id, and stored them.
      expect(mockGetPostMetrics).toHaveBeenCalledWith(expect.anything(), ['70000000123'], expect.anything());
      expect(mockDbInsertValues).toHaveLength(1);
      expect(mockDbInsertValues[0].platform).toBe('tiktok');
      expect(mockDbInsertValues[0].impressions).toBe(1000);
    });

    it('skips SELF_ONLY posts (never resolvable) without calling status/fetch', async () => {
      mockDbSelectResults.push(
        [{
          ppId: 8, postId: 80, channelId: 9, platform: 'tiktok',
          platformPostId: 'v_pub_url~v2-1.555',
          platformSpecific: { tiktok: { privacyLevel: 'SELF_ONLY' } },
        }],
        [{
          id: 9, platform: 'tiktok', accountId: 'tt', accountName: 'tt',
          accessToken: 'enc', isActive: true, metadata: {},
        }],
      );

      mockGetPostMetrics.mockResolvedValue(new Map());

      await capturedProcessor!({ name: 'sync-metrics', data: { organizationId: 1 } });

      expect(mockResolvePublishId).not.toHaveBeenCalled();
      expect(mockDbUpdateCalls).toHaveLength(0);
      // getPostMetrics still runs (the handler skips the non-numeric id internally)
      expect(mockGetPostMetrics).toHaveBeenCalledWith(expect.anything(), ['v_pub_url~v2-1.555'], expect.anything());
      expect(mockDbInsertValues).toHaveLength(0);
    });

    it('does not re-resolve an already-numeric (public) video id', async () => {
      mockDbSelectResults.push(
        [{
          ppId: 9, postId: 90, channelId: 9, platform: 'tiktok',
          platformPostId: '70000000777',
          platformSpecific: { tiktok: { privacyLevel: 'PUBLIC_TO_EVERYONE' } },
        }],
        [{
          id: 9, platform: 'tiktok', accountId: 'tt', accountName: 'tt',
          accessToken: 'enc', isActive: true, metadata: {},
        }],
      );

      mockGetPostMetrics.mockResolvedValue(
        new Map([['70000000777', { impressions: 5, likes: 1 }]]),
      );

      await capturedProcessor!({ name: 'sync-metrics', data: { organizationId: 1 } });

      expect(mockResolvePublishId).not.toHaveBeenCalled();
      expect(mockDbUpdateCalls).toHaveLength(0);
      expect(mockGetPostMetrics).toHaveBeenCalledWith(expect.anything(), ['70000000777'], expect.anything());
      expect(mockDbInsertValues).toHaveLength(1);
    });
  });
});
