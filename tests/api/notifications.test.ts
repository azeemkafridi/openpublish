import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock drizzle-orm before importing the route
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
const mockLimit = vi.fn();
const mockOffset = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockReturning = vi.fn();

const chainResult: any[] = [];
const queryChain = {
  select: mockSelect,
  from: mockFrom,
  where: mockWhere,
  orderBy: mockOrderBy,
  limit: mockLimit,
  offset: mockOffset,
  update: mockUpdate,
  set: mockSet,
  returning: mockReturning,
};

// Each method returns the chain
for (const [key, fn] of Object.entries(queryChain)) {
  (fn as any).mockReturnValue(queryChain);
}

// Make the chain awaitable
mockOffset.mockResolvedValue(chainResult);
mockLimit.mockResolvedValue(chainResult);
mockWhere.mockResolvedValue(chainResult);
mockSet.mockImplementation(() => queryChain);

// index.ts pulls invalidateUnreadCount from ./count, which uses the redis
// cache helper — keep tests off any real redis.
vi.mock('@/lib/cache', () => ({
  cached: (_k: string, _t: number, compute: () => Promise<unknown>) => compute(),
  invalidateCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/db', () => ({
  db: {
    select: () => queryChain,
    update: () => queryChain,
    insert: () => queryChain,
    delete: () => queryChain,
  },
}));

vi.mock('@/lib/db/schema', () => ({
  notifications: {
    id: 'notifications.id',
    userId: 'notifications.user_id',
    isRead: 'notifications.is_read',
    createdAt: 'notifications.created_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: any[]) => ({ type: 'eq', args })),
  and: vi.fn((...args: any[]) => ({ type: 'and', args })),
  desc: vi.fn((col: any) => ({ type: 'desc', col })),
  inArray: vi.fn((col: any, vals: any[]) => ({ type: 'inArray', col, vals })),
  count: vi.fn(() => 'count'),
  sql: vi.fn(),
}));

// Import route handlers AFTER mocks are set up
import { GET, PATCH } from '@/pages/api/notifications/index';
import { inArray } from 'drizzle-orm';

function createContext(overrides: any = {}) {
  const url = new URL('http://localhost:4321/api/notifications');
  for (const [k, v] of Object.entries(overrides.searchParams ?? {})) {
    url.searchParams.set(k, v as string);
  }

  return {
    locals: {
      auth: {
        user: overrides.user !== undefined ? overrides.user : { id: 'user-1', name: 'Test' },
      },
    },
    url,
    request: {
      json: vi.fn().mockResolvedValue(overrides.body ?? {}),
    } as unknown as Request,
    params: overrides.params ?? {},
  };
}

async function parseResponse(res: Response) {
  return { status: res.status, data: await res.json() };
}

describe('GET /api/notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const fn of Object.values(queryChain)) {
      (fn as any).mockReturnValue(queryChain);
    }
    // Mock Promise.all result for GET: [items, [{ total }]]
    mockOffset.mockResolvedValue([]);
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createContext({ user: null });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 401 when user is undefined', async () => {
    const ctx = createContext({ user: undefined });
    // locals.auth.user is undefined
    ctx.locals.auth = { user: undefined as any };
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(401);
  });
});

describe('PATCH /api/notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const fn of Object.values(queryChain)) {
      (fn as any).mockReturnValue(queryChain);
    }
    mockWhere.mockResolvedValue([]);
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createContext({ user: null, body: { ids: [1] } });
    const res = await PATCH(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 400 when no ids or all provided', async () => {
    const ctx = createContext({ body: {} });
    const res = await PATCH(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('ids array');
  });

  it('returns 400 when ids is empty array', async () => {
    const ctx = createContext({ body: { ids: [] } });
    const res = await PATCH(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('non-empty array');
  });

  it('returns 400 when ids is not an array', async () => {
    const ctx = createContext({ body: { ids: 'not-an-array' } });
    const res = await PATCH(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it('marks specific ids as read using inArray (not raw SQL ANY)', async () => {
    const ctx = createContext({ body: { ids: [1, 2, 3] } });
    const res = await PATCH(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.success).toBe(true);

    // Verify inArray was used instead of raw SQL ANY()
    expect(inArray).toHaveBeenCalledWith(
      'notifications.id',
      [1, 2, 3],
    );
  });

  it('converts string ids to numbers via .map(Number)', async () => {
    const ctx = createContext({ body: { ids: ['8', '15', '22'] } });
    const res = await PATCH(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(200);

    // inArray should receive numbers, not strings
    expect(inArray).toHaveBeenCalledWith(
      'notifications.id',
      [8, 15, 22],
    );
  });

  it('handles single id in array (the original bug)', async () => {
    const ctx = createContext({ body: { ids: [8] } });
    const res = await PATCH(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(200);

    // Should still use inArray, not raw SQL ANY
    expect(inArray).toHaveBeenCalledWith(
      'notifications.id',
      [8],
    );
  });

  it('marks all unread as read when all=true', async () => {
    const ctx = createContext({ body: { all: true } });
    const res = await PATCH(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.success).toBe(true);

    // Should NOT call inArray for mark-all
    expect(inArray).not.toHaveBeenCalled();
  });
});
