import { PlatformHandler } from './base';
import { isReconnectError } from './auth-errors';
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
  MetricsData,
} from './types';

// Reddit uses two hosts: the public www host for the OAuth/token endpoints and a
// dedicated oauth.reddit.com host for all authenticated API calls.
const AUTH_BASE = 'https://www.reddit.com';
const API_BASE = 'https://oauth.reddit.com';

// Reddit requires a descriptive, unique User-Agent on EVERY request or it returns
// 429/403. Format: <platform>:<app id>:<version> (by /u/<reddit username>).
const USER_AGENT = 'web:openpublish:0.1 (self-hosted)';

/**
 * Infer an image mimetype from a URL's extension for Reddit's asset
 * registration. Poster derivatives are .webp; user uploads are usually
 * jpg/png. Reddit only uses this to build the S3 upload lease, so a
 * best-effort guess with a jpeg default is fine.
 */
function imageMimeFromUrl(url: string): string {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    default: return 'image/jpeg';
  }
}

const config: PlatformConfig = {
  name: 'reddit',
  displayName: 'Reddit',
  icon: 'reddit',
  color: '#FF4500',
  authType: 'oauth',
  postTypes: [
    {
      value: 'post',
      label: 'Post',
      description: 'Submit a text, link, image, or video post to a subreddit',
      maxMedia: 1,
      allowedMediaTypes: ['image', 'video'],
    },
  ],
  mediaRules: {
    image: { maxSizeMB: 20, formats: ['jpg', 'jpeg', 'png', 'gif'], maxCount: 1 },
    video: { maxSizeMB: 1024, formats: ['mp4', 'mov'], maxCount: 1 },
  },
};

/** Per-channel publish options the composer stores under platformSpecific[channel.id]. */
interface RedditPostSettings {
  subreddit?: string;
  title?: string;
  type?: string;
  url?: string;
  flairId?: string;
  thumbnailUrl?: string;
}

export class RedditHandler extends PlatformHandler {
  constructor() {
    super(config);
  }

  private getClientId(): string {
    const clientId = process.env.REDDIT_CLIENT_ID;
    if (!clientId) throw new Error('REDDIT_CLIENT_ID not configured');
    return clientId;
  }

  private getClientSecret(): string {
    const clientSecret = process.env.REDDIT_CLIENT_SECRET;
    if (!clientSecret) throw new Error('REDDIT_CLIENT_SECRET not configured');
    return clientSecret;
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
      response_type: 'code',
      state: state,
      redirect_uri: redirectUri,
      // duration=permanent is REQUIRED for Reddit to issue a refresh_token.
      duration: 'permanent',
      scope: 'read identity submit flair',
    });

    return `${AUTH_BASE}/api/v1/authorize?${params.toString()}`;
  }

  async exchangeCodeForToken(
    code: string,
    redirectUri: string,
  ): Promise<TokenData> {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri,
    });

    const tokenData = await this.fetchJson<{
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type: string;
    }>(`${AUTH_BASE}/api/v1/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: this.getBasicAuthHeader(),
        'User-Agent': USER_AGENT,
      },
      body: params.toString(),
    });

    return {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresIn: tokenData.expires_in,
    };
  }

  async getAccountInfo(accessToken: string): Promise<AccountInfo> {
    const data = await this.fetchJson<{
      id: string;
      name: string;
      icon_img?: string;
    }>(`${API_BASE}/api/v1/me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': USER_AGENT,
      },
    });

    return {
      id: data.id,
      name: data.name,
      // Reddit appends a signed query string to avatar URLs — strip it for a stable URL.
      profileImage: data.icon_img?.split('?')[0],
      accountType: undefined,
    };
  }

  async refreshToken(refreshTokenValue: string): Promise<TokenData | null> {
    try {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshTokenValue,
      });

      const tokenData = await this.fetchJson<{
        access_token: string;
        expires_in?: number;
        token_type: string;
      }>(`${AUTH_BASE}/api/v1/access_token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: this.getBasicAuthHeader(),
          'User-Agent': USER_AGENT,
        },
        body: params.toString(),
      });

      return {
        accessToken: tokenData.access_token,
        // Reddit does NOT rotate refresh tokens — keep reusing the same one.
        refreshToken: refreshTokenValue,
        expiresIn: tokenData.expires_in,
      };
    } catch (error) {
      this.logger.error({ error }, 'Failed to refresh Reddit token');
      return null;
    }
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
      'Reddit publish started',
    );

    if (!channel.accessToken) {
      return { success: false, error: 'No access token for Reddit account' };
    }

    // platformSpecific is keyed by channelId from the composer; fall back to the
    // flat object (e.g. API callers) and then to channel.metadata for the subreddit.
    const s = (post.platformSpecific?.[channel.id] ??
      post.platformSpecific ??
      {}) as RedditPostSettings;

    const subreddit = s.subreddit || (channel.metadata?.subreddit as string | undefined);
    if (!subreddit) {
      return { success: false, error: 'Reddit requires a target subreddit.' };
    }
    // Accept "r/foo", "/r/foo", or "foo" — normalize to a bare lowercase name.
    const sr = subreddit.replace(/^\/?r\//, '').toLowerCase();

    const title =
      s.title || post.content.split('\n')[0]?.slice(0, 300) || post.content.slice(0, 300);
    if (!title) {
      return { success: false, error: 'Reddit requires a post title.' };
    }

    try {
      const imageFile = post.mediaFiles.find((f) => f.mimeType.startsWith('image/'));
      const videoFile = post.mediaFiles.find((f) => f.mimeType.startsWith('video/'));

      // Determine the submission kind Reddit expects.
      let kind: 'image' | 'video' | 'link' | 'self';
      if (imageFile) kind = 'image';
      else if (videoFile) kind = 'video';
      else if (s.type === 'link' || s.url) kind = 'link';
      else kind = 'self';

      let mediaAssetUrl: string | undefined;
      let videoPosterUrl: string | undefined;

      if (kind === 'image' || kind === 'video') {
        // Reddit media posts accept exactly one asset.
        if (post.mediaFiles.length !== 1) {
          return {
            success: false,
            error: 'Reddit media posts require exactly one image or video file.',
          };
        }
        const mediaFile = (kind === 'image' ? imageFile : videoFile) as MediaFileData;
        mediaAssetUrl = await this.uploadAsset(channel.accessToken, mediaFile);

        if (kind === 'video') {
          // Reddit video submissions require a poster/thumbnail image.
          // Resolution order matches Pinterest video-pin covers: explicit
          // thumbnailUrl from platform options, then the video's
          // auto-extracted poster frame.
          const thumbnailUrl =
            s.thumbnailUrl ||
            (post.platformSpecific?.thumbnailUrl as string | undefined) ||
            videoFile?.posterUrl;
          if (!thumbnailUrl) {
            return {
              success: false,
              error:
                'Reddit video posts need a thumbnail image and no frame could be extracted from this video. Set a thumbnail in Reddit options and try again.',
            };
          }
          videoPosterUrl = await this.uploadAsset(channel.accessToken, {
            url: thumbnailUrl,
            localPath: thumbnailUrl,
            mimeType: imageMimeFromUrl(thumbnailUrl),
            sizeBytes: 0,
          });
        }
      }

      const body = new URLSearchParams({
        api_type: 'json',
        sr,
        title,
        kind,
        text: post.content,
        ...(kind === 'link' && s.url ? { url: s.url } : {}),
        ...(mediaAssetUrl ? { url: mediaAssetUrl } : {}),
        ...(videoPosterUrl ? { video_poster_url: videoPosterUrl } : {}),
        ...(s.flairId ? { flair_id: s.flairId } : {}),
      });

      const resp = await this.fetchJson<{
        json?: {
          errors?: unknown[];
          data?: { id?: string; url?: string; name?: string; websocket_url?: string };
        };
      }>(`${API_BASE}/api/submit`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${channel.accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
        body: body.toString(),
      });

      // Reddit returns HTTP 200 even when a submission rule fails — the real error
      // lives in json.errors as a non-empty array of [code, message, field] tuples.
      const errors = resp.json?.errors;
      if (Array.isArray(errors) && errors.length > 0) {
        return { success: false, error: JSON.stringify(errors[0]) };
      }

      const d = resp.json?.data;

      // Text/link self-posts get an id back immediately.
      if (d?.id) {
        const url = d.url || `https://www.reddit.com/r/${sr}/comments/${d.id}`;
        this.logger.info({ postId: d.id, url, sr }, 'Reddit post published');
        return { success: true, postId: d.id, url };
      }

      // Media (and crosspost) submits resolve asynchronously: Reddit returns a
      // websocket_url and pushes the final permalink over it. Confirm with a hard
      // timeout so a stuck socket never wedges a publish worker slot.
      if (d?.websocket_url && typeof globalThis.WebSocket !== 'undefined') {
        const resolvedId = await this.confirmViaWebSocket(d.websocket_url);
        if (resolvedId) {
          const url = `https://www.reddit.com/r/${sr}/comments/${resolvedId}`;
          this.logger.info({ postId: resolvedId, url, sr }, 'Reddit post published');
          return { success: true, postId: resolvedId, url };
        }
      }

      // No post id could be confirmed. Reddit may have accepted the submission,
      // but returning success with an empty id would seal a blank "published"
      // post (no link, no metrics, no first comment) with no recovery path — so
      // fail loudly instead, letting the worker surface/retry the outcome.
      this.logger.warn({ sr }, 'Reddit submit returned no confirmable post id');
      return {
        success: false,
        error:
          'Reddit accepted the submission but did not confirm a post id in time. It may still appear on the subreddit, so please verify before retrying.',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: message }, 'Failed to publish Reddit post');
      return {
        success: false,
        error: message,
        // Reuse the canonical reconnect classifier (word-boundary 401, invalid_grant,
        // etc.) instead of a loose substring match that could false-flag a healthy
        // channel off a stray "401" in an asset URL or content error.
        ...(isReconnectError(message) ? { authExpired: true } : {}),
      };
    }
  }

  /**
   * Wait for Reddit to push the final permalink over the submit websocket and
   * extract the post id from it. Resolves null on a 20s timeout or socket error
   * so a publish never hangs; the caller treats null as an unconfirmed submit.
   */
  private confirmViaWebSocket(wsUrl: string): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const ws = new globalThis.WebSocket(wsUrl);
      const timeout = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        resolve(null);
      }, 20000);

      const finish = (value: string | null) => {
        clearTimeout(timeout);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        resolve(value);
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const parsed = JSON.parse(String(event.data));
          const redirect: string | undefined = parsed?.payload?.redirect;
          if (redirect) {
            const onlyId = redirect.replace(
              /https:\/\/www\.reddit\.com\/r\/.*?\/comments\/(.*?)\/.*/,
              '$1',
            );
            finish(onlyId);
          }
        } catch {
          /* keep waiting for a parseable redirect message */
        }
      };
      ws.onerror = () => finish(null);
    });
  }

  /**
   * Upload a single media file to Reddit and return its hosted asset URL.
   *
   * Ports Postiz's uploadFileToReddit: register the asset (multipart) to get an
   * S3 form, fetch the media bytes, then POST every returned field + the file
   * (LAST) to the S3 action URL. The asset URL is in the <Location> tag of the
   * S3 XML response. Faithful to the Reddit flow + the Postiz reference — verify
   * against the live API before relying on it in production.
   */
  private async uploadAsset(
    accessToken: string,
    mediaFile: MediaFileData,
  ): Promise<string> {
    const filename = (mediaFile.localPath || mediaFile.url).split('/').pop() || 'upload';

    // 1. Register the asset to obtain the S3 upload action + fields.
    const registerForm = new FormData();
    registerForm.append('filepath', filename);
    registerForm.append('mimetype', mediaFile.mimeType || 'application/octet-stream');

    const registerResp = await this.fetchWithFile(`${API_BASE}/api/media/asset`, registerForm, {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': USER_AGENT,
    });
    if (!registerResp.ok) {
      throw new Error(`Reddit rejected the media registration (${registerResp.status}).`);
    }
    const registered = (await registerResp.json()) as {
      args: { action: string; fields: Array<{ name: string; value: string }> };
    };
    const { action, fields } = registered.args;

    // 2. Fetch the media bytes. The URL is usually our own storage, but video
    // posters can arrive as a user-supplied thumbnailUrl via platformSpecific —
    // always go through the SSRF-guarded fetch.
    const mediaResp = await this.fetchRemoteMedia(mediaFile.url);
    if (!mediaResp.ok) {
      throw new Error(`Could not read the media for upload (${mediaResp.status}).`);
    }
    const mediaBlob = await mediaResp.blob();

    // 3. POST the S3 form: every returned field first, then the file LAST.
    const uploadForm = new FormData();
    for (const field of fields) {
      uploadForm.append(field.name, field.value);
    }
    uploadForm.append('file', mediaBlob);

    const uploadResp = await fetch(`https:${action}`, { method: 'POST', body: uploadForm });
    if (!uploadResp.ok) {
      throw new Error(`Reddit rejected the media upload (${uploadResp.status}).`);
    }

    const uploadText = await uploadResp.text();
    const match = uploadText.match(/<Location>(.*?)<\/Location>/);
    if (!match) {
      throw new Error('Reddit did not return an upload location for the media.');
    }
    return match[1];
  }

  async publishComment(
    channel: ChannelData,
    platformPostId: string,
    comment: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!channel.accessToken) {
      return { success: false, error: 'No access token for Reddit account' };
    }

    try {
      // Reddit identifies posts by "thing" fullnames: a link is t3_<id>.
      const thingId = platformPostId.startsWith('t3_') ? platformPostId : `t3_${platformPostId}`;

      const body = new URLSearchParams({
        text: comment,
        thing_id: thingId,
        api_type: 'json',
      });

      const resp = await this.fetchJson<{
        json?: { errors?: unknown[]; data?: { things?: Array<{ data?: { id?: string } }> } };
      }>(`${API_BASE}/api/comment`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${channel.accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
        body: body.toString(),
      });

      const errors = resp.json?.errors;
      if (Array.isArray(errors) && errors.length > 0) {
        return { success: false, error: JSON.stringify(errors[0]) };
      }

      const commentId = resp.json?.data?.things?.[0]?.data?.id;
      if (commentId) return { success: true };
      return { success: false, error: 'Reddit did not return a comment id.' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: message }, 'Failed to publish Reddit comment');
      return { success: false, error: message };
    }
  }

  /**
   * Search public subreddits by name for the composer's subreddit picker.
   * Uses the same endpoint as the Postiz reference; needs the 'read' scope we hold.
   */
  async searchSubreddits(
    accessToken: string,
    query: string,
  ): Promise<Array<{ id: string; name: string }>> {
    if (!query.trim()) return [];
    const params = new URLSearchParams({
      q: query.trim(),
      show: 'public',
      sort: 'activity',
      show_users: 'false',
      limit: '10',
    });
    const data = await this.fetchJson<{
      data?: { children?: Array<{ data: { id: string; url: string; subreddit_type?: string } }> };
    }>(`${API_BASE}/subreddits/search?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': USER_AGENT },
    });
    return (data.data?.children || [])
      .filter((c) => c.data.subreddit_type === 'public')
      // url is like "/r/name/" — normalize to a bare subreddit name.
      .map((c) => ({ id: c.data.id, name: c.data.url.replace(/^\/?r\//, '').replace(/\/$/, '') }));
  }

  /**
   * List the available post flairs for a subreddit (composer flair picker).
   * Returns [] when the subreddit has no flairs or doesn't expose them.
   */
  async getFlairs(
    accessToken: string,
    subreddit: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const sr = subreddit.replace(/^\/?r\//, '').replace(/\/$/, '');
    if (!sr) return [];
    try {
      const flairs = await this.fetchJson<Array<{ id: string; text: string }>>(
        `${API_BASE}/r/${sr}/api/link_flair_v2`,
        { headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': USER_AGENT } },
        { quiet: true },
      );
      return (flairs || []).map((f) => ({ id: f.id, name: f.text }));
    } catch {
      return [];
    }
  }

  /**
   * A Reddit link (t3) reports `score`, `num_comments` and `num_crossposts` —
   * real likes/comments/shares figures, readable by the connected account from
   * `GET /api/info?id=t3_a,t3_b` (up to 100 fullnames per request). What Reddit
   * does NOT report through the data API is views: `view_count` exists as a
   * field but is null in practice (the author-facing "Post Insights" views are
   * a UI feature, not exposed via the API), so impressions are deliberately
   * not claimed — see RAW_METRIC_SUPPORT in metrics-support.ts.
   */
  async getPostMetrics(
    channel: ChannelData,
    platformPostIds: string[],
  ): Promise<Map<string, MetricsData>> {
    const results = new Map<string, MetricsData>();
    if (!channel.accessToken || platformPostIds.length === 0) return results;

    const headers = { Authorization: `Bearer ${channel.accessToken}`, 'User-Agent': USER_AGENT };

    for (let i = 0; i < platformPostIds.length; i += 100) {
      const batch = platformPostIds.slice(i, i + 100);
      // Stored ids may be bare base36 or t3_ fullnames; /api/info wants
      // fullnames. Map back to whichever form the caller stored.
      const storedByFullname = new Map(
        batch.map((id) => [id.startsWith('t3_') ? id : `t3_${id}`, id]),
      );

      try {
        const listing = await this.fetchJson<{
          data?: {
            children?: Array<{
              kind?: string;
              data?: {
                name?: string;
                score?: number;
                upvote_ratio?: number;
                num_comments?: number;
                num_crossposts?: number;
              };
            }>;
          };
        }>(
          `${API_BASE}/api/info?id=${[...storedByFullname.keys()].join(',')}&raw_json=1`,
          { headers },
        );

        for (const child of listing?.data?.children ?? []) {
          const d = child.data;
          if (child.kind !== 't3' || !d?.name) continue;
          const storedId = storedByFullname.get(d.name);
          if (!storedId) continue;
          results.set(storedId, {
            likes: d.score ?? 0,
            comments: d.num_comments ?? 0,
            shares: d.num_crossposts ?? 0,
            extra: {
              // 0–1 float from Reddit, stored as a whole percentage.
              upvoteRatioPct: Math.round((d.upvote_ratio ?? 0) * 100),
            },
          });
        }
      } catch (error) {
        this.logger.warn({ error, batch: batch.length }, 'Reddit metrics batch failed');
      }
    }

    return results;
  }

  /**
   * Reddit comments are public and come back as a nested listing from
   * `/comments/{article}`. `platformPostId` is the link's fullname (t3_xxx) or
   * the bare id — the endpoint wants the bare id.
   *
   * There is no per-user vote list on Reddit (votes are deliberately anonymous
   * and the API exposes only aggregate score), so this reports commenters and
   * sets `reactionsUnsupported` rather than showing a Reactors tab that can
   * never fill.
   */
  async getPostEngagement(
    channel: ChannelData,
    platformPostId: string,
    opts?: { commentsLimit?: number; reactionsLimit?: number },
  ): Promise<EngagementData> {
    if (!channel.accessToken) {
      return { comments: [], reactions: [], notice: 'No access token', commentsNotice: 'No access token' };
    }
    const limit = Math.min(opts?.commentsLimit ?? 25, 100);
    // The article id is the bare base36 — passing the t3_ fullname 404s.
    const article = platformPostId.replace(/^t3_/, '');

    type RedditComment = {
      kind?: string;
      data?: {
        id?: string;
        body?: string;
        author?: string;
        created_utc?: number;
        score?: number;
        parent_id?: string;
        // "" when there are no replies, a Listing when there are — Reddit does
        // not use null here, so this must be checked as an object.
        replies?: '' | { data?: { children?: RedditComment[] } };
      };
    };

    try {
      const listings = await this.fetchJson<Array<{ data?: { children?: RedditComment[] } }>>(
        // raw_json=1 stops Reddit HTML-escaping &, < and > inside comment bodies.
        `${API_BASE}/comments/${encodeURIComponent(article)}?limit=${limit}&depth=3&sort=top&raw_json=1`,
        { headers: { Authorization: `Bearer ${channel.accessToken}`, 'User-Agent': USER_AGENT } },
      );

      // [0] is the link itself, [1] the comment tree.
      const roots = listings?.[1]?.data?.children ?? [];
      const comments: EngagementComment[] = [];
      let truncated = false;

      const walk = (nodes: RedditComment[]) => {
        for (const node of nodes) {
          // "more" nodes are Reddit's "load N more comments" placeholders, not
          // comments — counting them would inflate the total shown in the UI.
          if (node.kind === 'more') {
            truncated = true;
            continue;
          }
          const d = node.data;
          if (node.kind !== 't1' || !d?.id) continue;
          const id = d.id;
          if (comments.length >= limit) {
            truncated = true;
            return;
          }

          const author = d.author && d.author !== '[deleted]' ? d.author : null;
          // parent_id is t3_<link> for a top-level comment and t1_<comment> for
          // a reply; only the latter is a parent within this list.
          const parent = d.parent_id?.startsWith('t1_') ? d.parent_id.slice(3) : undefined;

          comments.push({
            id,
            text: d.body ?? '',
            createdAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : undefined,
            likeCount: typeof d.score === 'number' ? d.score : undefined,
            parentId: parent,
            actor: {
              id: author ?? `deleted-${id}`,
              name: author ? `u/${author}` : '[deleted]',
              handle: author ?? undefined,
              profileUrl: author ? `https://www.reddit.com/user/${author}` : undefined,
            },
          });

          const replies = d.replies;
          if (replies && typeof replies === 'object') {
            walk(replies.data?.children ?? []);
          }
        }
      };
      walk(roots);

      return {
        comments,
        reactions: [],
        hasMoreComments: truncated,
        reactionsUnsupported: true,
        notice: 'Reddit keeps votes anonymous, so only commenters are available.',
      };
    } catch (error) {
      this.logger.warn({ error, platformPostId }, 'Reddit engagement fetch failed');
      return { comments: [], reactions: [], reactionsUnsupported: true, notice: 'Comments unavailable', commentsNotice: 'Comments unavailable' };
    }
  }
}
