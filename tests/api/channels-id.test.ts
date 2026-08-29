/**
 * Tests for the Channels [id] API.
 *
 *   GET    /api/channels/[id] — get single channel with tokenStatus
 *   DELETE /api/channels/[id] — delete channel with recurring schedule deactivation
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
  recurringSchedules: {
    id: 'recurring_schedules.id',
    organizationId: 'recurring_schedules.organization_id',
    channelIds: 'recurring_schedules.channel_ids',
    isActive: 'recurring_schedules.is_active',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ type: 'eq', args: a })),
  and: vi.fn((...a: any[]) => ({ type: 'and', args: a })),
  desc: vi.fn((c: any) => ({ type: 'desc', col: c })),
  inArray: vi.fn((...a: any[]) => ({ type: 'inArray', args: a })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: any[]) => ({
    type: 'sql', strings, values,
  })),
}));

vi.mock('@/lib/activity/log', () => ({ logActivity: vi.fn() }));

// ---------------------------------------------------------------------------
// Import handlers AFTER mocks
// ---------------------------------------------------------------------------
import { GET, DELETE, PATCH } from '@/pages/api/channels/[id]';
import { logActivity } from '@/lib/activity/log';
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
// GET /api/channels/[id]
// ---------------------------------------------------------------------------

describe('GET /api/channels/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([SAMPLE_CHANNEL]);
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null, params: { id: '1' } });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns 400 for invalid (non-numeric) channel ID', async () => {
    const ctx = createMockContext({ user: USER_A, params: { id: 'abc' } });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('Invalid');
  });

  it('returns 404 when channel does not belong to org', async () => {
    resetChain([]);
    queryChain.then = (resolve: any) => resolve([]);
    const ctx = createMockContext({ user: USER_A, params: { id: '999' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it('returns 200 with channel data and tokenStatus', async () => {
    queryChain.then = (resolve: any) => resolve([SAMPLE_CHANNEL]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toHaveProperty('channel');
    expect(data.channel.id).toBe(1);
    expect(data.channel.platform).toBe('facebook');
    expect(data.channel).toHaveProperty('tokenStatus');
  });

  it('does not expose accessToken or refreshToken', async () => {
    queryChain.then = (resolve: any) => resolve([SAMPLE_CHANNEL]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.channel).not.toHaveProperty('accessToken');
    expect(data.channel).not.toHaveProperty('refreshToken');
  });

  it('returns expired tokenStatus when token has expired', async () => {
    const pastDate = new Date(Date.now() - 1000 * 60 * 60).toISOString();
    queryChain.then = (resolve: any) => resolve([{ ...SAMPLE_CHANNEL, tokenExpiresAt: pastDate }]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.channel.tokenStatus).toBe('expired');
  });

  it('returns expiring_soon tokenStatus when token expires within 7 days', async () => {
    const soonDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 2).toISOString();
    queryChain.then = (resolve: any) => resolve([{ ...SAMPLE_CHANNEL, tokenExpiresAt: soonDate }]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.channel.tokenStatus).toBe('expiring_soon');
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/channels/[id]
// ---------------------------------------------------------------------------

describe('DELETE /api/channels/[id]', () => {
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

  it('returns 400 for invalid channel ID', async () => {
    const ctx = createMockContext({ user: USER_A, params: { id: 'abc' } });
    const res = await DELETE(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it('returns 404 when channel does not exist or is not owned', async () => {
    queryChain.limit = vi.fn().mockResolvedValue([]);
    const ctx = createMockContext({ user: USER_A, params: { id: '999' }, organizationId: 1 });
    const res = await DELETE(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it('returns 200 with success and deletedId after soft-deleting', async () => {
    // ownership lookup returns the channel row
    queryChain.limit = vi.fn().mockResolvedValue([{ id: 1, metadata: { pageAccessToken: 'x', pageId: 'p1' } }]);
    // schedulesWithChannel query returns empty (no schedules to deactivate)
    queryChain.then = (resolve: any) => resolve([]);

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await DELETE(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.deletedId).toBe(1);
  });

  it('soft-deletes: wipes tokens, deactivates, and strips sensitive metadata', async () => {
    queryChain.limit = vi.fn().mockResolvedValue([{ id: 1, metadata: { pageAccessToken: 'x', pageId: 'p1' } }]);
    queryChain.then = (resolve: any) => resolve([]);

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    await DELETE(ctx as any);

    expect(queryChain.delete).not.toHaveBeenCalled();
    expect(queryChain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        isActive: false,
        needsReconnect: false,
        accessToken: null,
        refreshToken: null,
        tokenExpiresAt: null,
        metadata: { pageId: 'p1' },
      }),
    );
  });

  it('logs channel.disconnected activity after deleting', async () => {
    queryChain.limit = vi.fn().mockResolvedValue([{ id: 1, metadata: null }]);
    queryChain.then = (resolve: any) => resolve([]);

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    await DELETE(ctx as any);
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'channel.disconnected',
        resource: 'channel',
        resourceId: 1,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/channels/[id] — X metrics sync opt-in
// ---------------------------------------------------------------------------

describe('PATCH /api/channels/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([{ ...SAMPLE_CHANNEL, metadata: { foo: 'bar' } }]);
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null, params: { id: '1' }, body: { metricsSyncEnabled: true } });
    const res = await PATCH(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns 404 when the channel is not in the org', async () => {
    resetChain([]);
    const ctx = createMockContext({ user: USER_A, params: { id: '999' }, organizationId: 1, body: { metricsSyncEnabled: true } });
    const res = await PATCH(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it('returns 400 when no supported fields are provided', async () => {
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1, body: {} });
    const res = await PATCH(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it('opts in by merging metricsSyncEnabled into existing channel metadata', async () => {
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1, body: { metricsSyncEnabled: true } });
    const res = await PATCH(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    // Existing metadata is preserved; the opt-in flag is merged in.
    const setArg = (queryChain.set as any).mock.calls[0][0];
    expect(setArg.metadata).toEqual({ foo: 'bar', metricsSyncEnabled: true });
  });
});
