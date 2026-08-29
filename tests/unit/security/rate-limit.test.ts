import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Redis before importing rate-limit
const mockMulti = {
  zremrangebyscore: vi.fn().mockReturnThis(),
  zcard: vi.fn().mockReturnThis(),
  zadd: vi.fn().mockReturnThis(),
  expire: vi.fn().mockReturnThis(),
  exec: vi.fn(),
};

const mockRedis = {
  multi: vi.fn(() => mockMulti),
  zrange: vi.fn(),
};

vi.mock('@lib/jobs/queue', () => ({
  getRedisConnection: () => mockRedis,
}));

import { checkRateLimit, rateLimitResponse } from '@lib/rate-limit';

describe('Rate Limiter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows requests under the limit', async () => {
    mockMulti.exec.mockResolvedValue([
      [null, 0],  // zremrangebyscore
      [null, 3],  // zcard — 3 existing requests
      [null, 1],  // zadd
      [null, 1],  // expire
    ]);

    const result = await checkRateLimit('test-key', 10, 60);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(6); // 10 - 3 - 1
    expect(result.retryAfter).toBeUndefined();
  });

  it('fails open (allows the request) when Redis is unavailable', async () => {
    // A Redis blip must not 500 every API request and login — burst protection is
    // best-effort, so the limiter allows the request instead of throwing.
    mockMulti.exec.mockRejectedValue(new Error('Redis connection refused'));

    const result = await checkRateLimit('test-key', 10, 60);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(10);
  });

  it('blocks requests at the limit', async () => {
    mockMulti.exec.mockResolvedValue([
      [null, 0],
      [null, 10], // zcard — already at max
      [null, 1],
      [null, 1],
    ]);

    const now = Date.now();
    mockRedis.zrange.mockResolvedValue([
      'oldest-entry',
      String(now - 50000), // oldest entry 50s ago
    ]);

    const result = await checkRateLimit('test-key', 10, 60);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('returns a 429 response with Retry-After header', () => {
    const response = rateLimitResponse(30);

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(response.headers.get('Content-Type')).toBe('application/json');
  });
});
