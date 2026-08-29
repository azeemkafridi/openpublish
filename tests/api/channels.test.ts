/**
 * Tests for the Channels API (index).
 *
 *   GET /api/channels — list channels with token status
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
  channels: {
    id: 'channels.id',
    organizationId: 'channels.organization_id',
    userId: 'channels.user_id',
    platform: 'channels.platform',
    accountName: 'channels.account_name',
    accountId: 'channels.account_id',
    accountType: 'channels.account_type',
    profileImage: 'channels.profile_image',
    isActive: 'channels.is_active',
    accessToken: 'channels.access_token',
    refreshToken: 'channels.refresh_token',
    tokenExpiresAt: 'channels.token_expires_at',
    metadata: 'channels.metadata',
    createdAt: 'channels.created_at',
    updatedAt: 'channels.updated_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ type: 'eq', args: a })),
  and: vi.fn((...a: any[]) => ({ type: 'and', args: a })),
  desc: vi.fn((c: any) => ({ type: 'desc', col: c })),
  inArray: vi.fn((...a: any[]) => ({ type: 'inArray', args: a })),
  sql: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import handlers AFTER mocks
// ---------------------------------------------------------------------------
import { GET } from '@/pages/api/channels/index';
import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A, SAMPLE_CHANNEL } from '../helpers/fixtures';

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
// GET /api/channels
// ---------------------------------------------------------------------------

describe('GET /api/channels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([SAMPLE_CHANNEL]);
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns 200 with channels list', async () => {
    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toHaveProperty('channels');
    expect(Array.isArray(data.channels)).toBe(true);
    expect(data.channels).toHaveLength(1);
    expect(data.channels[0]).toHaveProperty('id');
    expect(data.channels[0]).toHaveProperty('platform');
    expect(data.channels[0]).toHaveProperty('tokenStatus');
  });

  it('returns empty array when no channels exist', async () => {
    resetChain([]);
    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.channels).toEqual([]);
  });

  it('computes tokenStatus as expired when needsReconnect is set, even with no tokenExpiresAt', async () => {
    // Regression: Facebook page tokens (tokenExpiresAt null) reported "valid"
    // after Meta revoked them server-side — needsReconnect must win.
    resetChain([{ ...SAMPLE_CHANNEL, tokenExpiresAt: null, needsReconnect: true }]);
    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.channels[0].tokenStatus).toBe('expired');
    expect(data.channels[0].needsReconnect).toBe(true);
  });

  it('computes tokenStatus as valid when no tokenExpiresAt', async () => {
    resetChain([{ ...SAMPLE_CHANNEL, tokenExpiresAt: null }]);
    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.channels[0].tokenStatus).toBe('valid');
  });

  it('computes tokenStatus as expired when token has expired', async () => {
    const pastDate = new Date(Date.now() - 1000 * 60 * 60).toISOString(); // 1h ago
    resetChain([{ ...SAMPLE_CHANNEL, tokenExpiresAt: pastDate }]);
    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.channels[0].tokenStatus).toBe('expired');
  });

  it('computes tokenStatus as expiring_soon when token expires within 7 days', async () => {
    const soonDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 3).toISOString(); // 3 days
    resetChain([{ ...SAMPLE_CHANNEL, tokenExpiresAt: soonDate }]);
    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.channels[0].tokenStatus).toBe('expiring_soon');
  });

  it('computes tokenStatus as valid when token expires in > 7 days', async () => {
    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(); // 30 days
    resetChain([{ ...SAMPLE_CHANNEL, tokenExpiresAt: futureDate }]);
    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.channels[0].tokenStatus).toBe('valid');
  });

  it('sets Cache-Control: no-store header', async () => {
    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('does not expose accessToken or refreshToken in response', async () => {
    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.channels[0]).not.toHaveProperty('accessToken');
    expect(data.channels[0]).not.toHaveProperty('refreshToken');
  });

  it('respects active=false query parameter', async () => {
    const ctx = createMockContext({
      user: USER_A,
      organizationId: 1,
      searchParams: { active: 'false' },
    });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
  });
});
