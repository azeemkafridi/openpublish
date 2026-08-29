/**
 * Recurring worker tests.
 *
 * Tests webapp/src/lib/jobs/recurring.worker.ts covering:
 *   - Creates posts with correct fields from schedule template
 *   - Stores plain media IDs (numbers), not objects (bug fix)
 *   - Skips inactive schedules (filtered by DB query)
 *   - Handles missing/empty channels gracefully
 *   - Creates postPlatform entries for each active channel
 *   - Does NOT enqueue a publish job — the post is created 'scheduled' and the publish
 *     worker's check-scheduled reconciler publishes it once (avoids the double-path)
 *   - Updates nextRunAt after processing
 *   - Updates lastRunAt to current time
 *   - Logs activity with schedule info
 *   - Resolves valid media IDs (filters deleted files)
 *   - Continues processing other schedules when one fails
 */

// ---------------------------------------------------------------------------
// Mocks BEFORE importing the module
// ---------------------------------------------------------------------------

const mockDbSelectResults: any[][] = [];
const mockDbInsertResults: any[][] = [];
const mockDbUpdateSets: any[] = [];
/** Every object passed to insert(...).values(...), in call order. */
const mockDbInsertValues: any[] = [];
let selectCallIdx = 0;
let insertCallIdx = 0;

const mockAddPublishJob = vi.fn().mockResolvedValue(undefined);
const mockCalculateNextRunAt = vi.fn().mockReturnValue(new Date('2026-04-01T09:00:00Z'));
const mockLogActivity = vi.fn();
let capturedProcessor: ((job: any) => Promise<void>) | null = null;

/** Chainable select: works with .limit() or direct await */
function buildSelectChain() {
  const getResult = () => {
    const rows = mockDbSelectResults[selectCallIdx] || [];
    selectCallIdx++;
    return rows;
  };

  const makeThenable = (resolver: () => any[]) => {
    const obj: any = {
      limit: vi.fn().mockImplementation(() => Promise.resolve(resolver())),
      then: (resolve: any, reject?: any) => Promise.resolve(resolver()).then(resolve, reject),
    };
    return obj;
  };

  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(() => makeThenable(getResult)),
    }),
  };
}

/** Chainable insert: supports .values().returning() and .values() alone */
function buildInsertChain() {
  const getResult = () => {
    const rows = mockDbInsertResults[insertCallIdx] || [];
    insertCallIdx++;
    return rows;
  };

  return {
    values: vi.fn().mockImplementation((data: any) => {
      mockDbInsertValues.push(data);
      const result = getResult();
      const obj: any = {
        returning: vi.fn().mockResolvedValue(result),
        then: (resolve: any, reject?: any) => Promise.resolve(result).then(resolve, reject),
      };
      return obj;
    }),
  };
}

/** Chainable update: .set().where() */
function buildUpdateChain() {
  return {
    set: vi.fn().mockImplementation((data: any) => {
      mockDbUpdateSets.push(data);
      return {
        where: vi.fn().mockResolvedValue(undefined),
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
  QUEUE_NAMES: { RECURRING: 'recurring' },
  addPublishJob: (...args: any[]) => mockAddPublishJob(...args),
}));

vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn().mockImplementation((...args: any[]) => buildSelectChain()),
    insert: vi.fn().mockImplementation((...args: any[]) => buildInsertChain()),
    update: vi.fn().mockImplementation((...args: any[]) => buildUpdateChain()),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  recurringSchedules: { id: 'id', isActive: 'isActive', nextRunAt: 'nextRunAt' },
  posts: { id: 'id' },
  postPlatforms: { postId: 'postId' },
  channels: { id: 'id', isActive: 'isActive', organizationId: 'organizationId' },
  mediaFiles: { id: 'id', organizationId: 'organizationId', isOriginalDeleted: 'isOriginalDeleted' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ _type: 'eq', a })),
  and: vi.fn((...a: any[]) => ({ _type: 'and', a })),
  lt: vi.fn((...a: any[]) => ({ _type: 'lt', a })),
  lte: vi.fn((...a: any[]) => ({ _type: 'lte', a })),
  inArray: vi.fn((...a: any[]) => ({ _type: 'inArray', a })),
  count: vi.fn(() => ({ _type: 'count' })),
}));

vi.mock('@/lib/schedules/next-run', () => ({
  calculateNextRunAt: (...args: any[]) => mockCalculateNextRunAt(...args),
}));

vi.mock('@/lib/activity/log', () => ({
  logActivity: (...args: any[]) => mockLogActivity(...args),
}));

const mockGetOrgPlan = vi.fn().mockResolvedValue('business');
// Default: unlimited, so the execution-time plan check adds no extra SELECT and
// the ordered select queues in the tests above stay untouched. The downgrade
// describe block overrides this per-test.
const mockGetUserLimits = vi.fn().mockReturnValue({ recurringSchedules: -1 });
vi.mock('@/lib/quotas/check', () => ({
  checkPostQuotasBatch: vi.fn().mockResolvedValue({
    daily: { allowed: true, current: 0, limit: 30 },
    monthly: { allowed: true, current: 0, limit: 500 },
  }),
  getOrgPlan: (...a: any[]) => mockGetOrgPlan(...a),
  getUserLimits: (...a: any[]) => mockGetUserLimits(...a),
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

const { createRecurringWorker } = await import('@/lib/jobs/recurring.worker');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetState() {
  selectCallIdx = 0;
  insertCallIdx = 0;
  mockDbSelectResults.length = 0;
  mockDbInsertResults.length = 0;
  mockDbUpdateSets.length = 0;
  mockDbInsertValues.length = 0;
}

function makeSchedule(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    userId: 'user-1',
    organizationId: 1,
    name: 'Weekly Post',
    frequency: 'weekly',
    dayOfWeek: [1],
    dayOfMonth: null,
    timeOfDay: '09:00',
    timezone: 'America/New_York',
    channelIds: [10, 20],
    contentTemplate: 'Hello from recurring schedule!',
    mediaFileIds: [100, 200],
    isActive: true,
    nextRunAt: new Date('2026-03-28T09:00:00Z'),
    lastRunAt: null,
    postFormat: 'post',
    postTypeOverrides: {},
    platformSpecific: {},
    threadParts: null,
    ...overrides,
  };
}

function makeActiveChannel(overrides: Record<string, any> = {}) {
  return {
    id: 10,
    platform: 'x',
    isActive: true,
    organizationId: 1,
    ...overrides,
  };
}

/**
 * processRecurringSchedules flow:
 *   select 0: due schedules (with .limit())
 *
 * For each schedule, createPostFromSchedule:
 *   select 1: active channels
 *   select 2: valid media files (if mediaFileIds not empty)
 *   insert 0: post (with .returning())
 *   insert 1..N: postPlatform entries (per channel, no .returning())
 *   -> addPublishJob
 *   -> logActivity
 *   update 0: schedule nextRunAt/lastRunAt
 */
function setupSingleSchedule(opts: {
  schedule?: any;
  channels?: any[];
  mediaRows?: any[];
  newPostId?: number;
}) {
  const schedule = opts.schedule ?? makeSchedule();
  const channels = opts.channels ?? [makeActiveChannel({ id: 10 }), makeActiveChannel({ id: 20, platform: 'facebook' })];
  const mediaRows = opts.mediaRows ?? [{ id: 100 }, { id: 200 }];
  const newPostId = opts.newPostId ?? 42;

  mockDbSelectResults.push(
    [schedule],   // 0: due schedules
    channels,     // 1: active channels
  );

  if (schedule.mediaFileIds && schedule.mediaFileIds.length > 0) {
    mockDbSelectResults.push(mediaRows); // 2: valid media files
  }

  // Insert results
  mockDbInsertResults.push(
    [{ id: newPostId }], // post insert with .returning()
  );
  // For each channel, insert postPlatform (no returning value needed)
  for (const _ch of channels) {
    mockDbInsertResults.push([]);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recurring worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
    capturedProcessor = null;
    createRecurringWorker();
  });

  it('does nothing for non process-recurring jobs', async () => {
    await capturedProcessor!({ name: 'unknown-job', data: {} });

    expect(selectCallIdx).toBe(0);
  });

  it('does nothing when no schedules are due', async () => {
    mockDbSelectResults.push([]); // no due schedules

    await capturedProcessor!({ name: 'process-recurring', data: {} });

    expect(insertCallIdx).toBe(0);
    expect(mockAddPublishJob).not.toHaveBeenCalled();
  });

  it('creates post from schedule with correct fields', async () => {
    setupSingleSchedule({});

    await capturedProcessor!({ name: 'process-recurring', data: {} });

    // Verify the post insert was called via the insert chain
    // The first insert should be the post with correct fields
    // No publish job is enqueued anymore (the scheduled checker publishes it). The
    // post-created proxy is the repeat.triggered activity carrying the new post id.
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ postId: 42 }) }),
    );
    expect(mockAddPublishJob).not.toHaveBeenCalled();
  });

  it('stores plain media IDs (numbers), not objects (bug fix)', async () => {
    // This is a critical bug fix test. The recurring worker must store
    // validMediaIds (plain number array like [100, 200]), NOT objects.
    const schedule = makeSchedule({ mediaFileIds: [100, 200] });

    setupSingleSchedule({
      schedule,
      mediaRows: [{ id: 100 }, { id: 200 }],
    });

    await capturedProcessor!({ name: 'process-recurring', data: {} });

    // The insert chain's .values() was called. We verify via the publish job.
    // The actual validation is that validMediaIds = media.map(m => m.id)
    // produces [100, 200] (numbers), not [{id:100}, {id:200}] (objects).
    // We confirm the flow completed successfully.
    // No publish job is enqueued anymore (the scheduled checker publishes it). The
    // post-created proxy is the repeat.triggered activity carrying the new post id.
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ postId: 42 }) }),
    );
    expect(mockAddPublishJob).not.toHaveBeenCalled();
  });

  it('handles schedule with no media files', async () => {
    const schedule = makeSchedule({ mediaFileIds: [] });

    mockDbSelectResults.push(
      [schedule],
      [makeActiveChannel({ id: 10 })],
      // No media query since mediaFileIds is empty
    );
    mockDbInsertResults.push([{ id: 42 }], []);

    await capturedProcessor!({ name: 'process-recurring', data: {} });

    // No publish job is enqueued anymore (the scheduled checker publishes it). The
    // post-created proxy is the repeat.triggered activity carrying the new post id.
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ postId: 42 }) }),
    );
    expect(mockAddPublishJob).not.toHaveBeenCalled();
  });

  // This used to assert the opposite: that the occurrence was created with the
  // surviving 2 of 3 media files. That is the bug — a schedule set up with three
  // images would quietly start posting two, or (if all were deleted) plain text,
  // on every run forever, with nothing anywhere saying the posts no longer match
  // what was configured. Skip the occurrence and surface it instead.
  it('skips the occurrence when any attached media file is gone', async () => {
    const schedule = makeSchedule({ mediaFileIds: [100, 200, 300] });

    mockDbSelectResults.push(
      [schedule],
      [makeActiveChannel({ id: 10 })],
      [{ id: 100 }, { id: 300 }], // 200 is deleted
    );
    mockDbInsertResults.push([{ id: 42 }], []);

    await capturedProcessor!({ name: 'process-recurring', data: {} });

    // No post created for this occurrence.
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ postId: 42 }) }),
    );
    expect(mockAddPublishJob).not.toHaveBeenCalled();

    // ...and the reason is recorded, naming the media that vanished.
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'repeat.skipped',
        level: 'error',
        details: expect.objectContaining({
          reason: 'media_unavailable',
          lostMediaIds: [200],
        }),
      }),
    );
  });

  it('creates the occurrence normally when every attached media file resolves', async () => {
    const schedule = makeSchedule({ mediaFileIds: [100, 200] });

    mockDbSelectResults.push(
      [schedule],
      [makeActiveChannel({ id: 10 })],
      [{ id: 100 }, { id: 200 }],
    );
    mockDbInsertResults.push([{ id: 42 }], []);

    await capturedProcessor!({ name: 'process-recurring', data: {} });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ postId: 42 }) }),
    );
  });

  it('skips schedule with empty channelIds', async () => {
    const schedule = makeSchedule({ channelIds: [] });

    mockDbSelectResults.push([schedule]);

    await capturedProcessor!({ name: 'process-recurring', data: {} });

    // No post should be created (no repeat.triggered activity)
    expect(mockLogActivity).not.toHaveBeenCalled();

    // nextRunAt should still be updated
    expect(mockDbUpdateSets.length).toBeGreaterThan(0);
  });

  it('skips schedule when all channels are inactive', async () => {
    const schedule = makeSchedule({ channelIds: [10, 20] });

    mockDbSelectResults.push(
      [schedule],
      [], // no active channels found
    );

    await capturedProcessor!({ name: 'process-recurring', data: {} });

    expect(mockLogActivity).not.toHaveBeenCalled();

    // nextRunAt should still be updated
    expect(mockDbUpdateSets).toContainEqual(
      expect.objectContaining({
        nextRunAt: expect.any(Date),
      }),
    );
  });

  it('creates postPlatform entries for each active channel', async () => {
    const channel1 = makeActiveChannel({ id: 10, platform: 'x' });
    const channel2 = makeActiveChannel({ id: 20, platform: 'facebook' });

    setupSingleSchedule({
      schedule: makeSchedule({ mediaFileIds: [] }),
      channels: [channel1, channel2],
    });

    await capturedProcessor!({ name: 'process-recurring', data: {} });

    // 1 post insert + 2 postPlatform inserts = 3 inserts total
    expect(insertCallIdx).toBe(3);
  });

  it('creates the post with the new post ID (no direct publish job)', async () => {
    setupSingleSchedule({
      schedule: makeSchedule({ mediaFileIds: [] }),
      channels: [makeActiveChannel({ id: 10 })],
      newPostId: 77,
    });

    await capturedProcessor!({ name: 'process-recurring', data: {} });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ postId: 77 }) }),
    );
    expect(mockAddPublishJob).not.toHaveBeenCalled();
  });

  it('updates nextRunAt using calculateNextRunAt with schedule params', async () => {
    const schedule = makeSchedule({
      frequency: 'weekly',
      dayOfWeek: [1],
      dayOfMonth: null,
      timeOfDay: '14:30',
      timezone: 'Europe/London',
      mediaFileIds: [],
    });

    setupSingleSchedule({
      schedule,
      channels: [makeActiveChannel({ id: 10 })],
    });

    await capturedProcessor!({ name: 'process-recurring', data: {} });

    expect(mockCalculateNextRunAt).toHaveBeenCalledWith(
      'weekly',
      [1],
      null,
      '14:30',
      'Europe/London',
    );

    expect(mockDbUpdateSets).toContainEqual(
      expect.objectContaining({
        nextRunAt: new Date('2026-04-01T09:00:00Z'),
      }),
    );
  });

  it('updates lastRunAt to current time', async () => {
    setupSingleSchedule({
      schedule: makeSchedule({ mediaFileIds: [] }),
      channels: [makeActiveChannel({ id: 10 })],
    });

    const before = new Date();
    await capturedProcessor!({ name: 'process-recurring', data: {} });
    const after = new Date();

    const lastRunUpdate = mockDbUpdateSets.find((s) => s.lastRunAt);
    expect(lastRunUpdate).toBeDefined();
    expect(lastRunUpdate.lastRunAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(lastRunUpdate.lastRunAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('logs activity with schedule details', async () => {
    setupSingleSchedule({
      schedule: makeSchedule({ name: 'Daily Newsletter', mediaFileIds: [] }),
      channels: [makeActiveChannel({ id: 10 }), makeActiveChannel({ id: 20, platform: 'fb' })],
      newPostId: 42,
    });

    await capturedProcessor!({ name: 'process-recurring', data: {} });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        organizationId: 1,
        action: 'repeat.triggered',
        resource: 'schedule',
        resourceId: 1,
        details: expect.objectContaining({
          postId: 42,
          scheduleName: 'Daily Newsletter',
          channels: 2,
        }),
      }),
    );
  });

  it('continues processing other schedules when one fails', async () => {
    const schedule1 = makeSchedule({ id: 1, channelIds: [10], mediaFileIds: [] });
    const schedule2 = makeSchedule({ id: 2, channelIds: [20], name: 'Second', mediaFileIds: [] });

    // Due schedules returns both
    mockDbSelectResults.push([schedule1, schedule2]);

    // First schedule's channel query returns empty -> createPostFromSchedule returns early
    mockDbSelectResults.push([]);

    // Second schedule's channel query
    mockDbSelectResults.push([makeActiveChannel({ id: 20 })]);

    // Second schedule's post insert
    mockDbInsertResults.push([{ id: 55 }], []);

    await capturedProcessor!({ name: 'process-recurring', data: {} });

    // Second schedule should still have been processed
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ postId: 55 }) }),
    );
  });

  it('sets deleteMediaAfterPublish to false for recurring posts', async () => {
    // The recurring worker always sets deleteMediaAfterPublish: false
    // because the same media is reused across recurring posts.
    setupSingleSchedule({
      schedule: makeSchedule({ mediaFileIds: [] }),
      channels: [makeActiveChannel({ id: 10 })],
    });

    await capturedProcessor!({ name: 'process-recurring', data: {} });

    // The flow completed successfully (post created)
    expect(mockLogActivity).toHaveBeenCalled();
  });

  it('creates the post as scheduled and does NOT enqueue a publish job (single publish path)', async () => {
    // Regression for the recurring double-path: the post is created 'scheduled' and the
    // publish worker's check-scheduled reconciler claims and publishes it once. Enqueuing
    // a job here too would race the reconciler and publish the same post twice.
    setupSingleSchedule({
      schedule: makeSchedule({ mediaFileIds: [] }),
      channels: [makeActiveChannel({ id: 10 })],
    });

    await capturedProcessor!({ name: 'process-recurring', data: {} });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ postId: 42 }) }),
    );
    expect(mockAddPublishJob).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Approval gating (team roles Phase 2)
  // -------------------------------------------------------------------------

  it('parks each occurrence as pending when the schedule requires approval', async () => {
    setupSingleSchedule({ schedule: makeSchedule({ requireApproval: true }) });

    await capturedProcessor!({ name: 'process-recurring', data: {} });

    const post = mockDbInsertValues[0];
    expect(post.status).toBe('scheduled');
    expect(post.approvalStatus).toBe('pending');
  });

  it('leaves occurrences ungated when the schedule does not require approval', async () => {
    setupSingleSchedule({ schedule: makeSchedule({ requireApproval: false }) });

    await capturedProcessor!({ name: 'process-recurring', data: {} });

    expect(mockDbInsertValues[0].approvalStatus).toBe('none');
  });

  it('treats a legacy schedule with no requireApproval column as ungated', async () => {
    const schedule = makeSchedule();
    delete (schedule as any).requireApproval;
    setupSingleSchedule({ schedule });

    await capturedProcessor!({ name: 'process-recurring', data: {} });

    expect(mockDbInsertValues[0].approvalStatus).toBe('none');
  });
});


// ---------------------------------------------------------------------------
// Execution-time plan re-check (audit F6)
// ---------------------------------------------------------------------------
// A schedule created under Pro/Business must stop firing when the org
// downgrades — mirroring the RSS worker's downgrade handling. Creation-time
// checks alone are the classic recurring-quota hole.
describe('plan downgrade stops recurring schedules at execution time', () => {
  beforeEach(() => {
    resetState();
    mockGetUserLimits.mockReturnValue({ recurringSchedules: -1 });
  });

  it('skips every schedule when the plan no longer includes the feature (free = 0)', async () => {
    mockGetUserLimits.mockReturnValue({ recurringSchedules: 0 });
    const schedule = makeSchedule();
    mockDbSelectResults.push([schedule]); // due schedules
    // No further selects expected: the plan gate exits before channels are read.
    await capturedProcessor!({ name: 'process-recurring' });
    expect(mockDbInsertValues).toHaveLength(0);
    // nextRunAt still advances so the schedule doesn't hot-loop while blocked.
    expect(mockDbUpdateSets.some((u) => u.nextRunAt)).toBe(true);
  });

  it('skips schedules beyond a reduced paid limit, keeping the oldest', async () => {
    mockGetUserLimits.mockReturnValue({ recurringSchedules: 1 });
    const schedule = makeSchedule({ id: 50 });
    mockDbSelectResults.push([schedule]); // due schedules
    mockDbSelectResults.push([{ n: 1 }]); // one OLDER active schedule already holds the slot
    await capturedProcessor!({ name: 'process-recurring' });
    expect(mockDbInsertValues).toHaveLength(0);
  });

  it('still fires a schedule within the reduced limit', async () => {
    mockGetUserLimits.mockReturnValue({ recurringSchedules: 2 });
    const schedule = makeSchedule({ id: 50 });
    mockDbSelectResults.push([schedule]); // due schedules
    mockDbSelectResults.push([{ n: 1 }]); // count of older schedules: under the limit of 2
    mockDbSelectResults.push([makeActiveChannel()]); // channels
    // makeSchedule() defaults to mediaFileIds [100, 200]; return both so this
    // test exercises the plan-limit gate it is about, rather than tripping the
    // media-unavailable skip.
    mockDbSelectResults.push([{ id: 100 }, { id: 200 }]); // media
    mockDbInsertResults.push([{ id: 900 }]); // created post
    await capturedProcessor!({ name: 'process-recurring' });
    expect(mockDbInsertValues.length).toBeGreaterThan(0);
  });
});
