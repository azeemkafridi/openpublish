import { randomBytes, createCipheriv } from 'node:crypto';
import { PlatformHandler } from './base';
import type {
  TokenData,
  AccountInfo,
  PublishResult,
  PostData,
  ChannelData,
  MediaFileData,
  PlatformConfig,
  MetricsData,
  PostMetricsOptions,
  EngagementData,
} from './types';

// Snap splits its OAuth and API across two hosts: accounts.snapchat.com issues
// tokens, businessapi.snapchat.com serves the Public Profile API.
const AUTH_BASE = 'https://accounts.snapchat.com/login/oauth2';
const API_BASE = 'https://businessapi.snapchat.com';

// Snap's upload protocol encrypts every media file with AES-256-CBC before
// upload and splits anything over 32MB into numbered parts (max 35 parts,
// 1GB total).
const CHUNK_SIZE = 32 * 1024 * 1024;
const MAX_PARTS = 35;

const config: PlatformConfig = {
  name: 'snapchat',
  displayName: 'Snapchat',
  icon: 'snapchat',
  color: '#FFFC00',
  authType: 'oauth',
  postTypes: [
    {
      value: 'story',
      label: 'Story',
      description: 'A snap on your public story, visible for 24 hours',
      mediaRequired: true,
      maxMedia: 1,
      allowedMediaTypes: ['image', 'video'],
    },
    {
      value: 'saved_story',
      label: 'Saved Story',
      description: 'A permanent story pinned to your public profile',
      mediaRequired: true,
      maxMedia: 1,
      allowedMediaTypes: ['image', 'video'],
    },
    {
      value: 'spotlight',
      label: 'Spotlight',
      description: 'A vertical video distributed on Spotlight',
      mediaRequired: true,
      maxMedia: 1,
      allowedMediaTypes: ['video'],
    },
  ],
  mediaRules: {
    image: { maxSizeMB: 20, formats: ['jpg', 'jpeg', 'png'], maxCount: 1 },
    video: {
      maxSizeMB: 1024,
      formats: ['mp4', 'mov'],
      maxCount: 1,
      // Stories accept 5–60s; Spotlight narrows the floor to 6s, checked in
      // publishPost where the post type is known.
      minDurationSec: 5,
      maxDurationSec: 60,
      orientation: 'vertical',
    },
  },
};

/** Per-channel publish options the composer stores under platformSpecific[channel.id]. */
interface SnapchatPostSettings {
  /** Saved Story title, max 45 chars. Falls back to the first line of content. */
  title?: string;
  /** Spotlight locale, e.g. "en_US". Required by Snap for Spotlight posts. */
  locale?: string;
  /** Spotlight: also save the video to the profile (default true on Snap's side). */
  saveToProfile?: boolean;
}

interface SnapMediaResponse {
  media?: Array<{
    media?: { id?: string; media_id?: string; add_path?: string; finalize_path?: string };
  }>;
  // Some responses put the object at the top level, keyed media_id.
  id?: string;
  media_id?: string;
  add_path?: string;
  finalize_path?: string;
}

export class SnapchatHandler extends PlatformHandler {
  constructor() {
    super(config);
  }

  private getClientId(): string {
    const clientId = process.env.SNAPCHAT_CLIENT_ID;
    if (!clientId) throw new Error('SNAPCHAT_CLIENT_ID not configured');
    return clientId;
  }

  private getClientSecret(): string {
    const clientSecret = process.env.SNAPCHAT_CLIENT_SECRET;
    if (!clientSecret) throw new Error('SNAPCHAT_CLIENT_SECRET not configured');
    return clientSecret;
  }

  private authHeaders(accessToken: string): Record<string, string> {
    return { Authorization: `Bearer ${accessToken}` };
  }

  async getOAuthUrl(redirectUri: string, state: string): Promise<string> {
    const params = new URLSearchParams({
      client_id: this.getClientId(),
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
      scope: 'snapchat-profile-api',
    });
    return `${AUTH_BASE}/authorize?${params.toString()}`;
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

  /**
   * Snap access tokens live 1 hour, so the token-refresh worker leans on this
   * constantly. Snap rotates the refresh token on every grant — always store
   * the new one, but keep the old as a fallback when the response omits it.
   */
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
      return { ...token, refreshToken: token.refreshToken || refreshToken };
    } catch (error) {
      this.logger.error({ error }, 'Snapchat token refresh failed');
      return null;
    }
  }

  private async requestToken(body: URLSearchParams): Promise<TokenData> {
    const data = await this.fetchJson<{
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    }>(`${AUTH_BASE}/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    return {
      accessToken: this.requireOAuthField(data.access_token, 'access_token'),
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }

  /**
   * The channel connects as the caller's own public profile. Snap's
   * `my_profile` endpoint resolves the profile the logged-in Snapchatter
   * hosts — the id it returns is the {profile_id} every publish and stats
   * call is addressed to.
   */
  async getAccountInfo(accessToken: string): Promise<AccountInfo> {
    let data: {
      public_profiles?: Array<{ public_profile?: SnapProfile }>;
      public_profile?: SnapProfile;
    };
    try {
      data = await this.fetchJson(`${API_BASE}/v1/public_profiles/my_profile`, {
        headers: this.authHeaders(accessToken),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The Public Profile API allowlists the OAuth CLIENT ID, separately from
      // the org-level approval. A newly created OAuth app 403s (empty body)
      // here even after Snap has approved the organization.
      if (/\(403\)/.test(message)) {
        throw new Error(
          'Snapchat returned 403 for this OAuth app. The Public Profile API allowlists the OAuth client id, ' +
          'email dev-support@snap.com (or your Snap contact) with this app\'s client id to have it added, then reconnect.',
        );
      }
      throw error;
    }

    const profile =
      data.public_profile ?? data.public_profiles?.[0]?.public_profile;
    if (!profile?.id) {
      throw new Error(
        'No Snapchat public profile found on this account. The Public Profile API requires a public profile. Create one in the Snapchat app first.',
      );
    }

    return {
      id: profile.id,
      name: profile.display_name || profile.snap_user_name || 'Snapchat profile',
      profileImage: pickLogo(profile.logo_urls),
      accountType: 'public_profile',
    };
  }

  async publishPost(post: PostData, channel: ChannelData): Promise<PublishResult> {
    const settings = ((post.platformSpecific?.[channel.id] ??
      post.platformSpecific ??
      {}) as SnapchatPostSettings);
    const postType = post.postType || 'story';
    const profileId = channel.accountId;
    const media = post.mediaFiles ?? [];

    if (!profileId) {
      return { success: false, error: 'No Snapchat public profile on this channel.' };
    }
    if (media.length !== 1) {
      return {
        success: false,
        error: media.length === 0
          ? 'Snapchat requires exactly one image or video per post.'
          : 'Snapchat accepts only one media file per post.',
      };
    }

    const item = media[0];
    const isVideo = item.mimeType?.startsWith('video/') ?? false;

    if (postType === 'spotlight' && !isVideo) {
      return { success: false, error: 'Snapchat Spotlight requires a video (MP4, 6–60 seconds).' };
    }
    if (isVideo && item.duration) {
      const minSec = postType === 'spotlight' ? 6 : 5;
      if (item.duration < minSec || item.duration > 60) {
        return {
          success: false,
          error: `Snapchat ${postType === 'spotlight' ? 'Spotlight' : 'story'} videos must be ${minSec}–60 seconds (got ${Math.round(item.duration)}s).`,
        };
      }
    }

    try {
      const mediaId = await this.uploadMedia(channel.accessToken, profileId, item, isVideo);

      // Snap transcodes after FINALIZE and rejects the create until the media
      // is ready — usually within seconds for images, longer for video. Wait
      // and retry in-handler (the media id stays valid, so this never
      // re-uploads); a transcode that outlasts the budget falls through to the
      // publish worker's transient-retry path via friendlyError.
      const waitsMs = [0, 5000, 10000, 20000];
      for (let attempt = 0; ; attempt++) {
        if (waitsMs[attempt] > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitsMs[attempt]));
        }
        try {
          switch (postType) {
            case 'spotlight':
              return await this.postSpotlight(channel, profileId, mediaId, post, settings);
            case 'saved_story':
              return await this.postSavedStory(channel, profileId, mediaId, post, settings);
            default:
              return await this.postStory(channel, profileId, mediaId);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const stillProcessing = /media.*(process|transcode)/i.test(message);
          if (!stillProcessing || attempt >= waitsMs.length - 1) throw error;
          this.logger.warn(
            { profileId, mediaId, attempt: attempt + 1, error: message.slice(0, 200) },
            'Snapchat media still processing — waiting before retrying the create',
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: this.friendlyError(message),
        authExpired: /\(401\)|invalid_grant|invalid_token|unauthorized/i.test(message),
      };
    }
  }

  /**
   * Snap's three-step upload: create a media container (declaring an AES-256-CBC
   * key+IV), upload the ENCRYPTED bytes in ≤32MB parts, then finalize. The
   * container response hands back the add/finalize paths to use verbatim.
   */
  private async uploadMedia(
    accessToken: string,
    profileId: string,
    item: MediaFileData,
    isVideo: boolean,
  ): Promise<string> {
    const fs = await import('node:fs/promises');
    const bytes = await fs.readFile(item.localPath);

    const key = randomBytes(32);
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);

    const partCount = Math.ceil(encrypted.length / CHUNK_SIZE);
    if (partCount > MAX_PARTS) {
      throw new Error('Snapchat media is limited to 1GB per file.');
    }

    const name = item.localPath?.split('/').pop() || (isVideo ? 'video.mp4' : 'image.jpg');
    const created = await this.fetchJson<SnapMediaResponse>(
      `${API_BASE}/v1/public_profiles/${encodeURIComponent(profileId)}/media`,
      {
        method: 'POST',
        headers: { ...this.authHeaders(accessToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: isVideo ? 'VIDEO' : 'IMAGE',
          name,
          key: key.toString('base64'),
          iv: iv.toString('base64'),
        }),
      },
    );

    const container = created.media?.[0]?.media ?? created;
    const mediaId = container.media_id ?? container.id;
    const addPath = container.add_path;
    const finalizePath = container.finalize_path;
    if (!mediaId || !addPath || !finalizePath) {
      throw new Error(
        `Snapchat media container response missing id/add_path/finalize_path: ${JSON.stringify(created).slice(0, 200)}`,
      );
    }

    for (let part = 0; part < partCount; part++) {
      const chunk = encrypted.subarray(part * CHUNK_SIZE, (part + 1) * CHUNK_SIZE);
      const form = new FormData();
      form.append('action', 'ADD');
      form.append('part_number', String(part + 1));
      form.append('file', new Blob([new Uint8Array(chunk)]), name);
      await this.uploadForm(this.apiUrl(addPath), form, accessToken);
    }

    const finalizeForm = new FormData();
    finalizeForm.append('action', 'FINALIZE');
    await this.uploadForm(this.apiUrl(finalizePath), finalizeForm, accessToken);

    return mediaId;
  }

  /** add_path/finalize_path come back relative ("/us/v1/...") or absolute. */
  private apiUrl(path: string): string {
    return /^https?:\/\//i.test(path) ? path : `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  private async uploadForm(url: string, form: FormData, accessToken: string): Promise<void> {
    const response = await this.fetchWithFile(url, form, this.authHeaders(accessToken));
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      this.logger.error({ url, status: response.status, text: text.slice(0, 300) }, 'Snapchat upload error');
      throw new Error(`snapchat API error (${response.status}): ${text.slice(0, 200)}`);
    }
    // Drain so the socket returns to the pool.
    await response.text().catch(() => {});
  }

  private async postStory(
    channel: ChannelData,
    profileId: string,
    mediaId: string,
  ): Promise<PublishResult> {
    const data = await this.fetchJson<Record<string, unknown>>(
      `${API_BASE}/v1/public_profiles/${encodeURIComponent(profileId)}/stories`,
      {
        method: 'POST',
        headers: { ...this.authHeaders(channel.accessToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ media_id: mediaId }),
      },
    );

    // The story response nests the created snap; fall back to the media id so
    // the post is never marked failed after Snap accepted it.
    const postId = findId(data, ['snap_id', 'story_id', 'id']) || mediaId;
    return { success: true, postId, url: this.profileUrl(channel) };
  }

  private async postSavedStory(
    channel: ChannelData,
    profileId: string,
    mediaId: string,
    post: PostData,
    settings: SnapchatPostSettings,
  ): Promise<PublishResult> {
    // Saved Story titles cap at 45 chars; fall back to the caption's first line.
    const title = (settings.title || post.content || 'Story')
      .split('\n')[0]
      .trim()
      .slice(0, 45) || 'Story';

    const data = await this.fetchJson<Record<string, unknown>>(
      `${API_BASE}/v1/public_profiles/${encodeURIComponent(profileId)}/saved_stories`,
      {
        method: 'POST',
        headers: { ...this.authHeaders(channel.accessToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          saved_stories: [{ title, snap_sources: [{ media_id: mediaId }] }],
        }),
      },
    );

    const postId = findId(data, ['saved_story_id', 'id']) || mediaId;
    return { success: true, postId, url: this.profileUrl(channel) };
  }

  private async postSpotlight(
    channel: ChannelData,
    profileId: string,
    mediaId: string,
    post: PostData,
    settings: SnapchatPostSettings,
  ): Promise<PublishResult> {
    // Spotlight descriptions cap at 160 chars — hashtags in it are clickable.
    const description = (post.content || '').trim().slice(0, 160);
    const body: Record<string, unknown> = {
      media_id: mediaId,
      locale: settings.locale || 'en_US',
    };
    if (description) body.description = description;
    if (settings.saveToProfile === false) body.skip_save_to_profile = true;

    const data = await this.fetchJson<Record<string, unknown>>(
      `${API_BASE}/v1/public_profiles/${encodeURIComponent(profileId)}/spotlights`,
      {
        method: 'POST',
        headers: { ...this.authHeaders(channel.accessToken), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    const postId = findId(data, ['spotlight_id', 'id']) || mediaId;
    return { success: true, postId, url: this.profileUrl(channel) };
  }

  private profileUrl(channel: ChannelData): string | undefined {
    const username = channel.metadata?.snapUserName;
    return typeof username === 'string' && username
      ? `https://www.snapchat.com/add/${encodeURIComponent(username)}`
      : undefined;
  }

  /**
   * Post metrics via snap stats, falling back to spotlight stats — a published
   * story stores a snap id, a Spotlight post stores a spotlight id, and the
   * metrics worker only has the id. Both calls are quiet: one of them is
   * expected to 404 for every post.
   */
  async getPostMetrics(
    channel: ChannelData,
    platformPostIds: string[],
    _opts?: PostMetricsOptions,
  ): Promise<Map<string, MetricsData>> {
    const results = new Map<string, MetricsData>();
    const profileId = channel.accountId;
    if (!channel.accessToken || !profileId) return results;

    for (const id of platformPostIds) {
      const urls = [
        `${API_BASE}/v1/snaps/${encodeURIComponent(id)}/stats`,
        `${API_BASE}/v1/public_profiles/${encodeURIComponent(profileId)}/spotlights/${encodeURIComponent(id)}/stats`,
        `${API_BASE}/v1/public_profiles/${encodeURIComponent(profileId)}/saved_stories/${encodeURIComponent(id)}/stats`,
      ];
      for (const url of urls) {
        try {
          const data = await this.fetchJson<Record<string, unknown>>(url, {
            headers: this.authHeaders(channel.accessToken),
          }, { quiet: true });
          const metrics = extractStats(data);
          if (metrics) {
            results.set(id, metrics);
            break;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // Expired/revoked token fails every remaining call identically —
          // rethrow so the sync worker logs the channel as auth-failed instead
          // of this channel silently reporting nothing forever.
          if (/\(401\)|\(403\)|unauthorized/i.test(message)) throw error;
          // Rate limited: stop hammering and keep what was already fetched.
          if (/\(429\)/.test(message)) {
            this.logger.warn(
              { channelId: channel.id, fetched: results.size, remaining: platformPostIds.length - results.size },
              'Snapchat rate limit during metrics fetch; returning partial results',
            );
            return results;
          }
          // 404 = wrong asset type for this id, expected — try the next
          // endpoint quietly. Anything else is a real failure worth a log
          // line, but still fall through to the next endpoint.
          if (!/\(404\)/.test(message)) {
            this.logger.warn({ channelId: channel.id, error: message }, 'Snapchat metrics fetch failed');
          }
        }
      }
    }
    return results;
  }

  async getAccountAnalytics(
    channel: ChannelData,
  ): Promise<{ followers?: number; impressions?: number; platformSpecific?: Record<string, number> } | null> {
    if (!channel.accessToken || !channel.accountId) return null;
    try {
      const data = await this.fetchJson<{
        public_profiles?: Array<{ public_profile?: SnapProfile }>;
        public_profile?: SnapProfile;
      }>(`${API_BASE}/v1/public_profiles/${encodeURIComponent(channel.accountId)}`, {
        headers: this.authHeaders(channel.accessToken),
      });
      const profile = data.public_profile ?? data.public_profiles?.[0]?.public_profile;
      if (!profile) return null;
      return {
        followers: typeof profile.subscriber_count === 'number' ? profile.subscriber_count : undefined,
      };
    } catch (error) {
      this.logger.warn({ error }, 'Snapchat account analytics fetch failed');
      return null;
    }
  }

  /**
   * The Public Profile API exposes aggregate counters only (REPLIES is a
   * number in /stats) — the reply/comment objects themselves are never
   * readable, so engagement is genuinely unsupported, not unimplemented.
   */
  async getPostEngagement(): Promise<EngagementData> {
    return {
      comments: [],
      reactions: [],
      unsupported: true,
      notice: 'Snapchat reports reply counts only. Its API does not expose individual comments.',
    };
  }

  private friendlyError(message: string): string {
    if (/\(401\)|unauthorized/i.test(message)) {
      return 'Snapchat access expired. Please reconnect the account.';
    }
    if (/\(403\)/.test(message)) {
      return 'Snapchat rejected the request. The public profile may not have API posting enabled.';
    }
    if (/\(429\)/.test(message)) {
      return 'Snapchat rate limit reached. This post will be retried.';
    }
    if (/media.*(process|transcode)/i.test(message)) {
      return 'Snapchat is still processing the media. Try again shortly.';
    }
    return message;
  }
}

interface SnapProfile {
  id?: string;
  display_name?: string;
  snap_user_name?: string;
  subscriber_count?: number;
  logo_urls?: Record<string, string>;
  profile_tier?: string;
}

function pickLogo(urls?: Record<string, string>): string | undefined {
  if (!urls) return undefined;
  const values = Object.values(urls).filter((u) => typeof u === 'string' && u);
  return values[0];
}

/** Depth-first search for the first matching id key in a nested response. */
function findId(data: unknown, keys: string[], depth = 0): string | undefined {
  if (!data || typeof data !== 'object' || depth > 4) return undefined;
  const obj = data as Record<string, unknown>;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v) return v;
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const found = findId(value, keys, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Snap stats responses key metrics by UPPER_SNAKE metric name (VIEWS,
 * VIEW_TIME_MILLIS, SHARES, ...), sometimes nested under timeseries/stats
 * wrappers. Collect every numeric metric found and map the known ones onto
 * our normalized fields.
 */
function extractStats(data: unknown): MetricsData | null {
  const found: Record<string, number> = {};
  collectNumericMetrics(data, found, 0);
  if (Object.keys(found).length === 0) return null;

  const metrics: MetricsData = { extra: {} };
  for (const [key, value] of Object.entries(found)) {
    switch (key) {
      case 'VIEWS':
      case 'STORY_VIEWS':
        metrics.impressions = (metrics.impressions ?? 0) + value;
        metrics.videoViews = (metrics.videoViews ?? 0) + value;
        break;
      case 'VIEWERS':
      case 'UNIQUE_VIEWERS':
        metrics.reach = (metrics.reach ?? 0) + value;
        break;
      case 'SHARES':
        metrics.shares = (metrics.shares ?? 0) + value;
        break;
      case 'REPLIES':
        metrics.comments = (metrics.comments ?? 0) + value;
        break;
      case 'FAVORITES':
        metrics.likes = (metrics.likes ?? 0) + value;
        break;
      case 'SWIPE_UPS':
        metrics.clicks = (metrics.clicks ?? 0) + value;
        break;
      default:
        metrics.extra![key] = value;
    }
  }
  return metrics;
}

function collectNumericMetrics(
  data: unknown,
  out: Record<string, number>,
  depth: number,
): void {
  if (!data || typeof data !== 'object' || depth > 6) return;
  if (Array.isArray(data)) {
    for (const item of data) collectNumericMetrics(item, out, depth + 1);
    return;
  }
  const obj = data as Record<string, unknown>;
  // { metric: "VIEWS", value: 123 } pair shape
  if (typeof obj.metric === 'string' && typeof obj.value === 'number') {
    out[obj.metric] = (out[obj.metric] ?? 0) + obj.value;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'number' && /^[A-Z][A-Z_]+$/.test(key)) {
      out[key] = (out[key] ?? 0) + value;
    } else if (value && typeof value === 'object') {
      collectNumericMetrics(value, out, depth + 1);
    }
  }
}
