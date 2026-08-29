/**
 * Tests for the Telegram platform handler.
 *
 * Covers:
 *   - config: credentials authType
 *   - getOAuthUrl: throws (bot-token model, no OAuth)
 *   - exchangeCodeForToken: validates token via getMe, resolves chat via getChat,
 *     returns the bot token as accessToken and the chat id as userId; rejects bad JSON
 *   - getAccountInfo: maps the bot identity from getMe
 *   - publishPost: text post (private /c/ url), public @channel url, image -> sendPhoto,
 *     no-bot-token error
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

const { TelegramHandler, normalizeTelegramChatId } = await import('@/lib/platforms/telegram');
import type { PostData, ChannelData, MediaFileData } from '@/lib/platforms/types';

export {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(overrides: Partial<ChannelData> = {}): ChannelData {
  return {
    id: 1,
    platform: 'telegram',
    accountId: '-1001234567890',
    accountName: 'My Channel',
    accessToken: '123:ABC',
    metadata: { chatId: '-1001234567890' },
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

function makeImage(url = 'https://cdn.test/img.jpg'): MediaFileData {
  return { url, localPath: '/tmp/img.jpg', mimeType: 'image/jpeg', sizeBytes: 1000 };
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

describe('TelegramHandler', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new TelegramHandler();

  describe('config', () => {
    it('has correct platform config', () => {
      expect(handler.config.name).toBe('telegram');
      expect(handler.config.displayName).toBe('Telegram');
      expect(handler.config.authType).toBe('credentials');
      expect(handler.config.postTypes).toHaveLength(1);
    });
  });

  describe('getOAuthUrl', () => {
    it('throws — Telegram uses bot-token credentials', async () => {
      await expect(handler.getOAuthUrl('https://x/cb', 'state')).rejects.toThrow(/credentials/);
    });
  });

  describe('exchangeCodeForToken', () => {
    it('validates the bot token and resolves the chat', async () => {
      mockFetch
        // getMe
        .mockResolvedValueOnce(mockFetchJson({ ok: true, result: { id: 1, username: 'bot' } }))
        // getChat
        .mockResolvedValueOnce(
          mockFetchJson({
            ok: true,
            result: { id: -1001234567890, title: 'My Channel', type: 'channel' },
          }),
        );

      const code = JSON.stringify({ botToken: '123:ABC', chatId: '@mychan' });
      const result = await handler.exchangeCodeForToken(code, 'https://x/cb');

      expect(result.accessToken).toBe('123:ABC');
      expect(result.userId).toBe('-1001234567890');

      // First call validates the token via getMe.
      expect(mockFetch.mock.calls[0][0]).toContain('/bot123:ABC/getMe');
      // Second call resolves the chat via getChat.
      expect(mockFetch.mock.calls[1][0]).toContain('/getChat');
    });

    it('throws on invalid JSON', async () => {
      await expect(
        handler.exchangeCodeForToken('not-json', 'https://x/cb'),
      ).rejects.toThrow(/Invalid Telegram credentials/);
    });

    it('throws when bot token or chat id missing', async () => {
      await expect(
        handler.exchangeCodeForToken(JSON.stringify({ botToken: '123:ABC' }), 'https://x/cb'),
      ).rejects.toThrow(/bot token and a chat id/);
    });

    it('throws when getChat reports the chat is not found', async () => {
      mockFetch
        .mockResolvedValueOnce(mockFetchJson({ ok: true, result: { id: 1, username: 'bot' } }))
        .mockResolvedValueOnce(mockFetchJson({ ok: false, description: 'chat not found' }));

      await expect(
        handler.exchangeCodeForToken(
          JSON.stringify({ botToken: '123:ABC', chatId: '@nope' }),
          'https://x/cb',
        ),
      ).rejects.toThrow(/Could not find that chat/);
    });
  });

  describe('getChatInfo', () => {
    it('validates the token and returns the resolved chat', async () => {
      mockFetch
        .mockResolvedValueOnce(mockFetchJson({ ok: true, result: { id: 1, username: 'bot' } }))
        .mockResolvedValueOnce(
          mockFetchJson({ ok: true, result: { id: -1001234567890, title: 'My Channel', type: 'channel' } }),
        );

      const chat = await handler.getChatInfo('123:ABC', '@mychan');
      expect(chat.id).toBe('-1001234567890');
      expect(chat.title).toBe('My Channel');
      expect(chat.type).toBe('channel');
    });

    it('throws a friendly error on an invalid bot token', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });
      await expect(handler.getChatInfo('bad', '@x')).rejects.toThrow(/Invalid bot token/);
    });

    it('adds a leading @ to a bare public username for the getChat lookup', async () => {
      mockFetch
        .mockResolvedValueOnce(mockFetchJson({ ok: true, result: { id: 1, username: 'bot' } }))
        .mockResolvedValueOnce(mockFetchJson({ ok: true, result: { id: -100123, title: 'Chan', type: 'channel' } }));

      const chat = await handler.getChatInfo('123:ABC', 'mychan'); // no @
      expect(chat.chatId).toBe('@mychan');
      // The getChat call (2nd fetch) used the @-prefixed form (URL-encoded as %40).
      expect(mockFetch.mock.calls[1][0]).toContain('chat_id=%40mychan');
    });

    it('leaves a numeric chat id unchanged (no @)', async () => {
      mockFetch
        .mockResolvedValueOnce(mockFetchJson({ ok: true, result: { id: 1 } }))
        .mockResolvedValueOnce(mockFetchJson({ ok: true, result: { id: -1001234567890, title: 'X', type: 'channel' } }));

      const chat = await handler.getChatInfo('123:ABC', '-1001234567890');
      expect(chat.chatId).toBe('-1001234567890');
      expect(mockFetch.mock.calls[1][0]).toContain('chat_id=-1001234567890');
    });
  });

  describe('normalizeTelegramChatId', () => {
    it('adds @ to a bare username, leaves @-prefixed and numeric ids alone', () => {
      expect(normalizeTelegramChatId('mychan')).toBe('@mychan');
      expect(normalizeTelegramChatId('@mychan')).toBe('@mychan');
      expect(normalizeTelegramChatId('  @spaced  ')).toBe('@spaced');
      expect(normalizeTelegramChatId('-1001234567890')).toBe('-1001234567890');
      expect(normalizeTelegramChatId('123456')).toBe('123456');
    });
  });

  describe('getAccountInfo', () => {
    it('maps the bot identity from getMe', async () => {
      mockFetch.mockResolvedValueOnce(
        mockFetchJson({ ok: true, result: { id: 42, username: 'mybot' } }),
      );

      const info = await handler.getAccountInfo('123:ABC');
      expect(info.id).toBe('42');
      expect(info.name).toBe('mybot');
      expect(info.accountType).toBe('bot');
      expect(mockFetch.mock.calls[0][0]).toContain('/bot123:ABC/getMe');
    });
  });

  describe('publishPost', () => {
    it('sends a text post and builds a private /c/ url', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchJson({ ok: true, result: { message_id: 55 } }));

      const result = await handler.publishPost(makePost(), makeChannel());
      expect(result.success).toBe(true);
      expect(result.postId).toBe('55');
      expect(result.url).toContain('/c/1234567890/55');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/sendMessage');
      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
      expect(body.chat_id).toBe('-1001234567890');
      expect(body.text).toBe('Hello!');
      // Plain text — no parse_mode, so reserved chars never trip a 400.
      expect(body.parse_mode).toBeUndefined();
    });

    it('sends reserved characters as plain text without parse_mode', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchJson({ ok: true, result: { message_id: 9 } }));

      const result = await handler.publishPost(
        makePost({ content: 'Tom & Jerry: 5 < 10 > 3' }),
        makeChannel(),
      );
      expect(result.success).toBe(true);

      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
      // Sent verbatim (no entity-escaping needed) and crucially no parse_mode.
      expect(body.text).toBe('Tom & Jerry: 5 < 10 > 3');
      expect(body.parse_mode).toBeUndefined();
    });

    it('posts long text (>1024) as its own message when media is attached', async () => {
      // 1: sendPhoto (captionless), 2: follow-up sendMessage with the full text.
      mockFetch
        .mockResolvedValueOnce(mockFetchJson({ ok: true, result: { message_id: 100 } }))
        .mockResolvedValueOnce(mockFetchJson({ ok: true, result: { message_id: 101 } }));

      const longText = 'a'.repeat(1500);
      const result = await handler.publishPost(
        makePost({ content: longText, mediaFiles: [makeImage()] }),
        makeChannel(),
      );
      expect(result.success).toBe(true);
      expect(result.postId).toBe('100'); // the media message is the anchor

      // The photo went out without a caption (would exceed the 1024 cap)...
      const photoBody = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
      expect(mockFetch.mock.calls[0][0]).toContain('sendPhoto');
      expect(photoBody.caption).toBeUndefined();
      // ...and the full text followed as a standalone message.
      expect(mockFetch.mock.calls[1][0]).toContain('sendMessage');
      const textBody = JSON.parse((mockFetch.mock.calls[1][1] as RequestInit).body as string);
      expect(textBody.text).toBe(longText);
    });

    it('returns no /c/ link for a non-supergroup numeric chat', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchJson({ ok: true, result: { message_id: 5 } }));

      // A plain numeric id (not a -100… supergroup) has no public permalink.
      const result = await handler.publishPost(
        makePost(),
        makeChannel({ accountId: '12345', metadata: { chatId: '12345' } }),
      );
      expect(result.success).toBe(true);
      expect(result.url).toBe('');
    });

    it('builds a public t.me/<username> url for a public channel', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchJson({ ok: true, result: { message_id: 55 } }));

      const result = await handler.publishPost(
        makePost(),
        makeChannel({ metadata: { chatId: '@mychan' } }),
      );
      expect(result.success).toBe(true);
      expect(result.url).toBe('https://t.me/mychan/55');
    });

    it('sends a single image via sendPhoto', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchJson({ ok: true, result: { message_id: 77 } }));

      const result = await handler.publishPost(
        makePost({ mediaFiles: [makeImage()] }),
        makeChannel(),
      );
      expect(result.success).toBe(true);
      expect(result.postId).toBe('77');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('sendPhoto');
      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
      expect(body.photo).toBe('https://cdn.test/img.jpg');
      expect(body.caption).toBe('Hello!');
    });

    it('returns error when no bot token', async () => {
      const result = await handler.publishPost(makePost(), makeChannel({ accessToken: '' }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('No bot token');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
