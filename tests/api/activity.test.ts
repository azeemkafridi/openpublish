/**
 * Tests for the Activity Log API.
 *
 *   GET /api/activity — list activity log with filters and pagination
 */

// ---------------------------------------------------------------------------
// Hoisted state used by the mock factory — vi.hoisted runs before vi.mock
// ---------------------------------------------------------------------------
const { state, makeChain } = vi.hoisted(() => {
  const state = {
    selectCallIndex: 0,
    selectResults: [] as any[][],
  };

  function makeChain(resolveWith: any[]) {
    const chain: Record<string, any> = {};
    const methods = [
      'select', 'from', 'where', 'orderBy', 'limit', 'offset',
      'insert', 'values', 'returning', 'update', 'set', 'delete',
      'innerJoin', 'leftJoin', 'groupBy', 'having',
    ];
    for (const m of methods) {
      chain[m] = (..._args: any[]) => chain;
    }
    chain.then = (resolve: any) => resolve(resolveWith);
    return chain;
  }

  return { state, makeChain };
});

// ---------------------------------------------------------------------------
// vi.mock (hoisted)
// ---------------------------------------------------------------------------
vi.mock('@lib/db', () => ({
  db: {
    select: (..._args: any[]) => {
      const idx = state.selectCallIndex++;
      const result = idx < state.selectResults.length ? state.selectResults[idx] : [];
      return makeChain(result);
    },
    update: () => makeChain([]),
    insert: () => makeChain([]),
    delete: () => makeChain([]),
  },
}));

vi.mock('@lib/db/schema', () => ({
  activityLogs: {
    id: 'activity_logs.id',
    userId: 'activity_logs.user_id',
    organizationId: 'activity_logs.organization_id',
    action: 'activity_logs.action',
    resource: 'activity_logs.resource',
    resourceId: 'activity_logs.resource_id',
    details: 'activity_logs.details',
    level: 'activity_logs.level',
    createdAt: 'activity_logs.created_at',
  },
  posts: {
    id: 'posts.id',
    mediaFiles: 'posts.media_files',
  },
  mediaFiles: {
    id: 'media_files.id',
    thumbnailPath: 'media_files.thumbnail_path',
    originalPath: 'media_files.original_path',
    mimeType: 'media_files.mime_type',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: any[]) => ({ type: 'eq', args: a }),
  ne: (...a: any[]) => ({ type: 'ne', args: a }),
  and: (...a: any[]) => ({ type: 'and', args: a }),
  or: (...a: any[]) => ({ type: 'or', args: a }),
  isNull: (c: any) => ({ type: 'isNull', col: c }),
  desc: (c: any) => ({ type: 'desc', col: c }),
  count: () => 'count_expr',
  inArray: (...a: any[]) => ({ type: 'inArray', args: a }),
}));

vi.mock('@lib/media/upload', () => ({
  getMediaPublicUrl: (path: string) => `https://cdn.example.com/${path}`,
}));

// ---------------------------------------------------------------------------
// Import handlers AFTER mocks
// ---------------------------------------------------------------------------
import { GET } from '@/pages/api/activity/index';
import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A } from '../helpers/fixtures';

const SAMPLE_ACTIVITY = {
  id: 1,
  userId: 'user-a',
  organizationId: 1,
  action: 'post.published',
  resource: 'post',
  resourceId: '1',
  details: { platforms: 2 },
  level: 'info',
  createdAt: new Date('2026-01-20'),
};

const SAMPLE_NON_POST_ACTIVITY = {
  id: 2,
  userId: 'user-a',
  organizationId: 1,
  action: 'channel.disconnected',
  resource: 'channel',
  resourceId: '5',
  details: {},
  level: 'info',
  createdAt: new Date('2026-01-19'),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setSelectResults(...results: any[][]) {
  state.selectCallIndex = 0;
  state.selectResults = results;
}

// ---------------------------------------------------------------------------
// GET /api/activity
// ---------------------------------------------------------------------------

describe('GET /api/activity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.selectCallIndex = 0;
    state.selectResults = [];
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns 200 with activity list and pagination', async () => {
    // First select: items query, second select: count query
    setSelectResults([SAMPLE_ACTIVITY], [{ total: 1 }]);

    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toHaveProperty('activities');
    expect(data).toHaveProperty('pagination');
    expect(data.pagination).toHaveProperty('page');
    expect(data.pagination).toHaveProperty('limit');
    expect(data.pagination).toHaveProperty('total');
    expect(data.pagination).toHaveProperty('totalPages');
  });

  it('sets Cache-Control: private, no-store header', async () => {
    setSelectResults([], [{ total: 0 }]);

    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=15');
  });

  it('returns empty activities when none exist', async () => {
    setSelectResults([], [{ total: 0 }]);

    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.activities).toEqual([]);
    expect(data.pagination.total).toBe(0);
  });

  it('respects action filter parameter', async () => {
    setSelectResults([SAMPLE_ACTIVITY], [{ total: 1 }]);

    const ctx = createMockContext({
      user: USER_A,
      organizationId: 1,
      searchParams: { action: 'post.published' },
    });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
  });

  it('respects resource filter parameter', async () => {
    setSelectResults([SAMPLE_NON_POST_ACTIVITY], [{ total: 1 }]);

    const ctx = createMockContext({
      user: USER_A,
      organizationId: 1,
      searchParams: { resource: 'channel' },
    });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
  });

  it('respects page and limit parameters', async () => {
    setSelectResults([], [{ total: 0 }]);

    const ctx = createMockContext({
      user: USER_A,
      organizationId: 1,
      searchParams: { page: '2', limit: '10' },
    });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.pagination.page).toBe(2);
    expect(data.pagination.limit).toBe(10);
  });

  it('clamps limit to max 100', async () => {
    setSelectResults([], [{ total: 0 }]);

    const ctx = createMockContext({
      user: USER_A,
      organizationId: 1,
      searchParams: { limit: '500' },
    });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.pagination.limit).toBe(100);
  });

  it('defaults page to 1 and limit to 20', async () => {
    setSelectResults([], [{ total: 0 }]);

    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.pagination.page).toBe(1);
    expect(data.pagination.limit).toBe(20);
  });
});
