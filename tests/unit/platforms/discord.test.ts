/**
 * Tests for the Discord platform handler.
 *
 * Covers:
 *   - config (authType 'oauth')
 *   - getOAuthUrl: scope/permissions/state/redirect_uri; throws when unconfigured
 *   - exchangeCodeForToken: threads the guild id through userId
 *   - getAccountInfo: maps name, builds the bot avatar URL, accountType 'guild'
 *   - publishPost: missing channel error; text message success via the bot token;
 *     a 50013 permission error returns a clear message (NOT authExpired)
 *   - refreshToken: success and failure
 */

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// SSRF guard does real DNS lookups — stub it and route the guarded fetch to the
// same global mock so mockResolvedValueOnce queues stay in order.
vi.mock('@/lib/security/url-guard', () => ({
  ssrfSafeDispatcher: {},
  validateHostname: vi.fn(async () => true),
  ssrfSafeFetch: (...args: unknown[]) => (globalThis.fetch as any)(...args),
}));

const { DiscordHandler } = await import('@/lib/platforms/discord');
import type { PostData, ChannelData, MediaFileData } from '@/lib/platforms/types';

export {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(overrides: Partial<ChannelData> = {}): ChannelData {
  return {
    id: 1,
    platform: 'discord',
    accountId: 'g1',
    accountName: 'My Server',
    accessToken: 'discord-access-token',
    metadata: {},
    ...overrides,
  };
}

function makePost(overrides: Partial<PostData> = {}): PostData {
  return {
    content: 'Hello!',
    mediaUrls: [],
    mediaFiles: [],
    ...overrides,
  };
}

function makeImage(url = 'https://cdn.test/img.png'): MediaFileData {
  return { url, localPath: '/tmp/img.png', mimeType: 'image/png', sizeBytes: 1000 };
}

function mockFetchJson(data: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
    json: async () => data,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DiscordHandler', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new DiscordHandler();

  beforeAll(() => {
    process.env.DISCORD_CLIENT_ID = 'test-client-id';
    process.env.DISCORD_CLIENT_SECRET = 'test-client-secret';
    process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
  });

  describe('config', () => {
    it('has correct platform config', () => {
      expect(handler.config.name).toBe('discord');
      expect(handler.config.displayName).toBe('Discord');
      expect(handler.config.authType).toBe('oauth');
      expect(handler.config.postTypes).toHaveLength(1);
    });
  });

  describe('getOAuthUrl', () => {
    it('builds an authorize URL with the right scope, permissions, state, and redirect', async () => {
      const url = await handler.getOAuthUrl('https://app.test/cb', 'state-xyz');
      expect(url).toContain('discord.com/oauth2/authorize');

      const parsed = new URL(url);
      expect(parsed.searchParams.get('scope')).toBe('bot identify guilds');
      expect(parsed.searchParams.get('permissions')).toBe('377957124096');
      expect(parsed.searchParams.get('state')).toBe('state-xyz');
      expect(parsed.searchParams.get('redirect_uri')).toBe('https://app.test/cb');
      expect(parsed.searchParams.get('client_id')).toBe('test-client-id');
    });

    it('throws when DISCORD_CLIENT_ID is not configured', async () => {
      const original = process.env.DISCORD_CLIENT_ID;
      delete process.env.DISCORD_CLIENT_ID;
      await expect(handler.getOAuthUrl('https://app.test/cb', 's')).rejects.toThrow(
        'DISCORD_CLIENT_ID not configured',
      );
      process.env.DISCORD_CLIENT_ID = original;
    });
  });

  describe('exchangeCodeForToken', () => {
    it('threads the guild id through userId', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          access_token: 'at_1',
          refresh_token: 'rt_1',
          expires_in: 604800,
          guild: { id: 'g1', name: 'G' },
        }),
      );

      const result = await handler.exchangeCodeForToken('the-code', 'https://app.test/cb');
      expect(result.accessToken).toBe('at_1');
      expect(result.refreshToken).toBe('rt_1');
      expect(result.expiresIn).toBe(604800);
      expect(result.userId).toBe('g1');
    });
  });

  describe('getAccountInfo', () => {
    it('maps the app name, builds the bot avatar URL, and sets accountType', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          application: {
            id: 'app_1',
            name: 'My Bot App',
            bot: { id: 'bot_1', avatar: 'avatarhash', username: 'mybot' },
          },
        }),
      );

      const info = await handler.getAccountInfo('bearer-token');
      expect(info.id).toBe('bot_1');
      expect(info.name).toBe('My Bot App');
      expect(info.profileImage).toBe(
        'https://cdn.discordapp.com/avatars/bot_1/avatarhash.png',
      );
      expect(info.accountType).toBe('guild');
    });
  });

  describe('publishPost', () => {
    it('returns an error when no channel is selected', async () => {
      const result = await handler.publishPost(makePost(), makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toContain('No Discord channel selected');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('publishes a text message via the bot token', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchJson({ id: 'm1' }));

      const post = makePost({ platformSpecific: { channelId: 'c1' } });
      const result = await handler.publishPost(post, makeChannel({ accountId: 'g1' }));

      expect(result.success).toBe(true);
      expect(result.postId).toBe('m1');
      expect(result.url).toContain('channels/g1/c1/m1');

      // The request must target the channel messages endpoint with the bot token.
      const [reqUrl, reqOpts] = mockFetch.mock.calls[0];
      expect(reqUrl).toBe('https://discord.com/api/channels/c1/messages');
      expect(reqOpts.headers.Authorization).toBe('Bot test-bot-token');
      const body = JSON.parse(reqOpts.body);
      expect(body.content).toBe('Hello!');
    });

    it('returns a clear message (not authExpired) on a 50013 permission error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () =>
          JSON.stringify({ message: 'Missing Permissions', code: 50013 }),
      });

      const post = makePost({ platformSpecific: { channelId: 'c1' } });
      const result = await handler.publishPost(post, makeChannel());

      expect(result.success).toBe(false);
      expect(result.error).toContain('lacks permission to send messages');
      expect(result.authExpired).toBeUndefined();
    });
  });

  describe('refreshToken', () => {
    it('refreshes the token successfully', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({
          access_token: 'new_access',
          refresh_token: 'new_refresh',
          expires_in: 604800,
        }),
      );

      const result = await handler.refreshToken('old_refresh');
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe('new_access');
      expect(result!.refreshToken).toBe('new_refresh');
    });

    it('returns null on failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'invalid_grant' }),
      });

      const result = await handler.refreshToken('bad');
      expect(result).toBeNull();
    });
  });
});
