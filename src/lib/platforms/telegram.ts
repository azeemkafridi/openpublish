import { PlatformHandler } from './base';
import type {
  TokenData,
  AccountInfo,
  PublishResult,
  PostData,
  ChannelData,
  PlatformConfig,
  EngagementData,
} from './types';

const config: PlatformConfig = {
  name: 'telegram',
  displayName: 'Telegram',
  icon: 'telegram',
  color: '#26A5E4',
  authType: 'credentials',
  postTypes: [
    {
      value: 'post',
      label: 'Post',
      description: 'Send a message with optional media to a Telegram channel or group',
      maxMedia: 10,
      allowedMediaTypes: ['image', 'video'],
    },
  ],
  mediaRules: {
    // We hand Telegram the media URL (not multipart bytes), and the Bot API caps
    // download-by-URL at ~5MB for photos and ~20MB for other files — well below
    // the 50MB that applies to direct uploads. Advertise the real limits so
    // oversized media is rejected up front instead of 400-ing at publish.
    image: {
      maxSizeMB: 5,
      formats: ['jpg', 'jpeg', 'png', 'webp'],
      maxCount: 10,
    },
    video: {
      maxSizeMB: 20,
      formats: ['mp4'],
      maxCount: 10,
    },
  },
};

/**
 * A media item resolved from a post, classified for Telegram's Bot API.
 * `kind` maps directly to the `type` field of a sendMediaGroup entry.
 */
interface TelegramMediaItem {
  kind: 'photo' | 'video';
  url: string;
}

/** Telegram wraps every Bot API response as `{ ok, result, description? }`. */
interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

interface TelegramMessage {
  message_id: number;
}

interface TelegramChat {
  id: number;
  title?: string;
  username?: string;
  first_name?: string;
  type?: string;
}

interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
}

/** Displayable info about a connected destination chat (channel/group). */
export interface TelegramChatInfo {
  /** The numeric chat id from Telegram (e.g. "-1001234567890"). */
  id: string;
  /** The normalized chat reference to send to (numeric id or "@username"). */
  chatId: string;
  title: string;
  username?: string;
  type: string;
}

/**
 * Normalize a user-entered chat reference for the Telegram Bot API. A public
 * channel/group must be addressed as "@username" (a bare "username" is rejected
 * by getChat and send*), while a numeric chat id ("-1001234567890") must NOT
 * carry an "@". So: leave numeric ids alone; ensure usernames have a leading "@".
 */
export function normalizeTelegramChatId(input: string): string {
  const s = input.trim();
  if (!s) return s;
  if (/^-?\d+$/.test(s)) return s; // numeric chat id — no "@"
  return s.startsWith('@') ? s : `@${s}`; // public username — needs "@"
}

/**
 * Telegram handler using the PER-USER bot-token model: each connection stores
 * its own bot token (from @BotFather) plus a target chat id/username. There is
 * no shared/global bot and no OAuth — credentials arrive as a JSON blob through
 * the `code` parameter of {@link exchangeCodeForToken}.
 */
export class TelegramHandler extends PlatformHandler {
  constructor() {
    super(config);
  }

  /** Build a Bot API method URL for a given bot token. */
  private api(botToken: string, method: string): string {
    return `https://api.telegram.org/bot${botToken}/${method}`;
  }

  async getOAuthUrl(_redirectUri: string, _state: string): Promise<string> {
    throw new Error('Telegram uses bot-token credentials, not OAuth');
  }

  async exchangeCodeForToken(
    code: string,
    _redirectUri: string,
  ): Promise<TokenData> {
    // The "code" parameter contains JSON-encoded credentials.
    let credentials: { botToken?: string; chatId?: string };

    try {
      credentials = JSON.parse(code);
    } catch {
      throw new Error(
        'Invalid Telegram credentials. Expected JSON with botToken and chatId.',
      );
    }

    const { botToken, chatId } = credentials;
    if (!botToken || !chatId) {
      throw new Error('Both a bot token and a chat id/username are required.');
    }

    const chat = await this.getChatInfo(botToken, chatId);
    return { accessToken: botToken, userId: chat.id };
  }

  /**
   * Validate a bot token and resolve the destination chat to displayable account
   * info. Used by the connect route — getAccountInfo only sees the bot, not the
   * target chat. Throws friendly errors on a bad token / unreachable chat.
   */
  async getChatInfo(botToken: string, chatId: string): Promise<TelegramChatInfo> {
    // Validate the token. fetchJson throws on a non-2xx (a bad token is 401), so
    // map both the thrown error and an {ok:false} body to the same friendly message.
    let me: TelegramResponse<TelegramUser>;
    try {
      me = await this.fetchJson<TelegramResponse<TelegramUser>>(this.api(botToken, 'getMe'));
    } catch {
      throw new Error('Invalid bot token.');
    }
    if (!me.ok) throw new Error('Invalid bot token.');

    // Accept the channel with or without a leading "@" (and numeric ids as-is).
    const normalizedChatId = normalizeTelegramChatId(chatId);

    // Resolve the destination chat — also verifies the bot can see it.
    const chatNotFound =
      'Could not find that chat. Make sure the bot is an admin of the channel/group.';
    let chat: TelegramResponse<TelegramChat>;
    try {
      chat = await this.fetchJson<TelegramResponse<TelegramChat>>(
        `${this.api(botToken, 'getChat')}?chat_id=${encodeURIComponent(normalizedChatId)}`,
      );
    } catch {
      throw new Error(chatNotFound);
    }
    if (!chat.ok) throw new Error(chatNotFound);

    const c = chat.result;
    return {
      id: String(c.id),
      chatId: normalizedChatId,
      title: c.title || c.username || String(c.id),
      username: c.username,
      type: c.type || 'channel',
    };
  }

  /**
   * The access token IS the bot token. With only the bot token we can identify
   * the BOT, not the destination chat — the connect route resolves the chat via
   * getChat and overrides accountId=chat.id, accountName=chat.title, and stores
   * chatId in metadata.
   */
  async getAccountInfo(accessToken: string): Promise<AccountInfo> {
    const me = await this.fetchJson<TelegramResponse<TelegramUser>>(
      this.api(accessToken, 'getMe'),
    );

    return {
      id: String(me.result.id),
      name: me.result.username || me.result.first_name || 'Telegram Bot',
      accountType: 'bot',
    };
  }

  async publishPost(
    post: PostData,
    channel: ChannelData,
  ): Promise<PublishResult> {
    this.logger.info(
      {
        accountId: channel.accountId,
        hasMedia: post.mediaFiles.length > 0,
        mediaCount: post.mediaFiles.length,
      },
      'Telegram publish started',
    );

    const botToken = channel.accessToken;
    if (!botToken) {
      return { success: false, error: 'No bot token for Telegram account' };
    }

    const chatId = (channel.metadata?.chatId as string) ?? channel.accountId;
    if (!chatId) {
      return { success: false, error: 'No Telegram chat configured for this account.' };
    }

    // Our composer/API content is plain text (like the X/Bluesky/Mastodon
    // handlers). Send it WITHOUT parse_mode so bare "&", "<", ">" can't trip
    // Telegram's "can't parse entities" 400 — Telegram still auto-links URLs.
    const text = post.content || '';

    // Telegram caps captions at 1024 chars (vs 4096 for a standalone message).
    const CAPTION_LIMIT = 1024;

    // Telegram fetches remote URLs directly, so no multipart upload is needed —
    // we hand it the media file URL as the file value.
    const media: TelegramMediaItem[] = post.mediaFiles
      .map((file): TelegramMediaItem | null => {
        if (file.mimeType.startsWith('image/')) return { kind: 'photo', url: file.url };
        if (file.mimeType.startsWith('video/')) return { kind: 'video', url: file.url };
        return null;
      })
      .filter((item): item is TelegramMediaItem => item !== null);

    // When media is present the text rides along as a caption (1024 cap). If it's
    // longer, keep the media captionless and post the full text as its own message
    // below, so nothing is silently dropped.
    const captionFits = text.length <= CAPTION_LIMIT;
    const caption = media.length > 0 && captionFits ? text : '';

    try {
      let resp: TelegramResponse<TelegramMessage>;

      if (media.length === 0) {
        // Plain text message.
        resp = await this.send<TelegramMessage>(botToken, 'sendMessage', {
          chat_id: chatId,
          text,
        });
      } else if (media.length === 1) {
        // A single photo or video, with the text as caption (when it fits).
        const item = media[0];
        const method = item.kind === 'photo' ? 'sendPhoto' : 'sendVideo';
        const fileKey = item.kind === 'photo' ? 'photo' : 'video';
        resp = await this.send<TelegramMessage>(botToken, method, {
          chat_id: chatId,
          [fileKey]: item.url,
          ...(caption ? { caption } : {}),
        });
      } else {
        // 2..N media — send as media group(s) of up to 10. The caption rides on
        // the first item of the very first chunk only.
        let first: TelegramResponse<TelegramMessage> | undefined;
        for (let i = 0; i < media.length; i += 10) {
          const chunk = media.slice(i, i + 10);
          const groupResp = await this.send<TelegramMessage[]>(botToken, 'sendMediaGroup', {
            chat_id: chatId,
            media: chunk.map((m, index) => ({
              type: m.kind,
              media: m.url,
              ...(caption && i === 0 && index === 0 ? { caption } : {}),
            })),
          });
          if (i === 0) {
            // sendMediaGroup returns an array of messages — take the first.
            first = { ok: groupResp.ok, result: groupResp.result[0], description: groupResp.description };
          }
        }
        // `first` is always set: media.length >= 2 guarantees the loop ran once.
        resp = first!;
      }

      if (!resp.ok || !resp.result) {
        return { success: false, error: resp.description || 'Telegram rejected the message.' };
      }

      const messageId = String(resp.result.message_id);
      const url = this.buildReleaseUrl(chatId, channel.accountId, messageId);

      // Long text + media: the caption couldn't hold it, so post the full text as
      // a follow-up message (best-effort — the media post above is the anchor).
      if (media.length > 0 && !captionFits && text) {
        try {
          await this.send<TelegramMessage>(botToken, 'sendMessage', { chat_id: chatId, text });
        } catch (followUpError) {
          this.logger.warn({ error: followUpError }, 'Telegram follow-up text message failed');
        }
      }

      this.logger.info({ messageId, url }, 'Telegram message published successfully');
      return { success: true, postId: messageId, url };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: message }, 'Failed to publish Telegram message');
      return { success: false, error: message };
    }
  }

  async publishComment(
    channel: ChannelData,
    platformPostId: string,
    comment: string,
  ): Promise<{ success: boolean; error?: string }> {
    const botToken = channel.accessToken;
    if (!botToken) {
      return { success: false, error: 'No bot token for Telegram account' };
    }

    const chatId = (channel.metadata?.chatId as string) ?? channel.accountId;
    if (!chatId) {
      return { success: false, error: 'No Telegram chat configured for this account.' };
    }

    try {
      const resp = await this.send<TelegramMessage>(botToken, 'sendMessage', {
        chat_id: chatId,
        text: comment,
        reply_to_message_id: Number(platformPostId),
      });

      if (!resp.ok) {
        return { success: false, error: resp.description || 'Telegram rejected the comment.' };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** POST a JSON body to a Bot API method and return the parsed wrapper. */
  private async send<T>(
    botToken: string,
    method: string,
    body: Record<string, unknown>,
  ): Promise<TelegramResponse<T>> {
    return this.fetchJson<TelegramResponse<T>>(this.api(botToken, method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /**
   * Build the public t.me link for a published message. Public channels/groups
   * use the @username form; private ones (numeric -100… ids) use the /c/ form
   * with the -100 prefix stripped.
   */
  private buildReleaseUrl(chatId: string, accountId: string, messageId: string): string {
    const username = this.resolveUsername(chatId, accountId);
    if (username) {
      return `https://t.me/${username.replace(/^@/, '')}/${messageId}`;
    }
    // Only -100… supergroups/channels have a public /c/ permalink; basic groups
    // and DMs have none, so don't fabricate a broken link for them.
    const id = String(chatId);
    if (id.startsWith('-100')) {
      return `https://t.me/c/${id.slice(4)}/${messageId}`;
    }
    return '';
  }

  /**
   * Return the public @username for a chat if one is available, else null.
   * A chat is public when its id/accountId is a @handle or any non-numeric
   * string; private supergroups/channels expose only numeric -100… ids.
   */
  private resolveUsername(chatId: string, accountId: string): string | null {
    const isUsername = (value: string): boolean =>
      value.startsWith('@') || !/^-?\d+$/.test(value);

    if (isUsername(chatId)) return chatId;
    if (accountId && isUsername(accountId)) return accountId;
    return null;
  }

  /**
   * Telegram channel comments live in the linked discussion group, and the Bot
   * API has no call to list them: a bot only learns of messages and reactions
   * through pushed updates while it is running, which is not something a
   * request-time read can reconstruct.
   */
  async getPostEngagement(): Promise<EngagementData> {
    // `unsupported` keeps the UI from rendering an empty panel for it.
    return { comments: [], reactions: [], unsupported: true, notice: 'Telegram does not let a bot list comments on demand.' };
  }
}
