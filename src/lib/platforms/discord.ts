import { PlatformHandler } from './base';
import type {
  TokenData,
  AccountInfo,
  PublishResult,
  PostData,
  ChannelData,
  PlatformConfig,
  EngagementData,
  EngagementOptions,
  EngagementComment,
  EngagementReaction,
  MetricsData,
  PostMetricsOptions,
} from './types';

const API_BASE = 'https://discord.com/api';

const config: PlatformConfig = {
  name: 'discord',
  displayName: 'Discord',
  icon: 'discord',
  color: '#5865F2',
  authType: 'oauth',
  postTypes: [
    {
      value: 'post',
      label: 'Message',
      description: 'Send a message with optional attachments to a Discord channel',
      maxMedia: 10,
      allowedMediaTypes: ['image', 'video'],
    },
  ],
  mediaRules: {
    image: {
      maxSizeMB: 25,
      formats: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
      maxCount: 10,
    },
    video: {
      maxSizeMB: 25,
      formats: ['mp4', 'mov', 'webm'],
      maxCount: 10,
    },
  },
};

/**
 * Discord handler.
 *
 * Architecture note: the connected "account" is a GUILD (server), not a user.
 * The per-channel OAuth access token is only consulted at connect time (for
 * `/oauth2/@me`). ALL posting goes through the GLOBAL bot token
 * (`Authorization: Bot <DISCORD_BOT_TOKEN>`), never the stored OAuth token, so a
 * publish failure is never a per-user re-auth situation. The target channel is
 * chosen per-post (the composer resolves it via {@link listGuildChannels}).
 */
export class DiscordHandler extends PlatformHandler {
  constructor() {
    super(config);
  }

  private getClientId(): string {
    const clientId = process.env.DISCORD_CLIENT_ID;
    if (!clientId) throw new Error('DISCORD_CLIENT_ID not configured');
    return clientId;
  }

  private getClientSecret(): string {
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    if (!clientSecret) throw new Error('DISCORD_CLIENT_SECRET not configured');
    return clientSecret;
  }

  private getBotToken(): string {
    const botToken = process.env.DISCORD_BOT_TOKEN;
    if (!botToken) throw new Error('DISCORD_BOT_TOKEN not configured');
    return botToken;
  }

  private getBasicAuthHeader(): string {
    const clientId = this.getClientId();
    const clientSecret = this.getClientSecret();
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    return `Basic ${credentials}`;
  }

  async getOAuthUrl(redirectUri: string, state: string): Promise<string> {
    const params = new URLSearchParams({
      client_id: this.getClientId(),
      permissions: '377957124096',
      response_type: 'code',
      integration_type: '0',
      scope: 'bot identify guilds',
      state: state,
      redirect_uri: redirectUri,
    });

    return `https://discord.com/oauth2/authorize?${params.toString()}`;
  }

  async exchangeCodeForToken(
    code: string,
    redirectUri: string,
  ): Promise<TokenData> {
    const params = new URLSearchParams({
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });

    const data = await this.fetchJson<{
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      guild?: { id: string; name?: string };
    }>(`${API_BASE}/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: this.getBasicAuthHeader(),
      },
      body: params.toString(),
    });

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      // The guild id only appears on the token-exchange response — thread it
      // through userId so the connect route can persist it as the accountId.
      userId: data.guild?.id,
    };
  }

  /**
   * Returns the bot application's identity. NOTE: `/oauth2/@me` cannot see the
   * guild the bot was added to — the connect route MUST override the stored
   * `accountId` with the guild id from {@link TokenData.userId} returned by
   * {@link exchangeCodeForToken}, since posting URLs and channel lookups key off
   * the guild id.
   */
  async getAccountInfo(accessToken: string): Promise<AccountInfo> {
    const data = await this.fetchJson<{
      application: {
        id: string;
        name: string;
        bot?: { id: string; avatar?: string | null; username?: string };
      };
    }>(`${API_BASE}/oauth2/@me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const app = data.application;
    return {
      id: app.bot?.id || app.id,
      name: app.name,
      profileImage:
        app.bot?.avatar
          ? `https://cdn.discordapp.com/avatars/${app.bot.id}/${app.bot.avatar}.png`
          : undefined,
      accountType: 'guild',
    };
  }

  async refreshToken(refreshTokenValue: string): Promise<TokenData | null> {
    try {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshTokenValue,
      });

      const data = await this.fetchJson<{
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
      }>(`${API_BASE}/oauth2/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: this.getBasicAuthHeader(),
        },
        body: params.toString(),
      });

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
      };
    } catch (error) {
      this.logger.error({ error }, 'Failed to refresh Discord token');
      // A 5xx, 429 or network failure says nothing about the refresh token;
      // returning null for it read as "cannot be refreshed" and flagged
      // reconnect after one blip. Only a rejection returns null.
      if (this.isTransientRefreshFailure(error)) throw error;
      return null;
    }
  }

  async publishPost(
    post: PostData,
    channel: ChannelData,
  ): Promise<PublishResult> {
    // Resolve the target Discord channel id: composer keys platformSpecific by
    // channelId, but also accept a top-level value or a channel-metadata default.
    const channelSpecific = post.platformSpecific?.[channel.id] as
      | { channelId?: string }
      | undefined;
    const channelId =
      channelSpecific?.channelId ??
      (post.platformSpecific as { channelId?: string } | undefined)?.channelId ??
      (channel.metadata?.channelId as string | undefined);

    if (!channelId) {
      return { success: false, error: 'No Discord channel selected for this message.' };
    }

    const botToken = this.getBotToken();
    const guildId = channel.accountId;
    const content = post.content;

    this.logger.info(
      {
        guildId,
        channelId,
        hasMedia: post.mediaFiles.length > 0,
        mediaCount: post.mediaFiles.length,
      },
      'Discord publish started',
    );

    const url = `${API_BASE}/channels/${channelId}/messages`;

    try {
      let data: { id: string };

      if (post.mediaFiles.length > 0) {
        // Multipart: payload_json describes the message + attachment metadata,
        // and each file is appended as files[i]. Do NOT set Content-Type — the
        // FormData boundary must be set automatically.
        const form = new FormData();
        form.append(
          'payload_json',
          JSON.stringify({
            content,
            attachments: post.mediaFiles.map((m, i) => ({
              id: i,
              description: m.altText || `Attachment ${i}`,
              filename: m.url.split('/').pop() || `file${i}`,
            })),
          }),
        );

        for (let i = 0; i < post.mediaFiles.length; i++) {
          const media = post.mediaFiles[i];
          const filename = media.url.split('/').pop() || `file${i}`;
          const r = await this.fetchRemoteMedia(media.url);
          if (!r.ok) {
            return { success: false, error: `Could not read attachment for upload (${r.status}).` };
          }
          const blob = await r.blob();
          form.append(`files[${i}]`, blob, filename);
        }

        const resp = await this.fetchWithFile(url, form, {
          Authorization: `Bot ${botToken}`,
        });

        if (!resp.ok) {
          const text = await resp.text();
          return { success: false, error: this.mapError(text) };
        }
        data = (await resp.json()) as { id: string };
      } else {
        data = await this.fetchJson<{ id: string }>(url, {
          method: 'POST',
          headers: {
            Authorization: `Bot ${botToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content }),
        });
      }

      const postId = data.id;
      const postUrl = `https://discord.com/channels/${guildId}/${channelId}/${postId}`;

      this.logger.info({ postId, url: postUrl }, 'Discord message published successfully');

      return { success: true, postId, url: postUrl };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const message = this.mapError(raw);
      this.logger.error({ error: raw }, 'Failed to publish Discord message');
      // Posting uses the GLOBAL bot token, not a per-user token, so a failure is
      // never a user-reconnect situation — do NOT set authExpired.
      return { success: false, error: message };
    }
  }

  /**
   * Translate a Discord error body/message into a clear, actionable message.
   * Matches on the documented Discord JSON error codes embedded in the body —
   * and, as a fallback, on the human-readable Discord message text, since the
   * no-media path surfaces `fetchJson`'s thrown message (which keeps the
   * `message` string but drops the numeric `code`).
   */
  private mapError(body: string): string {
    const lower = body.toLowerCase();
    if (body.includes('50001') || lower.includes('missing access'))
      return 'The bot does not have access to this channel.';
    if (body.includes('50013') || lower.includes('missing permissions'))
      return 'The bot lacks permission to send messages in this channel.';
    if (body.includes('10003') || lower.includes('unknown channel'))
      return 'That Discord channel no longer exists.';
    if (body.includes('40005') || lower.includes('request entity too large'))
      return "An attachment exceeds Discord's size limit.";

    // Fall back to the raw Discord message when present, else the raw body.
    try {
      const parsed = JSON.parse(body) as { message?: string };
      if (parsed.message) return parsed.message;
    } catch {
      // not JSON — return the raw body below
    }
    return body;
  }

  /**
   * Lists the text-capable channels of a guild for the composer's channel picker.
   * Filters to types 0 (text), 5 (announcement), and 15 (forum). Uses the global
   * bot token — the OAuth access token is not consulted here.
   */
  async listGuildChannels(
    guildId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const botToken = this.getBotToken();

    const list = await this.fetchJson<
      Array<{ id: string; name: string; type: number }>
    >(`${API_BASE}/guilds/${guildId}/channels`, {
      headers: {
        Authorization: `Bot ${botToken}`,
      },
    });

    return (list || [])
      .filter((c) => c.type === 0 || c.type === 5 || c.type === 15)
      .map((c) => ({ id: String(c.id), name: c.name }));
  }

  /**
   * A Discord message reports real per-post figures: `reactions[].count`
   * (total uses of each emoji — summed, that is the likes figure) and, when a
   * thread was started from the message, the thread's `message_count` (the
   * comments figure — a message with no thread genuinely has zero thread
   * replies). No views/impressions field exists on the Message resource.
   *
   * One GET per message: `/channels/{channelId}/messages/{id}` with the bot
   * token. The channel id comes from the stored permalink via opts.urlsById —
   * a message id alone is not addressable.
   */
  async getPostMetrics(
    channel: ChannelData,
    platformPostIds: string[],
    opts?: PostMetricsOptions,
  ): Promise<Map<string, MetricsData>> {
    const results = new Map<string, MetricsData>();
    const botToken = process.env.DISCORD_BOT_TOKEN;
    if (!botToken || platformPostIds.length === 0) return results;
    const headers = { Authorization: `Bot ${botToken}` };

    for (const id of platformPostIds) {
      const url = opts?.urlsById?.[id];
      const fromUrl = url?.match(/\/channels\/\d+\/(\d+)(?:\/|$)/)?.[1];
      const channelId = fromUrl ?? (channel.metadata?.channelId as string | undefined);
      if (!channelId) continue;

      try {
        const message = await this.fetchJson<{
          id: string;
          reactions?: Array<{ count?: number }>;
          thread?: { id: string; message_count?: number };
        }>(`${API_BASE}/channels/${channelId}/messages/${id}`, { headers }, { quiet: true });

        const likes = (message.reactions ?? []).reduce((sum, r) => sum + (r.count ?? 0), 0);
        results.set(id, {
          likes,
          comments: message.thread?.message_count ?? 0,
        });
      } catch (error) {
        this.logger.warn({ error, platformPostId: id }, 'Discord message metrics fetch failed');
      }
    }

    return results;
  }

  /**
   * Discord engagement is two different things, neither of them a "comment
   * list": emoji reactions on the message, and — if a thread was started from
   * it — the messages in that thread.
   *
   * Reactions arrive on the message as counts per emoji; the users behind each
   * one need a separate call, so the fan-out is capped. Plain channel replies
   * are NOT fetched: they are ordinary messages elsewhere in the channel, and
   * finding them would mean scanning channel history on every preview open.
   * A thread is the one case where Discord itself scopes the conversation to
   * the message, so that is what is read.
   */
  async getPostEngagement(
    channel: ChannelData,
    platformPostId: string,
    opts?: EngagementOptions,
  ): Promise<EngagementData> {
    const botToken = process.env.DISCORD_BOT_TOKEN;
    if (!botToken) {
      return { comments: [], reactions: [], notice: 'Discord bot is not configured', commentsNotice: 'Discord bot is not configured' };
    }

    // The permalink is /channels/{guild}/{channel}/{message} — the middle
    // segment is the only record of which channel this post went to.
    // Anchored on the guild+channel pair only. Requiring a numeric message
    // segment as well would make the match depend on a part of the URL this
    // does not need.
    const fromUrl = opts?.platformUrl?.match(/\/channels\/\d+\/(\d+)(?:\/|$)/)?.[1];
    const channelId = fromUrl ?? (channel.metadata?.channelId as string | undefined);
    if (!channelId) {
      return { comments: [], reactions: [], notice: 'Discord channel for this post is unknown', commentsNotice: 'Discord channel for this post is unknown' };
    }

    const commentsLimit = Math.min(opts?.commentsLimit ?? 25, 100);
    const reactionsLimit = Math.min(opts?.reactionsLimit ?? 25, 100);
    const headers = { Authorization: `Bot ${botToken}` };

    type DiscordUser = { id: string; username: string; global_name?: string | null; avatar?: string | null };
    type DiscordMessage = {
      id: string;
      content?: string;
      timestamp?: string;
      author?: DiscordUser;
      thread?: { id: string };
      reactions?: Array<{ count: number; emoji: { id?: string | null; name: string } }>;
    };

    const actorOf = (u: DiscordUser | undefined) => ({
      id: u?.id ?? 'unknown',
      name: u?.global_name || u?.username || 'Discord user',
      handle: u?.username,
      profileImage: u?.id && u.avatar
        ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64`
        : undefined,
    });

    const result: EngagementData = { comments: [], reactions: [] };
    let message: DiscordMessage;

    try {
      message = await this.fetchJson<DiscordMessage>(
        `${API_BASE}/channels/${channelId}/messages/${platformPostId}`,
        { headers },
      );
    } catch (error) {
      this.logger.warn({ error, platformPostId }, 'Discord message fetch failed');
      return { comments: [], reactions: [], notice: 'Message unavailable', commentsNotice: 'Message unavailable' };
    }

    // ── Reactors ──────────────────────────────────────────────────────────
    const emoji = (message.reactions ?? []).slice(0, 5); // cap the fan-out
    const reactions: EngagementReaction[] = [];
    for (const r of emoji) {
      if (reactions.length >= reactionsLimit) break;
      // Custom emoji are addressed as name:id, unicode ones as the character.
      const key = r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : r.emoji.name;
      try {
        const users = await this.fetchJson<DiscordUser[]>(
          `${API_BASE}/channels/${channelId}/messages/${platformPostId}/reactions/${encodeURIComponent(key)}?limit=${Math.min(reactionsLimit, 100)}`,
          { headers },
          { quiet: true },
        );
        for (const u of users ?? []) {
          if (reactions.length >= reactionsLimit) break;
          reactions.push({ id: `${key}-${u.id}`, type: r.emoji.name, actor: actorOf(u) });
        }
      } catch {
        // One unreadable emoji must not lose the others.
      }
    }
    result.reactions = reactions;
    result.hasMoreReactions =
      (message.reactions ?? []).length > emoji.length || reactions.length >= reactionsLimit;

    // ── Thread replies ────────────────────────────────────────────────────
    if (message.thread?.id) {
      try {
        const msgs = await this.fetchJson<DiscordMessage[]>(
          `${API_BASE}/channels/${message.thread.id}/messages?limit=${commentsLimit}`,
          { headers },
        );
        const comments: EngagementComment[] = [];
        // Discord returns newest-first; the panel reads oldest-first like every
        // other platform's thread.
        for (const m of (msgs ?? []).slice().reverse()) {
          if (!m.content) continue;
          comments.push({
            id: m.id,
            text: m.content,
            createdAt: m.timestamp,
            actor: actorOf(m.author),
          });
        }
        result.comments = comments;
        result.hasMoreComments = (msgs ?? []).length >= commentsLimit;
      } catch (error) {
        this.logger.warn({ error, platformPostId }, 'Discord thread fetch failed');
        result.notice = 'Thread replies unavailable';
        result.commentsNotice = 'Thread replies unavailable';
      }
    } else {
      result.notice = 'This message has no thread. On Discord, replies live in the channel rather than on the post.';
      result.commentsNotice = result.notice;
    }

    return result;
  }
}
