// Scheduler tests.
//
// Tests webapp/src/lib/jobs/scheduler.ts covering:
//   - setupRecurringJobs registers all 7 recurring jobs
//   - Each job uses the correct queue name and cron pattern
//   - Token refresh runs every 40 minutes (*/40 cron), not every 6 hours
//   - Each job has correct removeOnComplete settings

// ---------------------------------------------------------------------------
// Mocks BEFORE importing the module
// ---------------------------------------------------------------------------

const mockQueueAdd = vi.fn().mockResolvedValue({});
const mockGetRepeatableJobs = vi.fn().mockResolvedValue([]);
const mockRemoveRepeatableByKey = vi.fn().mockResolvedValue(true);

vi.mock('@/lib/jobs/queue', () => {
  const queues = new Map<string, {
    add: typeof mockQueueAdd;
    getRepeatableJobs: typeof mockGetRepeatableJobs;
    removeRepeatableByKey: typeof mockRemoveRepeatableByKey;
  }>();
  return {
    QUEUE_NAMES: {
      PUBLISH: 'publish',
      STATUS_CHECK: 'status-check',
      TOKEN_REFRESH: 'token-refresh',
      MEDIA_CLEANUP: 'media-cleanup',
      NOTIFICATION: 'notification',
      RECURRING: 'recurring',
      WEBHOOK: 'webhook-deliver',
      RETENTION: 'retention',
      METRICS_SYNC: 'metrics-sync',
    },
    getQueue: (name: string) => {
      if (!queues.has(name)) {
        queues.set(name, {
          add: mockQueueAdd,
          getRepeatableJobs: mockGetRepeatableJobs,
          removeRepeatableByKey: mockRemoveRepeatableByKey,
        });
      }
      return queues.get(name)!;
    },
  };
});

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

const { setupRecurringJobs } = await import('@/lib/jobs/scheduler');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('setupRecurringJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers all 10 recurring jobs', async () => {
    await setupRecurringJobs();

    // 10 jobs: check-scheduled, refresh-expiring-tokens, process-recurring,
    // check-cleanup, sync-all-metrics, poll-feeds (RSS), snapshot-x-api-usage,
    // run-retention, sync-link-clicks, process-channel-slots
    expect(mockQueueAdd).toHaveBeenCalledTimes(10);
  });

  it('registers the shortlink click sync with a 15-minute cron', async () => {
    await setupRecurringJobs();

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'sync-link-clicks',
      {},
      expect.objectContaining({
        repeat: { pattern: '*/15 * * * *' },
      }),
    );
  });

  it('registers the RSS poller with a 15-minute cron', async () => {
    await setupRecurringJobs();

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'poll-feeds',
      {},
      expect.objectContaining({
        repeat: { pattern: '*/15 * * * *' },
      }),
    );
  });

  it('registers check-scheduled with every-minute cron', async () => {
    await setupRecurringJobs();

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'check-scheduled',
      {},
      expect.objectContaining({
        repeat: { pattern: '* * * * *' },
      }),
    );
  });

  it('registers token refresh with */40 cron pattern (every 40 minutes)', async () => {
    await setupRecurringJobs();

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'refresh-expiring-tokens',
      {},
      expect.objectContaining({
        repeat: { pattern: '*/40 * * * *' },
      }),
    );
  });

  it('does NOT use 6-hour cron for token refresh (bug fix)', async () => {
    await setupRecurringJobs();

    const tokenRefreshCall = mockQueueAdd.mock.calls.find(
      (call: any[]) => call[0] === 'refresh-expiring-tokens',
    );
    expect(tokenRefreshCall).toBeDefined();
    // Must NOT be a 6-hour pattern
    expect(tokenRefreshCall![2].repeat.pattern).not.toBe('0 */6 * * *');
    // Must be the 40-minute pattern
    expect(tokenRefreshCall![2].repeat.pattern).toBe('*/40 * * * *');
  });

  it('registers recurring schedule processor with every-minute cron', async () => {
    await setupRecurringJobs();

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'process-recurring',
      {},
      expect.objectContaining({
        repeat: { pattern: '* * * * *' },
      }),
    );
  });

  it('registers media cleanup with every-5-minutes cron', async () => {
    await setupRecurringJobs();

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'check-cleanup',
      {},
      expect.objectContaining({
        repeat: { pattern: '*/5 * * * *' },
      }),
    );
  });

  it('does NOT register daily digest (feature removed)', async () => {
    await setupRecurringJobs();

    const calls = mockQueueAdd.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).not.toContain('daily-digest');
  });

  it('registers the sync-all-metrics fan-out every 6 hours', async () => {
    await setupRecurringJobs();

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'sync-all-metrics',
      {},
      expect.objectContaining({
        repeat: { pattern: '30 */6 * * *' },
      }),
    );
  });

  it('registers daily X API usage snapshot at 3 AM UTC', async () => {
    await setupRecurringJobs();

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'snapshot-x-api-usage',
      {},
      expect.objectContaining({
        repeat: { pattern: '0 3 * * *' },
      }),
    );
  });

  it('registers data retention at 3 AM daily', async () => {
    await setupRecurringJobs();

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'run-retention',
      {},
      expect.objectContaining({
        repeat: { pattern: '0 3 * * *' },
        removeOnComplete: 3,
        removeOnFail: 10,
      }),
    );
  });
});
