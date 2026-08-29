/**
 * Channel disconnect tests.
 *
 * Tests DELETE /api/channels/[id] at webapp/src/pages/api/channels/[id].ts covering:
 *   - DELETE with valid channel ID deletes and returns success
 *   - DELETE with invalid (non-numeric) ID returns 400
 *   - DELETE with non-existent channel returns 404
 *   - DELETE without auth returns 401
 *   - Activity is logged on disconnect
 */

import { createDbMock, createDrizzleOrmMock } from '../../helpers/db-mock';

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------
const { db: mockDb, setResult, resetChain } = createDbMock();
const drizzleOrmMock = createDrizzleOrmMock();

vi.mock('@/lib/db', () => ({ db: mockDb }));

vi.mock('@/lib/db/schema', () => ({
  channels: {
    id: 'ch.id',
    organizationId: 'ch.org_id',
    platform: 'ch.platform',
    accountName: 'ch.account_name',
    accountId: 'ch.account_id',
    accountType: 'ch.account_type',
    accessToken: 'ch.access_token',
    refreshToken: 'ch.refresh_token',
    tokenExpiresAt: 'ch.token_expires_at',
    profileImage: 'ch.profile_image',
    isActive: 'ch.is_active',
    userId: 'ch.user_id',
    metadata: 'ch.metadata',
    createdAt: 'ch.created_at',
    updatedAt: 'ch.updated_at',
  },
  recurringSchedules: {
    id: 'rs.id',
    organizationId: 'rs.org_id',
    isActive: 'rs.is_active',
    channelIds: 'rs.channel_ids',
  },
}));

vi.mock('drizzle-orm', () => drizzleOrmMock);

const mockLogActivity = vi.fn();
vi.mock('@/lib/activity/log', () => ({
  logActivity: (...args: any[]) => mockLogActivity(...args),
}));

// ---------------------------------------------------------------------------
// Import handlers AFTER mocks
// ---------------------------------------------------------------------------

const { GET, DELETE: DELETE_HANDLER } = await import('@/pages/api/channels/[id]');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCtx(options: {
  user?: { id: string; name: string } | null;
  organizationId?: number;
  params?: Record<string, string>;
}) {
  const {
    user = { id: 'user-1', name: 'Test User' },
    organizationId = 1,
    params = {},
  } = options;

  return {
    locals: {
      auth: {
        user,
        organizationId,
        organizationPlan: 'pro' as const,
        organizationName: 'Test Org',
      },
    },
    params,
  };
}

async function parseResponse(res: Response) {
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DELETE /api/channels/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain();
  });

  it('returns 401 when user is null', async () => {
    const ctx = createCtx({ user: null, params: { id: '1' } });
    const res = await DELETE_HANDLER(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 400 for non-numeric ID', async () => {
    const ctx = createCtx({ params: { id: 'abc' } });
    const res = await DELETE_HANDLER(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('Invalid');
  });

  it('returns 400 for NaN ID', async () => {
    const ctx = createCtx({ params: { id: 'NaN' } });
    const res = await DELETE_HANDLER(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('Invalid');
  });

  it('returns 404 when channel not found (empty returning)', async () => {
    // returning() resolves to empty array — channel didn't exist or wasn't owned
    setResult([]);

    const ctx = createCtx({ params: { id: '999' } });
    const res = await DELETE_HANDLER(ctx as any);
    const { status, data } = await parseResponse(res);

    expect(status).toBe(404);
    expect(data.error).toContain('not found');
  });

  it('deletes channel and returns success', async () => {
    // returning() resolves to the deleted channel
    setResult([{ id: 42 }]);

    const ctx = createCtx({ params: { id: '42' } });
    const res = await DELETE_HANDLER(ctx as any);
    const { status, data } = await parseResponse(res);

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.deletedId).toBe(42);
  });

  it('logs activity on successful disconnect', async () => {
    setResult([{ id: 42 }]);

    const ctx = createCtx({ params: { id: '42' } });
    await DELETE_HANDLER(ctx as any);

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        organizationId: 1,
        action: 'channel.disconnected',
        resource: 'channel',
        resourceId: 42,
      }),
    );
  });

  it('does not log activity when channel not found', async () => {
    setResult([]);

    const ctx = createCtx({ params: { id: '999' } });
    await DELETE_HANDLER(ctx as any);

    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});

describe('GET /api/channels/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain();
  });

  it('returns 401 when user is null', async () => {
    const ctx = createCtx({ user: null, params: { id: '1' } });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 400 for non-numeric ID', async () => {
    const ctx = createCtx({ params: { id: 'xyz' } });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('Invalid');
  });
});
