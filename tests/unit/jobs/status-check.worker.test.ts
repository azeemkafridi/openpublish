/**
 * Status check worker tests.
 *
 * Tests webapp/src/lib/jobs/status-check.worker.ts covering:
 *   - Updates postPlatform to published when platform confirms
 *   - Updates postPlatform to failed when platform reports failure
 *   - Throws error to trigger BullMQ retry when still processing
 *   - Marks failed after exhausting all attempts (timeout)
 *   - Skips already-resolved (published/failed) entries
 *   - Handles missing channel gracefully
 *   - Sends failure notification on platform failure
 *   - Sends failure notification on timeout
 *   - Updates overall post status after resolution
 *   - Logs activity for confirmed publishes
 */

// ---------------------------------------------------------------------------
// Mocks BEFORE importing the module
// ---------------------------------------------------------------------------

const mockDbSelectResults: any[][] = [];
const mockDbUpdateSets: any[] = [];
const mockUpdateClaims: any[][] = [];
let selectCallIdx = 0;

const mockDecrypt = vi.fn((v: string) => `dec_${v}`);
const mockCheckPublishStatus = vi.fn();
const mockPublishComment = vi.fn().mockResolvedValue({ success: true });
const mockAddNotificationJob = vi.fn().mockResolvedValue(undefined);
const mockAddMediaCleanupJob = vi.fn().mockResolvedValue(undefined);
const mockAddPublishJob = vi.fn().mockResolvedValue(undefined);
const mockLogActivity = vi.fn();
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
    }),
  };
}

// `where` is both awaitable (most call sites) and chainable into `.returning()`
// (the auto-republish claim on posts).
function buildUpdateChain() {
  return {
    set: vi.fn().mockImplementation((data: any) => {
      mockDbUpdateSets.push(data);
      const claimed = mockUpdateClaims.length ? mockUpdateClaims.shift() : [{ id: 10 }];
      return {
        where: vi.fn().mockImplementation(() => ({
          returning: vi.fn().mockResolvedValue(claimed),
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
  QUEUE_NAMES: { STATUS_CHECK: 'status-check' },
  addNotificationJob: (...args: any[]) => mockAddNotificationJob(...args),
  addMediaCleanupJob: (...args: any[]) => mockAddMediaCleanupJob(...args),
  addPublishJob: (...args: any[]) => mockAddPublishJob(...args),
}));

vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn().mockImplementation(() => buildSelectChain()),
    update: vi.fn().mockImplementation(() => buildUpdateChain()),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  postPlatforms: { id: 'id', postId: 'postId', status: 'status', retryCount: 'retryCount' },
  posts: { id: 'id', userId: 'userId', organizationId: 'organizationId', status: 'status', deleteMediaAfterPublish: 'deleteMediaAfterPublish' },
  channels: { id: 'id', organizationId: 'organizationId' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ _type: 'eq', a })),
  and: vi.fn((...a: any[]) => ({ _type: 'and', a })),
  ne: vi.fn((...a: any[]) => ({ _type: 'ne', a })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...v: any[]) => ({ _type: 'sql', strings, v })),
    { raw: (x: any) => x },
  ),
}));

vi.mock('@/lib/auth/crypto', () => ({
  decrypt: (v: string) => mockDecrypt(v),
}));

vi.mock('@/lib/platforms/registry', () => ({
  getPlatformHandler: () => ({
    checkPublishStatus: (...args: any[]) => mockCheckPublishStatus(...args),
    publishComment: (...args: any[]) => mockPublishComment(...args),
  }),
}));

vi.mock('@/lib/platforms/types', () => ({
  platformDisplayName: (p: string) => p.charAt(0).toUpperCase() + p.slice(1),
}));

vi.mock('@/lib/activity/log', () => ({
  logActivity: (...args: any[]) => mockLogActivity(...args),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

export {};

const { createStatusCheckWorker } = await import('@/lib/jobs/status-check.worker');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetState() {
  selectCallIdx = 0;
  mockDbSelectResults.length = 0;
  mockDbUpdateSets.length = 0;
  mockUpdateClaims.length = 0;
}

function makeJob(overrides: Record<string, any> = {}) {
  return {
    data: {
      postPlatformId: 1, platform: 'tiktok',
      publishId: 'pub-123', channelId: 5,
      ...overrides,
    },
    attemptsMade: 0,
    opts: { attempts: 20 },
  };
}

function makePP(overrides: Record<string, any> = {}) {
  return { id: 1, postId: 10, channelId: 5, platform: 'tiktok', status: 'processing', ...overrides };
}

function makeChannel(overrides: Record<string, any> = {}) {
  return {
    id: 5, platform: 'tiktok', accountId: 'acc-1', accountName: 'TikTokAccount',
    accountType: null, accessToken: 'enc_access', refreshToken: 'enc_refresh',
    metadata: {}, ...overrides,
  };
}

function makePost(overrides: Record<string, any> = {}) {
  return { id: 10, userId: 'user-1', organizationId: 1, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('status-check worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
    capturedProcessor = null;
    createStatusCheckWorker();
  });

  it('updates to published when platform confirms', async () => {
    mockDbSelectResults.push(
      [makePP()],                                     // postPlatform
      [makePost()],                                   // post (for org check)
      [makeChannel()],                                // channel
      [{ status: 'published' }],                      // updatePostStatus: all platforms
    );

    mockCheckPublishStatus.mockResolvedValue({
      status: 'published',
      postId: 'final-post-id',
      url: 'https://tiktok.com/@user/video/123',
    });

    await capturedProcessor!(makeJob());

    expect(mockDbUpdateSets).toContainEqual(
      expect.objectContaining({
        status: 'published',
        platformPostId: 'final-post-id',
        platformUrl: 'https://tiktok.com/@user/video/123',
      }),
    );

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'post.status_confirmed' }),
    );
  });

  it('does not overwrite an existing platformUrl when checkStatus returns no url', async () => {
    // YouTube saves the permalink at publish time and its checkPublishStatus
    // returns no `url` on completion — the update must omit platformUrl so the
    // already-saved link is preserved rather than nulled out.
    mockDbSelectResults.push(
      [makePP({ platform: 'youtube' })],
      [makePost()],
      [makeChannel()],
      [{ status: 'published' }],
    );

    mockCheckPublishStatus.mockResolvedValue({
      status: 'published',
      postId: 'yt-video-id',
      // no url
    });

    await capturedProcessor!(makeJob());

    const publishedSet = mockDbUpdateSets.find(
      (s: any) => s.status === 'published',
    );
    expect(publishedSet).toBeDefined();
    expect(publishedSet).not.toHaveProperty('platformUrl');
  });

  it('updates to failed when platform reports failure', async () => {
    mockDbSelectResults.push(
      [makePP()],
      [makePost()],                  // post (for org check)
      [makeChannel()],
      [{ status: 'failed' }],       // updatePostStatus
    );

    mockCheckPublishStatus.mockResolvedValue({
      status: 'failed',
      message: 'Video processing failed',
    });

    await capturedProcessor!(makeJob());

    expect(mockDbUpdateSets).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        errorMessage: 'Video processing failed',
      }),
    );

    expect(mockAddNotificationJob).toHaveBeenCalledWith(
      'user-1',
      'post_failed',
      expect.stringContaining('Tiktok'),
      'Video processing failed',
      expect.objectContaining({ postId: 10, platform: 'tiktok' }),
      1,
    );
  });

  // Regression: TikTok reported `fail_reason: internal` — which its own docs call
  // retryable — and we terminally failed the post and emailed the user. The same
  // media published fine when the user pressed Retry by hand.
  it('re-publishes automatically on a retryable platform failure', async () => {
    mockDbSelectResults.push(
      [makePP({ retryCount: 0, maxRetries: 3 })],
      [makePost()],
      [makeChannel()],
    );

    mockCheckPublishStatus.mockResolvedValue({
      status: 'failed',
      message: 'TikTok had a temporary problem on their side while processing this post.',
      retryable: true,
    });

    await capturedProcessor!(makeJob());

    // Row goes back to pending (so the re-publish picks it up) with the dead
    // publish id cleared, and the post is re-claimed as 'publishing'.
    expect(mockDbUpdateSets).toContainEqual(
      expect.objectContaining({ status: 'pending', platformPostId: null }),
    );
    expect(mockDbUpdateSets).toContainEqual(
      expect.objectContaining({ status: 'publishing' }),
    );

    // Delayed, and inside publish.worker's 15-min stuck-reclaim window.
    expect(mockAddPublishJob).toHaveBeenCalledWith(10, 5 * 60_000);

    // Never marked failed, and the user is not told about a blip we're handling.
    expect(mockDbUpdateSets).not.toContainEqual(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(mockAddNotificationJob).not.toHaveBeenCalled();
  });

  it('does not enqueue a second publish job when the post claim is lost', async () => {
    // Two platforms of one post failing together: only the job that flips the
    // post to 'publishing' enqueues; the other row rides along as 'pending'.
    mockDbSelectResults.push(
      [makePP({ retryCount: 0, maxRetries: 3 })],
      [makePost()],
      [makeChannel()],
    );
    mockUpdateClaims.push([], []); // postPlatforms update, then a lost post claim

    mockCheckPublishStatus.mockResolvedValue({
      status: 'failed',
      message: 'temporary',
      retryable: true,
    });

    await capturedProcessor!(makeJob());

    expect(mockAddPublishJob).not.toHaveBeenCalled();
    expect(mockDbUpdateSets).toContainEqual(
      expect.objectContaining({ status: 'pending' }),
    );
  });

  it('stops auto-retrying once the budget is spent, leaving a manual retry', async () => {
    mockDbSelectResults.push(
      [makePP({ retryCount: 2, maxRetries: 3 })],
      [makePost()],
      [makeChannel()],
      [{ status: 'failed' }], // updatePostStatus
    );

    mockCheckPublishStatus.mockResolvedValue({
      status: 'failed',
      message: 'TikTok had a temporary problem on their side while processing this post.',
      retryable: true,
    });

    await capturedProcessor!(makeJob());

    expect(mockAddPublishJob).not.toHaveBeenCalled();
    expect(mockDbUpdateSets).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        errorMessage: expect.stringContaining('already retried 2 times'),
      }),
    );
    expect(mockAddNotificationJob).toHaveBeenCalled();
  });

  it('never auto-retries a terminal failure', async () => {
    mockDbSelectResults.push(
      [makePP({ retryCount: 0, maxRetries: 3 })],
      [makePost()],
      [makeChannel()],
      [{ status: 'failed' }],
    );

    mockCheckPublishStatus.mockResolvedValue({
      status: 'failed',
      message: 'TikTok rejected this file format.',
      // no retryable flag
    });

    await capturedProcessor!(makeJob());

    expect(mockAddPublishJob).not.toHaveBeenCalled();
    expect(mockDbUpdateSets).toContainEqual(
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('skips a row already reset to pending by a re-publish', async () => {
    mockDbSelectResults.push([makePP({ status: 'pending' })]);

    await capturedProcessor!(makeJob());

    expect(mockCheckPublishStatus).not.toHaveBeenCalled();
    expect(mockAddPublishJob).not.toHaveBeenCalled();
    expect(mockDbUpdateSets).toHaveLength(0);
  });

  it('throws error to trigger BullMQ retry when still processing', async () => {
    mockDbSelectResults.push(
      [makePP()],
      [makePost()],
      [makeChannel()],
    );

    mockCheckPublishStatus.mockResolvedValue({
      status: 'processing',
      message: 'Video is being processed',
    });

    const job = { ...makeJob(), attemptsMade: 5 };

    await expect(capturedProcessor!(job)).rejects.toThrow('Still processing');
  });

  it('marks failed after exhausting all attempts (timeout)', async () => {
    mockDbSelectResults.push(
      [makePP()],
      [makePost()],             // post (for org check)
      [makeChannel()],
      [{ status: 'failed' }],  // updatePostStatus
    );

    mockCheckPublishStatus.mockResolvedValue({
      status: 'processing',
      message: 'Still processing',
    });

    // attemptsMade = 19, attempts = 20 -> last attempt (19 >= 20-1)
    const job = { ...makeJob(), attemptsMade: 19, opts: { attempts: 20 } };

    await capturedProcessor!(job);

    expect(mockDbUpdateSets).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        errorMessage: expect.stringContaining('timed out'),
      }),
    );

    expect(mockAddNotificationJob).toHaveBeenCalledWith(
      'user-1',
      'post_failed',
      expect.any(String),
      expect.stringContaining('timed out'),
      expect.any(Object),
      1,
    );
  });

  it('marks failed when the status check throws on the final attempt (no stuck processing)', async () => {
    mockDbSelectResults.push(
      [makePP()],
      [makePost()],
      [makeChannel()],
      [{ status: 'failed' }],  // updatePostStatus
    );

    mockCheckPublishStatus.mockRejectedValue(new Error('platform 500'));

    const job = { ...makeJob(), attemptsMade: 19, opts: { attempts: 20 } };

    await capturedProcessor!(job);

    expect(mockDbUpdateSets).toContainEqual(
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('re-throws (to retry) when the status check throws on a non-final attempt', async () => {
    mockDbSelectResults.push(
      [makePP()],
      [makePost()],
      [makeChannel()],
    );

    mockCheckPublishStatus.mockRejectedValue(new Error('transient'));

    const job = { ...makeJob(), attemptsMade: 2, opts: { attempts: 20 } };

    await expect(capturedProcessor!(job)).rejects.toThrow('transient');
    expect(mockDbUpdateSets).not.toContainEqual(
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('skips already-published entries', async () => {
    mockDbSelectResults.push([makePP({ status: 'published' })]);

    await capturedProcessor!(makeJob());

    expect(mockCheckPublishStatus).not.toHaveBeenCalled();
    expect(mockDbUpdateSets).toHaveLength(0);
  });

  it('skips already-failed entries', async () => {
    mockDbSelectResults.push([makePP({ status: 'failed' })]);

    await capturedProcessor!(makeJob());

    expect(mockCheckPublishStatus).not.toHaveBeenCalled();
  });

  it('skips when postPlatform not found', async () => {
    mockDbSelectResults.push([]);

    await capturedProcessor!(makeJob());

    expect(mockCheckPublishStatus).not.toHaveBeenCalled();
  });

  it('handles missing channel by marking as failed', async () => {
    mockDbSelectResults.push(
      [makePP()],
      [makePost()],               // post (for org check)
      [],                         // channel not found
      [{ status: 'failed' }],    // updatePostStatus
    );

    await capturedProcessor!(makeJob());

    expect(mockDbUpdateSets).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        errorMessage: expect.stringContaining('Channel not found'),
      }),
    );
  });

  describe('updatePostStatus', () => {
    it('sets post to published when all platforms are published', async () => {
      mockDbSelectResults.push(
        [makePP()],
        [makePost()],
        [makeChannel()],
        [{ status: 'published' }, { status: 'published' }], // all published
      );

      mockCheckPublishStatus.mockResolvedValue({ status: 'published', postId: 'p-1' });

      await capturedProcessor!(makeJob());

      // publishedAt is a COALESCE(publishedAt, NOW()) expression, not a JS Date,
      // so re-running never overwrites the original publish time.
      const postStatusUpdate = mockDbUpdateSets.find(
        (s) => s.status === 'published' && s.publishedAt && !s.platformPostId,
      );
      expect(postStatusUpdate).toBeDefined();
      expect(postStatusUpdate!.publishedAt).toMatchObject({ _type: 'sql' });
    });

    it('sets post to partial when some published and some failed', async () => {
      mockDbSelectResults.push(
        [makePP()],
        [makePost()],
        [makeChannel()],
        [{ status: 'published' }, { status: 'failed' }],
      );

      mockCheckPublishStatus.mockResolvedValue({ status: 'published', postId: 'p-1' });

      await capturedProcessor!(makeJob());

      const postStatusUpdate = mockDbUpdateSets.find(
        (s) => s.status === 'partial',
      );
      expect(postStatusUpdate).toBeDefined();
    });

    it('posts first comment after async publish confirmation', async () => {
      mockDbSelectResults.push(
        [makePP()],
        [makePost({ platformSpecific: { _firstComment: 'Check out my bio!' } })],
        [makeChannel()],
        [{ status: 'published' }],
      );

      mockCheckPublishStatus.mockResolvedValue({
        status: 'published',
        postId: 'final-post-id',
      });

      await capturedProcessor!(makeJob());

      expect(mockPublishComment).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'acc-1' }),
        'final-post-id',
        'Check out my bio!',
      );
    });

    it('does not attempt first comment when platformSpecific has no _firstComment', async () => {
      mockDbSelectResults.push(
        [makePP()],
        [makePost({ platformSpecific: { someOtherField: true } })],
        [makeChannel()],
        [{ status: 'published' }],
      );

      mockCheckPublishStatus.mockResolvedValue({
        status: 'published',
        postId: 'final-post-id',
      });

      await capturedProcessor!(makeJob());

      expect(mockPublishComment).not.toHaveBeenCalled();
    });

    it('enqueues media cleanup when the async-finalized post has deleteMediaAfterPublish', async () => {
      // Regression: posts finalized by the status-check worker (async platforms like
      // TikTok/YouTube) used to skip the cleanup enqueue entirely, stranding media forever.
      mockDbSelectResults.push(
        [makePP()],
        [makePost()],
        [makeChannel()],
        [{ status: 'published' }, { status: 'published' }],   // updatePostStatus: all published
        [{ deleteMediaAfterPublish: true }],                  // post flag lookup
      );

      mockCheckPublishStatus.mockResolvedValue({ status: 'published', postId: 'p-1' });

      await capturedProcessor!(makeJob());

      expect(mockAddMediaCleanupJob).toHaveBeenCalledWith(10);
    });

    it('does not enqueue media cleanup when deleteMediaAfterPublish is false', async () => {
      mockDbSelectResults.push(
        [makePP()],
        [makePost()],
        [makeChannel()],
        [{ status: 'published' }],                            // updatePostStatus: all published
        [{ deleteMediaAfterPublish: false }],                 // post flag lookup
      );

      mockCheckPublishStatus.mockResolvedValue({ status: 'published', postId: 'p-1' });

      await capturedProcessor!(makeJob());

      expect(mockAddMediaCleanupJob).not.toHaveBeenCalled();
    });

    it('does not enqueue media cleanup on partial finalization', async () => {
      mockDbSelectResults.push(
        [makePP()],
        [makePost()],
        [makeChannel()],
        [{ status: 'published' }, { status: 'failed' }],      // partial
      );

      mockCheckPublishStatus.mockResolvedValue({ status: 'published', postId: 'p-1' });

      await capturedProcessor!(makeJob());

      expect(mockAddMediaCleanupJob).not.toHaveBeenCalled();
    });

    it('does not update post when some platforms are still processing', async () => {
      mockDbSelectResults.push(
        [makePP()],
        [makePost()],
        [makeChannel()],
        [{ status: 'published' }, { status: 'processing' }], // not all done
      );

      mockCheckPublishStatus.mockResolvedValue({ status: 'published', postId: 'p-1' });

      await capturedProcessor!(makeJob());

      // Should not have a post-level status update (only the pp update)
      const postUpdates = mockDbUpdateSets.filter(
        (s) => ['published', 'partial', 'failed'].includes(s.status) && !s.platformPostId && !s.errorMessage,
      );
      // The pp update has platformPostId, so filter should only match post-level updates.
      // Since not allDone, updatePostStatus returns early — no post update.
      expect(postUpdates).toHaveLength(0);
    });
  });
});
