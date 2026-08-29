import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Environment Validation', () => {
  const requiredVars = [
    'DATABASE_URL',
    'REDIS_URL',
    'ENCRYPTION_KEY',
    'BETTER_AUTH_SECRET',
    'BASE_URL',
  ];

  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Set all required vars to valid values
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    process.env.BETTER_AUTH_SECRET = 'test-secret';
    process.env.BASE_URL = 'https://example.com';
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  for (const key of requiredVars) {
    it(`throws when ${key} is missing`, async () => {
      delete process.env[key];
      await expect(() => import('../../../src/lib/env')).rejects.toThrow(key);
    });
  }

  it('succeeds when all variables are present', async () => {
    await expect(import('../../../src/lib/env')).resolves.not.toThrow();
  });

  it('warns when BASE_URL uses HTTP in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.BASE_URL = 'http://example.com';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await import('../../../src/lib/env');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('HTTP in production'),
    );
    warnSpy.mockRestore();
  });
});
