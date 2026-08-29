/**
 * Tests for the Channels Mentions (user-search) API.
 *
 *   GET /api/channels/[id]/mentions?q= — provider user search for @mention autocomplete.
 *
 * This is a cost-sensitive endpoint: for X each search is a paid read ($0.05/call), so the route
 * guards it with a min query length, a per-user rate limit, and a short-TTL response cache.
 */

// ---------------------------------------------------------------------------
// Chainable Drizzle mock
// ---------------------------------------------------------------------------
const mockQueryResult: any[] = [];
const queryChain: Record<string, any> = {};
for (const m of ['select', 'from', 'where', 'limit']) {
  queryChain[m] = vi.fn().mockReturnValue(queryChain);
}
queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve(mockQueryResult));
queryChain.then = (resolve: any) => resolve(mockQueryResult);

vi.mock('@/lib/db', () => ({
  db: { select: () => queryChain },
}));
vi.mock('@/lib/db/schema', () => ({
  channels: { id: 'channels.id', organizationId: 'channels.organization_id' },
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ type: 'eq', args: a })),
  and: vi.fn((...a: any[]) => ({ type: 'and', args: a })),
}));

const mockSearchUsers = vi.fn().mockResolvedValue([{ id: '1', handle: '@a', name: 'A' }]);
vi.mock('@/lib/platforms/registry', () => ({
  getPlatformHandler: () => ({ searchUsers: mockSearchUsers }),
}));
vi.mock('@/lib/platforms/init', () => ({}));

const mockDecrypt = vi.fn().mockReturnValue('decrypted-token');
vi.mock('@/lib/auth/crypto', () => ({ decrypt: (...a: any[]) => mockDecrypt(...a) }));

const mockCheckRateLimit = vi.fn().mockResolvedValue({ allowed: true, remaining: 9 });
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...a: any[]) => mockCheckRateLimit(...a),
  rateLimitResponse: (retryAfter: number) =>
    new Response(JSON.stringify({ error: { message: 'Too many requests', code: 'RATE_LIMITED' } }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) },
    }),
}));

// cache-through: passthrough by default (runs compute); overridden per-test for cache hits
const mockCached = vi.fn(async (_key: string, _ttl: number, compute: () => Promise<unknown>) => compute());
vi.mock('@/lib/cache', () => ({ cached: (...a: any[]) => (mockCached as any)(...a) }));

// ---------------------------------------------------------------------------
// Import handler AFTER mocks
// ---------------------------------------------------------------------------
import { GET } from '@/pages/api/channels/[id]/mentions';
import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A, SAMPLE_CHANNEL } from '../helpers/fixtures';

export {};

function resetChain(result: any[] = []) {
  mockQueryResult.length = 0;
  result.forEach((r) => mockQueryResult.push(r));
  queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve(mockQueryResult));
  queryChain.then = (resolve: any) => resolve(mockQueryResult);
}

describe('GET /api/channels/[id]/mentions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([SAMPLE_CHANNEL]);
    mockSearchUsers.mockResolvedValue([{ id: '1', handle: '@a', name: 'A' }]);
    mockDecrypt.mockReturnValue('decrypted-token');
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9 });
    mockCached.mockImplementation(async (_k: string, _t: number, compute: () => Promise<unknown>) => compute());
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null, params: { id: '1' }, searchParams: { q: 'elon' } });
    const { status } = await parseResponse(await GET(ctx as any));
    expect(status).toBe(401);
  });

  it('returns empty (no provider read) for queries under 2 chars', async () => {
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1, searchParams: { q: 'a' } });
    const { status, data } = await parseResponse(await GET(ctx as any));
    expect(status).toBe(200);
    expect(data.users).toEqual([]);
    expect(mockSearchUsers).not.toHaveBeenCalled();
  });

  it('rate-limits abusive lookups (429) before any read', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfter: 30 });
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1, searchParams: { q: 'elon' } });
    const { status } = await parseResponse(await GET(ctx as any));
    expect(status).toBe(429);
    expect(mockSearchUsers).not.toHaveBeenCalled();
  });

  it('searches (through the cache) and returns users on a cache miss', async () => {
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1, searchParams: { q: 'elon' } });
    const { status, data } = await parseResponse(await GET(ctx as any));
    expect(status).toBe(200);
    expect(data.users).toHaveLength(1);
    expect(mockSearchUsers).toHaveBeenCalledWith(expect.anything(), 'elon');
  });

  it('serves cached results without re-spending the read budget (cache hit)', async () => {
    mockCached.mockResolvedValueOnce([{ id: '9', handle: '@cached', name: 'Cached' }]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1, searchParams: { q: 'elon' } });
    const { data } = await parseResponse(await GET(ctx as any));
    expect(data.users[0].handle).toBe('@cached');
    expect(mockSearchUsers).not.toHaveBeenCalled();
  });
});
