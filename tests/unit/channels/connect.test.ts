/**
 * Channel connect tests.
 *
 * Tests the connect flow at webapp/src/pages/api/channels/connect/[platform].ts
 * and the OAuth callback handler at webapp/src/lib/oauth/handler.ts covering:
 *   - Quota check runs AFTER existing channel lookup (not before)
 *   - Reconnecting same account skips quota check
 *   - Connecting new account at limit returns error
 *   - Platform check runs before quota check
 *   - Facebook page save, Bluesky connect, and Mastodon OAuth reconnection quota logic
 */

// Self-host gates every OAuth-app platform on credentials; give the suite a
// fully-credentialed environment so the connect-flow tests keep their meaning.
for (const v of [
  'X_CLIENT_ID','X_CLIENT_SECRET','LINKEDIN_CLIENT_ID','LINKEDIN_CLIENT_SECRET',
  'FACEBOOK_APP_ID','FACEBOOK_APP_SECRET','INSTAGRAM_APP_ID','INSTAGRAM_APP_SECRET',
  'THREADS_APP_ID','THREADS_APP_SECRET','TIKTOK_CLIENT_KEY','TIKTOK_CLIENT_SECRET',
  'YOUTUBE_CLIENT_ID','YOUTUBE_CLIENT_SECRET','PINTEREST_APP_ID','PINTEREST_APP_SECRET',
  'GMB_CLIENT_ID','GMB_CLIENT_SECRET','REDDIT_CLIENT_ID','REDDIT_CLIENT_SECRET',
  'DISCORD_CLIENT_ID','DISCORD_CLIENT_SECRET','DISCORD_BOT_TOKEN',
  'TUMBLR_CLIENT_ID','TUMBLR_CLIENT_SECRET','SNAPCHAT_CLIENT_ID','SNAPCHAT_CLIENT_SECRET',
]) {
  process.env[v] = process.env[v] || 'test-credential';
}

import { createDbMock, createDrizzleOrmMock } from '../../helpers/db-mock';

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------
const { db: mockDb, setResult, resetChain, queryChain } = createDbMock();
const drizzleOrmMock = createDrizzleOrmMock();

vi.mock('@/lib/db', () => ({ db: mockDb }));

vi.mock('@/lib/db/schema', () => ({
  channels: {
    id: 'ch.id',
    organizationId: 'ch.org_id',
    platform: 'ch.platform',
    accountId: 'ch.account_id',
    accountName: 'ch.account_name',
    accountType: 'ch.account_type',
    accessToken: 'ch.access_token',
    refreshToken: 'ch.refresh_token',
    tokenExpiresAt: 'ch.token_expires_at',
    profileImage: 'ch.profile_image',
    isActive: 'ch.is_active',
    userId: 'ch.user_id',
    metadata: 'ch.metadata',
    createdAt: 'ch.created_at',
    updatedAt: 'ch.updated_at',
  },
}));

vi.mock('drizzle-orm', () => drizzleOrmMock);

// url-guard does a real dns.lookup (SSRF check) — mock it so tests never hit DNS
vi.mock('@/lib/security/url-guard', () => ({
  ssrfSafeDispatcher: {},
  validateHostname: vi.fn().mockResolvedValue(true),
  ssrfSafeFetch: (url: any, init: any) => fetch(url, init),
}));

// ---------------------------------------------------------------------------
// Other mocks
// ---------------------------------------------------------------------------

const mockCheckChannelQuota = vi.fn();
const mockCheckPlatformAllowed = vi.fn();
const mockGetOrgPlan = vi.fn();

vi.mock('@/lib/quotas/check', () => ({
  checkChannelQuota: (...args: any[]) => mockCheckChannelQuota(...args),
  checkPlatformAllowed: (...args: any[]) => mockCheckPlatformAllowed(...args),
  getOrgPlan: (...args: any[]) => mockGetOrgPlan(...args),
}));

vi.mock('@/lib/quotas/plans', () => ({
  PLAN_DISPLAY_NAMES: { free: 'Free', pro: 'Pro', business: 'Business' },
}));

vi.mock('@/lib/quotas/errors', () => ({
  quotaExceededResponse: vi.fn(() =>
    new Response(JSON.stringify({ error: { code: 'QUOTA_EXCEEDED' } }), { status: 403 }),
  ),
}));

vi.mock('@/lib/auth/crypto', () => ({
  encrypt: vi.fn((v: string) => `enc_${v}`),
}));

vi.mock('@/lib/activity/log', () => ({
  logActivity: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

const mockGetPlatformHandler = vi.fn();
vi.mock('@/lib/platforms/registry', () => ({
  getPlatformHandler: (...args: any[]) => mockGetPlatformHandler(...args),
}));

vi.mock('@/lib/platforms/init', () => ({}));

vi.mock('@/lib/oauth/state', () => ({
  generateOAuthState: vi.fn(() => 'mock-state'),
  validateOAuthState: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import handlers AFTER mocks
// ---------------------------------------------------------------------------

const { GET, POST } = await import('@/pages/api/channels/connect/[platform]');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCtx(options: {
  user?: { id: string; name: string } | null;
  organizationId?: number;
  platform?: string;
  method?: string;
  body?: unknown;
  searchParams?: Record<string, string>;
}) {
  const {
    user = { id: 'user-1', name: 'Test User' },
    organizationId = 1,
    platform = 'instagram',
    method = 'GET',
    body,
    searchParams = {},
  } = options;

  const url = new URL('http://localhost:4321/api/channels/connect/' + platform);
  for (const [k, v] of Object.entries(searchParams)) {
    url.searchParams.set(k, v);
  }

  return {
    locals: {
      auth: {
        user,
        organizationId,
        organizationPlan: 'pro' as const,
        organizationName: 'Test Org',
      },
    },
    params: { platform },
    url,
    request: {
      method,
      json: vi.fn().mockResolvedValue(body ?? {}),
      headers: new Headers({ 'Content-Type': 'application/json' }),
    } as unknown as Request,
  };
}

async function parseResponse(res: Response) {
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/channels/connect/[platform]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain();
    mockCheckPlatformAllowed.mockResolvedValue({ allowed: true });
    mockGetOrgPlan.mockResolvedValue('pro');
    mockCheckChannelQuota.mockResolvedValue({ allowed: true, current: 0, limit: 22, resource: 'channels' });
  });

  it('returns 401 when user is null', async () => {
    const ctx = createCtx({ user: null });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 400 for invalid platform', async () => {
    const ctx = createCtx({ platform: 'myspace' });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toBe('Invalid platform');
  });

  it('platform check runs before OAuth URL generation', async () => {
    mockCheckPlatformAllowed.mockResolvedValue({ allowed: false });
    mockGetOrgPlan.mockResolvedValue('free');

    const ctx = createCtx({ platform: 'x' });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);

    expect(status).toBe(403);
    expect(data.error.code).toBe('FEATURE_DISABLED');
    expect(mockCheckPlatformAllowed).toHaveBeenCalledWith(1, 'x');
    expect(mockGetPlatformHandler).not.toHaveBeenCalled();
  });

  it('channel-limit wall fires BEFORE the OAuth round-trip (403 with structured error)', async () => {
    setResult([]); // no reconnectable channel on this platform
    mockCheckChannelQuota.mockResolvedValue({ allowed: false, current: 3, limit: 3, resource: 'channels' });
    mockGetOrgPlan.mockResolvedValue('free');

    const ctx = createCtx({ platform: 'pinterest' });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);

    expect(status).toBe(403);
    expect(data.error.code).toBe('QUOTA_EXCEEDED');
    expect(mockGetPlatformHandler).not.toHaveBeenCalled();
  });

  it('reconnect exception: an active broken-token channel skips the pre-OAuth quota wall', async () => {
    setResult({ id: 42 }); // active needs_reconnect/expired channel on this platform
    mockCheckChannelQuota.mockResolvedValue({ allowed: false, current: 3, limit: 3, resource: 'channels' });
    mockGetPlatformHandler.mockReturnValue({
      config: { authType: 'oauth' },
      getOAuthUrl: vi.fn().mockResolvedValue('https://platform.test/oauth'),
    });

    const ctx = createCtx({ platform: 'pinterest' });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);

    expect(status).toBe(200);
    expect(data.url).toBe('https://platform.test/oauth');
    expect(mockCheckChannelQuota).not.toHaveBeenCalled();
  });

  it('returns authType: credentials for bluesky', async () => {
    mockGetPlatformHandler.mockReturnValue({
      config: { authType: 'credentials' },
    });

    const ctx = createCtx({ platform: 'bluesky' });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);

    expect(status).toBe(200);
    expect(data.authType).toBe('credentials');
  });

  it('returns authType: mastodon for mastodon', async () => {
    mockGetPlatformHandler.mockReturnValue({
      config: { authType: 'oauth' },
    });

    const ctx = createCtx({ platform: 'mastodon' });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);

    expect(status).toBe(200);
    expect(data.authType).toBe('mastodon');
  });

  it('returns facebook_sdk config for facebook', async () => {
    process.env.FACEBOOK_APP_ID = 'test-app-id';
    process.env.FACEBOOK_CONFIG_ID = 'test-config-id';

    mockGetPlatformHandler.mockReturnValue({
      config: { authType: 'sdk' },
    });

    const ctx = createCtx({ platform: 'facebook' });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);

    expect(status).toBe(200);
    expect(data.authType).toBe('facebook_sdk');
    expect(data.appId).toBe('test-app-id');
  });
});

/**
 * LinkedIn company pages go through a second LinkedIn app (Community Management
 * API) with its own review, so `?mode=page` is gated on `PLATFORM_LINKEDIN_PAGES`
 * independently of personal-profile connect.
 */
describe('GET /api/channels/connect/linkedin?mode=page — company-page gate', () => {
  const SAVED: Record<string, string | undefined> = {};
  const KEYS = ['PLATFORM_LINKEDIN', 'PLATFORM_LINKEDIN_PAGES', 'LINKEDIN_PAGES_CLIENT_ID', 'LINKEDIN_PAGES_CLIENT_SECRET', 'LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'];

  beforeEach(() => {
    vi.clearAllMocks();
    resetChain();
    mockCheckPlatformAllowed.mockResolvedValue({ allowed: true });
    mockGetOrgPlan.mockResolvedValue('pro');
    mockGetPlatformHandler.mockReturnValue({ config: { authType: 'oauth' } });
    for (const k of KEYS) SAVED[k] = process.env[k];
    process.env.LINKEDIN_CLIENT_ID = 'app-a-id';
    process.env.LINKEDIN_CLIENT_SECRET = 'app-a-secret';
    process.env.LINKEDIN_PAGES_CLIENT_ID = 'app-b-id';
    process.env.LINKEDIN_PAGES_CLIENT_SECRET = 'app-b-secret';
    delete process.env.PLATFORM_LINKEDIN;
    delete process.env.PLATFORM_LINKEDIN_PAGES;
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (SAVED[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED[k];
    }
  });

  it('403s the page flow while pages are paused', async () => {
    process.env.PLATFORM_LINKEDIN_PAGES = 'connect_off';

    const ctx = createCtx({ platform: 'linkedin', searchParams: { mode: 'page' } });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);

    expect(status).toBe(403);
    expect(data.error.code).toBe('PLATFORM_DISABLED');
    expect(data.error.accountType).toBe('organization');
    expect(data.error.state).toBe('connect_off');
  });

  it('still hands out the personal-profile OAuth URL while pages are paused', async () => {
    process.env.PLATFORM_LINKEDIN_PAGES = 'connect_off';
    // Real handler here: the point is that the personal flow still resolves
    // App A's credentials and scopes, not that a stub was called.
    const { LinkedInHandler } = await import('@/lib/platforms/linkedin');
    mockGetPlatformHandler.mockReturnValue(new LinkedInHandler());

    const ctx = createCtx({ platform: 'linkedin' });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);

    expect(status).toBe(200);
    expect(data.url).toContain('client_id=app-a-id');
    expect(data.url).toContain('w_member_social');
  });

  it('allows the page flow when the variant flag is on', async () => {
    const ctx = createCtx({ platform: 'linkedin', searchParams: { mode: 'page' } });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);

    expect(status).toBe(200);
    expect(data.url).toContain('client_id=app-b-id');
  });
});

describe('POST /api/channels/connect/[platform] — Facebook page save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain();
    mockCheckChannelQuota.mockResolvedValue({ allowed: true, current: 0, limit: 22, resource: 'channels' });
    mockGetOrgPlan.mockResolvedValue('pro');

    // Mock global fetch for Facebook API calls
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'long-lived-token', id: 'page-123', name: 'Test Page', picture: { data: { url: 'https://pic.url' } } }),
    });
  });

  it('checks for existing channel BEFORE quota check (reconnection skips quota)', async () => {
    // Simulate existing channel found (reconnection)
    setResult({ id: 42, profileImage: 'old-pic.jpg', isActive: true });

    const ctx = createCtx({
      platform: 'facebook',
      method: 'POST',
      body: {
        userAccessToken: 'short-token',
        pageId: 'page-123',
        pageName: 'Test Page',
        pageAccessToken: 'page-token',
      },
    });

    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    // checkChannelQuota should NOT have been called since it's a reconnection
    expect(mockCheckChannelQuota).not.toHaveBeenCalled();
  });

  it('enforces quota for NEW channels (no existing found)', async () => {
    // First query: check existing - returns empty
    // We need to configure the mock to return empty for the first query
    setResult([]);

    mockCheckChannelQuota.mockResolvedValue({
      allowed: false,
      current: 22,
      limit: 22,
      resource: 'channels',
    });

    const ctx = createCtx({
      platform: 'facebook',
      method: 'POST',
      body: {
        userAccessToken: 'short-token',
        pageId: 'new-page-123',
        pageName: 'New Page',
        pageAccessToken: 'page-token',
      },
    });

    const res = await POST(ctx as any);
    const { status } = await parseResponse(res);

    // Should be 403 quota exceeded
    expect(status).toBe(403);
    expect(mockCheckChannelQuota).toHaveBeenCalledWith(1, 'facebook');
  });

  it('returns 400 for missing required fields', async () => {
    const ctx = createCtx({
      platform: 'facebook',
      method: 'POST',
      body: { userAccessToken: 'token' },
    });

    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);

    expect(status).toBe(400);
    expect(data.error).toContain('Missing required fields');
  });
});

describe('POST /api/channels/connect/bluesky', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain();
    mockCheckChannelQuota.mockResolvedValue({ allowed: true, current: 0, limit: 22, resource: 'channels' });
    mockGetOrgPlan.mockResolvedValue('pro');
  });

  it('skips quota check for reconnection (existing bluesky account)', async () => {
    // Simulate existing channel found
    setResult({ id: 10, refreshToken: 'old-refresh', isActive: true });

    mockGetPlatformHandler.mockReturnValue({
      config: { authType: 'credentials' },
      exchangeCodeForToken: vi.fn().mockResolvedValue({
        accessToken: 'bsky-access',
        refreshToken: 'bsky-refresh',
        userId: 'did:plc:123',
      }),
      getAccountInfo: vi.fn().mockResolvedValue({
        id: 'did:plc:123',
        name: 'testuser.bsky.social',
        accountType: 'user',
      }),
    });

    const ctx = createCtx({
      platform: 'bluesky',
      method: 'POST',
      body: { identifier: 'testuser.bsky.social', appPassword: 'xxx' },
    });

    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(mockCheckChannelQuota).not.toHaveBeenCalled();
  });

  it('enforces quota for new bluesky account', async () => {
    setResult([]);

    mockGetPlatformHandler.mockReturnValue({
      config: { authType: 'credentials' },
      exchangeCodeForToken: vi.fn().mockResolvedValue({
        accessToken: 'bsky-access',
        refreshToken: 'bsky-refresh',
        userId: 'did:plc:456',
      }),
      getAccountInfo: vi.fn().mockResolvedValue({
        id: 'did:plc:456',
        name: 'newuser.bsky.social',
        accountType: 'user',
      }),
    });

    mockCheckChannelQuota.mockResolvedValue({
      allowed: false,
      current: 22,
      limit: 22,
      resource: 'channels',
    });

    const ctx = createCtx({
      platform: 'bluesky',
      method: 'POST',
      body: { identifier: 'newuser.bsky.social', appPassword: 'xxx' },
    });

    const res = await POST(ctx as any);
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
    expect(mockCheckChannelQuota).toHaveBeenCalledWith(1, 'bluesky');
  });
});

describe('POST /api/channels/connect/mastodon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain();
    mockCheckChannelQuota.mockResolvedValue({ allowed: true, current: 0, limit: 22, resource: 'channels' });
    mockGetOrgPlan.mockResolvedValue('pro');
  });

  it('returns 400 for missing instance URL', async () => {
    const ctx = createCtx({
      platform: 'mastodon',
      method: 'POST',
      body: {},
    });

    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);

    expect(status).toBe(400);
    expect(data.error).toContain('Instance URL is required');
  });

  it('returns 400 for invalid instance URL', async () => {
    const ctx = createCtx({
      platform: 'mastodon',
      method: 'POST',
      body: { instanceUrl: 'not-a-domain' },
    });

    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);

    expect(status).toBe(400);
    expect(data.error).toContain('Invalid instance URL');
  });
});

describe('POST /api/channels/connect/[platform] — availability/plan gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain();
    mockCheckChannelQuota.mockResolvedValue({ allowed: true, current: 0, limit: 22, resource: 'channels' });
  });

  it('403s the credential POST path when the platform is not on the plan', async () => {
    mockCheckPlatformAllowed.mockResolvedValue({ allowed: false });
    mockGetOrgPlan.mockResolvedValue('free');

    const ctx = createCtx({
      platform: 'telegram',
      method: 'POST',
      body: { botToken: '123:abc', chatId: '@chan' },
    });

    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);

    expect(status).toBe(403);
    expect(data.error.code).toBe('FEATURE_DISABLED');
  });
});
