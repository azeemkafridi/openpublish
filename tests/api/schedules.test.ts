/**
 * Tests for the Schedules API (index).
 *
 *   GET  /api/schedules — list recurring schedules
 *   POST /api/schedules — create recurring schedule with validation
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
vi.mock('@/lib/db', () => ({
  db: {
    select: () => queryChain,
    update: () => queryChain,
    insert: () => queryChain,
    delete: () => queryChain,
  },
}));

vi.mock('@/lib/db/schema', () => ({
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
    mediaFileIds: 'recurring_schedules.media_file_ids',
    contentTemplate: 'recurring_schedules.content_template',
    postTypeOverrides: 'recurring_schedules.post_type_overrides',
    platformSpecific: 'recurring_schedules.platform_specific',
    isActive: 'recurring_schedules.is_active',
    nextRunAt: 'recurring_schedules.next_run_at',
    createdAt: 'recurring_schedules.created_at',
  },
  channels: {
    id: 'channels.id',
    organizationId: 'channels.organization_id',
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
  calculateNextRunAt: vi.fn(() => new Date('2026-03-01T10:00:00Z')),
}));

const mockCheckRecurringScheduleQuota = vi.fn().mockResolvedValue({ allowed: true });
const mockGetOrgPlan = vi.fn().mockResolvedValue('pro');
vi.mock('@/lib/quotas/check', () => ({
  checkRecurringScheduleQuota: (...a: any[]) => mockCheckRecurringScheduleQuota(...a),
  getOrgPlan: (...a: any[]) => mockGetOrgPlan(...a),
}));

const mockQuotaExceededResponse = vi.fn((..._args: any[]) =>
  new Response(JSON.stringify({ error: 'Quota exceeded' }), { status: 403 }),
);
vi.mock('@/lib/quotas/errors', () => ({
  quotaExceededResponse: (...a: any[]) => mockQuotaExceededResponse(...a),
}));

// ---------------------------------------------------------------------------
// Import handlers AFTER mocks
// ---------------------------------------------------------------------------
import { GET, POST } from '@/pages/api/schedules/index';
import { logActivity } from '@/lib/activity/log';
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
// GET /api/schedules
// ---------------------------------------------------------------------------

describe('GET /api/schedules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([SAMPLE_SCHEDULE]);
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns 200 with schedules list', async () => {
    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe('Daily Post');
  });

  it('returns empty array when no schedules exist', async () => {
    resetChain([]);
    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/schedules
// ---------------------------------------------------------------------------

describe('POST /api/schedules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([]);
    mockCheckRecurringScheduleQuota.mockResolvedValue({ allowed: true });
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null, body: { name: 'Test' } });
    const res = await POST(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns 403 when recurring schedule quota is exceeded', async () => {
    mockCheckRecurringScheduleQuota.mockResolvedValue({ allowed: false, limit: 3, current: 3 });
    const ctx = createMockContext({
      user: USER_A,
      body: { name: 'Test', frequency: 'daily', timeOfDay: '10:00', channelIds: [1] },
    });
    const res = await POST(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it('returns 400 when name is missing', async () => {
    const ctx = createMockContext({
      user: USER_A,
      body: { frequency: 'daily', timeOfDay: '10:00', channelIds: [1] },
    });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('required');
  });

  it('returns 400 when frequency is missing', async () => {
    const ctx = createMockContext({
      user: USER_A,
      body: { name: 'Test', timeOfDay: '10:00', channelIds: [1] },
    });
    const res = await POST(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it('returns 400 when timeOfDay is missing', async () => {
    const ctx = createMockContext({
      user: USER_A,
      body: { name: 'Test', frequency: 'daily', channelIds: [1] },
    });
    const res = await POST(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it('returns 400 for invalid frequency value', async () => {
    const ctx = createMockContext({
      user: USER_A,
      body: { name: 'Test', frequency: 'hourly', timeOfDay: '10:00', channelIds: [1] },
    });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('Invalid frequency');
  });

  it('returns 400 when channelIds is missing or empty', async () => {
    const ctx = createMockContext({
      user: USER_A,
      body: { name: 'Test', frequency: 'daily', timeOfDay: '10:00' },
    });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('channelId');
  });

  it('returns 403 when some channels do not belong to org', async () => {
    // Channel ownership check returns fewer than requested
    queryChain.then = (resolve: any) => resolve([{ id: 1 }]); // only 1 of 2 owned

    const ctx = createMockContext({
      user: USER_A,
      organizationId: 1,
      body: { name: 'Test', frequency: 'daily', timeOfDay: '10:00', channelIds: [1, 99] },
    });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(403);
    expect(data.error).toContain('channels do not belong');
  });

  it('returns 403 when some media files do not belong to org', async () => {
    // First query: channel ownership (ok); second query: media ownership (fail)
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([{ id: 1 }]); // channels ok
      if (callCount === 2) return resolve([{ id: 1 }]); // only 1 of 2 media
      return resolve([]);
    };

    const ctx = createMockContext({
      user: USER_A,
      organizationId: 1,
      body: {
        name: 'Test', frequency: 'daily', timeOfDay: '10:00',
        channelIds: [1], mediaFileIds: [1, 99],
      },
    });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(403);
    expect(data.error).toContain('media files do not belong');
  });

  it('returns 201 when creating a schedule successfully', async () => {
    // Channel ownership check passes
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([{ id: 1 }]); // channels owned
      return resolve([]);
    };
    queryChain.returning = vi.fn().mockResolvedValue([SAMPLE_SCHEDULE]);

    const ctx = createMockContext({
      user: USER_A,
      organizationId: 1,
      body: {
        name: 'Daily Post', frequency: 'daily', timeOfDay: '10:00',
        channelIds: [1],
      },
    });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(201);
    expect(data.name).toBe('Daily Post');
  });

  it('logs schedule.created activity', async () => {
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([{ id: 1 }]);
      return resolve([]);
    };
    queryChain.returning = vi.fn().mockResolvedValue([SAMPLE_SCHEDULE]);

    const ctx = createMockContext({
      user: USER_A,
      organizationId: 1,
      body: {
        name: 'Daily Post', frequency: 'daily', timeOfDay: '10:00',
        channelIds: [1],
      },
    });
    await POST(ctx as any);
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'schedule.created',
        resource: 'schedule',
        resourceId: 1,
        details: { name: 'Daily Post', frequency: 'daily' },
      }),
    );
  });

  it('persists postFormat and threadParts for a thread schedule', async () => {
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([{ id: 1 }]); // channels owned
      return resolve([]);
    };
    const parts = [{ content: 'part 1' }, { content: 'part 2' }];
    queryChain.returning = vi.fn().mockResolvedValue([{ ...SAMPLE_SCHEDULE, postFormat: 'thread', threadParts: parts }]);

    const ctx = createMockContext({
      user: USER_A,
      organizationId: 1,
      body: {
        name: 'Thread Sched', frequency: 'daily', timeOfDay: '10:00',
        channelIds: [1], postFormat: 'thread', threadParts: parts,
      },
    });
    const res = await POST(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(201);
    expect(queryChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ postFormat: 'thread', threadParts: parts }),
    );
  });

  it('rejects a thread schedule with fewer than 2 parts', async () => {
    const ctx = createMockContext({
      user: USER_A,
      organizationId: 1,
      body: {
        name: 'Bad Thread', frequency: 'daily', timeOfDay: '10:00',
        channelIds: [1], postFormat: 'thread', threadParts: [{ content: 'only one' }],
      },
    });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('threadParts');
  });

  it('accepts all valid frequency values', async () => {
    for (const freq of ['daily', 'weekly', 'biweekly', 'monthly']) {
      vi.clearAllMocks();
      let callCount = 0;
      queryChain.then = (resolve: any) => {
        callCount++;
        if (callCount === 1) return resolve([{ id: 1 }]);
        return resolve([]);
      };
      queryChain.returning = vi.fn().mockResolvedValue([{ ...SAMPLE_SCHEDULE, frequency: freq }]);

      const ctx = createMockContext({
        user: USER_A,
        organizationId: 1,
        body: { name: 'Test', frequency: freq, timeOfDay: '10:00', channelIds: [1] },
      });
      const res = await POST(ctx as any);
      const { status } = await parseResponse(res);
      expect(status).toBe(201);
    }
  });
});
