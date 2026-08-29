/**
 * Platform OAuth URL tests.
 *
 * Tests OAuth URL generation for each platform handler covering:
 *   - Instagram scopes: instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights
 *   - LinkedIn scopes: openid profile email w_member_social
 *   - X uses PKCE with S256 code challenge method
 *   - YouTube scopes include youtube, youtube.upload, youtube.readonly
 *   - Facebook throws (uses client-side SDK, not server-side OAuth)
 *   - Bluesky uses credentials auth type
 *   - Mastodon uses per-instance OAuth (throws)
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

export {};

// ---------------------------------------------------------------------------
// Import handlers
// ---------------------------------------------------------------------------

const { InstagramHandler } = await import('@/lib/platforms/instagram');
const { XHandler } = await import('@/lib/platforms/x');
const { LinkedInHandler } = await import('@/lib/platforms/linkedin');
const { YouTubeHandler } = await import('@/lib/platforms/youtube');
const { FacebookHandler } = await import('@/lib/platforms/facebook');
const { BlueskyHandler } = await import('@/lib/platforms/bluesky');
const { MastodonHandler } = await import('@/lib/platforms/mastodon');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Platform OAuth URLs', () => {
  describe('Instagram', () => {
    it('generates OAuth URL with correct scopes', async () => {
      process.env.INSTAGRAM_APP_ID = 'test-ig-app-id';

      const handler = new InstagramHandler();
      const url = await handler.getOAuthUrl('http://localhost:4321/auth/callback/instagram', 'test-state');

      expect(url).toContain('instagram.com/oauth/authorize');
      expect(url).toContain('client_id=test-ig-app-id');
      expect(url).toContain('instagram_business_basic');
      expect(url).toContain('instagram_business_content_publish');
      expect(url).toContain('state=test-state');
      expect(url).toContain('response_type=code');
    });

    it('throws when INSTAGRAM_APP_ID is not configured', async () => {
      delete process.env.INSTAGRAM_APP_ID;

      const handler = new InstagramHandler();
      await expect(
        handler.getOAuthUrl('http://localhost/callback', 'state'),
      ).rejects.toThrow('INSTAGRAM_APP_ID not configured');
    });

    it('config has authType oauth', () => {
      const handler = new InstagramHandler();
      expect(handler.config.authType).toBe('oauth');
    });
  });

  describe('LinkedIn', () => {
    it('generates OAuth URL with correct scopes', async () => {
      process.env.LINKEDIN_CLIENT_ID = 'test-li-client-id';

      const handler = new LinkedInHandler();
      const url = await handler.getOAuthUrl('http://localhost:4321/auth/callback/linkedin', 'test-state');

      expect(url).toContain('linkedin.com/oauth/v2/authorization');
      expect(url).toContain('client_id=test-li-client-id');
      expect(url).toContain('scope=openid+profile+email+w_member_social');
      expect(url).toContain('state=test-state');
      expect(url).toContain('response_type=code');
    });

    it('does not include organization scopes', async () => {
      process.env.LINKEDIN_CLIENT_ID = 'test-li-client-id';

      const handler = new LinkedInHandler();
      const url = await handler.getOAuthUrl('http://localhost/callback', 'state');

      expect(url).not.toContain('w_organization_social');
      expect(url).not.toContain('r_organization_social');
    });
  });

  describe('X (Twitter)', () => {
    it('generates OAuth URL with PKCE', async () => {
      process.env.X_CLIENT_ID = 'test-x-client-id';
      process.env.X_CLIENT_SECRET = 'test-x-secret';

      const handler = new XHandler();
      const url = await handler.getOAuthUrl('http://localhost:4321/auth/callback/x', 'test-state');

      expect(url).toContain('x.com/i/oauth2/authorize');
      expect(url).toContain('client_id=test-x-client-id');
      expect(url).toContain('code_challenge_method=S256');
      expect(url).toContain('code_challenge=');
      expect(url).toContain('state=test-state');
      expect(url).toContain('response_type=code');
    });

    it('includes correct scopes', async () => {
      process.env.X_CLIENT_ID = 'test-x-client-id';
      process.env.X_CLIENT_SECRET = 'test-x-secret';

      const handler = new XHandler();
      const url = await handler.getOAuthUrl('http://localhost/callback', 'state');

      expect(url).toContain('tweet.read');
      expect(url).toContain('tweet.write');
      expect(url).toContain('users.read');
      expect(url).toContain('media.write'); // required for v2 media upload
      expect(url).toContain('offline.access');
    });

    it('includes redirect_uri parameter', async () => {
      process.env.X_CLIENT_ID = 'test-x-client-id';
      process.env.X_CLIENT_SECRET = 'test-x-secret';

      const handler = new XHandler();
      const redirectUri = 'http://localhost:4321/auth/callback/x';
      const url = await handler.getOAuthUrl(redirectUri, 'state');

      expect(url).toContain(`redirect_uri=${encodeURIComponent(redirectUri)}`);
    });
  });

  describe('YouTube', () => {
    it('generates OAuth URL with correct scopes', async () => {
      process.env.YOUTUBE_CLIENT_ID = 'test-yt-client-id';
      process.env.YOUTUBE_CLIENT_SECRET = 'test-yt-secret';

      const handler = new YouTubeHandler();
      const url = await handler.getOAuthUrl('http://localhost:4321/auth/callback/youtube', 'test-state');

      expect(url).toContain('accounts.google.com/o/oauth2/v2/auth');
      expect(url).toContain('client_id=test-yt-client-id');
      expect(url).toContain('youtube');
      expect(url).toContain('youtube.upload');
      expect(url).toContain('youtube.readonly');
      expect(url).toContain('access_type=offline');
      expect(url).toContain('prompt=consent');
      expect(url).toContain('state=test-state');
    });
  });

  describe('Facebook', () => {
    it('throws because Facebook uses client-side SDK', async () => {
      const handler = new FacebookHandler();
      await expect(handler.getOAuthUrl()).rejects.toThrow(/SDK/);
    });

    it('config has authType sdk', () => {
      const handler = new FacebookHandler();
      expect(handler.config.authType).toBe('sdk');
    });
  });

  describe('Bluesky', () => {
    it('uses credentials auth type', () => {
      const handler = new BlueskyHandler();
      expect(handler.config.authType).toBe('credentials');
    });

    it('getOAuthUrl throws (no OAuth for bluesky)', async () => {
      const handler = new BlueskyHandler();
      await expect(
        handler.getOAuthUrl('http://localhost/callback', 'state'),
      ).rejects.toThrow(/credential/i);
    });
  });

  describe('Mastodon', () => {
    it('uses per-instance OAuth (getOAuthUrl throws)', async () => {
      const handler = new MastodonHandler();
      await expect(
        handler.getOAuthUrl('http://localhost/callback', 'state'),
      ).rejects.toThrow(/per-instance/i);
    });

    it('config has authType oauth', () => {
      const handler = new MastodonHandler();
      expect(handler.config.authType).toBe('oauth');
    });
  });
});
