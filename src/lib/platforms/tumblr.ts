import { PlatformHandler } from './base';
import type {
  TokenData,
  AccountInfo,
  PublishResult,
  PostData,
  ChannelData,
  MediaFileData,
  PlatformConfig,
  EngagementData,
  EngagementComment,
  EngagementReaction,
} from './types';

// Tumblr uses the www host for the authorize redirect and api.tumblr.com for
// everything else (including the token exchange).
const AUTH_BASE = 'https://www.tumblr.com';
const API_BASE = 'https://api.tumblr.com/v2';

// Tumblr asks API consumers to identify themselves; without it some endpoints
// rate-limit far more aggressively.
const USER_AGENT = 'openPublish/1.0 (+https://github.com/openpublish)';

// NPF caps a single text block at 4096 chars, so longer content is split across
// several blocks. The overall post limit is far higher — see PLATFORM_CHAR_LIMITS.
const TEXT_BLOCK_LIMIT = 4096;

// Tumblr requires width/height on video blocks but we don't always have the
// dimensions (no thumbnail). These are Tumblr's own historical defaults and are
// only used as a fallback — the player scales to the real aspect ratio anyway.
const DEFAULT_VIDEO_WIDTH = 540;
const DEFAULT_VIDEO_HEIGHT = 405;

const config: PlatformConfig = {
  name: 'tumblr',
  displayName: 'Tumblr',
  icon: 'tumblr',
  color: '#001935',
  authType: 'oauth',
  postTypes: [
    {
      value: 'post',
      label: 'Post',
      description: 'Publish a text, photo, or video post to a Tumblr blog',
      maxMedia: 30,
      allowedMediaTypes: ['image', 'video'],
    },
  ],
  mediaRules: {
    // Tumblr allows up to 30 images in one post but only a single uploaded video,
    // and a video cannot be mixed with images in the same post.
    image: { maxSizeMB: 20, formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'], maxCount: 30 },
    video: { maxSizeMB: 500, formats: ['mp4', 'mov'], maxCount: 1, maxDurationSec: 600 },
  },
};

/** A blog on the connected Tumblr account. */
export interface TumblrBlog {
  id: string;
  name: string;
  title?: string;
  url?: string;
  primary?: boolean;
  followers?: number;
}

/** Per-channel publish options the composer stores under platformSpecific[channel.id]. */
interface TumblrPostSettings {
  /** Which blog to publish to. Defaults to the channel's primary blog. */
  blogName?: string;
  /** Rendered as an NPF heading1 block above the body. */
  title?: string;
  /** Appended as a link block. */
  link?: string;
  /** Tumblr tags (no leading '#'). */
  tags?: string[];
  /** Attribution URL stored as the post's source. */
  sourceUrl?: string;
}

type TumblrMediaRef = {
  type: string;
  identifier: string;
  width?: number;
  height?: number;
};

interface TumblrCreateResponse {
  response?: {
    id?: string | number;
    id_string?: string;
    post_id?: string | number;
  };
}

type TumblrContentBlock =
  | { type: 'text'; text: string; subtype?: 'heading1' }
  | { type: 'link'; url: string }
  | { type: 'image'; media: TumblrMediaRef[]; alt_text?: string }
  | { type: 'video'; provider: 'tumblr'; media: TumblrMediaRef };

export class TumblrHandler extends PlatformHandler {
  constructor() {
    super(config);
  }

  private getClientId(): string {
    const clientId = process.env.TUMBLR_CLIENT_ID;
    if (!clientId) throw new Error('TUMBLR_CLIENT_ID not configured');
    return clientId;
  }

  private getClientSecret(): string {
    const clientSecret = process.env.TUMBLR_CLIENT_SECRET;
    if (!clientSecret) throw new Error('TUMBLR_CLIENT_SECRET not configured');
    return clientSecret;
  }

  private authHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': USER_AGENT,
    };
  }

  async getOAuthUrl(redirectUri: string, state: string): Promise<string> {
    const params = new URLSearchParams({
      client_id: this.getClientId(),
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
      // offline_access is what makes Tumblr issue a refresh_token; without it the
      // connection dies ~1h later with no way back except a manual reconnect.
      scope: 'basic write offline_access',
    });

    return `${AUTH_BASE}/oauth2/authorize?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string, redirectUri: string): Promise<TokenData> {
    return this.requestToken(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: this.getClientId(),
        client_secret: this.getClientSecret(),
      }),
    );
  }

  async refreshToken(refreshToken: string): Promise<TokenData | null> {
    try {
      const token = await this.requestToken(
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: this.getClientId(),
          client_secret: this.getClientSecret(),
        }),
      );
      // Tumblr rotates refresh tokens on some grants and omits it on others —
      // keep the existing one when it isn't returned, or we lose the ability to
      // refresh again.
      return { ...token, refreshToken: token.refreshToken || refreshToken };
    } catch (error) {
      this.logger.error({ error }, 'Tumblr token refresh failed');
      return null;
    }
  }

  private async requestToken(body: URLSearchParams): Promise<TokenData> {
    const data = await this.fetchJson<{
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    }>(`${API_BASE}/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: body.toString(),
    });

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }

  async getAccountInfo(accessToken: string): Promise<AccountInfo> {
    const blogs = await this.getBlogs(accessToken);
    const primary = blogs.find((b) => b.primary) || blogs[0];

    if (!primary) {
      throw new Error('This Tumblr account has no blogs to publish to.');
    }

    return {
      id: primary.name,
      name: primary.title || primary.name,
      profileImage: this.avatarUrl(primary.name),
      accountType: 'blog',
    };
  }

  /**
   * Every blog on the account. Surfaced through
   * `GET /api/channels/{id}/options` so the composer can target a specific blog
   * per post — a Tumblr user commonly has a personal blog plus several others.
   */
  async getBlogs(accessToken: string): Promise<TumblrBlog[]> {
    const data = await this.fetchJson<{
      response?: { user?: { name?: string; blogs?: Array<Record<string, unknown>> } };
    }>(`${API_BASE}/user/info`, { headers: this.authHeaders(accessToken) });

    const blogs = data.response?.user?.blogs ?? [];
    return blogs.map((blog) => {
      const name = String(blog.name ?? '');
      return {
        id: name,
        name,
        title: typeof blog.title === 'string' ? blog.title : undefined,
        url: typeof blog.url === 'string' ? blog.url : `https://${name}.tumblr.com/`,
        primary: blog.primary === true,
        followers: typeof blog.followers === 'number' ? blog.followers : undefined,
      };
    });
  }

  async publishPost(post: PostData, channel: ChannelData): Promise<PublishResult> {
    // platformSpecific is keyed by channelId from the composer; fall back to the
    // flat object for API callers that send one set of options for the post.
    const settings = ((post.platformSpecific?.[channel.id] ??
      post.platformSpecific ??
      {}) as TumblrPostSettings);
    const blogName = settings.blogName || channel.accountId;

    if (!blogName) {
      return { success: false, error: 'No Tumblr blog selected for this channel.' };
    }

    try {
      const media = post.mediaFiles ?? [];
      const videos = media.filter((m) => this.isVideo(m));
      const images = media.filter((m) => !this.isVideo(m));

      // Tumblr rejects a post mixing an uploaded video with photos, and only ever
      // accepts one video. Catch it here so the user gets a clear message instead
      // of an opaque 8001 from the API.
      if (videos.length > 1) {
        return { success: false, error: 'Tumblr accepts only one video per post.' };
      }
      if (videos.length === 1 && images.length > 0) {
        return { success: false, error: 'Tumblr cannot mix a video and images in the same post.' };
      }
      if (images.length > 30) {
        return { success: false, error: 'Tumblr accepts up to 30 images per post.' };
      }

      const content = this.buildContentBlocks(post, media, settings);
      const payload: Record<string, unknown> = {
        content,
        state: 'published',
      };
      if (settings.tags?.length) {
        // The v2 API takes tags as a comma-separated string, not an array.
        payload.tags = settings.tags.map((t) => t.trim().replace(/^#/, '').trim()).filter(Boolean).join(',');
      }
      if (settings.sourceUrl) {
        payload.source_url = this.normalizeUrl(settings.sourceUrl);
      }

      const endpoint = `${API_BASE}/blog/${encodeURIComponent(blogName)}/posts`;
      const response = media.length
        ? await this.createMultipartPost(endpoint, channel.accessToken, payload, media)
        : await this.fetchJson<TumblrCreateResponse>(endpoint, {
            method: 'POST',
            headers: { ...this.authHeaders(channel.accessToken), 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

      const postId = String(
        response.response?.id_string ?? response.response?.post_id ?? response.response?.id ?? '',
      );

      if (!postId) {
        return { success: false, error: 'Tumblr accepted the post but returned no post id.' };
      }

      return {
        success: true,
        postId,
        url: `https://www.tumblr.com/${blogName}/${postId}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: this.friendlyError(message),
        // 401 means the token is dead — surface it so the worker flags the
        // channel for reconnect rather than retrying forever.
        authExpired: /\(401\)|invalid_grant|invalid_token/i.test(message),
      };
    }
  }

  /**
   * Media is uploaded in the same multipart request as the post: a `json` part
   * carrying the payload, plus one part per file whose name matches the
   * `identifier` referenced by the corresponding content block.
   */
  private async createMultipartPost(
    endpoint: string,
    accessToken: string,
    payload: Record<string, unknown>,
    media: MediaFileData[],
  ): Promise<TumblrCreateResponse> {
    const form = new FormData();
    form.append('json', new Blob([JSON.stringify(payload)], { type: 'application/json' }));

    for (const [index, item] of media.entries()) {
      const bytes = await this.readMediaBytes(item);
      const filename = item.localPath?.split('/').pop() || `media-${index}`;
      // A Buffer IS a Uint8Array — wrapping it in `new Uint8Array(bytes)` made
      // a second full copy of every media file for nothing.
      form.append(
        `media-${index}`,
        new Blob([bytes], { type: item.mimeType }),
        filename,
      );
    }

    const response = await this.fetchWithFile(endpoint, form, this.authHeaders(accessToken));
    const text = await response.text();

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response from tumblr: ${text.slice(0, 200)}`);
    }

    if (!response.ok) {
      this.logger.error({ status: response.status, data }, 'API error');
      throw new Error(`tumblr API error (${response.status}): ${JSON.stringify(data).slice(0, 200)}`);
    }

    return data as TumblrCreateResponse;
  }

  private async readMediaBytes(item: MediaFileData): Promise<Buffer> {
    const fs = await import('node:fs/promises');
    return fs.readFile(item.localPath);
  }

  private buildContentBlocks(
    post: PostData,
    media: MediaFileData[],
    settings: TumblrPostSettings,
  ): TumblrContentBlock[] {
    const content: TumblrContentBlock[] = [];

    if (settings.title) {
      content.push({ type: 'text', subtype: 'heading1', text: settings.title });
    }

    content.push(...this.textBlocks(post.content || ''));

    if (settings.link) {
      content.push({ type: 'link', url: this.normalizeUrl(settings.link) });
    }

    for (const [index, item] of media.entries()) {
      const ref: TumblrMediaRef = { type: item.mimeType, identifier: `media-${index}` };

      if (this.isVideo(item)) {
        content.push({
          type: 'video',
          provider: 'tumblr',
          media: {
            ...ref,
            width: item.width || DEFAULT_VIDEO_WIDTH,
            height: item.height || DEFAULT_VIDEO_HEIGHT,
          },
        });
        continue;
      }

      content.push({
        type: 'image',
        media: [{ ...ref, ...(item.width ? { width: item.width } : {}), ...(item.height ? { height: item.height } : {}) }],
        ...(item.altText ? { alt_text: item.altText } : {}),
      });
    }

    // A post with no blocks at all is rejected; an empty text block is valid and
    // is what Tumblr's own clients send for a media-only post with no caption.
    if (content.length === 0) {
      content.push({ type: 'text', text: '' });
    }

    return content;
  }

  /** Split on paragraph breaks, then hard-chunk anything over the block limit. */
  private textBlocks(message: string): TumblrContentBlock[] {
    return message
      .split(/\n{2,}/g)
      .map((part) => part.trim())
      .flatMap((part) => this.chunk(part))
      .filter((text) => text.length > 0)
      .map((text) => ({ type: 'text' as const, text }));
  }

  private chunk(text: string): string[] {
    // Split by code point, not UTF-16 unit, so an emoji is never cut in half.
    const codePoints = Array.from(text);
    if (codePoints.length <= TEXT_BLOCK_LIMIT) return [text];

    const chunks: string[] = [];
    for (let i = 0; i < codePoints.length; i += TEXT_BLOCK_LIMIT) {
      chunks.push(codePoints.slice(i, i + TEXT_BLOCK_LIMIT).join(''));
    }
    return chunks;
  }

  private isVideo(item: MediaFileData): boolean {
    return item.mimeType?.startsWith('video/') ?? false;
  }

  private normalizeUrl(url: string): string {
    return /^https?:\/\//i.test(url) ? url : `https://${url}`;
  }

  private avatarUrl(blogName: string): string {
    return `${API_BASE}/blog/${encodeURIComponent(`${blogName}.tumblr.com`)}/avatar/128`;
  }

  /**
   * Tumblr's numeric error codes are far more actionable than its prose. Map the
   * ones a scheduled post realistically hits to something a user can act on.
   */
  private friendlyError(message: string): string {
    if (/\b8023\b/.test(message) || /daily posting limit/i.test(message)) {
      return 'Tumblr daily posting limit reached. Try again tomorrow.';
    }
    if (/\b8011\b/.test(message)) return 'Tumblr daily video upload limit reached.';
    if (/\b8004\b/.test(message)) return 'Tumblr daily media upload limit reached.';
    if (/\b8005\b/.test(message)) return 'Tumblr rejected one of the uploaded media files.';
    if (/\b8010\b/.test(message)) {
      return 'Tumblr is still transcoding an earlier video on this blog. Try again shortly.';
    }
    if (/\b8022\b/.test(message)) return 'This Tumblr blog\'s queue is full.';
    if (/\b8001\b/.test(message)) return 'Tumblr rejected the post content format.';
    if (/\(401\)/.test(message)) return 'Tumblr access expired. Please reconnect the account.';
    if (/\(429\)/.test(message)) return 'Tumblr rate limit reached. This post will be retried.';
    return message;
  }

  /**
   * Tumblr has no comments endpoint — engagement lives in a post's NOTES, one
   * feed mixing replies, reblogs and likes. `mode=all` returns all three in a
   * single call.
   *
   * Replies map to comments directly. A reblog that added commentary is also a
   * comment in every sense the UI cares about, so it is included and labelled;
   * a bare reblog (no added text) is a share, and lands in reactions next to
   * the likes.
   *
   * Notes carry no stable id, so one is synthesised from type + blog +
   * timestamp — unique in practice because a blog cannot reply twice in the
   * same second.
   */
  async getPostEngagement(
    channel: ChannelData,
    platformPostId: string,
    opts?: { commentsLimit?: number; reactionsLimit?: number },
  ): Promise<EngagementData> {
    if (!channel.accessToken) {
      return { comments: [], reactions: [], notice: 'No access token', commentsNotice: 'No access token' };
    }
    const blogName = channel.accountId;
    if (!blogName) {
      return { comments: [], reactions: [], notice: 'Missing Tumblr blog name', commentsNotice: 'Missing Tumblr blog name' };
    }
    const commentsLimit = Math.min(opts?.commentsLimit ?? 25, 100);
    const reactionsLimit = Math.min(opts?.reactionsLimit ?? 25, 100);

    type TumblrNote = {
      type?: string;
      blog_name?: string;
      blog_url?: string;
      blog_uuid?: string;
      timestamp?: number;
      reply_text?: string;
      added_text?: string;
      avatar_shape?: string;
    };

    try {
      const data = await this.fetchJson<{
        response?: { notes?: TumblrNote[]; total_notes?: number; _links?: unknown };
      }>(
        `${API_BASE}/blog/${encodeURIComponent(blogName)}/notes?id=${encodeURIComponent(platformPostId)}&mode=all`,
        { headers: this.authHeaders(channel.accessToken) },
      );

      const notes = data.response?.notes ?? [];
      const comments: EngagementComment[] = [];
      const reactions: EngagementReaction[] = [];

      const actorOf = (n: TumblrNote) => ({
        id: n.blog_uuid || n.blog_name || 'unknown',
        name: n.blog_name ?? 'Tumblr user',
        handle: n.blog_name,
        profileImage: n.blog_name ? this.avatarUrl(n.blog_name) : undefined,
        profileUrl: n.blog_url,
      });
      const idOf = (n: TumblrNote) => `${n.type}-${n.blog_name}-${n.timestamp ?? 0}`;
      const at = (n: TumblrNote) =>
        n.timestamp ? new Date(n.timestamp * 1000).toISOString() : undefined;

      for (const note of notes) {
        const text = note.type === 'reply' ? note.reply_text : note.added_text;
        if ((note.type === 'reply' || note.type === 'reblog') && text) {
          if (comments.length < commentsLimit) {
            comments.push({ id: idOf(note), text, createdAt: at(note), actor: actorOf(note) });
          }
        } else if (note.type === 'like' || note.type === 'reblog') {
          if (reactions.length < reactionsLimit) {
            reactions.push({
              id: idOf(note),
              type: note.type === 'like' ? 'LIKE' : 'REBLOG',
              createdAt: at(note),
              actor: actorOf(note),
            });
          }
        }
      }

      const total = data.response?.total_notes;
      return {
        comments,
        reactions,
        hasMoreComments: comments.length >= commentsLimit,
        // total_notes counts every note type, so it can only tell us there is
        // more somewhere — never that there are more *reactions* specifically.
        hasMoreReactions:
          reactions.length >= reactionsLimit ||
          (typeof total === 'number' && total > notes.length),
      };
    } catch (error) {
      this.logger.warn({ error, platformPostId }, 'Tumblr notes fetch failed');
      return { comments: [], reactions: [], notice: 'Notes unavailable', commentsNotice: 'Notes unavailable' };
    }
  }
}
