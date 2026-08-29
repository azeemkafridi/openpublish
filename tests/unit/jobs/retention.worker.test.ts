/**
 * Retention worker tests.
 *
 * Tests webapp/src/lib/jobs/retention.worker.ts covering:
 *   - run-retention job triggers all three purge operations in parallel
 *   - purgeOldActivityLogs deletes old activity log entries
 *   - purgeOldNotifications deletes old notifications
 *   - purgeOldPostContent nulls content/refs only; the orphan sweep deletes media
 *   - Skips posts linked to active recurring schedules
 *   - C2: paginates by an advancing id cursor (all-skipped batch cannot loop forever)
 *   - C3: never deletes media a newer post still references
 *   - Non run-retention jobs are ignored
 *   - Worker propagates errors from purge operations
 */

// ---------------------------------------------------------------------------
// Mocks BEFORE importing the module
// ---------------------------------------------------------------------------

const mockDbSelectResults: any[][] = [];
const mockDbDeleteResults: any[][] = [];
const mockDbUpdateSets: any[] = [];
const mockSelectConditions: any[] = [];
let selectCallIdx = 0;
let deleteCallIdx = 0;

const mockDeleteFromR2 = vi.fn().mockResolvedValue(undefined);
const mockIsR2Key = vi.fn().mockReturnValue(true);
let capturedProcessor: ((job: any) => Promise<void>) | null = null;

function buildSelectChain() {
  const getResult = () => {
    const rows = mockDbSelectResults[selectCallIdx] || [];
    selectCallIdx++;
    return rows;
  };
  const makeThenable = (resolver: () => any[]) => {
    const thenable: any = {
      orderBy: vi.fn(() => thenable),
      limit: vi.fn().mockImplementation(() => Promise.resolve(resolver())),
      then: (resolve: any, reject?: any) => Promise.resolve(resolver()).then(resolve, reject),
    };
    return thenable;
  };
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation((cond: any) => {
        mockSelectConditions.push(cond);
        return makeThenable(getResult);
      }),
    }),
  };
}

function buildUpdateChain() {
  return {
    set: vi.fn().mockImplementation((data: any) => {
      mockDbUpdateSets.push(data);
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
  };
}

function buildDeleteChain() {
  const getResult = () => {
    const rows = mockDbDeleteResults[deleteCallIdx] || [];
    deleteCallIdx++;
    return rows;
  };
  return {
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockImplementation(() => Promise.resolve(getResult())),
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
  QUEUE_NAMES: { RETENTION: 'retention' },
}));

vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn().mockImplementation(() => buildSelectChain()),
    update: vi.fn().mockImplementation(() => buildUpdateChain()),
    delete: vi.fn().mockImplementation(() => buildDeleteChain()),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  posts: { id: 'id', content: 'content', mediaFiles: 'mediaFiles', createdAt: 'createdAt', recurringScheduleId: 'recurringScheduleId', organizationId: 'organizationId' },
  mediaFiles: { id: 'id', organizationId: 'organizationId', createdAt: 'createdAt', isOriginalDeleted: 'isOriginalDeleted' },
  activityLogs: { id: 'id', createdAt: 'createdAt' },
  notifications: { id: 'id', createdAt: 'createdAt' },
  recurringSchedules: { id: 'id', isActive: 'isActive', organizationId: 'organizationId', mediaFileIds: 'mediaFileIds' },
  postMetrics: { id: 'id', fetchedAt: 'fetchedAt' },
  accountMetrics: { id: 'id', date: 'date' },
  emailLog: { id: 'id', createdAt: 'emailLogCreatedAt' },
  oauthTokens: { id: 'id', expiresAt: 'oauthTokenExpiresAt' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ _type: 'eq', a })),
  and: vi.fn((...a: any[]) => ({ _type: 'and', a })),
  lt: vi.fn((...a: any[]) => ({ _type: 'lt', a })),
  gt: vi.fn((...a: any[]) => ({ _type: 'gt', a })),
  asc: vi.fn((c: any) => ({ _type: 'asc', c })),
  or: vi.fn((...a: any[]) => ({ _type: 'or', a })),
  isNotNull: vi.fn((c: any) => ({ _type: 'isNotNull', c })),
  sql: vi.fn((strings: any, ...vals: any[]) => ({ _type: 'sql', strings, vals })),
  inArray: vi.fn((...a: any[]) => ({ _type: 'inArray', a })),
}));

vi.mock('@/lib/media/r2', () => ({
  deleteFromR2: (...args: any[]) => mockDeleteFromR2(...args),
  isR2Key: (...args: any[]) => mockIsR2Key(...args),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    unlinkSync: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

export {};

const { createRetentionWorker } = await import('@/lib/jobs/retention.worker');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetState() {
  selectCallIdx = 0;
  deleteCallIdx = 0;
  mockDbSelectResults.length = 0;
  mockDbDeleteResults.length = 0;
  mockDbUpdateSets.length = 0;
  mockSelectConditions.length = 0;
}

/**
 * Cursor values from the old-post-content queries (the `and(...)` that carries both a
 * `gt` cursor and the content `sql` filter). Used to assert pagination advances.
 */
function postContentCursors(): number[] {
  return mockSelectConditions
    .filter((c) => c && c._type === 'and' && Array.isArray(c.a)
      && c.a.some((x: any) => x?._type === 'gt')
      && c.a.some((x: any) => x?._type === 'sql'))
    .map((c) => c.a.find((x: any) => x?._type === 'gt').a[1]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('retention worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
    capturedProcessor = null;
    createRetentionWorker();
  });

  it('ignores non run-retention jobs', async () => {
    await capturedProcessor!({ name: 'unknown', data: {} });

    expect(selectCallIdx).toBe(0);
    expect(deleteCallIdx).toBe(0);
  });

  it('runs all three purge operations for run-retention job', async () => {
    // purgeOldPostContent:
    //   select 0: active schedules
    //   select 1: old posts batch (empty -> exits loop)
    // purgeOldActivityLogs:
    //   delete 0: activity logs
    // purgeOldNotifications:
    //   delete 1: notifications

    mockDbSelectResults.push(
      [],  // active schedules (none)
      [],  // old posts (none)
    );

    mockDbDeleteResults.push(
      [{ id: 1 }, { id: 2 }],   // activity logs deleted
      [{ id: 10 }],             // notifications deleted
      [],                        // post metrics deleted
      [],                        // account metrics deleted
    );

    await capturedProcessor!({ name: 'run-retention', data: {} });

    // All five purge operations ran (post content, activity logs, notifications,
    // post metrics, account metrics)
    expect(selectCallIdx).toBeGreaterThan(0);
    expect(deleteCallIdx).toBe(4);
  });

  it('nulls old post content, then the orphan sweep deletes the now-unreferenced media', async () => {
    // purgeOldPostContent no longer deletes media inline (that ignored reuse by other
    // posts/schedules). It nulls the post's refs; purgeOrphanedMedia then reference-checks
    // and deletes the files that are now orphaned.
    const oldPost = { id: 42, organizationId: 1, mediaFiles: [1, 2], recurringScheduleId: null };
    const media1 = {
      id: 1, organizationId: 1,
      originalPath: 'original/img1.jpg',
      thumbnailPath: 'thumb/img1.jpg',
      previewPath: 'thumb/preview-img1.webp',
      variants: { jpg_92: { path: 'converted/img1.jpg', mimeType: 'image/jpeg' } },
    };
    const media2 = { id: 2, organizationId: 1, originalPath: 'original/img2.jpg', thumbnailPath: null, previewPath: null, variants: {} };

    mockDbSelectResults.push(
      [],               // purgeOldPostContent: active schedules
      [oldPost],        // purgeOldPostContent: old posts batch 1
      [],               // purgeOldPostContent: batch 2 (empty -> exit loop)
      [media1, media2], // purgeOrphanedMedia: candidate batch
      [],               // media1: post containment -> none
      [],               // media1: active-schedule containment -> none
      [],               // media2: post containment -> none
      [],               // media2: active-schedule containment -> none
      [],               // purgeOrphanedMedia: next batch (empty -> break)
    );

    mockIsR2Key.mockReturnValue(true);

    await capturedProcessor!({ name: 'run-retention', data: {} });

    expect(mockDeleteFromR2).toHaveBeenCalledWith('original/img1.jpg');
    expect(mockDeleteFromR2).toHaveBeenCalledWith('thumb/img1.jpg');
    expect(mockDeleteFromR2).toHaveBeenCalledWith('thumb/preview-img1.webp');
    expect(mockDeleteFromR2).toHaveBeenCalledWith('converted/img1.jpg');
    expect(mockDeleteFromR2).toHaveBeenCalledWith('original/img2.jpg');
    // img1: original + thumbnail + preview + 1 variant = 4; img2: original = 1
    expect(mockDeleteFromR2).toHaveBeenCalledTimes(5);

    // Post content should be nulled out
    expect(mockDbUpdateSets).toContainEqual(
      expect.objectContaining({ content: null, mediaFiles: [] }),
    );
  });

  it('does NOT delete media a newer post still references when purging an old post (C3)', async () => {
    // Old post #42 referenced media #7; a newer post #99 also references #7. Purging #42
    // must not delete #7 — this is the silent-data-loss bug the inline delete caused.
    const oldPost = { id: 42, organizationId: 1, mediaFiles: [7], recurringScheduleId: null };
    const sharedMedia = { id: 7, organizationId: 1, originalPath: 'original/shared.jpg', thumbnailPath: null, previewPath: null, variants: {} };

    mockDbSelectResults.push(
      [],             // active schedules
      [oldPost],      // old posts batch 1
      [],             // old posts batch 2 (empty -> break)
      [sharedMedia],  // orphan candidate batch
      [{ id: 99 }],   // post containment -> newer post #99 still references it -> KEEP
      [],             // next candidate batch (empty -> break)
    );

    mockIsR2Key.mockReturnValue(true);

    await capturedProcessor!({ name: 'run-retention', data: {} });

    // Media survives because another post references it...
    expect(mockDeleteFromR2).not.toHaveBeenCalledWith('original/shared.jpg');
    // ...but the old post's content is still purged.
    expect(mockDbUpdateSets).toContainEqual(
      expect.objectContaining({ content: null, mediaFiles: [] }),
    );
  });

  it('paginates old posts by an advancing id cursor so an all-skipped batch cannot loop forever (C2)', async () => {
    // Both posts are linked to an active schedule, so both are skipped. Without a cursor,
    // the next query would re-select the same skipped rows forever. The cursor must
    // advance past the last id seen.
    const skipped = [
      { id: 10, recurringScheduleId: 100 },
      { id: 20, recurringScheduleId: 100 },
    ];

    mockDbSelectResults.push(
      [{ id: 100 }], // active schedules
      skipped,       // batch 1 (both skipped)
      [],            // batch 2 (empty -> break)
      [],            // orphan sweep: no candidates
    );

    await capturedProcessor!({ name: 'run-retention', data: {} });

    // No content nulled (every post skipped).
    expect(mockDbUpdateSets).toHaveLength(0);

    // Two post-content queries were issued, and the cursor advanced from 0 to the last
    // processed id (20) — proving forward pagination rather than re-scanning.
    const cursors = postContentCursors();
    expect(cursors.length).toBeGreaterThanOrEqual(2);
    expect(cursors[0]).toBe(0);
    expect(cursors[1]).toBe(20);
  });

  it('skips posts linked to active recurring schedules', async () => {
    const oldPost = {
      id: 42, userId: 'user-1', organizationId: 1,
      mediaFiles: [], recurringScheduleId: 100,
    };

    mockDbSelectResults.push(
      [{ id: 100 }],    // active schedule with id=100
      [oldPost],         // old post linked to active schedule
      [],                // next batch (empty)
    );

    mockDbDeleteResults.push([], []);

    await capturedProcessor!({ name: 'run-retention', data: {} });

    // Post content should NOT be nulled out
    expect(mockDbUpdateSets).toHaveLength(0);
  });

  it('re-throws errors from purge operations', async () => {
    // The delete for activity logs will reject, which should propagate
    // since the worker uses Promise.all and re-throws.
    // We setup select results so purgeOldPostContent works but
    // make the delete chain throw.

    mockDbSelectResults.push(
      [],  // active schedules
      [],  // old posts (empty -> loop exits immediately)
    );

    // First delete (activityLogs) throws
    mockDbDeleteResults.push([]); // placeholder so index works

    // Override the db.delete mock to throw on first call
    const { db } = await import('@/lib/db');
    let delCallCount = 0;
    (db.delete as any).mockImplementation(() => {
      delCallCount++;
      if (delCallCount === 1) {
        return {
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockRejectedValue(new Error('DB connection failed')),
          }),
        };
      }
      return buildDeleteChain();
    });

    await expect(
      capturedProcessor!({ name: 'run-retention', data: {} }),
    ).rejects.toThrow('DB connection failed');
  });

  it('sweeps orphaned media older than the window that no post or active schedule references', async () => {
    const orphan = {
      id: 50,
      organizationId: 1,
      originalPath: 'original/orphan.jpg',
      thumbnailPath: 'thumb/orphan.jpg',
      previewPath: null,
      variants: {},
    };
    mockDbSelectResults.push(
      [],         // purgeOldPostContent: active schedules
      [],         // purgeOldPostContent: old posts (none -> exit)
      [orphan],   // purgeOrphanedMedia: candidate batch
      [],         // post containment for #50 -> referenced by no post
      [],         // active-schedule containment for #50 -> none
      [],         // purgeOrphanedMedia: next batch (empty -> break)
    );
    mockDbDeleteResults.push([]); // orphan row delete
    mockIsR2Key.mockReturnValue(true);

    await capturedProcessor!({ name: 'run-retention', data: {} });

    expect(mockDeleteFromR2).toHaveBeenCalledWith('original/orphan.jpg');
    expect(mockDeleteFromR2).toHaveBeenCalledWith('thumb/orphan.jpg');
  });

  it('keeps old media that a post still references (not an orphan)', async () => {
    const inUse = {
      id: 60,
      organizationId: 1,
      originalPath: 'original/inuse.jpg',
      thumbnailPath: null,
      previewPath: null,
      variants: {},
    };
    mockDbSelectResults.push(
      [],            // active schedules
      [],            // old posts (none)
      [inUse],       // candidate batch
      [{ id: 999 }], // post containment -> a post references it -> skip
      [],            // next batch (empty -> break)
    );
    mockIsR2Key.mockReturnValue(true);

    await capturedProcessor!({ name: 'run-retention', data: {} });

    expect(mockDeleteFromR2).not.toHaveBeenCalledWith('original/inuse.jpg');
  });

  it('purges platform statistics on a 30-day window, shorter than the 3-month content window', async () => {
    // Nothing to purge — we only assert the cutoff dates passed to lt() differ by table.
    mockDbSelectResults.push(
      [], // active schedules
      [], // old posts (none -> exit)
      [], // orphan candidates (none -> exit)
    );
    mockDbDeleteResults.push([], [], [], [], [], []); // activity, notifications, postMetrics, accountMetrics, emailLog, oauthTokens

    await capturedProcessor!({ name: 'run-retention', data: {} });

    const { lt } = await import('drizzle-orm');
    const calls = (lt as any).mock.calls as any[][];
    const day = 24 * 60 * 60 * 1000;

    // post_metrics.fetchedAt cutoff is exactly ~30 days ago.
    const metricsCall = calls.find((c) => c[0] === 'fetchedAt');
    expect(metricsCall).toBeTruthy();
    const metricsCutoff = metricsCall![1] as Date;
    expect(Math.round((Date.now() - metricsCutoff.getTime()) / day)).toBe(30);

    // account_metrics.date uses a YYYY-MM-DD string cutoff (also the 30-day window).
    const acctCall = calls.find((c) => c[0] === 'date');
    expect(acctCall).toBeTruthy();
    expect(typeof acctCall![1]).toBe('string');

    // Content (posts.createdAt) uses the older 3-month window — its cutoff must be strictly
    // earlier than the metrics cutoff, proving statistics are retained for a shorter period.
    const contentCall = calls.find((c) => c[0] === 'createdAt');
    expect(contentCall).toBeTruthy();
    expect((contentCall![1] as Date).getTime()).toBeLessThan(metricsCutoff.getTime());
  });
});
