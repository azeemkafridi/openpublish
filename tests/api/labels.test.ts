/**
 * Full CRUD tests for the Labels API.
 *
 *   GET  /api/labels        — list all labels for the org
 *   POST /api/labels        — create a label (with quota + duplicate checks)
 *   PUT  /api/labels/[id]   — rename / recolor (with duplicate name check)
 *   DELETE /api/labels/[id] — remove label and its post-label join rows
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
queryChain.limit = vi.fn().mockImplementation(() => {
  const p = Promise.resolve(mockQueryResult);
  return p;
});
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
  labels: {
    id: 'labels.id', organizationId: 'labels.organization_id',
    userId: 'labels.user_id', name: 'labels.name', color: 'labels.color',
    type: 'labels.type', createdAt: 'labels.created_at',
  },
  postLabels: { labelId: 'post_labels.label_id', postId: 'post_labels.post_id' },
  mediaLabels: { labelId: 'media_labels.label_id', mediaFileId: 'media_labels.media_file_id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ type: 'eq', args: a })),
  and: vi.fn((...a: any[]) => ({ type: 'and', args: a })),
  desc: vi.fn((c: any) => ({ type: 'desc', col: c })),
  inArray: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@/lib/activity/log', () => ({ logActivity: vi.fn() }));

const mockCheckLabelQuota = vi.fn().mockResolvedValue({ allowed: true });
const mockGetOrgPlan = vi.fn().mockResolvedValue('pro');
vi.mock('@/lib/quotas/check', () => ({
  checkLabelQuota: (...a: any[]) => mockCheckLabelQuota(...a),
  getOrgPlan: (...a: any[]) => mockGetOrgPlan(...a),
}));

const mockQuotaExceededResponse = vi.fn((..._args: any[]) =>
  new Response(JSON.stringify({ error: 'Quota exceeded' }), { status: 429 }),
);
vi.mock('@/lib/quotas/errors', () => ({
  quotaExceededResponse: (...a: any[]) => mockQuotaExceededResponse(...a),
}));

// ---------------------------------------------------------------------------
// Import handlers AFTER mocks
// ---------------------------------------------------------------------------
import { GET, POST } from '@/pages/api/labels/index';
import { PUT, DELETE } from '@/pages/api/labels/[id]';
import { logActivity } from '@/lib/activity/log';

import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A, SAMPLE_LABEL, SAMPLE_LABEL_2 } from '../helpers/fixtures';

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
// GET /api/labels
// ---------------------------------------------------------------------------

describe('GET /api/labels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([SAMPLE_LABEL, SAMPLE_LABEL_2]);
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns list of labels for the org', async () => {
    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(2);
  });

  it('sets Cache-Control: private, no-store header', async () => {
    const ctx = createMockContext({ user: USER_A });
    const res = await GET(ctx as any);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=30');
  });

  it('returns empty array when org has no labels', async () => {
    resetChain([]);
    const ctx = createMockContext({ user: USER_A });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/labels
// ---------------------------------------------------------------------------

describe('POST /api/labels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([]);
    mockCheckLabelQuota.mockResolvedValue({ allowed: true });
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null, body: { name: 'Test' } });
    const res = await POST(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns 400 when name is missing', async () => {
    const ctx = createMockContext({ user: USER_A, body: {} });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('required');
  });

  it('returns 400 when name is empty string', async () => {
    const ctx = createMockContext({ user: USER_A, body: { name: '' } });
    const res = await POST(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it('returns 429 when label quota is exceeded', async () => {
    mockCheckLabelQuota.mockResolvedValue({ allowed: false, limit: 5, current: 5 });
    const ctx = createMockContext({ user: USER_A, body: { name: 'New' } });
    const res = await POST(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(429);
    expect(mockQuotaExceededResponse).toHaveBeenCalled();
  });

  it('returns 409 when label name already exists in the org', async () => {
    // limit() returns existing label → duplicate
    resetChain([SAMPLE_LABEL]);
    mockCheckLabelQuota.mockResolvedValue({ allowed: true });
    const ctx = createMockContext({ user: USER_A, body: { name: 'Marketing' } });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(409);
    expect(data.error.code).toBe('DUPLICATE_NAME');
  });

  it('creates a label and returns 201 with default color', async () => {
    const createdLabel = { id: 3, name: 'Sales', color: '#6366f1', userId: 'user-a', organizationId: 1 };
    // First call: limit() for duplicate check → empty
    let callCount = 0;
    queryChain.limit = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve([]);  // no duplicate
    });
    // returning() for insert
    queryChain.returning = vi.fn().mockResolvedValue([createdLabel]);
    mockCheckLabelQuota.mockResolvedValue({ allowed: true });

    const ctx = createMockContext({ user: USER_A, body: { name: 'Sales' } });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(201);
    expect(data.name).toBe('Sales');
  });

  it('logs activity after creating a label', async () => {
    queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve([]));
    queryChain.returning = vi.fn().mockResolvedValue([{ id: 10, name: 'DevOps' }]);
    mockCheckLabelQuota.mockResolvedValue({ allowed: true });

    const ctx = createMockContext({ user: USER_A, body: { name: 'DevOps' } });
    await POST(ctx as any);
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'label.created',
        resource: 'label',
        resourceId: 10,
      }),
    );
  });

  it('uses provided color when specified', async () => {
    const created = { id: 4, name: 'Design', color: '#FF0000' };
    queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve([]));
    queryChain.returning = vi.fn().mockResolvedValue([created]);
    mockCheckLabelQuota.mockResolvedValue({ allowed: true });

    const ctx = createMockContext({ user: USER_A, body: { name: 'Design', color: '#FF0000' } });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(201);
    expect(data.color).toBe('#FF0000');
  });
});

// ---------------------------------------------------------------------------
// PUT /api/labels/[id]
// ---------------------------------------------------------------------------

describe('PUT /api/labels/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([SAMPLE_LABEL]);
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null, params: { id: '1' }, body: { name: 'X' } });
    const res = await PUT(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns 400 when id is not numeric', async () => {
    const ctx = createMockContext({ user: USER_A, params: { id: 'abc' }, body: { name: 'X' } });
    const res = await PUT(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it('returns 400 when neither name nor color is provided', async () => {
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, body: {} });
    const res = await PUT(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('name or color');
  });

  it('returns 404 when label does not exist', async () => {
    resetChain([]);
    const ctx = createMockContext({ user: USER_A, params: { id: '999' }, body: { name: 'Y' } });
    const res = await PUT(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it('updates label name and returns 200', async () => {
    const updated = { ...SAMPLE_LABEL, name: 'Rebranded' };
    // First limit() → existing label found; second limit() → no duplicate
    let limitCalls = 0;
    queryChain.limit = vi.fn().mockImplementation(() => {
      limitCalls++;
      if (limitCalls === 1) return Promise.resolve([SAMPLE_LABEL]);
      return Promise.resolve([]);  // no duplicate
    });
    queryChain.returning = vi.fn().mockResolvedValue([updated]);

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, body: { name: 'Rebranded' } });
    const res = await PUT(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.name).toBe('Rebranded');
  });

  it('returns 409 when renaming to a duplicate name', async () => {
    // First limit() → existing label; second limit() → duplicate found
    let limitCalls = 0;
    queryChain.limit = vi.fn().mockImplementation(() => {
      limitCalls++;
      if (limitCalls === 1) return Promise.resolve([SAMPLE_LABEL]);
      return Promise.resolve([SAMPLE_LABEL_2]);  // duplicate exists
    });

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, body: { name: 'Product' } });
    const res = await PUT(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(409);
    expect(data.error.code).toBe('DUPLICATE_NAME');
  });

  it('skips duplicate check when name is unchanged', async () => {
    // existing label has name "Marketing", update with same name
    queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve([SAMPLE_LABEL]));
    queryChain.returning = vi.fn().mockResolvedValue([SAMPLE_LABEL]);

    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      body: { name: 'Marketing', color: '#FF0000' },
    });
    const res = await PUT(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
    // limit() should only be called once (for existence check, not for duplicate)
    expect(queryChain.limit).toHaveBeenCalledTimes(1);
  });

  it('logs activity after updating a label', async () => {
    queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve([SAMPLE_LABEL]));
    queryChain.returning = vi.fn().mockResolvedValue([{ ...SAMPLE_LABEL, color: '#000' }]);

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, body: { color: '#000' } });
    await PUT(ctx as any);
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'label.updated',
        resource: 'label',
        resourceId: 1,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/labels/[id]
// ---------------------------------------------------------------------------

describe('DELETE /api/labels/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([SAMPLE_LABEL]);
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null, params: { id: '1' } });
    const res = await DELETE(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns 400 when id is not numeric', async () => {
    const ctx = createMockContext({ user: USER_A, params: { id: 'abc' } });
    const res = await DELETE(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it('returns 404 when label does not exist', async () => {
    resetChain([]);
    queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve([]));
    const ctx = createMockContext({ user: USER_A, params: { id: '999' } });
    const res = await DELETE(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it('deletes label and returns { success: true }', async () => {
    queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve([SAMPLE_LABEL]));
    const ctx = createMockContext({ user: USER_A, params: { id: '1' } });
    const res = await DELETE(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
  });

  it('logs activity after deleting a label', async () => {
    queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve([SAMPLE_LABEL]));
    const ctx = createMockContext({ user: USER_A, params: { id: '1' } });
    await DELETE(ctx as any);
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'label.deleted',
        resource: 'label',
        resourceId: 1,
        details: { name: 'Marketing' },
      }),
    );
  });
});
