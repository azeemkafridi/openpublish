import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  scan: vi.fn(),
  del: vi.fn(),
};

vi.mock('@lib/jobs/queue', () => ({
  getRedisConnection: () => mockRedis,
}));

vi.mock('@lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

export {};

const { cached, invalidateCache } = await import('@lib/cache');

describe('cached()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cached value on hit without calling compute', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({ data: 'cached' }));
    const compute = vi.fn();

    const result = await cached('key:1', 300, compute);

    expect(result).toEqual({ data: 'cached' });
    expect(compute).not.toHaveBeenCalled();
    expect(mockRedis.get).toHaveBeenCalledWith('key:1');
  });

  it('calls compute on cache miss and stores result', async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    mockRedis.set.mockResolvedValueOnce('OK');
    const compute = vi.fn().mockResolvedValue({ data: 'fresh' });

    const result = await cached('key:2', 300, compute);

    expect(result).toEqual({ data: 'fresh' });
    expect(compute).toHaveBeenCalledOnce();
    expect(mockRedis.set).toHaveBeenCalledWith(
      'key:2',
      JSON.stringify({ data: 'fresh' }),
      'EX',
      300,
    );
  });

  it('falls back to compute when Redis GET throws', async () => {
    mockRedis.get.mockRejectedValueOnce(new Error('Connection refused'));
    mockRedis.set.mockRejectedValueOnce(new Error('Connection refused'));
    const compute = vi.fn().mockResolvedValue({ data: 'fallback' });

    const result = await cached('key:3', 300, compute);

    expect(result).toEqual({ data: 'fallback' });
    expect(compute).toHaveBeenCalledOnce();
  });

  it('returns computed result even if SET fails', async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    mockRedis.set.mockRejectedValueOnce(new Error('Redis full'));
    const compute = vi.fn().mockResolvedValue({ data: 'ok' });

    const result = await cached('key:4', 300, compute);

    expect(result).toEqual({ data: 'ok' });
  });

  it('uses provided TTL', async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    mockRedis.set.mockResolvedValueOnce('OK');
    const compute = vi.fn().mockResolvedValue(42);

    await cached('key:5', 600, compute);

    expect(mockRedis.set).toHaveBeenCalledWith('key:5', '42', 'EX', 600);
  });
});

describe('invalidateCache()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('SCANs and deletes matching keys (single batch)', async () => {
    mockRedis.scan.mockResolvedValueOnce(['0', ['cache:a:1', 'cache:a:2', 'cache:a:3']]);
    mockRedis.del.mockResolvedValueOnce(3);

    await invalidateCache('cache:a:*');

    expect(mockRedis.scan).toHaveBeenCalledWith('0', 'MATCH', 'cache:a:*', 'COUNT', 100);
    expect(mockRedis.del).toHaveBeenCalledWith('cache:a:1', 'cache:a:2', 'cache:a:3');
  });

  it('follows the SCAN cursor across multiple batches', async () => {
    mockRedis.scan
      .mockResolvedValueOnce(['42', ['cache:a:1']])  // first batch, cursor not done
      .mockResolvedValueOnce(['0', ['cache:a:2']]);  // second batch, cursor done
    mockRedis.del.mockResolvedValue(1);

    await invalidateCache('cache:a:*');

    expect(mockRedis.scan).toHaveBeenCalledTimes(2);
    expect(mockRedis.del).toHaveBeenCalledWith('cache:a:1');
    expect(mockRedis.del).toHaveBeenCalledWith('cache:a:2');
  });

  it('does nothing when no keys match', async () => {
    mockRedis.scan.mockResolvedValueOnce(['0', []]);

    await invalidateCache('cache:none:*');

    expect(mockRedis.del).not.toHaveBeenCalled();
  });

  it('silently handles Redis errors', async () => {
    mockRedis.scan.mockRejectedValueOnce(new Error('Connection refused'));

    await expect(invalidateCache('cache:err:*')).resolves.toBeUndefined();
  });
});
