/**
 * Engagement check worker tests.
 *
 * Tests webapp/src/lib/jobs/engagement-check.worker.ts covering:
 *   - Cancels remaining checks when post is missing / nothing pending / no published platforms
 *   - Fetches single-post metrics per channel and stores snapshots
 *   - Fires auto-plug comment when total likes cross the threshold (atomic claim)
 *   - Fires auto-repost when its (higher) threshold is crossed
 *   - Does NOT fire below threshold and keeps later checks scheduled
 *   - Does not fire when the atomic claim is lost to a concurrent run
 *   - Cancels remaining checks once everything pending has fired
 *   - Skips unresolved TikTok publish_ids (non-numeric)
 *   - Survives platform fetch errors (401) and still evaluates thresholds from stored metrics
 */

// ---------------------------------------------------------------------------
// Mocks BEFORE importing the module
// ---------------------------------------------------------------------------

const mockDbSelectResults: any[][] = [];
const mockDbInsertValues: any[] = [];
const mockDbUpdateSets: any[] = [];
// Rows returned by each `.returning()` call of an update (atomic claims), in order.
const mockDbUpdateReturns: any[][] = [];
let selectCallIdx = 0;
let updateReturnIdx = 0;

const mockDecrypt = vi.fn((v: string) => `dec_${v}`);
const mockGetPostMetrics = vi.fn();
const mockPublishComment = vi.fn();
const mockRepost = vi.fn();
const mockRefreshChannelToken = vi.fn().mockResolvedValue(null);
const mockRemoveRemaining = vi.fn().mockResolvedValue(undefined);
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
    from: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation(() => makeThenable(getResult)),
      // The totalLikes aggregate uses .from(sql`...`) with no .where() — make
      // from() itself awaitable too.
      then: (resolve: any, reject?: any) => Promise.resolve(getResult()).then(resolve, reject),
    })),
  };
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
    set: vi.fn().mockImplementation((data: any) => {
      mockDbUpdateSets.push(data);
      return {
        where: vi.fn().mockImplementation(() => ({
          returning: vi.fn().mockImplementation(() => {
            const rows = mockDbUpdateReturns[updateReturnIdx] ?? [{ id: 1 }];
            updateReturnIdx++;
            return Promise.resolve(rows);
          }),
          then: (resolve: any, reject?: any) => Promise.resolve(undefined).then(resolve, reject),
        })),
      };
    }),
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
  getRedisConnection: () => ({}),
  QUEUE_NAMES: { ENGAGEMENT_CHECK: 'engagement-check' },
  ENGAGEMENT_CHECK_DELAYS_MS: [3_600_000, 21_600_000, 86_400_000, 259_200_000],
  removeRemainingEngagementChecks: (...args: any[]) => mockRemoveRemaining(...args),
}));

vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn().mockImplementation(() => buildSelectChain()),
    insert: vi.fn().mockImplementation(() => buildInsertChain()),
    update: vi.fn().mockImplementation(() => buildUpdateChain()),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  channels: { id: 'id', isActive: 'isActive' },
  postPlatforms: { id: 'id', status: 'status', platformPostId: 'platformPostId', platform: 'platform', postId: 'postId', channelId: 'channelId' },
  posts: { id: 'id', autoPlugFired: 'autoPlugFired', autoRepostFired: 'autoRepostFired' },
  postMetrics: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ _type: 'eq', a })),
  and: vi.fn((...a: any[]) => ({ _type: 'and', a })),
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
    publishComment: (...args: any[]) => mockPublishComment(...args),
    repost: (...args: any[]) => mockRepost(...args),
  }),
}));

vi.mock('@/lib/oauth/refresh-lock', () => ({
  refreshChannelToken: (...args: any[]) => mockRefreshChannelToken(...args),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

export {};

const { createEngagementCheckWorker } = await import('@/lib/jobs/engagement-check.worker');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetState() {
  selectCallIdx = 0;
  updateReturnIdx = 0;
  mockDbSelectResults.length = 0;
  mockDbInsertValues.length = 0;
  mockDbUpdateSets.length = 0;
  mockDbUpdateReturns.length = 0;
}

function basePost(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    organizationId: 1,
    autoPlugEnabled: true,
    autoPlugText: 'Check out our site!',
    autoPlugThreshold: 50,
    autoPlugFired: false,
    autoRepostEnabled: false,
    autoRepostThreshold: 100,
    autoRepostFired: false,
    ...overrides,
  };
}

const xChannel = {
  id: 5, platform: 'x', accountId: 'acc', accountName: 'Acc',
  accountType: null, accessToken: 'enc_tok', refreshToken: null,
  metadata: {}, isActive: true,
};

function runCheck(checkNumber = 1, postId = 10) {
  return capturedProcessor!({ name: 'check-engagement', data: { postId, checkNumber } });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('engagement-check worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
    mockRefreshChannelToken.mockResolvedValue(null);
    mockPublishComment.mockResolvedValue({ success: true });
    mockRepost.mockResolvedValue({ success: true });
    capturedProcessor = null;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: any) => { fn(); return 0 as any; });
    createEngagementCheckWorker();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing when the post no longer exists', async () => {
    mockDbSelectResults.push([]); // post lookup

    await runCheck();

    expect(mockGetPostMetrics).not.toHaveBeenCalled();
    expect(mockRemoveRemaining).not.toHaveBeenCalled();
  });

  it('cancels remaining checks when nothing is pending (both already fired)', async () => {
    mockDbSelectResults.push([basePost({ autoPlugFired: true })]);

    await runCheck(2);

    expect(mockRemoveRemaining).toHaveBeenCalledWith(10, 2);
    expect(mockGetPostMetrics).not.toHaveBeenCalled();
  });

  it('cancels remaining checks when nothing is pending (automations disabled)', async () => {
    mockDbSelectResults.push([basePost({ autoPlugEnabled: false, autoRepostEnabled: false })]);

    await runCheck(1);

    expect(mockRemoveRemaining).toHaveBeenCalledWith(10, 1);
  });

  it('cancels remaining checks when the post has no published platforms', async () => {
    mockDbSelectResults.push(
      [basePost()],
      [], // published post_platforms
    );

    await runCheck(1);

    expect(mockRemoveRemaining).toHaveBeenCalledWith(10, 1);
    expect(mockGetPostMetrics).not.toHaveBeenCalled();
  });

  it('fetches single-post metrics and stores the snapshot', async () => {
    mockDbSelectResults.push(
      [basePost()],
      [{ ppId: 1, channelId: 5, platform: 'x', platformPostId: 'tw-1' }],
      [xChannel],              // channel lookup
      [{ totalLikes: 10 }],    // aggregate likes (below threshold)
    );
    mockGetPostMetrics.mockResolvedValue(
      new Map([['tw-1', { impressions: 1000, likes: 10, comments: 5, shares: 2, clicks: 3 }]]),
    );

    await runCheck(1);

    expect(mockGetPostMetrics).toHaveBeenCalledWith(expect.anything(), ['tw-1'], expect.anything());
    expect(mockDbInsertValues).toHaveLength(1);
    const snap = mockDbInsertValues[0];
    expect(snap.postId).toBe(10);
    expect(snap.likes).toBe(10);
    // rate = round(((10+5+2+3)/1000)*10000) = 200
    expect(snap.engagementRate).toBe(200);
    // Below threshold: no action, later checks stay scheduled
    expect(mockPublishComment).not.toHaveBeenCalled();
    expect(mockRemoveRemaining).not.toHaveBeenCalled();
  });

  it('fires the auto-plug comment when likes cross the threshold and cancels the rest', async () => {
    mockDbSelectResults.push(
      [basePost()],
      [{ ppId: 1, channelId: 5, platform: 'x', platformPostId: 'tw-1' }],
      [xChannel],
      [{ totalLikes: 75 }],   // >= 50
      [xChannel],             // channel lookup inside fireOnPlatforms
    );
    mockGetPostMetrics.mockResolvedValue(new Map([['tw-1', { likes: 75 }]]));
    mockDbUpdateReturns.push([{ id: 10 }]); // claim wins

    await runCheck(1);

    // Claim set autoPlugFired first...
    expect(mockDbUpdateSets[0]).toEqual({ autoPlugFired: true });
    // ...then the comment was posted with the plug text
    expect(mockPublishComment).toHaveBeenCalledTimes(1);
    expect(mockPublishComment.mock.calls[0][1]).toBe('tw-1');
    expect(mockPublishComment.mock.calls[0][2]).toBe('Check out our site!');
    // Repost was never enabled
    expect(mockRepost).not.toHaveBeenCalled();
    // Everything pending fired → remaining checks cancelled
    expect(mockRemoveRemaining).toHaveBeenCalledWith(10, 1);
  });

  it('fires auto-repost at its higher threshold', async () => {
    mockDbSelectResults.push(
      [basePost({ autoPlugEnabled: false, autoRepostEnabled: true })],
      [{ ppId: 1, channelId: 5, platform: 'x', platformPostId: 'tw-1' }],
      [xChannel],
      [{ totalLikes: 150 }],  // >= 100
      [xChannel],             // channel lookup inside fireOnPlatforms
    );
    mockGetPostMetrics.mockResolvedValue(new Map([['tw-1', { likes: 150 }]]));
    mockDbUpdateReturns.push([{ id: 10 }]);

    await runCheck(2);

    expect(mockDbUpdateSets[0]).toEqual({ autoRepostFired: true });
    expect(mockRepost).toHaveBeenCalledTimes(1);
    expect(mockRepost.mock.calls[0][1]).toBe('tw-1');
    expect(mockPublishComment).not.toHaveBeenCalled();
    expect(mockRemoveRemaining).toHaveBeenCalledWith(10, 2);
  });

  it('does not fire when the atomic claim is lost to a concurrent run', async () => {
    mockDbSelectResults.push(
      [basePost()],
      [{ ppId: 1, channelId: 5, platform: 'x', platformPostId: 'tw-1' }],
      [xChannel],
      [{ totalLikes: 75 }],
    );
    mockGetPostMetrics.mockResolvedValue(new Map([['tw-1', { likes: 75 }]]));
    mockDbUpdateReturns.push([]); // claim lost — 0 rows updated

    await runCheck(1);

    expect(mockPublishComment).not.toHaveBeenCalled();
  });

  it('keeps later checks scheduled when only one of two pending automations fires', async () => {
    // Plug fires at 60 likes, repost (threshold 100) still pending.
    mockDbSelectResults.push(
      [basePost({ autoRepostEnabled: true })],
      [{ ppId: 1, channelId: 5, platform: 'x', platformPostId: 'tw-1' }],
      [xChannel],
      [{ totalLikes: 60 }],
      [xChannel],             // fireOnPlatforms channel lookup (plug)
    );
    mockGetPostMetrics.mockResolvedValue(new Map([['tw-1', { likes: 60 }]]));
    mockDbUpdateReturns.push([{ id: 10 }]); // plug claim wins

    await runCheck(1);

    expect(mockPublishComment).toHaveBeenCalledTimes(1);
    expect(mockRepost).not.toHaveBeenCalled();
    // Repost still pending → do NOT cancel the remaining checks
    expect(mockRemoveRemaining).not.toHaveBeenCalled();
  });

  it('does not cancel after firing on the final check (nothing scheduled after it)', async () => {
    mockDbSelectResults.push(
      [basePost()],
      [{ ppId: 1, channelId: 5, platform: 'x', platformPostId: 'tw-1' }],
      [xChannel],
      [{ totalLikes: 75 }],
      [xChannel],
    );
    mockGetPostMetrics.mockResolvedValue(new Map([['tw-1', { likes: 75 }]]));
    mockDbUpdateReturns.push([{ id: 10 }]);

    await runCheck(4); // final check

    expect(mockPublishComment).toHaveBeenCalledTimes(1);
    expect(mockRemoveRemaining).not.toHaveBeenCalled();
  });

  it('skips unresolved TikTok publish_ids (non-numeric) without a metrics call', async () => {
    mockDbSelectResults.push(
      [basePost()],
      [{ ppId: 1, channelId: 9, platform: 'tiktok', platformPostId: 'v_pub_url~v2.999' }],
      [{ ...xChannel, id: 9, platform: 'tiktok' }],
      [{ totalLikes: 0 }],
    );

    await runCheck(1);

    expect(mockGetPostMetrics).not.toHaveBeenCalled();
    expect(mockDbInsertValues).toHaveLength(0);
  });

  it('survives a platform 401 and still evaluates thresholds from stored metrics', async () => {
    mockDbSelectResults.push(
      [basePost()],
      [{ ppId: 1, channelId: 5, platform: 'x', platformPostId: 'tw-1' }],
      [xChannel],
      [{ totalLikes: 80 }],   // stored history from an earlier successful sync
      [xChannel],             // fireOnPlatforms channel lookup
    );
    mockGetPostMetrics.mockRejectedValue(new Error('401 Unauthorized'));
    mockDbUpdateReturns.push([{ id: 10 }]);

    await expect(runCheck(1)).resolves.toBeUndefined();

    // Fetch failed, but the DB aggregate still crossed the threshold → plug fired
    expect(mockPublishComment).toHaveBeenCalledTimes(1);
  });

  it('logs and continues when the comment action itself fails (claim stays)', async () => {
    mockDbSelectResults.push(
      [basePost()],
      [{ ppId: 1, channelId: 5, platform: 'x', platformPostId: 'tw-1' }],
      [xChannel],
      [{ totalLikes: 75 }],
      [xChannel],
    );
    mockGetPostMetrics.mockResolvedValue(new Map([['tw-1', { likes: 75 }]]));
    mockPublishComment.mockResolvedValue({ success: false, error: 'nope' });
    mockDbUpdateReturns.push([{ id: 10 }]);

    await expect(runCheck(1)).resolves.toBeUndefined();

    // Fired flag was claimed before the attempt — no re-fire on later checks by design
    expect(mockDbUpdateSets[0]).toEqual({ autoPlugFired: true });
    expect(mockRemoveRemaining).toHaveBeenCalledWith(10, 1);
  });

  it('ignores unknown job names', async () => {
    await capturedProcessor!({ name: 'something-else', data: {} });
    expect(mockGetPostMetrics).not.toHaveBeenCalled();
  });
});
