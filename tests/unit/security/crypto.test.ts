import { describe, it, expect, vi, afterEach } from 'vitest';

describe('Encryption Key Validation', () => {
  const originalEnv = process.env.ENCRYPTION_KEY;

  afterEach(() => {
    process.env.ENCRYPTION_KEY = originalEnv;
    vi.resetModules();
  });

  it('throws if ENCRYPTION_KEY is missing', async () => {
    delete process.env.ENCRYPTION_KEY;
    const { encrypt } = await import('@lib/auth/crypto');
    expect(() => encrypt('test')).toThrow('ENCRYPTION_KEY');
  });

  it('throws if ENCRYPTION_KEY is not 64 hex chars', async () => {
    process.env.ENCRYPTION_KEY = 'too-short';
    const { encrypt } = await import('@lib/auth/crypto');
    expect(() => encrypt('test')).toThrow('64-character hex');
  });

  it('encrypts and decrypts correctly with valid key', async () => {
    process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const { encrypt, decrypt } = await import('@lib/auth/crypto');

    const plaintext = 'hello world';
    const encrypted = encrypt(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted).toContain(':');

    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });
});
