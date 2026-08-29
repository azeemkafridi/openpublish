/**
 * Tests for the Redis-backed per-platform publish semaphore.
 * A fake in-memory Redis stands in for ioredis (INCR/DECR/EXPIRE/DEL).
 */

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const counters = new Map<string, number>();
const mockRedis = {
  incr: vi.fn(async (key: string) => {
    const v = (counters.get(key) ?? 0) + 1;
    counters.set(key, v);
    return v;
  }),
  decr: vi.fn(async (key: string) => {
    const v = (counters.get(key) ?? 0) - 1;
    counters.set(key, v);
    return v;
  }),
  expire: vi.fn(async () => 1),
  del: vi.fn(async (key: string) => {
    counters.delete(key);
    return 1;
  }),
};

vi.mock('@/lib/jobs/queue', () => ({
  getRedisConnection: () => mockRedis,
}));

import { withPlatformSlot, platformConcurrencyCap } from '@/lib/jobs/platform-semaphore';

describe('platformConcurrencyCap', () => {
  it('gives X the strictest cap', () => {
    expect(platformConcurrencyCap('x')).toBe(1);
  });
  it('falls back to the default for unlisted platforms', () => {
    expect(platformConcurrencyCap('mastodon')).toBe(5);
  });
});

describe('withPlatformSlot', () => {
  beforeEach(() => {
    counters.clear();
    vi.clearAllMocks();
  });

  it('runs the function and releases the slot', async () => {
    const result = await withPlatformSlot('mastodon', async () => 'done');
    expect(result).toBe('done');
    expect(counters.get('publish:sem:mastodon') ?? 0).toBeLessThanOrEqual(0);
  });

  it('releases the slot even when the function throws', async () => {
    await expect(withPlatformSlot('mastodon', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(counters.get('publish:sem:mastodon') ?? 0).toBeLessThanOrEqual(0);
  });

  it('caps concurrent execution at the platform limit (x = 1)', async () => {
    let active = 0;
    let peak = 0;
    const task = () =>
      withPlatformSlot('x', async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
      });

    await Promise.all([task(), task(), task()]);
    expect(peak).toBe(1);
  });

  it('proceeds fail-open when Redis errors', async () => {
    mockRedis.incr.mockRejectedValueOnce(new Error('redis down'));
    const result = await withPlatformSlot('x', async () => 'still-ran');
    expect(result).toBe('still-ran');
  });
});

export {};
