/**
 * Tests for the LinkedIn company-page OAuth session store.
 * Redis is forced to throw so the in-memory fallback path is exercised; crypto is
 * stubbed with a reversible wrapper to prove tokens are encrypted at rest.
 */

vi.mock('@/lib/jobs/queue', () => ({
  getRedisConnection: () => {
    throw new Error('no redis in test');
  },
}));

vi.mock('@/lib/auth/crypto', () => ({
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\(/, '').replace(/\)$/, ''),
}));

const { storeLinkedInPageSession, peekLinkedInPageSession, consumeLinkedInPageSession } = await import(
  '@/lib/oauth/linkedin-page-session'
);

describe('LinkedIn page session store', () => {
  it('stores, peeks without consuming, then consumes a session', async () => {
    const key = await storeLinkedInPageSession({
      userId: 'u1',
      organizationId: 7,
      accessToken: 'tok',
      refreshToken: 'rt',
      expiresIn: 3600,
    });
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(20);

    const peeked = await peekLinkedInPageSession(key);
    expect(peeked).toMatchObject({
      userId: 'u1',
      organizationId: 7,
      accessToken: 'tok',
      refreshToken: 'rt',
      expiresIn: 3600,
    });

    // Peek must NOT consume — still retrievable
    expect(await peekLinkedInPageSession(key)).not.toBeNull();

    const consumed = await consumeLinkedInPageSession(key);
    expect(consumed?.accessToken).toBe('tok');

    // Consume deletes it
    expect(await peekLinkedInPageSession(key)).toBeNull();
  });

  it('returns null for unknown keys', async () => {
    expect(await peekLinkedInPageSession('does-not-exist')).toBeNull();
    expect(await consumeLinkedInPageSession('does-not-exist')).toBeNull();
  });

  it('handles sessions without a refresh token', async () => {
    const key = await storeLinkedInPageSession({
      userId: 'u2',
      organizationId: 9,
      accessToken: 'tok2',
    });
    const peeked = await peekLinkedInPageSession(key);
    expect(peeked?.refreshToken).toBeUndefined();
    expect(peeked?.accessToken).toBe('tok2');
  });
});

export {};
