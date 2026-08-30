/**
 * Queue helper tests.
 *
 * Tests webapp/src/lib/jobs/queue.ts covering:
 *   - QUEUE_NAMES constant values
 *   - addPublishJob adds job with correct name, data, and options
 *   - addStatusCheckJob adds job with delay and retry config
 *   - addMediaCleanupJob adds job with 60s delay
 *   - addNotificationJob adds job with correct payload
 *   - adds job with exponential backoff
 *   - addMetricsSyncJob routes to correct job name based on organizationId
 *   - getQueue creates and caches queues
 */

// ---------------------------------------------------------------------------
// Mocks BEFORE importing the module
// ---------------------------------------------------------------------------

const mockQueueAdd = vi.fn().mockResolvedValue({});
const mockQueueRemove = vi.fn().mockResolvedValue(1);

vi.mock('bullmq', () => {
  class MockQueue {
    name: string;
    add = mockQueueAdd;
    remove = mockQueueRemove;
    on = vi.fn();
    constructor(name: string, _opts: any) {
      this.name = name;
    }
  }
  class MockWorker {
    constructor() {}
  }
  return { Queue: MockQueue, Worker: MockWorker };
});

vi.mock('ioredis', () => {
  return {
    default: class MockIORedis {
      on = vi.fn().mockReturnThis();
      quit = vi.fn().mockResolvedValue('OK');
      constructor() {}
    },
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

export {};

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------

const {
  QUEUE_NAMES,
  getQueue,
  addPublishJob,
  addStatusCheckJob,
  addMediaCleanupJob,
  addNotificationJob,
  addMetricsSyncJob,
  addEngagementCheckJobs,
  removeRemainingEngagementChecks,
  engagementCheckJobId,
  ENGAGEMENT_CHECK_DELAYS_MS,
} = await import('@/lib/jobs/queue');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QUEUE_NAMES', () => {
  it('has all expected queue names', () => {
    expect(QUEUE_NAMES.PUBLISH).toBe('publish');
    expect(QUEUE_NAMES.STATUS_CHECK).toBe('status-check');
    expect(QUEUE_NAMES.TOKEN_REFRESH).toBe('token-refresh');
    expect(QUEUE_NAMES.MEDIA_CLEANUP).toBe('media-cleanup');
    expect(QUEUE_NAMES.NOTIFICATION).toBe('notification');
    expect(QUEUE_NAMES.RETENTION).toBe('retention');
    expect(QUEUE_NAMES.METRICS_SYNC).toBe('metrics-sync');
    expect(QUEUE_NAMES.ENGAGEMENT_CHECK).toBe('engagement-check');
  });
});

describe('getQueue', () => {
  it('returns a Queue instance', () => {
    const q = getQueue('test-queue');
    expect(q).toBeDefined();
    expect(q.add).toBeDefined();
  });

  it('caches queue instances for the same name', () => {
    const q1 = getQueue('cached-queue');
    const q2 = getQueue('cached-queue');
    expect(q1).toBe(q2);
  });

  it('creates separate instances for different names', () => {
    const q1 = getQueue('queue-a');
    const q2 = getQueue('queue-b');
    expect(q1).not.toBe(q2);
  });
});

describe('addPublishJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds a publish-post job with correct data', async () => {
    await addPublishJob(42);

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'publish-post',
      { postId: 42 },
      expect.objectContaining({
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      }),
    );
  });

  it('passes delay when provided', async () => {
    await addPublishJob(99, 30000);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'publish-post',
      { postId: 99 },
      expect.objectContaining({ delay: 30000 }),
    );
  });

  it('does not include delay when not provided', async () => {
    await addPublishJob(10);

    const options = mockQueueAdd.mock.calls[0][2];
    expect(options.delay).toBeUndefined();
  });
});

describe('addStatusCheckJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds a check-status job with correct data and retry config', async () => {
    await addStatusCheckJob(1, 'x', 'pub-123', 5);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'check-status',
      { postPlatformId: 1, platform: 'x', publishId: 'pub-123', channelId: 5 },
      expect.objectContaining({
        // Fast first check so async-finalized IG/Threads posts feel instant
        // to the user; 30 attempts × 3s fixed backoff = ~90s total budget.
        delay: 1000,
        attempts: 120,
        backoff: { type: 'fixed', delay: 3000 },
      }),
    );
  });
});

describe('addMediaCleanupJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds a cleanup-media job with 60s delay', async () => {
    await addMediaCleanupJob(7);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'cleanup-media',
      { postId: 7 },
      expect.objectContaining({ delay: 60000 }),
    );
  });
});

describe('addNotificationJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds a send-notification job with full payload', async () => {
    await addNotificationJob(
      'user-1',
      'post_failed',
      'Publish Failed',
      'Something went wrong',
      { postId: 3, platform: 'x' },
      10,
    );

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'send-notification',
      {
        userId: 'user-1',
        type: 'post_failed',
        title: 'Publish Failed',
        message: 'Something went wrong',
        data: { postId: 3, platform: 'x' },
        organizationId: 10,
      },
      expect.objectContaining({ removeOnComplete: 100 }),
    );
  });

  it('works without optional data and organizationId', async () => {
    await addNotificationJob('user-2', 'post_published', 'Done', 'OK');

    const payload = mockQueueAdd.mock.calls[0][1];
    expect(payload.data).toBeUndefined();
    expect(payload.organizationId).toBeUndefined();
  });
});

describe('addMetricsSyncJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses sync-metrics job name when organizationId is provided', async () => {
    await addMetricsSyncJob(42);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'sync-metrics',
      { organizationId: 42 },
      expect.any(Object),
    );
  });

  it('uses sync-all-metrics job name when organizationId is omitted', async () => {
    await addMetricsSyncJob();

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'sync-all-metrics',
      { organizationId: undefined },
      expect.any(Object),
    );
  });
});

describe('engagement check jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('schedules 4 delayed checks at 1h/6h/24h/72h with deterministic jobIds', async () => {
    await addEngagementCheckJobs(7);

    expect(mockQueueAdd).toHaveBeenCalledTimes(4);
    expect(ENGAGEMENT_CHECK_DELAYS_MS).toEqual([
      3_600_000, 21_600_000, 86_400_000, 259_200_000,
    ]);
    for (let i = 0; i < 4; i++) {
      expect(mockQueueAdd).toHaveBeenNthCalledWith(
        i + 1,
        'check-engagement',
        { postId: 7, checkNumber: i + 1 },
        expect.objectContaining({
          jobId: `engagement-7-${i + 1}`,
          delay: ENGAGEMENT_CHECK_DELAYS_MS[i],
          attempts: 2,
        }),
      );
    }
  });

  it('engagementCheckJobId builds the dedup key', () => {
    // Dashes, not colons — BullMQ rejects ':' in a custom job id.
    expect(engagementCheckJobId(12, 3)).toBe('engagement-12-3');
  });

  it('removeRemainingEngagementChecks removes only the not-yet-run checks', async () => {
    await removeRemainingEngagementChecks(7, 2);

    expect(mockQueueRemove).toHaveBeenCalledTimes(2);
    expect(mockQueueRemove).toHaveBeenCalledWith('engagement-7-3');
    expect(mockQueueRemove).toHaveBeenCalledWith('engagement-7-4');
  });

  it('removeRemainingEngagementChecks after the final check is a no-op', async () => {
    await removeRemainingEngagementChecks(7, 4);
    expect(mockQueueRemove).not.toHaveBeenCalled();
  });

  it('removeRemainingEngagementChecks swallows remove errors (best-effort)', async () => {
    mockQueueRemove.mockRejectedValueOnce(new Error('job is active'));
    await expect(removeRemainingEngagementChecks(7, 3)).resolves.toBeUndefined();
  });
});
