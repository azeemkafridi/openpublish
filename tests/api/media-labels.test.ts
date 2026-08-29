/**
 * Tests for the Media Labels API.
 *
 *   GET /api/media/[id]/labels — get labels for a media file
 *   PUT /api/media/[id]/labels — set labels for a media file (replaces all)
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
  mediaFiles: {
    id: 'media_files.id',
    organizationId: 'media_files.organization_id',
  },
  mediaLabels: {
    mediaFileId: 'media_labels.media_file_id',
    labelId: 'media_labels.label_id',
  },
  labels: {
    id: 'labels.id',
    name: 'labels.name',
    color: 'labels.color',
    organizationId: 'labels.organization_id',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ type: 'eq', args: a })),
  and: vi.fn((...a: any[]) => ({ type: 'and', args: a })),
  inArray: vi.fn((...a: any[]) => ({ type: 'inArray', args: a })),
}));

// ---------------------------------------------------------------------------
// Import handlers AFTER mocks
// ---------------------------------------------------------------------------
import { GET, PUT } from '@/pages/api/media/[id]/labels';
import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A } from '../helpers/fixtures';

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
// GET /api/media/[id]/labels
// ---------------------------------------------------------------------------

describe('GET /api/media/[id]/labels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([]);
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null, params: { id: '1' } });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns 400 for invalid media ID', async () => {
    const ctx = createMockContext({ user: USER_A, params: { id: '0' } });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it('returns 200 with labels array', async () => {
    const labelRows = [
      { labelId: 1, name: 'Marketing', color: '#3B82F6' },
      { labelId: 2, name: 'Product', color: '#10B981' },
    ];
    queryChain.then = (resolve: any) => resolve(labelRows);

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(2);
    expect(data[0]).toHaveProperty('id');
    expect(data[0]).toHaveProperty('name');
    expect(data[0]).toHaveProperty('color');
  });

  it('returns empty array when media has no labels', async () => {
    queryChain.then = (resolve: any) => resolve([]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/media/[id]/labels
// ---------------------------------------------------------------------------

describe('PUT /api/media/[id]/labels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([]);
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null, params: { id: '1' }, body: { labelIds: [1] } });
    const res = await PUT(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns 400 for invalid media ID', async () => {
    const ctx = createMockContext({ user: USER_A, params: { id: '0' }, body: { labelIds: [1] } });
    const res = await PUT(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it('returns 404 when media file does not belong to org', async () => {
    // First query for ownership check returns empty
    queryChain.then = (resolve: any) => resolve([]);
    const ctx = createMockContext({ user: USER_A, params: { id: '999' }, organizationId: 1, body: { labelIds: [1] } });
    const res = await PUT(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it('returns 400 when some labels do not belong to org', async () => {
    // First query: media exists; second query: label validation returns fewer
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([{ id: 1 }]); // media found
      if (callCount === 2) return resolve([{ id: 1 }]); // only 1 of 2 labels found
      return resolve([]);
    };

    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      organizationId: 1,
      body: { labelIds: [1, 999] },
    });
    const res = await PUT(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('labels not found');
  });

  it('returns 200 with ok:true when labels are set successfully', async () => {
    // First: media ownership check; second: label validation
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([{ id: 1 }]); // media found
      if (callCount === 2) return resolve([{ id: 1 }, { id: 2 }]); // labels valid
      return resolve([]);
    };

    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      organizationId: 1,
      body: { labelIds: [1, 2] },
    });
    const res = await PUT(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
  });

  it('handles empty labelIds to clear all labels', async () => {
    queryChain.then = (resolve: any) => resolve([{ id: 1 }]); // media found
    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      organizationId: 1,
      body: { labelIds: [] },
    });
    const res = await PUT(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
  });
});
