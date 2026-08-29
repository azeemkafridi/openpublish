import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRedis = {
  set: vi.fn(),
  del: vi.fn(),
  exists: vi.fn(),
};

vi.mock('@/lib/jobs/queue', () => ({
  getRedisConnection: () => mockRedis,
}));

export {};

const { acquireRefreshLock, releaseRefreshLock, waitForRefreshLock } = await import('@/lib/oauth/refresh-lock');

describe('refresh-lock (per-channel single-flight)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('acquires the lock when SET NX succeeds', async () => {
    mockRedis.set.mockResolvedValueOnce('OK');
    expect(await acquireRefreshLock(5)).toBe(true);
    expect(mockRedis.set).toHaveBeenCalledWith('refresh-lock:5', '1', 'EX', 30, 'NX');
  });

  it('does NOT acquire when the key already exists (SET NX returns null)', async () => {
    mockRedis.set.mockResolvedValueOnce(null);
    expect(await acquireRefreshLock(5)).toBe(false);
  });

  it('fails open (treated as acquired) when Redis throws', async () => {
    mockRedis.set.mockRejectedValueOnce(new Error('redis down'));
    expect(await acquireRefreshLock(5)).toBe(true);
  });

  it('releases the lock by deleting the key', async () => {
    mockRedis.del.mockResolvedValueOnce(1);
    await releaseRefreshLock(5);
    expect(mockRedis.del).toHaveBeenCalledWith('refresh-lock:5');
  });

  it('waitForRefreshLock returns once the lock key is gone', async () => {
    mockRedis.exists.mockResolvedValue(0); // already released on the first poll
    await waitForRefreshLock(5, 2000);
    expect(mockRedis.exists).toHaveBeenCalled();
  });
});
