/**
 * Full CRUD tests for the API Keys API.
 *
 *   GET    /api/api-keys        — list keys (hashes redacted)
 *   POST   /api/api-keys        — generate a new key (with quota check)
 *   DELETE /api/api-keys/[id]   — revoke a key
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  apiKeys: {
    id: 'api_keys.id', organizationId: 'api_keys.organization_id',
    userId: 'api_keys.user_id', name: 'api_keys.name',
    keyHash: 'api_keys.key_hash', keyPrefix: 'api_keys.key_prefix',
    isActive: 'api_keys.is_active', expiresAt: 'api_keys.expires_at',
    lastUsedAt: 'api_keys.last_used_at', createdAt: 'api_keys.created_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ type: 'eq', args: a })),
  and: vi.fn((...a: any[]) => ({ type: 'and', args: a })),
  desc: vi.fn((c: any) => ({ type: 'desc', col: c })),
  inArray: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@/lib/activity/log', () => ({ logActivity: vi.fn() }));

const mockCheckApiKeyQuota = vi.fn().mockResolvedValue({ allowed: true });
const mockGetOrgPlan = vi.fn().mockResolvedValue('pro');
vi.mock('@/lib/quotas/check', () => ({
  checkApiKeyQuota: (...a: any[]) => mockCheckApiKeyQuota(...a),
  getOrgPlan: (...a: any[]) => mockGetOrgPlan(...a),
}));

const mockQuotaExceededResponse = vi.fn((..._args: any[]) =>
  new Response(JSON.stringify({ error: 'Quota exceeded' }), { status: 429 }),
);
vi.mock('@/lib/quotas/errors', () => ({
  quotaExceededResponse: (...a: any[]) => mockQuotaExceededResponse(...a),
}));

// Mock node:crypto — the source uses `crypto.randomBytes` and `crypto.createHash`
vi.mock('node:crypto', () => ({
  default: {
    randomBytes: vi.fn(() => ({
      toString: () => 'a1b2c3d4'.repeat(8),  // 64 hex chars
    })),
    createHash: vi.fn(() => ({
      update: vi.fn().mockReturnThis(),
      digest: () => 'hashed_' + 'f'.repeat(57),  // 64 chars
    })),
  },
}));

// ---------------------------------------------------------------------------
// Import handlers AFTER mocks
// ---------------------------------------------------------------------------
import { GET, POST } from '@/pages/api/api-keys/index';
import { DELETE } from '@/pages/api/api-keys/[id]';
import { logActivity } from '@/lib/activity/log';

import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A, SAMPLE_API_KEY } from '../helpers/fixtures';

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
// GET /api/api-keys
// ---------------------------------------------------------------------------

describe('GET /api/api-keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([SAMPLE_API_KEY]);
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  it('returns sanitized keys (keyPreview instead of full hash)', async () => {
    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data[0]).toHaveProperty('keyPreview');
    // Must NOT expose the full keyHash
    expect(data[0]).not.toHaveProperty('keyHash');
  });

  it('keyPreview is prefix + "..."', async () => {
    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    // SAMPLE_API_KEY: keyPrefix = 'bp_1234'
    // Expected: 'bp_1234...'
    expect(data[0].keyPreview).toBe('bp_1234...');
  });

  it('returns empty array when org has no keys', async () => {
    resetChain([]);
    const ctx = createMockContext({ user: USER_A });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/api-keys
// ---------------------------------------------------------------------------

describe('POST /api/api-keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([]);
    mockCheckApiKeyQuota.mockResolvedValue({ allowed: true });
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null, body: { name: 'Key' } });
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

  it('returns 429 when API key quota is exceeded', async () => {
    mockCheckApiKeyQuota.mockResolvedValue({ allowed: false, limit: 3, current: 3 });
    const ctx = createMockContext({ user: USER_A, body: { name: 'New Key' } });
    const res = await POST(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(429);
    expect(mockQuotaExceededResponse).toHaveBeenCalled();
  });

  it('creates key and returns 201 with the raw key (shown only once)', async () => {
    const createdKey = {
      id: 5, name: 'CI Key',
      keyHash: 'hashed_' + 'f'.repeat(57),
      keyPrefix: 'bp_a1b2',
      expiresAt: null, createdAt: new Date(),
    };
    queryChain.returning = vi.fn().mockResolvedValue([createdKey]);

    const ctx = createMockContext({ user: USER_A, body: { name: 'CI Key' } });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(201);
    expect(data.name).toBe('CI Key');
    // The raw key is returned in the `key` field — starts with "bp_"
    expect(data.key).toMatch(/^bp_/);
    // Full hash must NOT be in the response
    expect(data).not.toHaveProperty('keyHash');
  });

  it('logs activity after creating a key', async () => {
    const createdKey = { id: 7, name: 'Deploy Key' };
    queryChain.returning = vi.fn().mockResolvedValue([createdKey]);

    const ctx = createMockContext({ user: USER_A, body: { name: 'Deploy Key' } });
    await POST(ctx as any);
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'api_key.created',
        resource: 'api_key',
        resourceId: 7,
        details: { name: 'Deploy Key' },
      }),
    );
  });

  it('accepts optional expiresAt date', async () => {
    const createdKey = {
      id: 8, name: 'Temp Key',
      keyHash: 'x'.repeat(64), keyPrefix: 'bp_temp',
      expiresAt: '2026-12-31T00:00:00.000Z', createdAt: new Date(),
    };
    queryChain.returning = vi.fn().mockResolvedValue([createdKey]);

    const ctx = createMockContext({
      user: USER_A,
      body: { name: 'Temp Key', expiresAt: '2026-12-31' },
    });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(201);
    expect(data.expiresAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/api-keys/[id]
// ---------------------------------------------------------------------------

describe('DELETE /api/api-keys/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([SAMPLE_API_KEY]);
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
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('Invalid');
  });

  it('returns 404 when key does not exist', async () => {
    resetChain([]);
    queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve([]));
    const ctx = createMockContext({ user: USER_A, params: { id: '999' } });
    const res = await DELETE(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it('deletes key and returns { success: true }', async () => {
    queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve([SAMPLE_API_KEY]));
    const ctx = createMockContext({ user: USER_A, params: { id: '1' } });
    const res = await DELETE(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
  });

  it('logs activity after deleting a key', async () => {
    queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve([SAMPLE_API_KEY]));
    const ctx = createMockContext({ user: USER_A, params: { id: '1' } });
    await DELETE(ctx as any);
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'api_key.deleted',
        resource: 'api_key',
        resourceId: 1,
        details: { name: 'Test Key' },
      }),
    );
  });
});
