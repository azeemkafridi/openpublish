/**
 * Token refresh worker tests.
 *
 * Tests webapp/src/lib/jobs/token-refresh.worker.ts covering:
 *   - Refreshes expiring tokens and updates DB with encrypted tokens
 *   - Skips channels with no refresh token
 *   - Updates tokenExpiresAt when expiresIn is returned
 *   - Stores new refreshToken when returned
 *   - Sends notification when refresh returns null and token expires within 3 days
 *   - Sends notification on refresh error (token_expired type)
 *   - Does nothing when no channels need refreshing
 *   - Processes multiple channels independently
 *   - Static-token validation sweep (Facebook page tokens etc. with no expiry):
 *     flags needsReconnect on platform-side revocation, skips recently-validated
 *     channels, ignores transient errors, never touches X
 */

// ---------------------------------------------------------------------------
// Mocks BEFORE importing the module
// ---------------------------------------------------------------------------

const mockDbSelectResults: any[][] = [];
const mockDbUpdateSets: any[] = [];
let selectCallIdx = 0;

const mockDecrypt = vi.fn((v: string) => `decrypted_${v}`);
const mockEncrypt = vi.fn((v: string) => `encrypted_${v}`);
const mockRefreshToken = vi.fn();
const mockGetAccountInfo = vi.fn();
const mockAddNotificationJob = vi.fn().mockResolvedValue(undefined);
let capturedProcessor: ((job: any) => Promise<void>) | null = null;

function buildSelectChain() {
  const getResult = () => {
    const rows = mockDbSelectResults[selectCallIdx] || [];
    selectCallIdx++;
    return rows;
  };
  const makeThenable = (resolver: () => any[]) => ({
    limit: vi.fn().mockImplementation(() => Promise.resolve(resolver())),
    then: (resolve: any, reject?: any) => Promise.resolve(resolver()).then(resolve, reject),
  });
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(() => makeThenable(getResult)),
    }),
  };
}

function buildUpdateChain() {
  return {
    set: vi.fn().mockImplementation((data: any) => {
      mockDbUpdateSets.push(data);
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
  };
}

vi.mock('bullmq', () => {
  class MockWorker {
    constructor(_name: string, processor: any, _opts: any) {
      capturedProcessor = processor;
    }
  }
  return { Worker: MockWorker };
});

vi.mock('@/lib/jobs/queue', () => ({
  getRedisConnection: () => ({}),
  QUEUE_NAMES: { TOKEN_REFRESH: 'token-refresh' },
  addNotificationJob: (...args: any[]) => mockAddNotificationJob(...args),
}));

vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn().mockImplementation(() => buildSelectChain()),
    update: vi.fn().mockImplementation(() => buildUpdateChain()),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  channels: {
    isActive: 'isActive', refreshToken: 'refreshToken',
    tokenExpiresAt: 'tokenExpiresAt', id: 'id',
    platform: 'platform', userId: 'userId', organizationId: 'organizationId',
    needsReconnect: 'needsReconnect', accessToken: 'accessToken', metadata: 'metadata',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ _type: 'eq', a })),
  and: vi.fn((...a: any[]) => ({ _type: 'and', a })),
  lte: vi.fn((...a: any[]) => ({ _type: 'lte', a })),
  gte: vi.fn((...a: any[]) => ({ _type: 'gte', a })),
  isNotNull: vi.fn((c: any) => ({ _type: 'isNotNull', c })),
  isNull: vi.fn((c: any) => ({ _type: 'isNull', c })),
}));

vi.mock('@/lib/auth/crypto', () => ({
  encrypt: (v: string) => mockEncrypt(v),
  decrypt: (v: string) => mockDecrypt(v),
}));

vi.mock('@/lib/platforms/registry', () => ({
  getPlatformHandler: () => ({
    refreshToken: (...args: any[]) => mockRefreshToken(...args),
    getAccountInfo: (...args: any[]) => mockGetAccountInfo(...args),
  }),
}));

vi.mock('@/lib/platforms/types', () => ({
  platformDisplayName: (p: string) => p.charAt(0).toUpperCase() + p.slice(1),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

export {};

const { createTokenRefreshWorker } = await import('@/lib/jobs/token-refresh.worker');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetState() {
  selectCallIdx = 0;
  mockDbSelectResults.length = 0;
  mockDbUpdateSets.length = 0;
}

function makeChannel(overrides: Record<string, any> = {}) {
  return {
    id: 1, platform: 'x', userId: 'user-1', organizationId: 1,
    accountName: 'TestAccount', accessToken: 'enc_access',
    refreshToken: 'enc_refresh',
    tokenExpiresAt: new Date(Date.now() + 86400000), // 1 day
    isActive: true, metadata: null, ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('token-refresh worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
    capturedProcessor = null;
    createTokenRefreshWorker();
  });

  it('does nothing when no channels need refreshing', async () => {
    mockDbSelectResults.push([]);

    await capturedProcessor!({ name: 'refresh', data: {} });

    expect(mockRefreshToken).not.toHaveBeenCalled();
    expect(mockDbUpdateSets).toHaveLength(0);
  });

  it('refreshes expiring token and updates DB with encrypted values', async () => {
    mockDbSelectResults.push([makeChannel()]);

    mockRefreshToken.mockResolvedValue({
      accessToken: 'new_access_token',
      refreshToken: 'new_refresh_token',
      expiresIn: 3600,
    });

    await capturedProcessor!({ name: 'refresh', data: {} });

    expect(mockDecrypt).toHaveBeenCalledWith('enc_refresh');
    expect(mockRefreshToken).toHaveBeenCalledWith('decrypted_enc_refresh', undefined);
    expect(mockEncrypt).toHaveBeenCalledWith('new_access_token');
    expect(mockEncrypt).toHaveBeenCalledWith('new_refresh_token');

    expect(mockDbUpdateSets).toHaveLength(1);
    expect(mockDbUpdateSets[0]).toEqual(
      expect.objectContaining({
        accessToken: 'encrypted_new_access_token',
        refreshToken: 'encrypted_new_refresh_token',
      }),
    );
    expect(mockDbUpdateSets[0].tokenExpiresAt).toBeInstanceOf(Date);
  });

  it('passes accountType so org channels refresh against the right app', async () => {
    mockDbSelectResults.push([makeChannel({ platform: 'linkedin', accountType: 'organization' })]);

    mockRefreshToken.mockResolvedValue({ accessToken: 'new_access_token', expiresIn: 3600 });

    await capturedProcessor!({ name: 'refresh', data: {} });

    expect(mockRefreshToken).toHaveBeenCalledWith('decrypted_enc_refresh', 'organization');
  });

  it('updates only accessToken when no new refreshToken returned', async () => {
    mockDbSelectResults.push([makeChannel()]);

    mockRefreshToken.mockResolvedValue({ accessToken: 'new_access_only' });

    await capturedProcessor!({ name: 'refresh', data: {} });

    expect(mockDbUpdateSets[0].accessToken).toBe('encrypted_new_access_only');
    expect(mockDbUpdateSets[0].refreshToken).toBeUndefined();
    expect(mockDbUpdateSets[0].tokenExpiresAt).toBeUndefined();
  });

  it('skips channels with no refresh token', async () => {
    mockDbSelectResults.push([makeChannel({ refreshToken: null })]);

    await capturedProcessor!({ name: 'refresh', data: {} });

    expect(mockRefreshToken).not.toHaveBeenCalled();
    expect(mockDbUpdateSets).toHaveLength(0);
  });

  it('sends notification when refresh returns null and token expires within 3 days', async () => {
    mockDbSelectResults.push([
      makeChannel({ tokenExpiresAt: new Date(Date.now() + 2 * 86400000) }), // 2 days
    ]);

    mockRefreshToken.mockResolvedValue(null);

    await capturedProcessor!({ name: 'refresh', data: {} });

    expect(mockAddNotificationJob).toHaveBeenCalledWith(
      'user-1',
      'token_expiring',
      expect.stringContaining('expiring soon'),
      expect.stringContaining('TestAccount'),
      expect.objectContaining({ channelId: 1, platform: 'x' }),
      1,
    );
  });

  it('sends expired notification when token is already expired and refresh returns null', async () => {
    mockDbSelectResults.push([
      makeChannel({ tokenExpiresAt: new Date(Date.now() - 86400000) }), // 1 day ago
    ]);

    mockRefreshToken.mockResolvedValue(null);

    await capturedProcessor!({ name: 'refresh', data: {} });

    expect(mockAddNotificationJob).toHaveBeenCalledWith(
      'user-1',
      'token_expired',
      expect.stringContaining('expired'),
      expect.stringContaining('has expired'),
      expect.any(Object),
      1,
    );
  });

  it('does not send notification when token expires in >3 days and refresh returns null', async () => {
    mockDbSelectResults.push([
      makeChannel({ tokenExpiresAt: new Date(Date.now() + 5 * 86400000) }), // 5 days
    ]);

    mockRefreshToken.mockResolvedValue(null);

    await capturedProcessor!({ name: 'refresh', data: {} });

    expect(mockAddNotificationJob).not.toHaveBeenCalled();
  });

  it('sends token_expired notification on refresh error', async () => {
    mockDbSelectResults.push([makeChannel()]);

    mockRefreshToken.mockRejectedValue(new Error('Invalid grant'));

    await capturedProcessor!({ name: 'refresh', data: {} });

    expect(mockAddNotificationJob).toHaveBeenCalledWith(
      'user-1',
      'token_expired',
      expect.stringContaining('needs attention'),
      expect.stringContaining('reconnect'),
      expect.objectContaining({ channelId: 1, platform: 'x', accountName: 'TestAccount' }),
      1,
    );
  });

  it('processes multiple channels independently', async () => {
    mockDbSelectResults.push([
      makeChannel({ id: 1, platform: 'x' }),
      makeChannel({ id: 2, platform: 'facebook', refreshToken: null }),
      makeChannel({ id: 3, platform: 'linkedin' }),
    ]);

    mockRefreshToken.mockResolvedValue({ accessToken: 'new' });

    await capturedProcessor!({ name: 'refresh', data: {} });

    // Channels 1 and 3 refreshed, channel 2 skipped (no refresh token)
    expect(mockRefreshToken).toHaveBeenCalledTimes(2);
    expect(mockDbUpdateSets).toHaveLength(2);
  });

  it('does not send duplicate notification within 24 hours', async () => {
    mockDbSelectResults.push([
      makeChannel({
        tokenExpiresAt: new Date(Date.now() + 2 * 86400000),
        metadata: { lastTokenExpiryNotifiedAt: new Date(Date.now() - 3600000).toISOString() }, // 1 hour ago
      }),
    ]);

    mockRefreshToken.mockResolvedValue(null);

    await capturedProcessor!({ name: 'refresh', data: {} });

    expect(mockAddNotificationJob).not.toHaveBeenCalled();
  });

  it('sends notification after 24 hours have passed since last notification', async () => {
    mockDbSelectResults.push([
      makeChannel({
        tokenExpiresAt: new Date(Date.now() + 2 * 86400000),
        metadata: { lastTokenExpiryNotifiedAt: new Date(Date.now() - 25 * 3600000).toISOString() }, // 25 hours ago
      }),
    ]);

    mockRefreshToken.mockResolvedValue(null);

    await capturedProcessor!({ name: 'refresh', data: {} });

    expect(mockAddNotificationJob).toHaveBeenCalledTimes(1);
    // Should also write the new notification timestamp to metadata
    const metadataUpdate = mockDbUpdateSets.find((s) => s.metadata);
    expect(metadataUpdate).toBeDefined();
    expect(metadataUpdate.metadata.lastTokenExpiryNotifiedAt).toBeDefined();
  });

  it('preserves existing metadata when writing lastTokenExpiryNotifiedAt', async () => {
    mockDbSelectResults.push([
      makeChannel({
        tokenExpiresAt: new Date(Date.now() + 2 * 86400000),
        metadata: { instanceUrl: 'https://mastodon.social' },
      }),
    ]);

    mockRefreshToken.mockResolvedValue(null);

    await capturedProcessor!({ name: 'refresh', data: {} });

    const metadataUpdate = mockDbUpdateSets.find((s) => s.metadata);
    expect(metadataUpdate.metadata.instanceUrl).toBe('https://mastodon.social');
    expect(metadataUpdate.metadata.lastTokenExpiryNotifiedAt).toBeDefined();
  });

  it('does not send duplicate notification on refresh error within 24 hours', async () => {
    mockDbSelectResults.push([
      makeChannel({
        metadata: { lastTokenExpiryNotifiedAt: new Date(Date.now() - 3600000).toISOString() },
      }),
    ]);

    mockRefreshToken.mockRejectedValue(new Error('Invalid grant'));

    await capturedProcessor!({ name: 'refresh', data: {} });

    expect(mockAddNotificationJob).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Static-token validation sweep — regression for the Facebook channel that
  // reported tokenStatus "valid" while Meta had revoked its page token
  // (channel 41, posts 355/356, 2026-06-29). Long-lived tokens (refreshToken
  // null + tokenExpiresAt null) are invisible to the expiry sweep, so the
  // worker now validates them with a lightweight getAccountInfo call.
  // -------------------------------------------------------------------------
  describe('static-token validation (no refresh token, no expiry)', () => {
    function makeStaticChannel(overrides: Record<string, any> = {}) {
      return makeChannel({
        platform: 'facebook', refreshToken: null, tokenExpiresAt: null,
        needsReconnect: false, ...overrides,
      });
    }

    it('flags needsReconnect and notifies when the platform rejects the token', async () => {
      mockDbSelectResults.push([]); // expiry sweep — nothing
      mockDbSelectResults.push([makeStaticChannel()]); // static sweep
      mockGetAccountInfo.mockRejectedValue(
        new Error('facebook API error (400): Error validating access token: Session has expired'),
      );

      await capturedProcessor!({ name: 'refresh', data: {} });

      expect(mockGetAccountInfo).toHaveBeenCalledWith('decrypted_enc_access');
      expect(mockDbUpdateSets).toContainEqual(expect.objectContaining({ needsReconnect: true }));
      expect(mockAddNotificationJob).toHaveBeenCalledWith(
        'user-1',
        'token_expired',
        expect.stringContaining('Facebook'),
        expect.stringContaining('reconnect'),
        expect.objectContaining({ channelId: 1, platform: 'facebook' }),
        1,
      );
    });

    it('records lastTokenValidatedAt and does not flag when the token is healthy', async () => {
      mockDbSelectResults.push([]);
      mockDbSelectResults.push([makeStaticChannel()]);
      mockGetAccountInfo.mockResolvedValue({ id: 'page-1', name: 'Lota Leaks' });

      await capturedProcessor!({ name: 'refresh', data: {} });

      expect(mockDbUpdateSets).not.toContainEqual(expect.objectContaining({ needsReconnect: true }));
      const metaUpdate = mockDbUpdateSets.find((s) => s.metadata?.lastTokenValidatedAt);
      expect(metaUpdate).toBeDefined();
      expect(mockAddNotificationJob).not.toHaveBeenCalled();
    });

    it('skips channels validated within the last 24 hours', async () => {
      mockDbSelectResults.push([]);
      mockDbSelectResults.push([
        makeStaticChannel({
          metadata: { lastTokenValidatedAt: new Date(Date.now() - 3600000).toISOString() }, // 1h ago
        }),
      ]);

      await capturedProcessor!({ name: 'refresh', data: {} });

      expect(mockGetAccountInfo).not.toHaveBeenCalled();
    });

    it('re-validates once the previous validation is older than 24 hours', async () => {
      mockDbSelectResults.push([]);
      mockDbSelectResults.push([
        makeStaticChannel({
          metadata: { lastTokenValidatedAt: new Date(Date.now() - 25 * 3600000).toISOString() },
        }),
      ]);
      mockGetAccountInfo.mockResolvedValue({ id: 'page-1', name: 'Lota Leaks' });

      await capturedProcessor!({ name: 'refresh', data: {} });

      expect(mockGetAccountInfo).toHaveBeenCalledTimes(1);
    });

    it('ignores transient (non-auth) errors — no flag, no lastTokenValidatedAt advance', async () => {
      mockDbSelectResults.push([]);
      mockDbSelectResults.push([makeStaticChannel()]);
      mockGetAccountInfo.mockRejectedValue(new Error('facebook API error (500): internal error'));

      await capturedProcessor!({ name: 'refresh', data: {} });

      expect(mockDbUpdateSets).toHaveLength(0);
      expect(mockAddNotificationJob).not.toHaveBeenCalled();
    });

    it('never validates X channels (paid reads)', async () => {
      mockDbSelectResults.push([]);
      mockDbSelectResults.push([makeStaticChannel({ platform: 'x' })]);

      await capturedProcessor!({ name: 'refresh', data: {} });

      expect(mockGetAccountInfo).not.toHaveBeenCalled();
    });

    it('does not re-notify within 24h when the same dead token is re-checked', async () => {
      mockDbSelectResults.push([]);
      mockDbSelectResults.push([
        makeStaticChannel({
          metadata: { lastTokenExpiryNotifiedAt: new Date(Date.now() - 3600000).toISOString() },
        }),
      ]);
      mockGetAccountInfo.mockRejectedValue(new Error('facebook API error (400): Error validating access token'));

      await capturedProcessor!({ name: 'refresh', data: {} });

      expect(mockDbUpdateSets).toContainEqual(expect.objectContaining({ needsReconnect: true }));
      expect(mockAddNotificationJob).not.toHaveBeenCalled();
    });
  });
});
