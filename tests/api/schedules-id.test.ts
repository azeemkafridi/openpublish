/**
 * Tests for the Schedules [id] API.
 *
 *   PUT    /api/schedules/[id] — update schedule with channel/media validation
 *   DELETE /api/schedules/[id] — delete schedule
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
queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve(mockQueryResult));
queryChain.then = (resolve: any) => resolve(mockQueryResult);

// ---------------------------------------------------------------------------
// vi.mock (hoisted)
// ---------------------------------------------------------------------------
vi.mock('@/lib/db', () => {
  const dbObj: Record<string, any> = {
    select: () => queryChain,
    update: () => queryChain,
    insert: () => queryChain,
    delete: () => queryChain,
    transaction: (cb: any) => cb(dbObj),
  };
  return { db: dbObj };
});

vi.mock('@/lib/db/schema', () => ({
  posts: {
    id: 'posts.id',
    recurringScheduleId: 'posts.recurring_schedule_id',
  },
  recurringSchedules: {
    id: 'recurring_schedules.id',
    userId: 'recurring_schedules.user_id',
    organizationId: 'recurring_schedules.organization_id',
    name: 'recurring_schedules.name',
    frequency: 'recurring_schedules.frequency',
    dayOfWeek: 'recurring_schedules.day_of_week',
    dayOfMonth: 'recurring_schedules.day_of_month',
    timeOfDay: 'recurring_schedules.time_of_day',
    timezone: 'recurring_schedules.timezone',
    channelIds: 'recurring_schedules.channel_ids',
    isActive: 'recurring_schedules.is_active',
    nextRunAt: 'recurring_schedules.next_run_at',
    createdAt: 'recurring_schedules.created_at',
  },
  channels: {
    id: 'channels.id',
    organizationId: 'channels.organization_id',
    isActive: 'channels.is_active',
  },
  mediaFiles: {
    id: 'media_files.id',
    organizationId: 'media_files.organization_id',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ type: 'eq', args: a })),
  and: vi.fn((...a: any[]) => ({ type: 'and', args: a })),
  desc: vi.fn((c: any) => ({ type: 'desc', col: c })),
  inArray: vi.fn((...a: any[]) => ({ type: 'inArray', args: a })),
}));

vi.mock('@/lib/activity/log', () => ({ logActivity: vi.fn() }));

vi.mock('@/lib/schedules/next-run', () => ({
  calculateNextRunAt: vi.fn(() => new Date('2026-04-01T10:00:00Z')),
}));

// ---------------------------------------------------------------------------
// Import handlers AFTER mocks
// ---------------------------------------------------------------------------
import { PUT, DELETE } from '@/pages/api/schedules/[id]';
import { logActivity } from '@/lib/activity/log';
import { calculateNextRunAt } from '@/lib/schedules/next-run';
import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A } from '../helpers/fixtures';

const SAMPLE_SCHEDULE = {
  id: 1,
  userId: 'user-a',
  organizationId: 1,
  name: 'Daily Post',
  frequency: 'daily',
  dayOfWeek: null,
  dayOfMonth: null,
  timeOfDay: '10:00',
  timezone: 'UTC',
  channelIds: [1],
  mediaFileIds: [],
  contentTemplate: 'Hello world',
  postTypeOverrides: {},
  platformSpecific: {},
  isActive: true,
  nextRunAt: new Date('2026-03-01T10:00:00Z'),
  createdAt: new Date('2026-01-01'),
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
  queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve(mockQueryResult));
  queryChain.then = (resolve: any) => resolve(mockQueryResult);
}

// ---------------------------------------------------------------------------
// PUT /api/schedules/[id]
// ---------------------------------------------------------------------------

describe('PUT /api/schedules/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([]);
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null, params: { id: '1' }, body: { name: 'X' } });
    const res = await PUT(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns 400 for invalid schedule ID', async () => {
    const ctx = createMockContext({ user: USER_A, params: { id: 'abc' }, body: { name: 'X' } });
    const res = await PUT(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it('returns 404 when schedule does not exist', async () => {
    queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve([]));
    const ctx = createMockContext({ user: USER_A, params: { id: '999' }, organizationId: 1, body: { name: 'X' } });
    const res = await PUT(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it('returns 403 when some channels do not belong to org or are inactive', async () => {
    // First limit() call: existing schedule found; then channels query: fewer owned
    let limitCalls = 0;
    queryChain.limit = vi.fn().mockImplementation(() => {
      limitCalls++;
      if (limitCalls === 1) return Promise.resolve([SAMPLE_SCHEDULE]);
      return Promise.resolve([]);
    });
    // Channel query returns fewer than requested
    let thenCalls = 0;
    queryChain.then = (resolve: any) => {
      thenCalls++;
      if (thenCalls === 1) return resolve([{ id: 1 }]); // only 1 of 2 channels
      return resolve([]);
    };

    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      organizationId: 1,
      body: { channelIds: [1, 99] },
    });
    const res = await PUT(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(403);
    expect(data.error).toContain('channels');
  });

  it('returns 403 when some media files do not belong to org', async () => {
    // existing schedule found
    queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve([SAMPLE_SCHEDULE]));
    // channel ownership ok, media ownership fail
    let thenCalls = 0;
    queryChain.then = (resolve: any) => {
      thenCalls++;
      if (thenCalls === 1) return resolve([{ id: 1 }]); // media: only 1 found
      return resolve([]);
    };

    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      organizationId: 1,
      body: { mediaFileIds: [1, 99] },
    });
    const res = await PUT(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(403);
    expect(data.error).toContain('media files do not belong');
  });

  it('updates schedule and returns 200', async () => {
    const updated = { ...SAMPLE_SCHEDULE, name: 'Updated Schedule' };
    queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve([SAMPLE_SCHEDULE]));
    queryChain.returning = vi.fn().mockResolvedValue([updated]);

    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      organizationId: 1,
      body: { name: 'Updated Schedule' },
    });
    const res = await PUT(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.name).toBe('Updated Schedule');
  });

  it('persists postFormat and threadParts on update', async () => {
    const parts = [{ content: 'part 1' }, { content: 'part 2' }];
    queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve([SAMPLE_SCHEDULE]));
    queryChain.returning = vi.fn().mockResolvedValue([{ ...SAMPLE_SCHEDULE, postFormat: 'thread', threadParts: parts }]);

    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      organizationId: 1,
      body: { postFormat: 'thread', threadParts: parts },
    });
    const res = await PUT(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
    expect(queryChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ postFormat: 'thread', threadParts: parts }),
    );
  });

  it('rejects a thread update with fewer than 2 parts', async () => {
    queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve([SAMPLE_SCHEDULE]));
    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      organizationId: 1,
      body: { postFormat: 'thread', threadParts: [{ content: 'only one' }] },
    });
    const res = await PUT(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('threadParts');
  });

  it('recalculates nextRunAt when timing fields change', async () => {
    queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve([SAMPLE_SCHEDULE]));
    queryChain.returning = vi.fn().mockResolvedValue([{ ...SAMPLE_SCHEDULE, timeOfDay: '14:00' }]);

    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      organizationId: 1,
      body: { timeOfDay: '14:00' },
    });
    await PUT(ctx as any);
    expect(calculateNextRunAt).toHaveBeenCalled();
  });

  it('recalculates nextRunAt when reactivating a schedule', async () => {
    const inactiveSchedule = { ...SAMPLE_SCHEDULE, isActive: false };
    queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve([inactiveSchedule]));
    queryChain.returning = vi.fn().mockResolvedValue([{ ...inactiveSchedule, isActive: true }]);

    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      organizationId: 1,
      body: { isActive: true },
    });
    await PUT(ctx as any);
    expect(calculateNextRunAt).toHaveBeenCalled();
  });

  it('does not recalculate nextRunAt for non-timing changes', async () => {
    queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve([SAMPLE_SCHEDULE]));
    queryChain.returning = vi.fn().mockResolvedValue([{ ...SAMPLE_SCHEDULE, name: 'Renamed' }]);

    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      organizationId: 1,
      body: { name: 'Renamed' },
    });
    await PUT(ctx as any);
    expect(calculateNextRunAt).not.toHaveBeenCalled();
  });

  it('logs schedule.updated activity', async () => {
    queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve([SAMPLE_SCHEDULE]));
    queryChain.returning = vi.fn().mockResolvedValue([SAMPLE_SCHEDULE]);

    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      organizationId: 1,
      body: { name: 'Updated' },
    });
    await PUT(ctx as any);
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'schedule.updated',
        resource: 'schedule',
        resourceId: 1,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/schedules/[id]
// ---------------------------------------------------------------------------

describe('DELETE /api/schedules/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([]);
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null, params: { id: '1' } });
    const res = await DELETE(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns 400 for invalid schedule ID', async () => {
    const ctx = createMockContext({ user: USER_A, params: { id: 'abc' } });
    const res = await DELETE(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it('returns 404 when schedule does not exist', async () => {
    queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve([]));
    const ctx = createMockContext({ user: USER_A, params: { id: '999' }, organizationId: 1 });
    const res = await DELETE(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it('deletes schedule and returns success', async () => {
    queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve([SAMPLE_SCHEDULE]));
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await DELETE(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
  });

  it('logs schedule.deleted activity with schedule name', async () => {
    queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve([SAMPLE_SCHEDULE]));
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    await DELETE(ctx as any);
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'schedule.deleted',
        resource: 'schedule',
        resourceId: 1,
        details: { name: 'Daily Post' },
      }),
    );
  });
});
