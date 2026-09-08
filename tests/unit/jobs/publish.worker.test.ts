/**
 * Publish worker tests.
 *
 * Tests webapp/src/lib/jobs/publish.worker.ts covering:
 *   - publishPost marks post as publishing
 *   - Per-platform success updates postPlatform to published
 *   - Per-platform failure updates postPlatform to failed
 *   - Processing result queues status check job
 *   - 401 retry logic: refreshes token and retries publish
 *   - 401 retry: updates channel tokens in DB
 *   - 401 retry: does not retry if no refresh token
 *   - Thread publishing delegates to publishThread
 *   - Final status derivation: all published -> 'published'
 *   - Final status derivation: mixed -> 'partial'
 *   - Final status derivation: all failed -> 'failed'
 *   - Final status derivation: all done + processing -> 'processing'
 *   - Notification sent on failure
 *   - Media cleanup triggered when all published and deleteMediaAfterPublish
 *   - Only re-publishes pending/publishing platforms on retry (not already-published)
 *   - Handles missing post gracefully
 *   - Handles missing channel per-platform
 *   - Pre-publish validation failure
 *   - Catches thrown exceptions per platform
 */

// ---------------------------------------------------------------------------
// Mocks BEFORE importing the module
// ---------------------------------------------------------------------------

const mockDbSelectResults: any[][] = [];
const mockDbUpdateSets: any[] = [];
// Rows returned by each `db.update(...).set(...).where(...).returning()` call, in order
// (used by the atomic scheduled→publishing claim). Plain updates without .returning()
// don't consume this queue.
const mockDbUpdateReturns: any[][] = [];
let selectCallIdx = 0;
let updateCallIdx = 0;
let updateReturnIdx = 0;

const mockDecrypt = vi.fn((v: string) => `dec_${v}`);
const mockEncrypt = vi.fn((v: string) => `enc_${v}`);
const mockPublishPost = vi.fn();
const mockPublishThread = vi.fn();
const mockRefreshToken = vi.fn();
const mockValidateForPlatform = vi.fn().mockReturnValue([]);
const mockAddPublishJob = vi.fn().mockResolvedValue(undefined);
const mockAddStatusCheckJob = vi.fn().mockResolvedValue(undefined);
const mockAddMediaCleanupJob = vi.fn().mockResolvedValue(undefined);
const mockAddMediaDeleteJob = vi.fn().mockResolvedValue(undefined);
const mockAddNotificationJob = vi.fn().mockResolvedValue(undefined);
const mockAddEngagementCheckJobs = vi.fn().mockResolvedValue(undefined);
const mockGetMediaPublicUrl = vi.fn((path: string) => `https://cdn.example.com/${path}`);
const mockConvertImageIfNeeded = vi.fn().mockResolvedValue(null);
const mockComposeStoryImage = vi.fn().mockResolvedValue(null);
const mockDownloadFromR2 = vi.fn().mockResolvedValue(Buffer.from('media-bytes'));
const mockLogActivity = vi.fn();
const mockExtractFirstUrl = vi.fn().mockReturnValue(null);
// Per-platform image rules the registry mock returns; tests override to trigger conversion.
let mockImageMediaRules: { formats: string[]; maxDimension: number | undefined } = { formats: [], maxDimension: undefined };
let capturedProcessor: ((job: any) => Promise<void>) | null = null;

/** Build a chainable select mock that works with/without .limit() */
function buildSelectChain() {
  const getResult = () => {
    const rows = mockDbSelectResults[selectCallIdx] || [];
    selectCallIdx++;
    return rows;
  };

  // The chain needs to be thenable (for queries without .limit())
  // AND have .limit() (for queries with .limit())
  const makeThenable = (resolver: () => any[]) => {
    const obj: any = {
      limit: vi.fn().mockImplementation(() => {
        return Promise.resolve(resolver());
      }),
      then: (resolve: any, reject?: any) => {
        return Promise.resolve(resolver()).then(resolve, reject);
      },
    };
    return obj;
  };

  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(() => makeThenable(getResult)),
    }),
  };
}

/** Build a chainable update mock. `.where()` is awaitable (resolves undefined) AND exposes
 *  `.returning()` for the atomic claim, which consumes the next mockDbUpdateReturns entry. */
function buildUpdateChain() {
  return {
    set: vi.fn().mockImplementation((data: any) => {
      mockDbUpdateSets.push(data);
      updateCallIdx++;
      return {
        where: vi.fn().mockImplementation(() => ({
          returning: vi.fn().mockImplementation(() => {
            const rows = mockDbUpdateReturns[updateReturnIdx] ?? [];
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
  QUEUE_NAMES: { PUBLISH: 'publish' },
  addPublishJob: (...args: any[]) => mockAddPublishJob(...args),
  addStatusCheckJob: (...args: any[]) => mockAddStatusCheckJob(...args),
  addMediaCleanupJob: (...args: any[]) => mockAddMediaCleanupJob(...args),
  addMediaDeleteJob: (...args: any[]) => mockAddMediaDeleteJob(...args),
  addNotificationJob: (...args: any[]) => mockAddNotificationJob(...args),
  addEngagementCheckJobs: (...args: any[]) => mockAddEngagementCheckJobs(...args),
}));

vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn().mockImplementation(() => buildSelectChain()),
    update: vi.fn().mockImplementation(() => buildUpdateChain()),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  posts: { id: 'id', status: 'status', scheduledAt: 'scheduledAt' },
  postPlatforms: { id: 'id', postId: 'postId', status: 'status' },
  channels: { id: 'id', organizationId: 'organizationId' },
  mediaFiles: { id: 'id', organizationId: 'organizationId' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ _type: 'eq', a })),
  and: vi.fn((...a: any[]) => ({ _type: 'and', a })),
  lte: vi.fn((...a: any[]) => ({ _type: 'lte', a })),
  lt: vi.fn((...a: any[]) => ({ _type: 'lt', a })),
  inArray: vi.fn((...a: any[]) => ({ _type: 'inArray', a })),
  or: vi.fn((...a: any[]) => ({ _type: 'or', a })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...v: any[]) => ({ _type: 'sql', strings, v })),
    { raw: (x: any) => x },
  ),
}));

vi.mock('@/lib/auth/crypto', () => ({
  decrypt: (v: string) => mockDecrypt(v),
  encrypt: (v: string) => mockEncrypt(v),
}));

vi.mock('@/lib/platforms/registry', () => ({
  getPlatformHandler: () => ({
    publishPost: (...args: any[]) => mockPublishPost(...args),
    publishThread: (...args: any[]) => mockPublishThread(...args),
    refreshToken: (...args: any[]) => mockRefreshToken(...args),
    config: {
      mediaRules: {
        image: mockImageMediaRules,
      },
    },
  }),
}));

vi.mock('@/lib/platforms/types', () => ({
  platformDisplayName: (p: string) => {
    const names: Record<string, string> = { x: 'X', facebook: 'Facebook', tiktok: 'TikTok' };
    return names[p] || p;
  },
}));

// Stub only what the tests drive and leave the rest real: a bare factory made
// every other export undefined, so the worker reaching for a second function
// from this module threw inside its own try/catch and looked like a publish
// failure.
vi.mock('@/lib/platforms/validation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platforms/validation')>();
  return {
    ...actual,
    validateForPlatform: (...args: any[]) => mockValidateForPlatform(...args),
  };
});

vi.mock('@/lib/media/upload', () => ({
  getMediaPublicUrl: (...args: [string]) => mockGetMediaPublicUrl(...args),
  convertImageIfNeeded: (...args: any[]) => mockConvertImageIfNeeded(...args),
  composeStoryImage: (...args: any[]) => mockComposeStoryImage(...args),
}));

vi.mock('@/lib/media/r2', () => ({
  downloadFromR2: (...args: any[]) => mockDownloadFromR2(...args),
  // Streaming variant routes to the same spy (key only) so assertions on which
  // R2 object was fetched keep working; the temp-file write is irrelevant here.
  downloadFromR2ToFile: (key: string, _dest: string) => mockDownloadFromR2(key),
  isR2Key: (p: string) => !p.startsWith('/'),
}));

vi.mock('@/lib/url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/url')>();
  return {
    ...actual,
    extractFirstUrl: (...args: any[]) => mockExtractFirstUrl(...args),
  };
});

vi.mock('@/lib/activity/log', () => ({
  logActivity: (...args: any[]) => mockLogActivity(...args),
}));

vi.mock('@/lib/quotas/check', () => ({
  checkPlatformAllowed: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

export {};

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------

const { createPublishWorker } = await import('@/lib/jobs/publish.worker');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePost(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    userId: 'user-1',
    organizationId: 1,
    content: 'Hello world!',
    mediaFiles: [],
    status: 'scheduled',
    postFormat: 'post',
    platformContent: {},
    postTypeOverrides: {},
    platformSpecific: {},
    deleteMediaAfterPublish: false,
    threadParts: null,
    platformThreadParts: null,
    ...overrides,
  };
}

function makePostPlatform(overrides: Record<string, any> = {}) {
  return {
    id: 100,
    postId: 1,
    channelId: 10,
    platform: 'x',
    status: 'pending',
    ...overrides,
  };
}

function makeChannel(overrides: Record<string, any> = {}) {
  return {
    id: 10,
    platform: 'x',
    accountId: 'acc-1',
    accountName: 'TestAccount',
    accountType: null,
    accessToken: 'enc_access',
    refreshToken: 'enc_refresh',
    organizationId: 1,
    metadata: {},
    ...overrides,
  };
}

/**
 * Push query results into the mockDbSelectResults queue.
 *
 * publishPost flow calls select in this order:
 *   0: select post by id (.limit(1))
 *   1: select postPlatforms where pending/publishing
 *   2: select channels by channelIds
 *   3: (if media) select mediaFiles by ids
 *   4: select all postPlatform statuses for final derivation
 */
function setupResults(opts: {
  post?: any;
  platforms?: any[];
  channels?: any[];
  mediaRows?: any[];
  allStatuses?: string[];
}) {
  const post = opts.post ?? makePost();
  const platforms = opts.platforms ?? [makePostPlatform()];
  const channelRows = opts.channels ?? [makeChannel()];
  const mediaRows = opts.mediaRows ?? [];
  const allStatuses = (opts.allStatuses ?? ['published']).map((s) => ({ status: s }));

  // Check if the post has media IDs that will trigger a media select query.
  // The source only does `db.select().from(mediaFilesTable)` when mediaIds.length > 0.
  const rawMediaIds = Array.isArray(post.mediaFiles) ? post.mediaFiles : [];
  const hasMedia = rawMediaIds.some((entry: any) => {
    const id = typeof entry === 'number' ? entry : entry?.id;
    return id && !Number.isNaN(id);
  });

  mockDbSelectResults.push(
    [post],         // 0: post
    platforms,      // 1: postPlatforms
    channelRows,    // 2: channels
  );

  if (hasMedia) {
    mockDbSelectResults.push(mediaRows); // 3: mediaFiles (only when post has media)
  }

  mockDbSelectResults.push(allStatuses); // final statuses
}

function resetState() {
  selectCallIdx = 0;
  updateCallIdx = 0;
  updateReturnIdx = 0;
  mockDbSelectResults.length = 0;
  mockDbUpdateSets.length = 0;
  mockDbUpdateReturns.length = 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('publish worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
    capturedProcessor = null;
    // Re-establish default mock return values that vi.clearAllMocks does not reset
    mockValidateForPlatform.mockReturnValue([]);
    mockConvertImageIfNeeded.mockResolvedValue(null);
    mockComposeStoryImage.mockResolvedValue(null);
    mockDownloadFromR2.mockResolvedValue(Buffer.from('media-bytes'));
    mockExtractFirstUrl.mockReturnValue(null);
    mockImageMediaRules = { formats: [], maxDimension: undefined };
    createPublishWorker();
  });

  describe('job routing', () => {
    it('calls publishPost for publish-post job', async () => {
      setupResults({ allStatuses: ['published'] });
      mockPublishPost.mockResolvedValue({ success: true, postId: 'post-1', url: 'https://x.com/1' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockPublishPost).toHaveBeenCalledTimes(1);
    });

    it('processes check-scheduled for scheduled posts', async () => {
      // processScheduledPosts: select scheduled posts (returns empty)
      mockDbSelectResults.push([]);

      await capturedProcessor!({ name: 'check-scheduled', data: {} });

      // Should have queried the DB
      expect(selectCallIdx).toBeGreaterThan(0);
    });

    it('skips a due scheduled post when the atomic claim is lost (no double-publish)', async () => {
      // Two check-scheduled runs can overlap; the conditional scheduled→publishing claim
      // returns 0 rows for the run that loses, which must then skip the post entirely.
      mockDbSelectResults.push([{ id: 1 }]); // one due scheduled post
      mockDbUpdateReturns.push([]);          // claim returns no row — another run won it

      await capturedProcessor!({ name: 'check-scheduled', data: {} });

      // The claim was attempted (scheduled→publishing)...
      expect(mockDbUpdateSets).toContainEqual(expect.objectContaining({ status: 'publishing' }));
      // ...but publishing never proceeded: no platform API was called for the lost-claim post.
      expect(mockPublishPost).not.toHaveBeenCalled();
    });

    it('enqueues a publish job for a due scheduled post when the atomic claim succeeds', async () => {
      mockDbSelectResults.push([{ id: 1 }]);   // due scheduled post
      mockDbUpdateReturns.push([{ id: 1 }]);   // claim won
      mockDbSelectResults.push([]);            // reclaimStuckPosts: none

      await capturedProcessor!({ name: 'check-scheduled', data: {} });

      // Claimed posts are published via a queued job (BullMQ retry semantics),
      // not inline — so no platform API call happens in this tick.
      expect(mockAddPublishJob).toHaveBeenCalledWith(1);
      expect(mockPublishPost).not.toHaveBeenCalled();
    });

    it('reclaims a post stuck in publishing (lost Redis job) by re-publishing it', async () => {
      mockDbSelectResults.push(
        [],  // no due scheduled posts
        [{ id: 5, status: 'publishing' }],  // reclaimStuckPosts: one stuck-publishing post
        // publishPost(5):
        [makePost({ id: 5, status: 'publishing' })],
        [makePostPlatform()],
        [makeChannel()],
        [{ status: 'published' }],
      );
      mockPublishPost.mockResolvedValue({ success: true, postId: 'p-5' });

      await capturedProcessor!({ name: 'check-scheduled', data: {} });

      expect(mockPublishPost).toHaveBeenCalledTimes(1);
    });

    it('reclaims a partial post whose async platform never confirmed', async () => {
      // A post can sit at 'partial' with one platform still 'processing' (another
      // channel failed). Those were previously never re-driven.
      mockDbSelectResults.push(
        [],  // no due scheduled posts
        [{ id: 8, status: 'partial' }],  // reclaimStuckPosts picks it up
        [makePostPlatform({ status: 'processing', platformPostId: 'plat-8' })],
      );

      await capturedProcessor!({ name: 'check-scheduled', data: {} });

      expect(mockAddStatusCheckJob).toHaveBeenCalledWith(100, 'x', 'plat-8', 10);
    });

    it('reclaims a post stuck in processing by re-enqueueing its status checks', async () => {
      mockDbSelectResults.push(
        [],  // no due scheduled posts
        [{ id: 7, status: 'processing' }],  // reclaimStuckPosts: one stuck-processing post
        [makePostPlatform({ status: 'processing', platformPostId: 'plat-7' })],  // its processing rows
      );

      await capturedProcessor!({ name: 'check-scheduled', data: {} });

      expect(mockAddStatusCheckJob).toHaveBeenCalledWith(100, 'x', 'plat-7', 10);
      // updatedAt is bumped so the post isn't re-driven next minute while the checks run.
      expect(mockDbUpdateSets).toContainEqual(expect.objectContaining({ updatedAt: expect.any(Date) }));
    });
  });

  describe('publishPost flow', () => {
    it('marks post as publishing first', async () => {
      setupResults({});
      mockPublishPost.mockResolvedValue({ success: true, postId: 'p-1' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      // First update set should be { status: 'publishing', ... }
      expect(mockDbUpdateSets[0]).toEqual(
        expect.objectContaining({ status: 'publishing' }),
      );
    });

    it('returns early when post not found', async () => {
      mockDbSelectResults.push([]); // post not found

      await capturedProcessor!({ name: 'publish-post', data: { postId: 999 } });

      expect(mockPublishPost).not.toHaveBeenCalled();
    });

    it('marks post as failed when no platforms selected', async () => {
      mockDbSelectResults.push(
        [makePost()], // post found
        [],           // no platforms
      );

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      // Should set post to failed
      expect(mockDbUpdateSets).toContainEqual(
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it('reconciles to published instead of failing when no pending platforms remain', async () => {
      // A concurrent run / prior attempt already published every platform, so the
      // pending/publishing select is empty. The post must be reconciled from the real
      // platform statuses — NOT blindly flipped to failed.
      mockDbSelectResults.push(
        [makePost({ status: 'publishing' })],                 // post
        [],                                                    // no pending/publishing platforms
        [{ status: 'published' }, { status: 'published' }],    // reconcile: all already published
      );

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockDbUpdateSets).toContainEqual(expect.objectContaining({ status: 'published' }));
      expect(mockDbUpdateSets).not.toContainEqual(expect.objectContaining({ status: 'failed' }));
    });
  });

  describe('per-platform success', () => {
    it('updates postPlatform to published on success', async () => {
      setupResults({ allStatuses: ['published'] });
      mockPublishPost.mockResolvedValue({
        success: true,
        postId: 'plat-post-1',
        url: 'https://x.com/status/123',
      });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockDbUpdateSets).toContainEqual(
        expect.objectContaining({
          status: 'published',
          platformPostId: 'plat-post-1',
          platformUrl: 'https://x.com/status/123',
        }),
      );
    });

    it('falls back to post.content when platformContent holds a non-string (prod regression: content.split crash)', async () => {
      // A malformed API payload once stored {"youtube": {"content": "..."}} in
      // platform_content; the object won the `||` fallback and crashed handlers.
      setupResults({
        post: makePost({
          content: 'Terracid clip',
          platformContent: { x: { content: 'nested caption' } },
        }),
        allStatuses: ['published'],
      });
      mockPublishPost.mockResolvedValue({ success: true, postId: 'p1', url: 'https://x.com/1' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockPublishPost).toHaveBeenCalledTimes(1);
      const [postDataArg] = mockPublishPost.mock.calls[0];
      expect(postDataArg.content).toBe('Terracid clip');
    });

    it('uses the platformContent override when it IS a string', async () => {
      setupResults({
        post: makePost({ content: 'base', platformContent: { x: 'x-specific caption' } }),
        allStatuses: ['published'],
      });
      mockPublishPost.mockResolvedValue({ success: true, postId: 'p1', url: 'https://x.com/1' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      const [postDataArg] = mockPublishPost.mock.calls[0];
      expect(postDataArg.content).toBe('x-specific caption');
    });
  });

  describe('per-platform failure', () => {
    it('updates postPlatform to failed and sends notification', async () => {
      // 'Rate limit exceeded' classifies as transient — spend the auto-republish
      // budget so the run reaches the visible failure + notification.
      setupResults({
        platforms: [makePostPlatform({ retryCount: 2, maxRetries: 3 })],
        allStatuses: ['failed'],
      });
      mockPublishPost.mockResolvedValue({
        success: false,
        error: 'Rate limit exceeded',
      });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockDbUpdateSets).toContainEqual(
        expect.objectContaining({ status: 'failed', errorMessage: 'Rate limit exceeded' }),
      );

      expect(mockAddNotificationJob).toHaveBeenCalledWith(
        'user-1',
        'post_failed',
        expect.stringContaining('X'),
        'Rate limit exceeded',
        expect.objectContaining({ postId: 1, platform: 'x', channelId: 10 }),
        1,
      );
    });

    it('defers a transient failure for BullMQ retry when attempts remain', async () => {
      setupResults({ allStatuses: ['pending'] });
      mockPublishPost.mockResolvedValue({
        success: false,
        error: 'x API error (429): Too Many Requests',
      });

      // attemptsMade counts completed attempts: 1 → this is the 2nd of 3 runs
      await expect(
        capturedProcessor!({ name: 'publish-post', data: { postId: 1 }, attemptsMade: 1, opts: { attempts: 3 } }),
      ).rejects.toThrow(/Transient platform failure/);

      // Platform row reset to pending (not failed), no user notification yet
      expect(mockDbUpdateSets).toContainEqual(
        expect.objectContaining({ status: 'pending', errorMessage: 'x API error (429): Too Many Requests' }),
      );
      expect(mockDbUpdateSets).not.toContainEqual(expect.objectContaining({ status: 'failed' }));
      expect(mockAddNotificationJob).not.toHaveBeenCalled();
    });

    it('bumps posts.updatedAt when deferring, so the reclaim sweep backs off', async () => {
      // Regression: publishPost() skips the 'publishing' status write when the post is
      // ALREADY 'publishing' (which is the case on the reclaim path). Without an explicit
      // bump here the row keeps its stale updatedAt, stays past reclaimStuckPosts' cutoff
      // forever, and is re-published every single minute — and because that sweep is
      // LIMIT 10, a batch of held posts starves genuinely stranded ones out of recovery.
      setupResults({ allStatuses: ['pending'] });
      mockPublishPost.mockResolvedValue({
        success: false,
        error: 'x API error (429): Too Many Requests',
      });

      await expect(
        capturedProcessor!({ name: 'publish-post', data: { postId: 1 }, attemptsMade: 1, opts: { attempts: 3 } }),
      ).rejects.toThrow(/Transient platform failure/);

      const bumpOnly = mockDbUpdateSets.filter(
        (s) => s && Object.keys(s).length === 1 && s.updatedAt instanceof Date,
      );
      expect(bumpOnly.length).toBeGreaterThan(0);
    });

    it('holds (does not fail) a post whose platform is switched off', async () => {
      // PLATFORM_<NAME>=off is our own kill switch, not the platform rejecting us —
      // the post must be parked as 'pending' and republish itself once we flip it back,
      // never burned as 'failed' and never notified to the user.
      const savedFlag = process.env.PLATFORM_X;
      process.env.PLATFORM_X = 'off';
      try {
        setupResults({ allStatuses: ['pending'] });

        await expect(
          capturedProcessor!({ name: 'publish-post', data: { postId: 1 }, attemptsMade: 1, opts: { attempts: 3 } }),
        ).rejects.toThrow(/Transient platform failure/);

        // Never reached the platform API at all.
        expect(mockPublishPost).not.toHaveBeenCalled();
        expect(mockDbUpdateSets).toContainEqual(
          expect.objectContaining({
            status: 'pending',
            errorMessage: expect.stringMatching(/temporarily unavailable/i),
          }),
        );
        expect(mockDbUpdateSets).not.toContainEqual(expect.objectContaining({ status: 'failed' }));
        expect(mockAddNotificationJob).not.toHaveBeenCalled();
      } finally {
        if (savedFlag === undefined) delete process.env.PLATFORM_X;
        else process.env.PLATFORM_X = savedFlag;
      }
    });

    it('schedules a delayed re-publish on a final-attempt transient error while budget remains', async () => {
      // The in-band BullMQ attempts all land within ~15s — too short for a
      // platform blip lasting minutes (Pinterest error 12, 2026-08-07). With
      // auto-republish budget left (retryCount < min(2, maxRetries-1)), the
      // final attempt parks the row 'pending', bumps retryCount, and queues a
      // delayed publish job instead of failing + emailing.
      setupResults({ allStatuses: ['pending'] });
      mockPublishPost.mockResolvedValue({
        success: false,
        error: 'x API error (429): Too Many Requests',
      });

      // attemptsMade = 2 completed attempts → this is the 3rd and final run of 3
      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 }, attemptsMade: 2, opts: { attempts: 3 } });

      expect(mockDbUpdateSets).toContainEqual(
        expect.objectContaining({
          status: 'pending',
          errorMessage: 'x API error (429): Too Many Requests',
          retryCount: expect.anything(),
        }),
      );
      expect(mockDbUpdateSets).not.toContainEqual(expect.objectContaining({ status: 'failed' }));
      expect(mockAddPublishJob).toHaveBeenCalledWith(1, 5 * 60_000);
      expect(mockAddNotificationJob).not.toHaveBeenCalled();
    });

    it('fails a transient error visibly on the final attempt once the auto-republish budget is spent', async () => {
      setupResults({
        platforms: [makePostPlatform({ retryCount: 2, maxRetries: 3 })],
        allStatuses: ['failed'],
      });
      mockPublishPost.mockResolvedValue({
        success: false,
        error: 'x API error (429): Too Many Requests',
      });

      // attemptsMade = 2 completed attempts → this is the 3rd and final run of 3
      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 }, attemptsMade: 2, opts: { attempts: 3 } });

      expect(mockDbUpdateSets).toContainEqual(
        expect.objectContaining({ status: 'failed', errorMessage: 'x API error (429): Too Many Requests' }),
      );
      expect(mockAddPublishJob).not.toHaveBeenCalled();
      expect(mockAddNotificationJob).toHaveBeenCalled();
    });

    it('reschedules a thrown transient error on the final attempt (Pinterest error 12 shape)', async () => {
      // Pinterest error code 12 surfaces as a THROWN fetchJson error with HTTP
      // 400 — classifyPublishError matches "went wrong on our end", not the
      // status. Both 2026-08-07 prod failures took this path.
      setupResults({ allStatuses: ['pending'] });
      mockPublishPost.mockRejectedValue(
        new Error('pinterest API error (400): Sorry! Something went wrong on our end.'),
      );

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 }, attemptsMade: 2, opts: { attempts: 3 } });

      expect(mockDbUpdateSets).toContainEqual(
        expect.objectContaining({ status: 'pending', retryCount: expect.anything() }),
      );
      expect(mockDbUpdateSets).not.toContainEqual(expect.objectContaining({ status: 'failed' }));
      expect(mockAddPublishJob).toHaveBeenCalledWith(1, 5 * 60_000);
      expect(mockAddNotificationJob).not.toHaveBeenCalled();
    });

    it('sends notification on thrown exception', async () => {
      setupResults({
        platforms: [makePostPlatform({ retryCount: 2, maxRetries: 3 })],
        allStatuses: ['failed'],
      });
      mockPublishPost.mockRejectedValue(new Error('Invalid image format'));

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockAddNotificationJob).toHaveBeenCalledWith(
        'user-1',
        'post_failed',
        expect.any(String),
        'Invalid image format',
        expect.objectContaining({ contentSnippet: 'Hello world!' }),
        1,
      );
    });

    it('a lost response (timeout) marks the platform unconfirmed — never retried', async () => {
      // 'Network timeout' means the request may have REACHED the platform; the
      // row must go terminal 'unconfirmed', not back to 'pending' for a retry
      // that could duplicate the post — even with retry budget remaining.
      setupResults({
        platforms: [makePostPlatform({ retryCount: 0, maxRetries: 3 })],
        allStatuses: ['unconfirmed'],
      });
      mockPublishPost.mockRejectedValue(new Error('Network timeout'));

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockDbUpdateSets).toContainEqual(
        expect.objectContaining({ status: 'unconfirmed', errorMessage: expect.stringContaining('could not confirm') }),
      );
      expect(mockDbUpdateSets).not.toContainEqual(expect.objectContaining({ status: 'pending' }));
      // No delayed re-publish is scheduled for an unknown outcome.
      expect(mockAddPublishJob).not.toHaveBeenCalled();
      expect(mockAddNotificationJob).toHaveBeenCalledWith(
        'user-1',
        'post_failed',
        expect.stringContaining("Couldn't confirm"),
        expect.stringContaining('could not confirm'),
        expect.objectContaining({ postId: 1 }),
        1,
      );
    });

    it('an aborted publish (returned error) also goes unconfirmed', async () => {
      setupResults({
        platforms: [makePostPlatform({ retryCount: 0, maxRetries: 3 })],
        allStatuses: ['unconfirmed'],
      });
      mockPublishPost.mockResolvedValue({ success: false, error: 'The operation was aborted' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockDbUpdateSets).toContainEqual(
        expect.objectContaining({ status: 'unconfirmed' }),
      );
      expect(mockAddPublishJob).not.toHaveBeenCalled();
    });
  });

  describe('needsReconnect writeback (dead token → channel shows Reconnect)', () => {
    it('flags the channel on an HTTP 401 auth failure', async () => {
      setupResults({ allStatuses: ['failed'] });
      mockPublishPost.mockResolvedValue({ success: false, error: 'x API error (401): Unauthorized' });
      // The 401 path attempts a token refresh first; simulate that yielding nothing.
      mockRefreshToken.mockResolvedValue(null);

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockDbUpdateSets).toContainEqual(expect.objectContaining({ needsReconnect: true }));
    });

    it('flags the channel when the handler signals authExpired (e.g. Facebook 190)', async () => {
      setupResults({ allStatuses: ['failed'] });
      mockPublishPost.mockResolvedValue({ success: false, error: 'Access token expired. Please reconnect.', authExpired: true });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockDbUpdateSets).toContainEqual(expect.objectContaining({ needsReconnect: true }));
    });

    it('flags the channel when a handler throws an auth error', async () => {
      setupResults({ allStatuses: ['failed'] });
      mockPublishPost.mockRejectedValue(new Error('linkedin API error (401): Invalid access token'));

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockDbUpdateSets).toContainEqual(expect.objectContaining({ needsReconnect: true }));
    });

    it('does NOT flag the channel on a content / rate-limit error', async () => {
      setupResults({ allStatuses: ['failed'] });
      mockPublishPost.mockResolvedValue({ success: false, error: 'Rate limit exceeded' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockDbUpdateSets).not.toContainEqual(expect.objectContaining({ needsReconnect: true }));
    });

    it('fast-fails without calling the platform when the channel already needs reconnect', async () => {
      setupResults({ channels: [makeChannel({ needsReconnect: true })], allStatuses: ['failed'] });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockPublishPost).not.toHaveBeenCalled();
      expect(mockDbUpdateSets).toContainEqual(
        expect.objectContaining({ status: 'failed', errorMessage: expect.stringContaining('reconnect') }),
      );
      // No new notification — the user was alerted when it first broke.
      expect(mockAddNotificationJob).not.toHaveBeenCalled();
    });
  });

  describe('processing result (async platforms)', () => {
    it('sets postPlatform to processing and queues status check', async () => {
      setupResults({ allStatuses: ['processing'] });
      mockPublishPost.mockResolvedValue({
        success: true,
        processing: true,
        processingId: 'proc-123',
      });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockDbUpdateSets).toContainEqual(
        expect.objectContaining({ status: 'processing', platformPostId: 'proc-123' }),
      );

      expect(mockAddStatusCheckJob).toHaveBeenCalledWith(
        100,        // postPlatformId
        'x',        // platform
        'proc-123', // processingId
        10,         // channelId
      );
    });

    it('persists the permalink on a processing result when the platform provides one at publish time', async () => {
      // YouTube knows the final watch URL immediately even though the video is
      // still processing — it must be saved now so the calendar link works.
      setupResults({ allStatuses: ['processing'] });
      mockPublishPost.mockResolvedValue({
        success: true,
        processing: true,
        processingId: 'yt-vid',
        url: 'https://www.youtube.com/watch?v=yt-vid',
      });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockDbUpdateSets).toContainEqual(
        expect.objectContaining({
          status: 'processing',
          platformPostId: 'yt-vid',
          platformUrl: 'https://www.youtube.com/watch?v=yt-vid',
        }),
      );
    });

    it('omits platformUrl on a processing result when the platform has no url yet', async () => {
      setupResults({ allStatuses: ['processing'] });
      mockPublishPost.mockResolvedValue({
        success: true,
        processing: true,
        processingId: 'proc-123',
      });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      const processingSet = mockDbUpdateSets.find(
        (s) => s.status === 'processing' && s.platformPostId === 'proc-123',
      );
      expect(processingSet).toBeDefined();
      expect(processingSet).not.toHaveProperty('platformUrl');
    });
  });

  describe('401 retry logic', () => {
    it('refreshes token and retries on 401 error', async () => {
      setupResults({ allStatuses: ['published'] });

      mockPublishPost
        .mockResolvedValueOnce({ success: false, error: '401 Unauthorized' })
        .mockResolvedValueOnce({ success: true, postId: 'p-1', url: 'https://x.com/1' });

      mockRefreshToken.mockResolvedValue({
        accessToken: 'fresh_access',
        refreshToken: 'fresh_refresh',
        expiresIn: 3600,
      });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      // Should have refreshed the token (accountType passed through for app selection)
      expect(mockRefreshToken).toHaveBeenCalledWith('dec_enc_refresh', undefined);

      // Should have published twice (original + retry)
      expect(mockPublishPost).toHaveBeenCalledTimes(2);

      // Should encrypt and store new tokens
      expect(mockEncrypt).toHaveBeenCalledWith('fresh_access');
      expect(mockEncrypt).toHaveBeenCalledWith('fresh_refresh');
    });

    it('does not retry 401 when no refresh token available', async () => {
      setupResults({
        channels: [makeChannel({ refreshToken: null })],
        allStatuses: ['failed'],
      });

      mockPublishPost.mockResolvedValue({
        success: false,
        error: '401 Unauthorized',
      });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockRefreshToken).not.toHaveBeenCalled();
      expect(mockPublishPost).toHaveBeenCalledTimes(1);
    });

    it('handles refresh token failure gracefully (no retry)', async () => {
      setupResults({ allStatuses: ['failed'] });

      mockPublishPost.mockResolvedValue({
        success: false,
        error: 'unauthorized request',
      });

      mockRefreshToken.mockRejectedValue(new Error('Invalid grant'));

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      // Refresh tried but failed; no retry of publish
      expect(mockPublishPost).toHaveBeenCalledTimes(1);
    });

    it('detects "unauthorized" (case-insensitive) as 401', async () => {
      setupResults({ allStatuses: ['published'] });

      mockPublishPost
        .mockResolvedValueOnce({ success: false, error: 'Unauthorized access to API' })
        .mockResolvedValueOnce({ success: true, postId: 'p-1' });

      mockRefreshToken.mockResolvedValue({ accessToken: 'new' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockRefreshToken).toHaveBeenCalled();
      expect(mockPublishPost).toHaveBeenCalledTimes(2);
    });

    it('refreshes and retries on Bluesky ExpiredToken (HTTP 400), not only on 401', async () => {
      // Bluesky reports an expired access JWT as HTTP 400 "ExpiredToken". It must trigger
      // the same on-demand refresh+retry as a 401 — otherwise a channel with a perfectly
      // valid refresh token self-bricks ~2h after connect and is mis-flagged needsReconnect.
      setupResults({ allStatuses: ['published'] });

      mockPublishPost
        .mockResolvedValueOnce({ success: false, error: 'bluesky API error (400): ExpiredToken' })
        .mockResolvedValueOnce({ success: true, postId: 'at://post/1' });

      mockRefreshToken.mockResolvedValue({
        accessToken: 'fresh_jwt',
        refreshToken: 'fresh_refresh_jwt',
      });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockRefreshToken).toHaveBeenCalled();
      expect(mockPublishPost).toHaveBeenCalledTimes(2);
      // The rotated refresh JWT is persisted so the refresh chain continues.
      expect(mockEncrypt).toHaveBeenCalledWith('fresh_refresh_jwt');
    });

    it('updates channel with new tokenExpiresAt from expiresIn', async () => {
      setupResults({ allStatuses: ['published'] });

      mockPublishPost
        .mockResolvedValueOnce({ success: false, error: '401' })
        .mockResolvedValueOnce({ success: true, postId: 'p-1' });

      mockRefreshToken.mockResolvedValue({
        accessToken: 'new_access',
        expiresIn: 7200,
      });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      // One of the update sets should include tokenExpiresAt
      const tokenUpdate = mockDbUpdateSets.find((s) => s.tokenExpiresAt instanceof Date);
      expect(tokenUpdate).toBeDefined();
      expect(tokenUpdate.accessToken).toBe('enc_new_access');
    });
  });

  describe('missing channel', () => {
    it('marks platform as failed when channel not found in map', async () => {
      // Channel with id=99 doesn't match any postPlatform's channelId=10
      setupResults({
        channels: [makeChannel({ id: 99 })], // different ID
        allStatuses: ['failed'],
      });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockPublishPost).not.toHaveBeenCalled();
      expect(mockDbUpdateSets).toContainEqual(
        expect.objectContaining({ status: 'failed', errorMessage: 'Channel not found' }),
      );
    });
  });

  describe('pre-publish validation', () => {
    it('marks platform as failed when validation fails', async () => {
      setupResults({ allStatuses: ['failed'] });

      mockValidateForPlatform.mockReturnValue([
        { field: 'content', message: 'Content too long for X (280 chars max)' },
      ]);

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockPublishPost).not.toHaveBeenCalled();
      expect(mockDbUpdateSets).toContainEqual(
        expect.objectContaining({
          status: 'failed',
          errorMessage: expect.stringContaining('280 chars max'),
        }),
      );
    });
  });

  describe('final status derivation', () => {
    it('sets post to published when all platforms are published', async () => {
      setupResults({
        platforms: [
          makePostPlatform({ id: 100 }),
          makePostPlatform({ id: 101, channelId: 20 }),
        ],
        channels: [makeChannel({ id: 10 }), makeChannel({ id: 20, platform: 'facebook' })],
        allStatuses: ['published', 'published'],
      });

      mockPublishPost.mockResolvedValue({ success: true, postId: 'p-1' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      // Final status should be 'published'
      const finalSet = mockDbUpdateSets[mockDbUpdateSets.length - 1];
      expect(finalSet.status).toBe('published');
      // COALESCE(publishedAt, NOW()) expression — preserves the first publish
      // time when this recomputes after a retry.
      expect(finalSet.publishedAt).toMatchObject({ _type: 'sql' });
    });

    it('sets post to partial when some published and some failed', async () => {
      setupResults({
        allStatuses: ['published', 'failed'],
      });

      mockPublishPost.mockResolvedValue({ success: true, postId: 'p-1' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      const finalSet = mockDbUpdateSets[mockDbUpdateSets.length - 1];
      expect(finalSet.status).toBe('partial');
    });

    it('sets post to failed when all platforms failed', async () => {
      setupResults({ allStatuses: ['failed'] });
      mockPublishPost.mockResolvedValue({ success: false, error: 'API error' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      const finalSet = mockDbUpdateSets[mockDbUpdateSets.length - 1];
      expect(finalSet.status).toBe('failed');
    });

    it('sets post to processing when all done with some processing', async () => {
      setupResults({ allStatuses: ['published', 'processing'] });
      mockPublishPost.mockResolvedValue({
        success: true,
        processing: true,
        processingId: 'proc-1',
      });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      const finalSet = mockDbUpdateSets[mockDbUpdateSets.length - 1];
      expect(finalSet.status).toBe('processing');
    });
  });

  describe('media cleanup', () => {
    it('triggers media cleanup when all published and deleteMediaAfterPublish is true', async () => {
      setupResults({
        post: makePost({ deleteMediaAfterPublish: true }),
        allStatuses: ['published'],
      });

      mockPublishPost.mockResolvedValue({ success: true, postId: 'p-1' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockAddMediaCleanupJob).toHaveBeenCalledWith(1);
    });

    it('does not trigger media cleanup when deleteMediaAfterPublish is false', async () => {
      setupResults({
        post: makePost({ deleteMediaAfterPublish: false }),
        allStatuses: ['published'],
      });

      mockPublishPost.mockResolvedValue({ success: true, postId: 'p-1' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockAddMediaCleanupJob).not.toHaveBeenCalled();
    });

    it('does not trigger media cleanup when status is partial', async () => {
      setupResults({
        post: makePost({ deleteMediaAfterPublish: true }),
        allStatuses: ['published', 'failed'],
      });

      mockPublishPost.mockResolvedValue({ success: true, postId: 'p-1' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockAddMediaCleanupJob).not.toHaveBeenCalled();
    });
  });

  describe('thread publishing', () => {
    it('delegates to publishThread for thread format posts', async () => {
      const threadPost = makePost({
        postFormat: 'thread',
        threadParts: [
          { content: 'Part 1', mediaFileIds: [] },
          { content: 'Part 2', mediaFileIds: [] },
        ],
      });

      mockDbSelectResults.push(
        [threadPost],                        // 0: post
        [makePostPlatform()],                // 1: postPlatforms
        [makeChannel()],                     // 2: channels
        [],                                  // 3: media for thread parts
        [{ status: 'published' }],           // 4: final statuses
      );

      mockPublishThread.mockResolvedValue({
        success: true,
        posts: [
          { sequence: 0, postId: 'thread-1', url: 'https://x.com/1' },
          { sequence: 1, postId: 'thread-2', url: 'https://x.com/2' },
        ],
      });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockPublishThread).toHaveBeenCalled();
      expect(mockPublishPost).not.toHaveBeenCalled();
    });

    it('blanks a non-string thread-part content instead of passing it to the handler', async () => {
      // Same jsonb trap as platform_content: a part stored as
      // {content: {…}} must not reach string handling in the handlers.
      const threadPost = makePost({
        postFormat: 'thread',
        threadParts: [
          { content: { text: 'nested object' }, mediaFileIds: [] },
          { content: 'Part 2', mediaFileIds: [] },
        ],
      });

      mockDbSelectResults.push(
        [threadPost],
        [makePostPlatform()],
        [makeChannel()],
        [],
        [{ status: 'published' }],
      );

      mockPublishThread.mockResolvedValue({
        success: true,
        posts: [{ sequence: 0, postId: 't1', url: 'https://x.com/1' }],
      });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockPublishThread).toHaveBeenCalledTimes(1);
      const [segments] = mockPublishThread.mock.calls[0];
      expect(segments[0].content).toBe('');
      expect(segments[1].content).toBe('Part 2');
    });

    it('sends notification when thread publish fails', async () => {
      const threadPost = makePost({
        postFormat: 'thread',
        threadParts: [{ content: 'Part 1', mediaFileIds: [] }],
      });

      mockDbSelectResults.push(
        [threadPost],
        // Transient error + exhausted auto-republish budget → visible failure.
        [makePostPlatform({ retryCount: 2, maxRetries: 3 })],
        [makeChannel()],
        [],
        [{ status: 'failed' }],
      );

      mockPublishThread.mockResolvedValue({
        success: false,
        error: 'Thread rate limited',
      });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockAddNotificationJob).toHaveBeenCalledWith(
        'user-1',
        'post_failed',
        expect.stringContaining('thread'),
        'Thread rate limited',
        expect.objectContaining({ postId: 1, platform: 'x' }),
        1,
      );
    });
  });

  describe('failure persistence', () => {
    it('preserves prior threadPostIds when a resumed thread retry fails before posting anything', async () => {
      const priorPosts = [
        { sequence: 0, postId: 'thread-1', url: 'https://x.com/1' },
        { sequence: 1, postId: 'thread-2', url: 'https://x.com/2' },
      ];
      const threadPost = makePost({
        postFormat: 'thread',
        threadParts: [
          { content: 'Part 1', mediaFileIds: [] },
          { content: 'Part 2', mediaFileIds: [] },
          { content: 'Part 3', mediaFileIds: [] },
        ],
      });

      mockDbSelectResults.push(
        [threadPost],
        // 'network blip' is transient — exhaust the auto-republish budget so
        // the failure write (whose threadPostIds handling is under test) runs.
        [makePostPlatform({ threadPostIds: priorPosts, retryCount: 2, maxRetries: 3 })],
        [makeChannel()],
        [],
        [{ status: 'failed' }],
      );

      // Failure before any new segment posted — handler returns no posts at all
      mockPublishThread.mockResolvedValue({ success: false, error: 'network blip' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      // Resume state passed to the handler...
      expect(mockPublishThread.mock.calls[0][2]).toEqual(priorPosts);
      // ...and NOT wiped by the failure write (or the next retry re-posts parts 1-2).
      const failedSet = mockDbUpdateSets.find((s) => s.status === 'failed');
      expect(failedSet.threadPostIds).toEqual(priorPosts);
    });

    it('persists a fallback errorMessage when the handler fails without an error string', async () => {
      setupResults({ allStatuses: ['failed'] });
      mockPublishPost.mockResolvedValue({ success: false });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      const failedSet = mockDbUpdateSets.find((s) => s.status === 'failed');
      expect(failedSet.errorMessage).toBe('Publishing failed');
    });

    it('fails (not strands) a processing result that has no processingId or postId', async () => {
      setupResults({ allStatuses: ['failed'] });
      mockPublishPost.mockResolvedValue({ success: true, processing: true });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      const failedSet = mockDbUpdateSets.find((s) => s.status === 'failed');
      expect(failedSet).toBeTruthy();
      expect(failedSet.errorMessage).toContain('no id');
      expect(mockDbUpdateSets.find((s) => s.status === 'processing')).toBeUndefined();
    });
  });

  describe('activity logging', () => {
    it('logs activity with correct action on success', async () => {
      setupResults({ allStatuses: ['published'] });
      mockPublishPost.mockResolvedValue({ success: true, postId: 'p-1' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          organizationId: 1,
          action: 'post.published',
          resourceId: 1,
          level: 'info',
        }),
      );
    });

    it('logs activity with error level on failure', async () => {
      setupResults({ allStatuses: ['failed'] });
      mockPublishPost.mockResolvedValue({ success: false, error: 'err' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'post.publish_failed',
          level: 'error',
        }),
      );
    });

    it('logs activity with warning level on partial', async () => {
      setupResults({ allStatuses: ['published', 'failed'] });
      mockPublishPost.mockResolvedValue({ success: true, postId: 'p-1' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'post.partially_published',
          level: 'warning',
        }),
      );
    });
  });

  describe('media handling', () => {
    // A post that references media must publish WITH that media. Resolution used
    // to `.filter(Boolean)` away anything missing, so a media-optional platform
    // silently published the post as text — under the user's name, with no
    // error anywhere. These pin the abort.
    describe('attached media unavailable', () => {
      const goodRow = {
        id: 1,
        originalPath: 'original/img.jpg',
        mimeType: 'image/jpeg',
        width: 800,
        height: 600,
        duration: null,
        sizeBytes: 50000,
        thumbnailPath: 'thumb/img.jpg',
        organizationId: 1,
        isOriginalDeleted: false,
      };

      it('fails the post when an attached media row no longer exists', async () => {
        setupResults({
          post: makePost({ mediaFiles: [1, 2] }),
          mediaRows: [goodRow], // id 2 was deleted from the library
          allStatuses: ['failed'],
        });

        await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

        expect(mockPublishPost).not.toHaveBeenCalled();
        expect(mockDbUpdateSets).toContainEqual(
          expect.objectContaining({
            status: 'failed',
            errorMessage: expect.stringContaining('no longer in the media library'),
          }),
        );
        // The id the user needs in order to fix it must be in the message.
        expect(mockDbUpdateSets).toContainEqual(
          expect.objectContaining({ errorMessage: expect.stringContaining('id 2') }),
        );
      });

      it('fails the post when the original bytes were swept by retention', async () => {
        setupResults({
          post: makePost({ mediaFiles: [1] }),
          mediaRows: [{ ...goodRow, isOriginalDeleted: true }],
          allStatuses: ['failed'],
        });

        await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

        // The row resolves, so the old code handed the platform a dead R2 URL
        // and failed with something unrelated to the real cause.
        expect(mockPublishPost).not.toHaveBeenCalled();
        expect(mockDbUpdateSets).toContainEqual(
          expect.objectContaining({
            status: 'failed',
            errorMessage: expect.stringContaining('retention sweep'),
          }),
        );
      });

      it('publishes normally when every attached media file resolves', async () => {
        setupResults({
          post: makePost({ mediaFiles: [1] }),
          mediaRows: [goodRow],
          allStatuses: ['published'],
        });
        mockPublishPost.mockResolvedValue({ success: true, postId: 'p-1' });

        await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

        expect(mockPublishPost).toHaveBeenCalled();
      });

      it('leaves a genuinely text-only post alone', async () => {
        // No media referenced at all — the guard must not fire.
        setupResults({ post: makePost({ mediaFiles: [] }), allStatuses: ['published'] });
        mockPublishPost.mockResolvedValue({ success: true, postId: 'p-1' });

        await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

        expect(mockPublishPost).toHaveBeenCalled();
      });
    });

    it('resolves media files from DB and builds MediaFileData', async () => {
      const mediaRow = {
        id: 1,
        originalPath: 'original/img.jpg',
        mimeType: 'image/jpeg',
        width: 800,
        height: 600,
        duration: null,
        sizeBytes: 50000,
        thumbnailPath: 'thumb/img.jpg',
        organizationId: 1,
      };

      setupResults({
        post: makePost({ mediaFiles: [1] }),
        mediaRows: [mediaRow],
        allStatuses: ['published'],
      });

      mockPublishPost.mockResolvedValue({ success: true, postId: 'p-1' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      const publishCall = mockPublishPost.mock.calls[0];
      const postData = publishCall[0];
      expect(postData.mediaFiles).toHaveLength(1);
      expect(postData.mediaFiles[0]).toEqual(
        expect.objectContaining({
          url: expect.stringContaining('original/img.jpg'),
          mimeType: 'image/jpeg',
          width: 800,
          height: 600,
        }),
      );
    });

    it('materializes R2 media to a local file for push-based platforms (LinkedIn)', async () => {
      setupResults({
        post: makePost({ mediaFiles: [1] }),
        platforms: [makePostPlatform({ platform: 'linkedin' })],
        channels: [makeChannel({ platform: 'linkedin' })],
        mediaRows: [{ id: 1, originalPath: 'original/43/img.png', mimeType: 'image/png', width: 100, height: 100, sizeBytes: 1000, organizationId: 1 }],
        allStatuses: ['published'],
      });
      mockPublishPost.mockResolvedValue({ success: true, postId: 'p-1' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      // The R2 object was downloaded and the handler got a local temp path, not the key.
      expect(mockDownloadFromR2).toHaveBeenCalledWith('original/43/img.png');
      const postData = mockPublishPost.mock.calls[0][0];
      expect(postData.mediaFiles[0].localPath).not.toBe('original/43/img.png');
      expect(postData.mediaFiles[0].localPath).toContain('pub-');
      // URL is unchanged (still the R2 public URL).
      expect(postData.mediaFiles[0].url).toContain('original/43/img.png');
    });

    it('does not download media for pull-based platforms (Facebook)', async () => {
      setupResults({
        post: makePost({ mediaFiles: [1] }),
        platforms: [makePostPlatform({ platform: 'facebook' })],
        channels: [makeChannel({ platform: 'facebook' })],
        mediaRows: [{ id: 1, originalPath: 'original/43/img.png', mimeType: 'image/png', width: 100, height: 100, sizeBytes: 1000, organizationId: 1 }],
        allStatuses: ['published'],
      });
      mockPublishPost.mockResolvedValue({ success: true, postId: 'p-1' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockDownloadFromR2).not.toHaveBeenCalled();
      const postData = mockPublishPost.mock.calls[0][0];
      expect(postData.mediaFiles[0].localPath).toBe('original/43/img.png');
    });

    it('schedules delayed cleanup of on-the-fly format conversions after publish', async () => {
      // Platform needs JPEG and the stored original is WebP → convertImageIfNeeded
      // produces a transient converted/ object that must be swept post-publish.
      mockImageMediaRules = { formats: ['jpg'], maxDimension: undefined };
      mockConvertImageIfNeeded.mockResolvedValue({
        localPath: 'converted/img-abc.jpg',
        mimeType: 'image/jpeg',
        url: 'https://cdn.example.com/converted/img-abc.jpg',
      });

      setupResults({
        post: makePost({ mediaFiles: [1] }),
        mediaRows: [{ id: 1, originalPath: 'original/1/img.webp', mimeType: 'image/webp', width: 1000, height: 800, sizeBytes: 50000, organizationId: 1 }],
        allStatuses: ['published'],
      });
      mockPublishPost.mockResolvedValue({ success: true, postId: 'p-1' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockAddMediaDeleteJob).toHaveBeenCalledTimes(1);
      const [keys, delayMs] = mockAddMediaDeleteJob.mock.calls[0];
      expect(keys).toEqual(['converted/img-abc.jpg']);
      expect(delayMs).toBe(15 * 60 * 1000);
    });

    /**
     * Regression: posts 681/682 failed live with Pinterest
     * `400 The format of the image is not supported`. Every poster derivative
     * we generate is WebP (media/thumbnail.ts), and Pinterest/Reddit accept
     * JPEG/PNG only for a video cover — so the poster handed to the handler
     * has to be converted first.
     */
    describe('video poster format conversion', () => {
      const videoRow = {
        id: 1,
        originalPath: 'original/1/clip.mp4',
        mimeType: 'video/mp4',
        largePath: 'large/1/clip-poster.webp',
        width: 1080,
        height: 1920,
        sizeBytes: 900000,
        organizationId: 1,
      };

      it('converts a WebP poster when the platform accepts only JPEG/PNG', async () => {
        mockImageMediaRules = { formats: ['jpg', 'jpeg', 'png'], maxDimension: undefined };
        mockConvertImageIfNeeded.mockResolvedValue({
          localPath: 'converted/clip-poster-abc.jpg',
          mimeType: 'image/jpeg',
          url: 'https://cdn.example.com/converted/clip-poster-abc.jpg',
        });

        setupResults({
          post: makePost({ mediaFiles: [1] }),
          mediaRows: [videoRow],
          allStatuses: ['published'],
        });
        mockPublishPost.mockResolvedValue({ success: true, postId: 'p-1' });

        await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

        // The handler must never see the .webp poster.
        const postData = mockPublishPost.mock.calls[0][0];
        expect(postData.mediaFiles[0].posterUrl).toBe('https://cdn.example.com/converted/clip-poster-abc.jpg');
        // Converted from the poster derivative, not the video itself.
        expect(mockConvertImageIfNeeded).toHaveBeenCalledWith(
          'large/1/clip-poster.webp',
          'image/webp',
          ['jpg', 'jpeg', 'png'],
        );
        // And the transient object is swept like any other conversion.
        expect(mockAddMediaDeleteJob.mock.calls[0][0]).toContain('converted/clip-poster-abc.jpg');
      });

      it('leaves the poster alone when the platform accepts WebP', async () => {
        mockImageMediaRules = { formats: ['jpg', 'png', 'webp'], maxDimension: undefined };

        setupResults({
          post: makePost({ mediaFiles: [1] }),
          mediaRows: [videoRow],
          allStatuses: ['published'],
        });
        mockPublishPost.mockResolvedValue({ success: true, postId: 'p-1' });

        await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

        const postData = mockPublishPost.mock.calls[0][0];
        expect(postData.mediaFiles[0].posterUrl).toBe('https://cdn.example.com/large/1/clip-poster.webp');
        expect(mockConvertImageIfNeeded).not.toHaveBeenCalled();
      });

      it('falls back to the original poster when conversion throws', async () => {
        // Losing the cover is better than losing the post — the handler's own
        // "needs a cover image" error is the worst case, not a crash here.
        mockImageMediaRules = { formats: ['jpg', 'jpeg', 'png'], maxDimension: undefined };
        mockConvertImageIfNeeded.mockRejectedValue(new Error('sharp exploded'));

        setupResults({
          post: makePost({ mediaFiles: [1] }),
          mediaRows: [videoRow],
          allStatuses: ['published'],
        });
        mockPublishPost.mockResolvedValue({ success: true, postId: 'p-1' });

        await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

        const postData = mockPublishPost.mock.calls[0][0];
        expect(postData.mediaFiles[0].posterUrl).toBe('https://cdn.example.com/large/1/clip-poster.webp');
      });

      it('exposes no poster for a video that has no derivative yet', async () => {
        mockImageMediaRules = { formats: ['jpg', 'jpeg', 'png'], maxDimension: undefined };

        setupResults({
          post: makePost({ mediaFiles: [1] }),
          mediaRows: [{ ...videoRow, largePath: null, previewPath: null, thumbnailPath: null }],
          allStatuses: ['published'],
        });
        mockPublishPost.mockResolvedValue({ success: true, postId: 'p-1' });

        await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

        const postData = mockPublishPost.mock.calls[0][0];
        expect(postData.mediaFiles[0].posterUrl).toBeUndefined();
        expect(mockConvertImageIfNeeded).not.toHaveBeenCalled();
      });
    });

    it('does not schedule conversion cleanup when no conversion happened', async () => {
      // Default rules don't require conversion → nothing transient to sweep.
      setupResults({
        post: makePost({ mediaFiles: [1] }),
        mediaRows: [{ id: 1, originalPath: 'original/1/img.webp', mimeType: 'image/webp', width: 100, height: 100, sizeBytes: 5000, organizationId: 1 }],
        allStatuses: ['published'],
      });
      mockPublishPost.mockResolvedValue({ success: true, postId: 'p-1' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockAddMediaDeleteJob).not.toHaveBeenCalled();
    });

    it('handles media IDs stored as objects (legacy format)', async () => {
      setupResults({
        post: makePost({ mediaFiles: [{ id: 1 }, { id: 2 }] }),
        mediaRows: [
          { id: 1, originalPath: 'original/1.jpg', mimeType: 'image/jpeg', width: 100, height: 100, sizeBytes: 1000, organizationId: 1 },
          { id: 2, originalPath: 'original/2.jpg', mimeType: 'image/png', width: 200, height: 200, sizeBytes: 2000, organizationId: 1 },
        ],
        allStatuses: ['published'],
      });

      mockPublishPost.mockResolvedValue({ success: true, postId: 'p-1' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      const postData = mockPublishPost.mock.calls[0][0];
      expect(postData.mediaFiles).toHaveLength(2);
    });

    it('includes thumbnail in failure notification when media present', async () => {
      const mediaRow = {
        id: 1,
        originalPath: 'original/img.jpg',
        thumbnailPath: 'thumb/img.jpg',
        mimeType: 'image/jpeg',
        width: 100,
        height: 100,
        sizeBytes: 5000,
        organizationId: 1,
      };

      setupResults({
        post: makePost({ mediaFiles: [1] }),
        mediaRows: [mediaRow],
        allStatuses: ['failed'],
      });

      mockPublishPost.mockResolvedValue({ success: false, error: 'API error' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockAddNotificationJob).toHaveBeenCalledWith(
        expect.any(String),
        'post_failed',
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          thumbnailUrl: expect.stringContaining('thumb/img.jpg'),
        }),
        expect.any(Number),
      );
    });

    it('uses originalPath as thumbnail fallback when no thumbnailPath', async () => {
      const mediaRow = {
        id: 1,
        originalPath: 'original/img.jpg',
        thumbnailPath: null,
        mimeType: 'image/jpeg',
        width: 100,
        height: 100,
        sizeBytes: 5000,
        organizationId: 1,
      };

      setupResults({
        post: makePost({ mediaFiles: [1] }),
        mediaRows: [mediaRow],
        allStatuses: ['failed'],
      });

      mockPublishPost.mockResolvedValue({ success: false, error: 'Failed' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      expect(mockAddNotificationJob).toHaveBeenCalledWith(
        expect.any(String),
        'post_failed',
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          thumbnailUrl: expect.stringContaining('original/img.jpg'),
        }),
        expect.any(Number),
      );
    });
  });

  describe('concurrent multi-platform publishing', () => {
    it('publishes to all 3 platforms concurrently', async () => {
      setupResults({
        platforms: [
          makePostPlatform({ id: 100, channelId: 10, platform: 'x' }),
          makePostPlatform({ id: 101, channelId: 20, platform: 'facebook' }),
          makePostPlatform({ id: 102, channelId: 30, platform: 'tiktok' }),
        ],
        channels: [
          makeChannel({ id: 10, platform: 'x' }),
          makeChannel({ id: 20, platform: 'facebook' }),
          makeChannel({ id: 30, platform: 'tiktok' }),
        ],
        allStatuses: ['published', 'published', 'published'],
      });

      mockPublishPost.mockResolvedValue({ success: true, postId: 'p-1' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      // All 3 platform handlers should have been called
      expect(mockPublishPost).toHaveBeenCalledTimes(3);

      // All 3 should be marked published
      const publishedUpdates = mockDbUpdateSets.filter(
        (s) => s.status === 'published' && s.platformPostId,
      );
      expect(publishedUpdates).toHaveLength(3);

      // Final post status should be published
      const finalSet = mockDbUpdateSets[mockDbUpdateSets.length - 1];
      expect(finalSet.status).toBe('published');
    });

    it('isolates failures — one platform failing does not abort others', async () => {
      setupResults({
        platforms: [
          makePostPlatform({ id: 100, channelId: 10, platform: 'x' }),
          makePostPlatform({ id: 101, channelId: 20, platform: 'facebook' }),
        ],
        channels: [
          makeChannel({ id: 10, platform: 'x' }),
          makeChannel({ id: 20, platform: 'facebook' }),
        ],
        allStatuses: ['published', 'failed'],
      });

      // First call succeeds, second throws
      mockPublishPost
        .mockResolvedValueOnce({ success: true, postId: 'p-1', url: 'https://x.com/1' })
        .mockRejectedValueOnce(new Error('Facebook API down'));

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      // Both platform handlers should have been called
      expect(mockPublishPost).toHaveBeenCalledTimes(2);

      // Should have one published and one failed update
      expect(mockDbUpdateSets).toContainEqual(
        expect.objectContaining({ status: 'published', platformPostId: 'p-1' }),
      );
      expect(mockDbUpdateSets).toContainEqual(
        expect.objectContaining({ status: 'failed', errorMessage: 'Facebook API down' }),
      );

      // Final status should be partial
      const finalSet = mockDbUpdateSets[mockDbUpdateSets.length - 1];
      expect(finalSet.status).toBe('partial');
    });
  });

  describe('link preview auto-detection', () => {
    it('sets linkPreview when content has URL and no media', async () => {
      setupResults({ allStatuses: ['published'] });
      mockExtractFirstUrl.mockReturnValue('https://example.com/article');
      mockPublishPost.mockResolvedValue({ success: true, postId: 'p-1' });

      await capturedProcessor!({ name: 'publish-post', data: { postId: 1 } });

      const postData = mockPublishPost.mock.calls[0][0];
      expect(postData.linkPreview).toEqual(
        expect.objectContaining({ url: 'https://example.com/article' }),
      );
    });
  });
});
