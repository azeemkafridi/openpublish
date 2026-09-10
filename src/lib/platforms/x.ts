import { randomBytes, createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { PlatformHandler } from './base';
import type {
  TokenData,
  AccountInfo,
  PublishResult,
  PostData,
  ChannelData,
  PlatformConfig,
  ThreadPublishResult,
  MetricsData,
  EngagementData,
  EngagementOptions,
  EngagementComment,
  EngagementReaction,
} from './types';
import { bareHandle } from './profile-urls';
import {
  X_API_COSTS_DCENTS,
  type XApiAction,
  trackXApiCall,
  checkXBudget,
  checkXReadBudget,
  detectUrlInContent,
  formatDcentsAsDollars,
  isXLiveApiDisabled,
  X_DISABLED_MESSAGE,
} from './x-usage';
import { getOrgPlan } from '../quotas/check';

const API_BASE = 'https://api.x.com/2';
// v2 media upload (replaces the retired v1.1 upload.twitter.com/1.1/media/upload.json).
// Same endpoint handles one-shot (small image) and chunked (INIT/APPEND/FINALIZE/STATUS).
const MEDIA_UPLOAD_URL = 'https://api.x.com/2/media/upload';

// In-memory store for PKCE code verifiers keyed by OAuth state
const codeVerifiers = new Map<string, string>();

const config: PlatformConfig = {
  name: 'x',
  displayName: 'X',
  icon: 'x',
  color: '#000000',
  authType: 'oauth',
  postTypes: [
    {
      value: 'tweet',
      label: 'Tweet',
      description: 'Post a tweet with optional media',
      maxMedia: 4,
      allowedMediaTypes: ['image', 'video'],
    },
  ],
  mediaRules: {
    image: {
      maxSizeMB: 5,
      formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
      maxCount: 4,
    },
    video: {
      maxSizeMB: 512,
      formats: ['mp4', 'mov'],
      maxCount: 1,
      maxDurationSec: 140,
    },
  },
};

/** Per-call cost-tracking context, set by withCostContext() before a billable fetchJson. */
interface CostContext {
  orgId: number;
  action: XApiAction;
  /**
   * For read actions, override how cost is computed: cost = unit × (count of resources in response).
   * The override receives the parsed response body and returns the multiplier.
   */
  resourceCountFromResponse?: (data: unknown) => number;
  /** For writes: the precomputed cost in dcents. */
  costDcentsOverride?: number;
}

/** v2 media-upload async processing state (returned under `data.processing_info`). */
interface XProcessingInfo {
  state: string;
  check_after_secs?: number;
  error?: { message?: string };
}

/** Minimal shape of a v2 media-upload response body. */
interface XMediaResponse {
  data?: { id?: string; processing_info?: XProcessingInfo };
}

export class XHandler extends PlatformHandler {
  /**
   * Billing context for the call in flight, scoped to the async chain that
   * opened it. The registry holds ONE XHandler per process, so an instance
   * field here leaked: a token refresh or account lookup that ran while some
   * other org's tweet was awaiting its response read that org's context and
   * was billed to it as a second tweet.
   */
  private readonly costContext = new AsyncLocalStorage<CostContext>();

  constructor() {
    super(config);
  }

  /**
   * Wrap a billable API call so it gets cost-tracked after success.
   * The override of fetchJson() reads the context set here.
   */
  private withCostContext<T>(ctx: CostContext, fn: () => Promise<T>): Promise<T> {
    return this.costContext.run(ctx, fn);
  }

  /**
   * Pre-call gate for write actions. Returns null if allowed, or a user-facing error message if blocked.
   *
   * Allowed when `(plan_limit - monthly_used) + credit_balance >= cost`. Plan budget is
   * consumed first; credits cover overage. Free-plan users (limit=0) can still publish if
   * they have credits.
   */
  private async ensureBudget(orgId: number | undefined, estimatedCostDcents: number): Promise<string | null> {
    if (isXLiveApiDisabled()) return X_DISABLED_MESSAGE; // global kill switch — block all writes
    if (!orgId) return null; // legacy callers without org context — don't gate
    const plan = await getOrgPlan(orgId);
    const status = await checkXBudget(orgId, plan, estimatedCostDcents);
    if (status.allowed) return null;

    const totalAvailable = formatDcentsAsDollars(status.totalAvailableDcents);
    const cost = formatDcentsAsDollars(estimatedCostDcents);
    const resetDate = new Date(status.resetsAt).toISOString().slice(0, 10);

    if (status.limitDcents === 0 && status.creditDcents === 0) {
      return 'X publishing requires either a paid plan or X API credits. Top up credits in the developer settings to enable X publishing.';
    }
    return `X API budget exhausted: this call needs ${cost} but only ${totalAvailable} is available (plan resets ${resetDate}). Top up credits or wait for the monthly reset.`;
  }

  /**
   * Read-side gate. Metered reads (metrics/analytics/user-search) draw from
   * the same monthly X budget as writes — no separate read quota — and are
   * unavailable on the free plan entirely. Returns false when the budget
   * declines; callers skip the read and degrade gracefully.
   */
  private async ensureReadBudget(
    orgId: number | undefined,
    estimatedCostDcents = 0,
  ): Promise<boolean> {
    if (isXLiveApiDisabled()) return false; // global kill switch — skip all metered reads
    if (!orgId) return true;
    const plan = await getOrgPlan(orgId);
    return checkXReadBudget(orgId, plan, estimatedCostDcents);
  }

  protected override async fetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
    const ctx = this.costContext.getStore();
    const data = await super.fetchJson<T>(url, options);

    if (ctx && ctx.orgId) {
      try {
        const unit = X_API_COSTS_DCENTS[ctx.action];
        let cost: number;
        let count = 1;
        if (ctx.costDcentsOverride !== undefined) {
          cost = ctx.costDcentsOverride;
        } else if (ctx.resourceCountFromResponse) {
          count = Math.max(0, ctx.resourceCountFromResponse(data));
          cost = unit * count;
        } else {
          cost = unit;
        }
        if (cost > 0) trackXApiCall(ctx.orgId, ctx.action, cost, count);
      } catch (err) {
        this.logger.warn({ err }, 'X cost tracking failed');
      }
    }
    return data;
  }

  private getClientId(): string {
    const clientId = process.env.X_CLIENT_ID;
    if (!clientId) throw new Error('X_CLIENT_ID not configured');
    return clientId;
  }

  private getClientSecret(): string {
    const clientSecret = process.env.X_CLIENT_SECRET;
    if (!clientSecret) throw new Error('X_CLIENT_SECRET not configured');
    return clientSecret;
  }

  private getBasicAuthHeader(): string {
    const clientId = this.getClientId();
    const clientSecret = this.getClientSecret();
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    return `Basic ${credentials}`;
  }

  async getOAuthUrl(redirectUri: string, state: string): Promise<string> {
    const clientId = this.getClientId();

    // Generate PKCE code verifier and challenge
    const codeVerifier = randomBytes(32).toString('hex');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    // Store verifier keyed by state for later retrieval (auto-expire after 10 min)
    codeVerifiers.set(state, codeVerifier);
    setTimeout(() => codeVerifiers.delete(state), 10 * 60 * 1000);

    // media.write is required for the v2 media upload endpoint. Accounts connected before this
    // scope was added must reconnect to obtain a token that can upload media.
    const scopes = 'tweet.read tweet.write users.read media.write offline.access';

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes,
      state: state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return `https://x.com/i/oauth2/authorize?${params.toString()}`;
  }

  async exchangeCodeForToken(
    code: string,
    redirectUri: string,
    state?: string,
  ): Promise<TokenData> {
    // Look up the PKCE verifier by the matching state (stored keyed by state in getAuthUrl).
    // Taking the first map entry would break two overlapping X connects (multi-tenant!) by
    // consuming the wrong — or another user's — verifier, failing both token exchanges.
    let codeVerifier: string | undefined;
    if (state) {
      codeVerifier = codeVerifiers.get(state);
      codeVerifiers.delete(state);
    }

    if (!codeVerifier) {
      throw new Error('No PKCE code verifier found. OAuth flow may have expired.');
    }

    const params = new URLSearchParams({
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });

    const tokenData = await this.fetchJson<{
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type: string;
    }>('https://api.x.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: this.getBasicAuthHeader(),
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
      data: {
        id: string;
        name: string;
        username: string;
        profile_image_url?: string;
      };
    }>(`${API_BASE}/users/me?user.fields=profile_image_url`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    return {
      id: data.data.id,
      name: data.data.username,
      profileImage: data.data.profile_image_url,
      accountType: 'user',
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
      'X publish started',
    );

    if (!channel.accessToken) {
      return { success: false, error: 'No access token for X account' };
    }

    const mediaFiles = post.mediaFiles;

    // Estimate cost for budget pre-check: 1 tweet (15 or 200 dcents) + 5 dcents per media upload.
    const tweetAction: XApiAction = detectUrlInContent(post.content) ? 'tweet_create_with_url' : 'tweet_create';
    const estimatedDcents = X_API_COSTS_DCENTS[tweetAction] + mediaFiles.length * X_API_COSTS_DCENTS.media_simple_upload;
    const budgetError = await this.ensureBudget(channel.organizationId, estimatedDcents);
    if (budgetError) {
      return { success: false, error: budgetError };
    }

    // Validate media constraints
    const images = mediaFiles.filter((f) => f.mimeType.startsWith('image/'));
    const videos = mediaFiles.filter((f) => f.mimeType.startsWith('video/'));

    if (images.length > 0 && videos.length > 0) {
      return {
        success: false,
        error: "X doesn't support mixing images and videos in a single tweet.",
      };
    }

    if (images.length > 4) {
      return {
        success: false,
        error: 'X allows a maximum of 4 images per tweet.',
      };
    }

    if (videos.length > 1) {
      return {
        success: false,
        error: 'X allows a maximum of 1 video per tweet.',
      };
    }

    // Upload media if present
    const mediaIds: string[] = [];
    for (const file of mediaFiles) {
      try {
        const isVideo = file.mimeType.startsWith('video/');
        const isLarge = file.sizeBytes > 5 * 1024 * 1024; // >5 MB
        let mediaId: string;

        if (isVideo || isLarge) {
          mediaId = await this.chunkedUpload(file.localPath, file.mimeType, file.sizeBytes, channel.accessToken, channel.organizationId);
        } else {
          mediaId = await this.simpleUpload(file.localPath, channel.accessToken, channel.organizationId);
        }
        await this.applyAltText(mediaId, file, channel.accessToken);

        mediaIds.push(mediaId);
        this.logger.debug({ mediaId, mimeType: file.mimeType }, 'Media uploaded to X');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error({ error: message }, 'Failed to upload media to X');
        return { success: false, error: `Failed to upload media: ${message}` };
      }
    }

    // Build tweet payload
    const tweetPayload: Record<string, unknown> = {
      text: post.content,
    };

    if (mediaIds.length > 0) {
      tweetPayload.media = {
        media_ids: mediaIds,
      };
    }

    // The publish worker passes the per-platform slice (post.platformSpecific?.[platform]),
    // so this handler receives { replySettings, ... } directly. Older call sites / tests pass
    // the full { x: {...} } object — accept both shapes (mirrors the TikTok handler).
    const xOpts = (post.platformSpecific?.x ?? post.platformSpecific) as Record<string, unknown> | undefined;
    const replySettings = xOpts?.replySettings as string | undefined;
    if (replySettings && replySettings !== 'everyone') {
      tweetPayload.reply_settings = replySettings;
    }

    try {
      const result = await this.withCostContext(
        { orgId: channel.organizationId ?? 0, action: tweetAction },
        () => this.fetchJson<{
          data: {
            id: string;
            text: string;
          };
        }>(`${API_BASE}/tweets`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${channel.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(tweetPayload),
        }),
      );

      const tweetId = result.data.id;
      const tweetUrl = `https://x.com/${bareHandle(channel.accountName)}/status/${tweetId}`;

      this.logger.info(
        { tweetId, url: tweetUrl },
        'Tweet published successfully',
      );

      return {
        success: true,
        postId: tweetId,
        url: tweetUrl,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: message }, 'Failed to publish tweet');
      return { success: false, error: message };
    }
  }

  async publishThread(
    segments: Array<PostData & { sequence: number }>,
    channel: ChannelData,
    alreadyPosted?: ThreadPublishResult['posts'],
  ): Promise<ThreadPublishResult> {
    this.logger.info(
      { accountId: channel.accountId, segmentCount: segments.length },
      'X thread publish started',
    );

    if (!channel.accessToken) {
      return { success: false, error: 'No access token for X account' };
    }

    // On a retry of a partially-posted thread, skip the segments already live and resume the
    // reply chain from the last one — otherwise the head segments get duplicated.
    const remaining = alreadyPosted?.length ? segments.slice(alreadyPosted.length) : segments;

    // Estimate cost for the remaining segments up-front so we don't half-publish into a budget wall.
    let estimatedDcents = 0;
    for (const segment of remaining) {
      const action: XApiAction = detectUrlInContent(segment.content) ? 'thread_segment_with_url' : 'thread_segment_create';
      estimatedDcents += X_API_COSTS_DCENTS[action];
      estimatedDcents += segment.mediaFiles.length * X_API_COSTS_DCENTS.media_simple_upload;
    }
    const budgetError = await this.ensureBudget(channel.organizationId, estimatedDcents);
    if (budgetError) {
      return { success: false, error: budgetError };
    }

    const publishedPosts: ThreadPublishResult['posts'] = alreadyPosted?.length ? [...alreadyPosted] : [];
    let replyToId: string | undefined = alreadyPosted?.length ? alreadyPosted[alreadyPosted.length - 1].postId : undefined;

    for (const segment of remaining) {
      // Upload media for this segment
      const mediaIds: string[] = [];
      for (const file of segment.mediaFiles) {
        try {
          const isVideo = file.mimeType.startsWith('video/');
          const isLarge = file.sizeBytes > 5 * 1024 * 1024;
          const mediaId = isVideo || isLarge
            ? await this.chunkedUpload(file.localPath, file.mimeType, file.sizeBytes, channel.accessToken, channel.organizationId)
            : await this.simpleUpload(file.localPath, channel.accessToken, channel.organizationId);
          await this.applyAltText(mediaId, file, channel.accessToken);
          mediaIds.push(mediaId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { success: false, error: `Failed to upload media for part ${segment.sequence + 1}: ${message}` };
        }
      }

      // Build tweet payload
      const tweetPayload: Record<string, unknown> = { text: segment.content };
      if (mediaIds.length > 0) {
        tweetPayload.media = { media_ids: mediaIds };
      }
      if (replyToId) {
        tweetPayload.reply = { in_reply_to_tweet_id: replyToId };
      }

      try {
        const segmentAction: XApiAction = detectUrlInContent(segment.content)
          ? 'thread_segment_with_url'
          : 'thread_segment_create';
        const result = await this.withCostContext(
          { orgId: channel.organizationId ?? 0, action: segmentAction },
          () => this.fetchJson<{ data: { id: string; text: string } }>(
            `${API_BASE}/tweets`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${channel.accessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(tweetPayload),
            },
          ),
        );

        const tweetId = result.data.id;
        const tweetUrl = `https://x.com/${bareHandle(channel.accountName)}/status/${tweetId}`;

        publishedPosts!.push({
          sequence: segment.sequence,
          postId: tweetId,
          url: tweetUrl,
          parentId: replyToId,
        });

        replyToId = tweetId;
        this.logger.debug({ tweetId, sequence: segment.sequence }, 'Thread tweet published');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error({ error: message, sequence: segment.sequence }, 'Thread tweet failed');
        return { success: false, posts: publishedPosts, error: `Part ${segment.sequence + 1} failed: ${message}` };
      }
    }

    this.logger.info({ count: publishedPosts!.length }, 'X thread published successfully');
    return { success: true, posts: publishedPosts };
  }

  async getPostMetrics(
    channel: ChannelData,
    platformPostIds: string[],
  ): Promise<Map<string, MetricsData>> {
    const results = new Map<string, MetricsData>();
    if (!channel.accessToken || platformPostIds.length === 0) return results;
    if (!(await this.ensureReadBudget(channel.organizationId, X_API_COSTS_DCENTS.post_read))) {
      this.logger.warn({ orgId: channel.organizationId }, 'X read budget exhausted — skipping post metrics');
      return results;
    }

    // X API allows up to 100 tweet IDs per request
    const batchSize = 100;
    for (let i = 0; i < platformPostIds.length; i += batchSize) {
      const batch = platformPostIds.slice(i, i + batchSize);
      const ids = batch.join(',');

      try {
        const data = await this.withCostContext(
          {
            orgId: channel.organizationId ?? 0,
            action: 'post_read',
            resourceCountFromResponse: (d) => {
              const arr = (d as { data?: unknown[] } | null)?.data;
              return Array.isArray(arr) ? arr.length : 0;
            },
          },
          () => this.fetchJson<{
            data?: Array<{
              id: string;
              public_metrics?: {
                impression_count?: number;
                like_count?: number;
                retweet_count?: number;
                reply_count?: number;
                quote_count?: number;
                bookmark_count?: number;
              };
            }>;
          }>(`${API_BASE}/tweets?ids=${ids}&tweet.fields=public_metrics`, {
            headers: { Authorization: `Bearer ${channel.accessToken}` },
          }),
        );

        if (data.data) {
          for (const tweet of data.data) {
            const m = tweet.public_metrics;
            if (!m) continue;
            results.set(tweet.id, {
              impressions: m.impression_count ?? 0,
              likes: m.like_count ?? 0,
              shares: m.retweet_count ?? 0,
              comments: m.reply_count ?? 0,
              // public_metrics.bookmark_count is X's save figure — same read,
              // no extra cost. Quotes stay in extra: retweet_count excludes
              // them, and folding them into shares would double-count against
              // how X itself splits the two.
              saves: m.bookmark_count ?? 0,
              extra: {
                quotes: m.quote_count ?? 0,
              },
            });
          }
        }
      } catch (error) {
        this.logger.warn({ error, batch: ids.slice(0, 50) }, 'Failed to fetch X metrics batch');
      }
    }

    return results;
  }

  async searchUsers(
    channel: ChannelData,
    query: string,
  ): Promise<Array<{ id: string; handle: string; name: string; profileImage?: string }>> {
    if (!channel.accessToken || !query) return [];
    if (!(await this.ensureReadBudget(channel.organizationId, X_API_COSTS_DCENTS.user_search))) {
      this.logger.warn({ orgId: channel.organizationId }, 'X read budget exhausted — skipping user search');
      return [];
    }

    try {
      const params = new URLSearchParams({
        query,
        max_results: '5',
        'user.fields': 'name,username,profile_image_url',
      });

      const data = await this.withCostContext(
        {
          orgId: channel.organizationId ?? 0,
          action: 'user_search',
          resourceCountFromResponse: (d) => {
            const arr = (d as { data?: unknown[] } | null)?.data;
            return Array.isArray(arr) ? arr.length : 0;
          },
        },
        () => this.fetchJson<{
          data?: Array<{
            id: string;
            name: string;
            username: string;
            profile_image_url?: string;
          }>;
        }>(`${API_BASE}/users/search?${params.toString()}`, {
          headers: {
            Authorization: `Bearer ${channel.accessToken}`,
          },
        }),
      );

      if (!data.data) return [];

      return data.data.map((user) => ({
        id: user.id,
        handle: `@${user.username}`,
        name: user.name,
        profileImage: user.profile_image_url,
      }));
    } catch (error) {
      this.logger.warn({ error, query }, 'Failed to search X users');
      return [];
    }
  }

  async refreshToken(refreshTokenValue: string): Promise<TokenData | null> {
    try {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshTokenValue,
      });

      const tokenData = await this.fetchJson<{
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        token_type: string;
      }>('https://api.x.com/2/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: this.getBasicAuthHeader(),
        },
        body: params.toString(),
      });

      return {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresIn: tokenData.expires_in,
      };
    } catch (error) {
      this.logger.error({ error }, 'Failed to refresh X token');
      // A 5xx, 429 or network failure says nothing about the refresh token;
      // returning null for it read as "cannot be refreshed" and flagged
      // reconnect after one blip. Only a rejection returns null.
      if (this.isTransientRefreshFailure(error)) throw error;
      return null;
    }
  }

  /**
   * Parse a v2 media-upload response defensively. The retired v1.1 endpoint could return an
   * empty body, which made `response.json()` throw the opaque "Unexpected end of JSON input";
   * here we read text first and surface the real HTTP status + error detail.
   */
  private async parseMediaResponse(res: Response, step: string): Promise<XMediaResponse> {
    const text = await res.text();
    let body: (XMediaResponse & { detail?: string; title?: string; errors?: Array<{ message?: string }> }) | null = null;
    if (text) {
      try { body = JSON.parse(text); } catch { /* non-JSON (e.g. HTML error page) */ }
    }
    if (!res.ok) {
      const detail =
        body?.detail ||
        body?.title ||
        body?.errors?.map((e) => e.message).filter(Boolean).join(', ') ||
        (text ? text.slice(0, 200) : `HTTP ${res.status}`);
      throw new Error(`X media ${step} failed (HTTP ${res.status}): ${detail}`);
    }
    if (!body) {
      throw new Error(`X media ${step} returned an empty/non-JSON response (HTTP ${res.status})`);
    }
    return body;
  }

  /** POST a multipart form to the v2 media endpoint with an abort timeout. */
  private async postMediaForm(
    form: FormData,
    accessToken: string,
    step: string,
    timeoutMs = 2 * 60 * 1000,
  ): Promise<XMediaResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // No explicit Content-Type — fetch derives multipart/form-data with the boundary itself.
      const res = await fetch(MEDIA_UPLOAD_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: form,
        signal: controller.signal,
      });
      return await this.parseMediaResponse(res, step);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Attach the library alt text to an uploaded image (v2 POST /2/media/metadata).
   * Images only — X has no alt text on video — and best-effort: a post without
   * its alt text is still the post the user wrote, so a metadata failure is
   * logged rather than failing the publish. Was never sent at all before, while
   * every other platform that supports alt text applied it.
   */
  private async applyAltText(mediaId: string, file: MediaFileData, accessToken: string): Promise<void> {
    const text = file.altText?.trim();
    if (!text || file.mimeType.startsWith('video/')) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${API_BASE}/media/metadata`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        // X caps alt text at 1000 characters.
        body: JSON.stringify({ id: mediaId, metadata: { alt_text: { text: text.slice(0, 1000) } } }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        this.logger.warn({ mediaId, status: res.status, body: errText.slice(0, 200) }, 'X alt text was not applied');
      }
    } catch (err) {
      this.logger.warn({ err, mediaId }, 'X alt text was not applied');
    } finally {
      clearTimeout(timer);
    }
  }

  /** One-shot upload for images under 5 MB (v2 POST /2/media/upload). */
  private async simpleUpload(
    localPath: string,
    accessToken: string,
    orgId?: number,
  ): Promise<string> {
    const fileBuffer = readFileSync(localPath);

    const form = new FormData();
    form.append('media', new Blob([fileBuffer]), 'media');
    form.append('media_category', 'tweet_image');

    const data = await this.postMediaForm(form, accessToken, 'upload');
    const mediaId = data.data?.id;
    if (!mediaId) {
      throw new Error('Media upload failed: response contained no media id');
    }

    if (orgId) {
      trackXApiCall(orgId, 'media_simple_upload', X_API_COSTS_DCENTS.media_simple_upload);
    }
    return mediaId;
  }

  /** Chunked upload for video and large files (v2 INIT → APPEND → FINALIZE → STATUS). */
  private async chunkedUpload(
    localPath: string,
    mimeType: string,
    totalBytes: number,
    accessToken: string,
    orgId?: number,
  ): Promise<string> {
    const mediaCategory = mimeType.startsWith('video/') ? 'tweet_video' : 'tweet_image';
    const UPLOAD_TIMEOUT = 2 * 60 * 1000;

    // The DB-recorded size is a hint; the file on disk is the truth. A mismatch
    // would make INIT's total_bytes disagree with what APPEND actually sends.
    try {
      totalBytes = statSync(localPath).size;
    } catch {
      /* keep the caller-provided size (tests / legacy paths) */
    }

    // INIT
    const initForm = new FormData();
    initForm.append('command', 'INIT');
    initForm.append('media_type', mimeType);
    initForm.append('total_bytes', String(totalBytes));
    initForm.append('media_category', mediaCategory);

    const initData = await this.postMediaForm(initForm, accessToken, 'INIT', UPLOAD_TIMEOUT);
    const mediaId = initData.data?.id;
    if (!mediaId) {
      throw new Error('Chunked upload INIT failed: response contained no media id');
    }
    this.logger.debug({ mediaId }, 'Chunked upload INIT complete');

    if (orgId) {
      trackXApiCall(orgId, 'media_chunked_init', X_API_COSTS_DCENTS.media_chunked_init);
    }

    // APPEND — send file in 5 MB chunks as raw binary in the `media` field (v2; v1.1 used base64).
    // Read each chunk from disk with fs.readSync (same pattern as LinkedIn's
    // ranged upload) — readFileSync here held an entire 512MB video in heap
    // just to slice 5MB windows off it.
    const CHUNK_SIZE = 5 * 1024 * 1024;
    let segmentIndex = 0;
    const fd = openSync(localPath, 'r');
    try {
      for (let offset = 0; offset < totalBytes; offset += CHUNK_SIZE) {
        const chunkSize = Math.min(CHUNK_SIZE, totalBytes - offset);
        const chunk = Buffer.alloc(chunkSize);
        readSync(fd, chunk, 0, chunkSize, offset);

        const appendForm = new FormData();
        appendForm.append('command', 'APPEND');
        appendForm.append('media_id', mediaId);
        appendForm.append('segment_index', String(segmentIndex));
        appendForm.append('media', new Blob([chunk]), `chunk_${segmentIndex}`);

        // APPEND returns 2xx with no useful body; only check for failure.
        const appendController = new AbortController();
        const appendTimer = setTimeout(() => appendController.abort(), UPLOAD_TIMEOUT);
        try {
          const appendRes = await fetch(MEDIA_UPLOAD_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}` },
            body: appendForm,
            signal: appendController.signal,
          });
          if (!appendRes.ok) {
            const errText = await appendRes.text();
            throw new Error(`Chunked upload APPEND failed (segment ${segmentIndex}, HTTP ${appendRes.status}): ${errText.slice(0, 200)}`);
          }
        } finally {
          clearTimeout(appendTimer);
        }

        segmentIndex++;
      }
    } finally {
      closeSync(fd);
    }

    this.logger.debug({ mediaId, segments: segmentIndex }, 'Chunked upload APPEND complete');

    // FINALIZE
    const finalizeForm = new FormData();
    finalizeForm.append('command', 'FINALIZE');
    finalizeForm.append('media_id', mediaId);

    const finalizeData = await this.postMediaForm(finalizeForm, accessToken, 'FINALIZE', UPLOAD_TIMEOUT);

    // STATUS — poll for async video processing if the server reports it's still processing
    const processingInfo = finalizeData.data?.processing_info;
    if (processingInfo) {
      await this.pollUploadStatus(mediaId, processingInfo, accessToken);
    }

    this.logger.debug({ mediaId }, 'Chunked upload complete');
    return mediaId;
  }

  async getAccountAnalytics(
    channel: ChannelData,
  ): Promise<{ followers?: number; following?: number; impressions?: number; reach?: number; profileViews?: number; websiteClicks?: number; platformSpecific?: Record<string, number> } | null> {
    if (!channel.accessToken) return null;
    if (!(await this.ensureReadBudget(channel.organizationId, X_API_COSTS_DCENTS.user_read))) {
      this.logger.warn({ orgId: channel.organizationId }, 'X read budget exhausted — skipping account analytics');
      return null;
    }

    try {
      const data = await this.withCostContext(
        { orgId: channel.organizationId ?? 0, action: 'user_read' },
        () => this.fetchJson<{
          data: {
            id: string;
            public_metrics?: {
              followers_count?: number;
              following_count?: number;
              tweet_count?: number;
              listed_count?: number;
            };
          };
        }>(`${API_BASE}/users/${channel.accountId}?user.fields=public_metrics`, {
          headers: {
            Authorization: `Bearer ${channel.accessToken}`,
          },
        }),
      );

      const m = data.data.public_metrics;
      if (!m) return null;

      return {
        followers: m.followers_count,
        following: m.following_count,
        platformSpecific: {
          ...(m.tweet_count != null ? { tweetCount: m.tweet_count } : {}),
          ...(m.listed_count != null ? { listedCount: m.listed_count } : {}),
        },
      };
    } catch (error) {
      this.logger.warn({ error }, 'Failed to fetch X account analytics');
      return null;
    }
  }

  async publishComment(
    channel: ChannelData,
    platformPostId: string,
    comment: string,
  ): Promise<{ success: boolean; error?: string }> {
    // A reply hits the same POST /tweets Content-Create endpoint, so a reply containing a URL
    // bills at the with-URL rate ($0.200) exactly like a top-level tweet. The auto-plug feature
    // (metrics-sync) posts link-bearing replies, so this path regularly carries URLs.
    const commentAction: XApiAction = detectUrlInContent(comment) ? 'comment_create_with_url' : 'comment_create';
    const budgetError = await this.ensureBudget(channel.organizationId, X_API_COSTS_DCENTS[commentAction]);
    if (budgetError) return { success: false, error: budgetError };

    try {
      const result = await this.withCostContext(
        { orgId: channel.organizationId ?? 0, action: commentAction },
        () => this.fetchJson<{ data?: { id: string } }>(
          `${API_BASE}/tweets`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${channel.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              text: comment,
              reply: { in_reply_to_tweet_id: platformPostId },
            }),
          },
        ),
      );
      if (!result.data?.id) return { success: false, error: 'Failed to create reply' };
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async repost(
    channel: ChannelData,
    platformPostId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const budgetError = await this.ensureBudget(channel.organizationId, X_API_COSTS_DCENTS.repost);
    if (budgetError) return { success: false, error: budgetError };

    try {
      const userId = channel.accountId;
      await this.withCostContext(
        { orgId: channel.organizationId ?? 0, action: 'repost' },
        () => this.fetchJson<{ data?: { retweeted: boolean } }>(
          `${API_BASE}/users/${userId}/retweets`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${channel.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ tweet_id: platformPostId }),
          },
        ),
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Poll v2 media STATUS until processing completes (reads data.processing_info.state). */
  private async pollUploadStatus(
    mediaId: string,
    processingInfo: XProcessingInfo,
    accessToken: string,
  ): Promise<void> {
    let info = processingInfo;
    // Bounded by wall clock, not by iteration count: X's check_after_secs is
    // not clamped by us, so 60 iterations of a large hint could hold a publish
    // job for hours. Each STATUS request also gets its own timeout — it was
    // the one network call in this file without one.
    const MAX_WAIT_MS = 10 * 60 * 1000;
    const STATUS_TIMEOUT_MS = 30 * 1000;
    const started = Date.now();
    let attempt = 0;

    const failed = (pi: XProcessingInfo) => {
      throw new Error(`Media processing failed: ${pi.error?.message || 'Unknown error'}`);
    };

    while (info.state !== 'succeeded') {
      if (info.state === 'failed') failed(info);
      if (Date.now() - started > MAX_WAIT_MS) throw new Error('Media processing timed out');

      const waitSecs = Math.min(30, Math.max(1, info.check_after_secs || 5));
      await new Promise((resolve) => setTimeout(resolve, waitSecs * 1000));

      const statusUrl = `${MEDIA_UPLOAD_URL}?command=STATUS&media_id=${mediaId}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
      let statusRes: Response;
      try {
        statusRes = await fetch(statusUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const statusData = await this.parseMediaResponse(statusRes, 'STATUS');
      const pi = statusData.data?.processing_info;
      if (!pi) break; // Processing complete
      info = pi;
      attempt++;

      this.logger.debug({ mediaId, state: info.state, attempt }, 'Polling upload status');
    }
    // A `failed` reported on the final poll must surface X's message, not a
    // timeout.
    if (info.state === 'failed') failed(info);
  }

  /** Both gates that can leave X engagement empty, quoted verbatim to the user. */
  private static readonly X_READS_OFF =
    'X charges for every read, so replies and likers stay off until you enable X analytics for this channel on the Channels page.';
  private static readonly X_BUDGET_SPENT =
    'X reads are unavailable. They need a paid plan with remaining monthly X budget.';

  /**
   * Replies and likers for one post.
   *
   * X is the only platform where reading engagement COSTS MONEY — every tweet
   * and every user returned is billed (see X_API_COSTS_DCENTS). The preview
   * pane fetches engagement whenever a post is selected, so an ungated
   * implementation would bill the org for idly clicking down the analytics
   * list. It is therefore gated three ways, and says which one declined:
   *
   *   1. the per-channel `metadata.metricsSyncEnabled` opt-in — the same switch
   *      that governs X metrics on the Channels page;
   *   2. the org's monthly X budget — paid plans only (`ensureReadBudget`);
   *   3. the global X live-API kill switch, via that same call.
   *
   * Both requests go through withCostContext, so the spend lands in
   * x_api_usage_daily with everything else.
   */
  async getPostEngagement(
    channel: ChannelData,
    platformPostId: string,
    opts?: EngagementOptions,
  ): Promise<EngagementData> {
    if (!channel.accessToken) {
      return { comments: [], reactions: [], notice: 'No access token', commentsNotice: 'No access token' };
    }
    if (channel.metadata?.metricsSyncEnabled !== true) {
      return {
        comments: [],
        reactions: [],
        notice: XHandler.X_READS_OFF,
        commentsNotice: XHandler.X_READS_OFF,
      };
    }
    if (!(await this.ensureReadBudget(channel.organizationId, X_API_COSTS_DCENTS.post_read))) {
      this.logger.warn({ orgId: channel.organizationId }, 'X read budget exhausted — skipping engagement');
      return { comments: [], reactions: [], notice: XHandler.X_BUDGET_SPENT, commentsNotice: XHandler.X_BUDGET_SPENT };
    }

    const commentsLimit = Math.min(opts?.commentsLimit ?? 25, 100);
    const reactionsLimit = Math.min(opts?.reactionsLimit ?? 25, 100);
    const headers = { Authorization: `Bearer ${channel.accessToken}` };
    const orgId = channel.organizationId ?? 0;
    const result: EngagementData = { comments: [], reactions: [] };

    type XUser = { id: string; name?: string; username?: string; profile_image_url?: string };
    const actorOf = (u: XUser | undefined, fallbackId: string) => ({
      id: u?.id ?? fallbackId,
      name: u?.name || (u?.username ? `@${u.username}` : 'X user'),
      handle: u?.username,
      profileImage: u?.profile_image_url,
      profileUrl: u?.username ? `https://x.com/${u.username}` : undefined,
    });

    const countData = (d: unknown) => {
      const arr = (d as { data?: unknown[] } | null)?.data;
      return Array.isArray(arr) ? arr.length : 0;
    };

    try {
      // Replies are not a sub-resource of a tweet on X — they are tweets sharing
      // its conversation_id, so this is a search, not a lookup. Recent search
      // only covers the last 7 days, which is why older posts come back empty
      // rather than wrong.
      const query = encodeURIComponent(`conversation_id:${platformPostId}`);
      const data = await this.withCostContext(
        { orgId, action: 'post_read', resourceCountFromResponse: countData },
        () =>
          this.fetchJson<{
            data?: Array<{
              id: string;
              text?: string;
              created_at?: string;
              author_id?: string;
              referenced_tweets?: Array<{ type: string; id: string }>;
            }>;
            includes?: { users?: XUser[] };
            meta?: { next_token?: string };
          }>(
            `${API_BASE}/tweets/search/recent?query=${query}` +
              `&max_results=${Math.max(10, Math.min(commentsLimit, 100))}` +
              '&tweet.fields=created_at,author_id,referenced_tweets' +
              '&expansions=author_id&user.fields=name,username,profile_image_url',
            { headers },
          ),
      );

      const users = new Map((data.includes?.users ?? []).map((u) => [u.id, u]));
      const present = new Set((data.data ?? []).map((t) => t.id));
      const comments: EngagementComment[] = [];
      // Search returns newest-first; read oldest-first like every other thread.
      for (const t of (data.data ?? []).slice().reverse()) {
        if (t.id === platformPostId) continue; // the root matches its own conversation_id
        const repliedTo = t.referenced_tweets?.find((r) => r.type === 'replied_to')?.id;
        comments.push({
          id: t.id,
          text: t.text ?? '',
          createdAt: t.created_at,
          // Nest only under a reply that is itself on this page; a reply to the
          // root post is top level.
          parentId:
            repliedTo && repliedTo !== platformPostId && present.has(repliedTo) ? repliedTo : undefined,
          actor: actorOf(t.author_id ? users.get(t.author_id) : undefined, t.author_id ?? t.id),
        });
      }
      result.comments = comments;
      result.hasMoreComments = !!data.meta?.next_token;
    } catch (error) {
      this.logger.warn({ error, platformPostId }, 'X replies fetch failed');
      result.notice = 'Replies are unavailable because X recent search only covers the last 7 days.';
      result.commentsNotice = result.notice;
    }

    try {
      const likes = await this.withCostContext(
        { orgId, action: 'user_read', resourceCountFromResponse: countData },
        () =>
          this.fetchJson<{ data?: XUser[]; meta?: { next_token?: string } }>(
            `${API_BASE}/tweets/${platformPostId}/liking_users` +
              `?max_results=${Math.max(10, Math.min(reactionsLimit, 100))}` +
              '&user.fields=name,username,profile_image_url',
            { headers },
          ),
      );
      result.reactions = (likes.data ?? []).map((u) => ({
        id: u.id,
        type: 'LIKE',
        actor: actorOf(u, u.id),
      })) as EngagementReaction[];
      // Doc caveat: liking_users returns at most the 100 most recent likers of
      // a post, ever — a next_token cannot page beyond that, so "more" here
      // means "more of the last 100", not the full liker list.
      result.hasMoreReactions = !!likes.meta?.next_token;
    } catch (error) {
      this.logger.warn({ error, platformPostId }, 'X liking_users fetch failed');
      const extra = 'Likers are unavailable because that endpoint needs an elevated X access tier.';
      result.notice = result.notice ? `${result.notice} ${extra}` : extra;
    }

    return result;
  }
}
