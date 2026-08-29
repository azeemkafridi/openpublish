/**
 * Tests for the unread-badge endpoint.
 *
 *   GET /api/notifications/count — cheap cached unread count for bell badges
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWhere = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: mockWhere })) })),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  notifications: {
    userId: 'notifications.user_id',
    type: 'notifications.type',
    isRead: 'notifications.is_read',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ type: 'eq', a })),
  ne: vi.fn((...a: any[]) => ({ type: 'ne', a })),
  and: vi.fn((...a: any[]) => ({ type: 'and', a })),
  count: vi.fn(() => ({ type: 'count' })),
}));

const mockCached = vi.fn((_k: string, _t: number, compute: () => Promise<unknown>) => compute());
vi.mock('@/lib/cache', () => ({
  cached: (...a: any[]) => mockCached(...(a as [string, number, () => Promise<unknown>])),
  invalidateCache: vi.fn().mockResolvedValue(undefined),
}));

const { GET } = await import('@/pages/api/notifications/count');

export {};

function ctx(user: { id: string } | null) {
  return { locals: { auth: { user } } } as any;
}

describe('GET /api/notifications/count', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await GET(ctx(null));
    expect(res.status).toBe(401);
  });

  it('returns the unread total through the cache helper, keyed per user', async () => {
    mockWhere.mockResolvedValueOnce([{ unreadTotal: 7 }]);
    const res = await GET(ctx({ id: 'user-1' }));
    const data = await res.json();
    expect(data).toEqual({ unreadTotal: 7 });
    expect(mockCached).toHaveBeenCalledWith('cache:notifcount:user-1', 30, expect.any(Function));
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=15');
  });
});
