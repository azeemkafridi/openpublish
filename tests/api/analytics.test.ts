import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQueryResult: any[] = [];
const queryChain: any = {};
const methods = [
  'select', 'from', 'where', 'orderBy', 'limit', 'offset', 'groupBy',
  'innerJoin', 'leftJoin', 'having',
];
for (const m of methods) {
  queryChain[m] = vi.fn().mockReturnValue(queryChain);
}
queryChain.then = (resolve: any) => resolve(mockQueryResult);

vi.mock('@/lib/db', () => ({
  db: { select: () => queryChain },
}));

// The route wraps its query in cached() (Redis-backed); bypass it so the test never opens a
// real Redis connection — in CI (no Redis) ioredis queues the GET and the route hangs.
vi.mock('@/lib/cache', () => ({
  cached: (_key: string, _ttl: number, compute: () => unknown) => compute(),
}));

vi.mock('@/lib/db/schema', () => ({
  posts: {
    id: 'posts.id',
    organizationId: 'posts.organization_id',
    userId: 'posts.user_id',
    status: 'posts.status',
    publishedAt: 'posts.published_at',
    scheduledAt: 'posts.scheduled_at',
    createdAt: 'posts.created_at',
  },
  postPlatforms: {
    postId: 'post_platforms.post_id',
    platform: 'post_platforms.platform',
    status: 'post_platforms.status',
  },
}));

vi.mock('drizzle-orm', () => {
  // Must be fully inline — vi.mock is hoisted above all const/let
  function makeSqlResult(...args: any[]) {
    return {
      args,
      as: vi.fn().mockReturnValue({ type: 'sql_alias', args }),
      mapWith: vi.fn().mockReturnThis(),
    };
  }
  const sqlFn = (...args: any[]) => makeSqlResult(...args);
  const sqlMock = new Proxy(sqlFn, {
    apply(_t, _this, argsList) { return makeSqlResult(...argsList); },
    get(_t, prop) {
      if (prop === 'raw') return vi.fn(() => makeSqlResult());
      return undefined;
    },
  });
  return {
    eq: vi.fn((...args: any[]) => ({ type: 'eq', args })),
    and: vi.fn((...args: any[]) => ({ type: 'and', args })),
    gte: vi.fn((...args: any[]) => ({ type: 'gte', args })),
    lte: vi.fn((...args: any[]) => ({ type: 'lte', args })),
    between: vi.fn((...args: any[]) => ({ type: 'between', args })),
    isNotNull: vi.fn((...args: any[]) => ({ type: 'isNotNull', args })),
    count: vi.fn(() => makeSqlResult('count')),
    sql: sqlMock,
    desc: vi.fn(),
    asc: vi.fn(),
  };
});

function createContext(overrides: any = {}) {
  const url = new URL('http://localhost:4321/api/analytics/summary');
  for (const [k, v] of Object.entries(overrides.searchParams ?? {})) {
    url.searchParams.set(k, v as string);
  }
  return {
    locals: {
      auth: {
        user: overrides.user !== undefined ? overrides.user : { id: 'user-1' },
      },
    },
    url,
  };
}

async function parseResponse(res: Response) {
  return { status: res.status, data: await res.json() };
}

import { GET } from '@/pages/api/analytics/summary';

describe('GET /api/analytics/summary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const [key, fn] of Object.entries(queryChain)) {
      if (typeof fn === 'function' && key !== 'then') {
        (fn as any).mockReturnValue(queryChain);
      }
    }
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createContext({ user: null });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  it('accepts from and to query params', async () => {
    const ctx = createContext({
      searchParams: { from: '2026-01-01', to: '2026-02-01' },
    });
    const res = await GET(ctx as any);
    expect(res.status).toBe(200);
  });

  it('returns JSON response with correct content-type', async () => {
    const ctx = createContext({
      searchParams: { from: '2026-01-01', to: '2026-02-01' },
    });
    const res = await GET(ctx as any);
    expect(res.headers.get('Content-Type')).toBe('application/json');
  });

  it('returns 200 for valid request', async () => {
    const ctx = createContext({
      searchParams: { from: '2026-01-01', to: '2026-02-06' },
    });
    const res = await GET(ctx as any);
    expect(res.status).toBe(200);
  });

  it('includes publishedTimes (ISO strings) for the posting heatmap', async () => {
    const ctx = createContext({
      searchParams: { from: '2026-01-01', to: '2026-02-01' },
    });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    // The mock query chain returns rows without a `ts` column, so the route's
    // map+filter must yield a clean empty array — never nulls/undefined entries.
    expect(Array.isArray(data.publishedTimes)).toBe(true);
    expect(data.publishedTimes.every((t: unknown) => typeof t === 'string')).toBe(true);
  });

  it('accepts an IANA tz parameter', async () => {
    const ctx = createContext({
      searchParams: { from: '2026-07-01', to: '2026-07-27', tz: 'Asia/Karachi' },
    });
    const res = await GET(ctx as any);
    expect(res.status).toBe(200);
  });

  it('rejects a malformed tz by falling back to UTC (still 200)', async () => {
    const ctx = createContext({
      searchParams: { from: '2026-07-01', to: '2026-07-27', tz: "1'; DROP TABLE posts;--" },
    });
    const res = await GET(ctx as any);
    expect(res.status).toBe(200);
  });

  it('clamps a from older than 30 days to the 30-day floor (statistics cap)', async () => {
    const today = new Date().toISOString().split('T')[0];
    // heatmap=1 so the publishedAt-bounded heatmap query runs — it's the
    // observable carrier of the clamped from date in this mock setup.
    const ctx = createContext({ searchParams: { from: '2020-01-01', to: today, heatmap: '1' } });
    const res = await GET(ctx as any);
    expect(res.status).toBe(200);

    // The lower bound passed to the query must be no earlier than ~30 days ago,
    // even though the caller asked for 2020 — proving the server-side window
    // enforcement. The summary window is a COALESCE(published_at, created_at)
    // sql expression now, so the clamp is asserted through the publishedAt
    // bound on the heatmap query, which uses the same clamped fromDate.
    const { gte } = await import('drizzle-orm');
    const publishedAtCall = (gte as any).mock.calls.find((c: any[]) => c[0] === 'posts.published_at');
    expect(publishedAtCall).toBeTruthy();
    const usedFrom = publishedAtCall[1] as Date;
    const floor = new Date();
    floor.setDate(floor.getDate() - 31); // 1-day slack
    expect(usedFrom.getTime()).toBeGreaterThanOrEqual(floor.getTime());
  });
});
