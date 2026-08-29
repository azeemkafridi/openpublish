/**
 * Tests for the Channels Health API.
 *
 *   GET /api/channels/[id]/health — check channel health (token + platform API)
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
    platform: 'channels.platform',
    accessToken: 'channels.access_token',
    tokenExpiresAt: 'channels.token_expires_at',
    isActive: 'channels.is_active',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ type: 'eq', args: a })),
  and: vi.fn((...a: any[]) => ({ type: 'and', args: a })),
}));

const mockGetAccountInfo = vi.fn().mockResolvedValue({ id: 'fb-123', name: 'Test' });
const mockGetPlatformHandler = vi.fn().mockReturnValue({
  getAccountInfo: mockGetAccountInfo,
});
vi.mock('@/lib/platforms/registry', () => ({
  getPlatformHandler: (...a: any[]) => mockGetPlatformHandler(...a),
}));

vi.mock('@/lib/platforms/init', () => ({}));

const mockDecrypt = vi.fn().mockReturnValue('decrypted-token');
vi.mock('@/lib/auth/crypto', () => ({
  decrypt: (...a: any[]) => mockDecrypt(...a),
}));

// X health checks hit GET /users/me — a paid read — so the route gates them by the read cap.
const mockCheckXReadBudget = vi.fn().mockResolvedValue(true);
const mockTrackXApiCall = vi.fn();
let mockXDisabled = false;
vi.mock('@/lib/platforms/x-usage', () => ({
  checkXReadBudget: (...a: any[]) => mockCheckXReadBudget(...a),
  trackXApiCall: (...a: any[]) => mockTrackXApiCall(...a),
  X_API_COSTS_DCENTS: { user_read: 10 },
  isXLiveApiDisabled: () => mockXDisabled,
}));
vi.mock('@/lib/quotas/check', () => ({
  getOrgPlan: vi.fn().mockResolvedValue('pro'),
}));
// cache-through helper: passthrough by default (runs compute); overridden per-test for cache hits
const mockCached = vi.fn(async (_key: string, _ttl: number, compute: () => Promise<unknown>) => compute());
vi.mock('@/lib/cache', () => ({
  cached: (...a: any[]) => (mockCached as any)(...a),
}));

// ---------------------------------------------------------------------------
// Import handlers AFTER mocks
// ---------------------------------------------------------------------------
import { GET } from '@/pages/api/channels/[id]/health';
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
// GET /api/channels/[id]/health
// ---------------------------------------------------------------------------

describe('GET /api/channels/[id]/health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([SAMPLE_CHANNEL]);
    mockGetAccountInfo.mockResolvedValue({ id: 'fb-123', name: 'Test' });
    mockDecrypt.mockReturnValue('decrypted-token');
    mockCheckXReadBudget.mockResolvedValue(true);
    mockXDisabled = false;
    mockCached.mockImplementation(async (_key: string, _ttl: number, compute: () => Promise<unknown>) => compute());
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null, params: { id: '1' } });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns 400 for invalid channel ID', async () => {
    const ctx = createMockContext({ user: USER_A, params: { id: 'abc' } });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it('returns 404 when channel does not exist', async () => {
    resetChain([]);
    queryChain.then = (resolve: any) => resolve([]);
    const ctx = createMockContext({ user: USER_A, params: { id: '999' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it('returns healthy: false without a platform call when the channel needs reconnect', async () => {
    queryChain.then = (resolve: any) => resolve([{ ...SAMPLE_CHANNEL, needsReconnect: true }]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.healthy).toBe(false);
    expect(data.tokenStatus).toBe('expired');
    expect(data.message).toContain('reconnect');
    expect(mockGetAccountInfo).not.toHaveBeenCalled();
  });

  it('persists needsReconnect when the live check hits a revoked-token error', async () => {
    queryChain.then = (resolve: any) => resolve([{ ...SAMPLE_CHANNEL, platform: 'facebook' }]);
    mockGetAccountInfo.mockRejectedValue(
      new Error('facebook API error (400): Error validating access token: Session has expired'),
    );
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.healthy).toBe(false);
    expect(queryChain.set).toHaveBeenCalledWith(expect.objectContaining({ needsReconnect: true }));
  });

  it('does not flag needsReconnect on a transient live-check failure', async () => {
    queryChain.then = (resolve: any) => resolve([SAMPLE_CHANNEL]);
    mockGetAccountInfo.mockRejectedValue(new Error('API rate limit exceeded'));
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    await GET(ctx as any);
    expect(queryChain.set).not.toHaveBeenCalled();
  });

  it('returns healthy: false when token is expired', async () => {
    const pastDate = new Date(Date.now() - 1000 * 60 * 60).toISOString();
    queryChain.then = (resolve: any) => resolve([{ ...SAMPLE_CHANNEL, tokenExpiresAt: pastDate }]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.healthy).toBe(false);
    expect(data.tokenStatus).toBe('expired');
  });

  it('returns healthy: false when no accessToken is stored', async () => {
    queryChain.then = (resolve: any) => resolve([{ ...SAMPLE_CHANNEL, accessToken: null }]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.healthy).toBe(false);
    expect(data.tokenStatus).toBe('error');
    expect(data.message).toContain('No access token');
  });

  it('returns healthy: true when platform API call succeeds', async () => {
    queryChain.then = (resolve: any) => resolve([SAMPLE_CHANNEL]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.healthy).toBe(true);
    expect(data.tokenStatus).toBe('valid');
  });

  it('decrypts the token before calling platform handler', async () => {
    queryChain.then = (resolve: any) => resolve([SAMPLE_CHANNEL]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    await GET(ctx as any);
    expect(mockDecrypt).toHaveBeenCalledWith('token');
    expect(mockGetAccountInfo).toHaveBeenCalledWith('decrypted-token');
  });

  it('returns healthy: false when platform API call fails', async () => {
    queryChain.then = (resolve: any) => resolve([SAMPLE_CHANNEL]);
    mockGetAccountInfo.mockRejectedValue(new Error('API rate limit exceeded'));
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.healthy).toBe(false);
    expect(data.tokenStatus).toBe('error');
    expect(data.message).toContain('API rate limit exceeded');
  });

  it('verifies an X token and counts the read when under the daily cap', async () => {
    mockCheckXReadBudget.mockResolvedValue(true);
    queryChain.then = (resolve: any) => resolve([{ ...SAMPLE_CHANNEL, platform: 'x' }]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.healthy).toBe(true);
    expect(mockGetAccountInfo).toHaveBeenCalled();
    expect(mockTrackXApiCall).toHaveBeenCalledWith(1, 'user_read', 10);
  });

  it('skips the live X health read (no API call) when the daily read cap is reached', async () => {
    mockCheckXReadBudget.mockResolvedValue(false);
    queryChain.then = (resolve: any) => resolve([{ ...SAMPLE_CHANNEL, platform: 'x' }]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(mockGetAccountInfo).not.toHaveBeenCalled();
    expect(mockTrackXApiCall).not.toHaveBeenCalled();
    expect(data.tokenStatus).toBe('unknown');
  });

  it('skips the live X read when the global kill switch is on', async () => {
    mockXDisabled = true;
    queryChain.then = (resolve: any) => resolve([{ ...SAMPLE_CHANNEL, platform: 'x' }]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(mockGetAccountInfo).not.toHaveBeenCalled();
    expect(data.tokenStatus).toBe('unknown');
  });

  it('serves a cached X health result without re-reading X', async () => {
    mockCached.mockResolvedValueOnce({ healthy: true, tokenStatus: 'valid' });
    queryChain.then = (resolve: any) => resolve([{ ...SAMPLE_CHANNEL, platform: 'x' }]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.healthy).toBe(true);
    expect(mockGetAccountInfo).not.toHaveBeenCalled();
  });
});
