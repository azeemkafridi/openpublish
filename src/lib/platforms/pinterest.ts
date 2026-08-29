import { PlatformHandler } from './base';
import type {
  TokenData,
  AccountInfo,
  PublishResult,
  PostData,
  ChannelData,
  PlatformConfig,
  MetricsData,
  EngagementData,
} from './types';

const API_BASE = 'https://api.pinterest.com/v5';

/**
 * Minimum gap between /pins/{id}/analytics calls.
 *
 * That endpoint is in Pinterest's `org_analytics` rate-limit category. Measured
 * against the live API on 2026-07-29, the response carries:
 *
 *   x-ratelimit-limit: 60, 100;w=1;name="safety_net_app_id_user_id",
 *                      60;w=60;name="org_analytics_app_id_user_id"
 *
 * so the binding constraint is 60 per 60s, and the bucket name confirms it is
 * scoped per app_id + user_id — one connected account's sync cannot exhaust
 * another's. (The 100/s safety net is never what we hit.) Because the bucket is
 * per user, pacing per getPostMetrics call — i.e. per channel — is the correct
 * granularity.
 *
 * 1100ms paces us at ~54/min, leaving headroom for the account-analytics call
 * that shares the same bucket.
 * https://developers.pinterest.com/docs/reference/rate-limits/
 *
 * Overridable via PINTEREST_ANALYTICS_MIN_INTERVAL_MS so the pace can be
 * loosened if Pinterest raises our limit, or tightened without a deploy if we
 * turn out to be on Trial access (1,000/day per app, shared by every account).
 */
const PIN_ANALYTICS_MIN_INTERVAL_MS = Number(
  process.env.PINTEREST_ANALYTICS_MIN_INTERVAL_MS ?? 1100,
);

/** True for an error thrown by fetchJson for an HTTP 429. */
function isRateLimited(error: unknown): boolean {
  return error instanceof Error && /\(429\)/.test(error.message);
}

/**
 * True when Pinterest rejected the call because the app lacks access to a
 * beta-gated endpoint:
 *   401 {"code":3,"message":"Your application does not have access to this
 *        restricted feature."}
 * The batch analytics endpoint is granted per app, so a token that works
 * everywhere else can still fail here — that is a capability signal, not an
 * outage, and it means "use the per-pin path", not "give up".
 */
function isRestrictedFeature(error: unknown): boolean {
  return (
    error instanceof Error &&
    /\((401|403)\)/.test(error.message) &&
    /restricted feature/i.test(error.message)
  );
}

/** Max pin ids accepted by GET /pins/analytics in one call. */
const PIN_ANALYTICS_BATCH_SIZE = 100;

type PinMetrics = {
  IMPRESSION?: number;
  PIN_CLICK?: number;
  OUTBOUND_CLICK?: number;
  SAVE?: number;
  TOTAL_REACTIONS?: number;
  TOTAL_COMMENTS?: number;
  VIDEO_MRC_VIEW?: number;
  VIDEO_V50_WATCH_TIME?: number;
};

type PinAnalytics = {
  all?: {
    summary_metrics?: PinMetrics;
    lifetime_metrics?: PinMetrics;
  };
};

/** Batch response: the same per-pin object, keyed by pin id. */
type BatchPinAnalytics = Record<string, PinAnalytics | undefined>;

// `metric_types` is an enum array of concrete metric names, and the enum is a
// oneOf: a STANDARD set (IMPRESSION | OUTBOUND_CLICK | PIN_CLICK | SAVE |
// SAVE_RATE | TOTAL_COMMENTS | TOTAL_REACTIONS) and a VIDEO set that adds
// VIDEO_MRC_VIEW / VIDEO_V50_WATCH_TIME etc. (pinterest/api-description
// v5.12.0, /pins/{pin_id}/analytics — the batch endpoint takes the same enum).
//
// We used to send `metric_types=LIFETIME`, which is in neither set. Pinterest
// tolerated it — prod has 1672 pin metric rows with real impressions and clicks
// — because the parameter's documented default is "all". What it did NOT do was
// let us ask for TOTAL_REACTIONS / TOTAL_COMMENTS, which is why every Pinterest
// pin reported 0 likes and 0 comments.
//
// Video metric names are only valid for VIDEO pins, so asking for them on an
// image pin risks a 400. Try the video-inclusive list first and fall back to
// the standard-only list, so an image pin can never end up with less than it
// reports today.
const STANDARD_METRICS =
  'IMPRESSION,PIN_CLICK,OUTBOUND_CLICK,SAVE,TOTAL_REACTIONS,TOTAL_COMMENTS';
const METRIC_SETS = [
  `${STANDARD_METRICS},VIDEO_MRC_VIEW,VIDEO_V50_WATCH_TIME`,
  STANDARD_METRICS,
];

/**
 * Fold one pin's analytics object into our MetricsData.
 *
 * MERGE summary_metrics and lifetime_metrics; do NOT pick one.
 *
 * Pinterest splits the metrics across them and the split is not what the schema
 * suggests. Measured against the live API on 2026-07-29 (per-pin) and
 * re-confirmed 2026-07-30 against the batch endpoint, requesting the full
 * standard set:
 *
 *   summary_metrics : IMPRESSION, OUTBOUND_CLICK, SAVE, PIN_CLICK
 *   lifetime_metrics: TOTAL_COMMENTS, TOTAL_REACTIONS
 *
 * TOTAL_REACTIONS / TOTAL_COMMENTS appear ONLY in lifetime_metrics, and
 * IMPRESSION / PIN_CLICK / SAVE appear ONLY in summary_metrics. Reading
 * `lifetime_metrics ?? summary_metrics` therefore returned an object holding
 * just the two engagement keys and silently zeroed impressions, clicks and
 * saves for every pin — 732 rows of all-zero Pinterest metrics in production on
 * the day that shipped.
 *
 * lifetime spreads last so that where Pinterest DOES report an all-time figure
 * (video and Idea pins, and every format created after 2023-03-20) it wins over
 * the windowed one.
 */
function parsePinMetrics(analytics: PinAnalytics | undefined): MetricsData | null {
  const summary = analytics?.all?.summary_metrics;
  const lifetime = analytics?.all?.lifetime_metrics;
  if (!summary && !lifetime) return null;
  const m: PinMetrics = { ...summary, ...lifetime };

  const metrics: MetricsData = {
    impressions: m.IMPRESSION ?? 0,
    clicks: m.PIN_CLICK ?? 0,
    saves: m.SAVE ?? 0,
    // Pinterest does report engagement counts, via TOTAL_REACTIONS /
    // TOTAL_COMMENTS — they were simply never requested.
    likes: m.TOTAL_REACTIONS ?? 0,
    comments: m.TOTAL_COMMENTS ?? 0,
    extra: {
      outboundClicks: m.OUTBOUND_CLICK ?? 0,
    },
  };

  // Video pin metrics (present only for video pins)
  if (m.VIDEO_MRC_VIEW != null) {
    metrics.videoViews = m.VIDEO_MRC_VIEW;
  }
  if (m.VIDEO_V50_WATCH_TIME != null) {
    if (!metrics.extra) metrics.extra = {};
    metrics.extra.videoWatchTime = m.VIDEO_V50_WATCH_TIME;
  }

  return metrics;
}

const config: PlatformConfig = {
  name: 'pinterest',
  displayName: 'Pinterest',
  icon: 'pinterest',
  color: '#E60023',
  authType: 'oauth',
  postTypes: [
    {
      value: 'pin',
      label: 'Pin',
      description: 'Image pin with description to a board',
      mediaRequired: true,
      maxMedia: 1,
      allowedMediaTypes: ['image'],
    },
    {
      value: 'video_pin',
      label: 'Video Pin',
      description: 'Video pin with description to a board',
      mediaRequired: true,
      maxMedia: 1,
      allowedMediaTypes: ['video'],
    },
    {
      value: 'carousel',
      label: 'Carousel',
      description: 'Multi-image pin (2-5 images) to a board',
      mediaRequired: true,
      maxMedia: 5,
      minMedia: 2,
      allowedMediaTypes: ['image'],
    },
  ],
  mediaRules: {
    image: {
      // JPEG/PNG only. Pinterest rejects WebP with
      // `400 The format of the image is not supported` — for pin images and
      // for a video pin's cover_image_url alike. Listing webp here (it was)
      // told the publish worker no conversion was needed, so a WebP upload
      // went to Pinterest untouched and failed.
      maxSizeMB: 20,
      formats: ['jpg', 'jpeg', 'png'],
      maxCount: 5,
    },
    video: {
      maxSizeMB: 2048,
      formats: ['mp4', 'mov'],
      maxCount: 1,
    },
  },
};

export class PinterestHandler extends PlatformHandler {
  constructor() {
    super(config);
  }

  private getAppId(): string {
    const appId = process.env.PINTEREST_APP_ID;
    if (!appId) throw new Error('PINTEREST_APP_ID not configured');
    return appId;
  }

  private getAppSecret(): string {
    const appSecret = process.env.PINTEREST_APP_SECRET;
    if (!appSecret) throw new Error('PINTEREST_APP_SECRET not configured');
    return appSecret;
  }

  private getBasicAuthHeader(): string {
    const appId = this.getAppId();
    const appSecret = this.getAppSecret();
    const credentials = Buffer.from(`${appId}:${appSecret}`).toString('base64');
    return `Basic ${credentials}`;
  }

  async getOAuthUrl(redirectUri: string, state: string): Promise<string> {
    const appId = this.getAppId();

    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'boards:read,boards:write,pins:read,pins:write,user_accounts:read',
      state: state,
    });

    return `https://www.pinterest.com/oauth/?${params.toString()}`;
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
    }>(`${API_BASE}/oauth/token`, {
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
      username: string;
      profile_image?: string;
      account_type?: string;
    }>(`${API_BASE}/user_account`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    return {
      id: data.username,
      name: data.username,
      profileImage: data.profile_image,
      accountType: data.account_type,
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
        postType: post.postType,
      },
      'Pinterest publish started',
    );

    if (!channel.accessToken) {
      return { success: false, error: 'No access token for Pinterest account' };
    }

    // Determine board ID — platformSpecific is keyed by channelId from the composer
    const channelSpecific = post.platformSpecific?.[channel.id] as
      | { boardId?: string }
      | undefined;
    let boardId =
      channelSpecific?.boardId ||
      (post.platformSpecific?.boardId as string | undefined) ||
      (channel.metadata?.defaultBoardId as string | undefined);

    if (!boardId) {
      boardId = await this.getOrCreateDefaultBoard(channel.accessToken) ?? undefined;
      if (!boardId) {
        return { success: false, error: 'Could not find or create a Pinterest board' };
      }
    }

    const postType = post.postType || 'pin';

    if (postType === 'carousel') {
      return this.publishCarousel(post, channel, boardId);
    }

    if (postType === 'video_pin') {
      return this.publishVideoPin(post, channel, boardId);
    }

    // Default: image pin
    return this.publishImagePin(post, channel, boardId);
  }

  private getPinFields(post: PostData): { title: string; description: string; link?: string } | { error: string } {
    const opts = post.platformSpecific ?? {};
    const title = (typeof opts.title === 'string' && opts.title.trim())
      ? opts.title.trim().slice(0, 100)
      : post.content.slice(0, 100);

    if (!title) {
      return { error: 'Pinterest requires a pin title.' };
    }

    const description = (typeof opts.description === 'string' && opts.description.trim())
      ? opts.description.trim().slice(0, 500)
      : post.content;
    const link = typeof opts.link === 'string' && opts.link.trim() ? opts.link.trim() : undefined;
    return { title, description, link };
  }

  private async publishImagePin(
    post: PostData,
    channel: ChannelData,
    boardId: string,
  ): Promise<PublishResult> {
    const imageFile = post.mediaFiles.find((f) =>
      f.mimeType.startsWith('image/'),
    );
    const imageUrl = imageFile?.url || post.mediaUrls[0];

    if (!imageUrl) {
      return {
        success: false,
        error: 'A pin requires an image. Please attach an image.',
      };
    }

    const fields = this.getPinFields(post);
    if ('error' in fields) return { success: false, error: fields.error };

    const pinPayload: Record<string, unknown> = {
      board_id: boardId,
      title: fields.title,
      description: fields.description,
      media_source: {
        source_type: 'image_url',
        url: imageUrl,
      },
    };

    if (fields.link) {
      pinPayload.link = fields.link;
    }

    const dominantColor = post.platformSpecific?.dominantColor as string | undefined;
    if (dominantColor) {
      pinPayload.dominant_color = dominantColor;
    }

    return this.createPin(pinPayload, channel.accessToken);
  }

  private async publishVideoPin(
    post: PostData,
    channel: ChannelData,
    boardId: string,
  ): Promise<PublishResult> {
    const videoFile = post.mediaFiles.find((f) =>
      f.mimeType.startsWith('video/'),
    );
    const videoUrl = videoFile?.url || post.mediaUrls[0];

    if (!videoUrl) {
      return {
        success: false,
        error: 'A video pin requires a video. Please attach a video.',
      };
    }

    const fields = this.getPinFields(post);
    if ('error' in fields) return { success: false, error: fields.error };

    // Pinterest requires a cover image for video pins. Resolution order:
    // 1. explicit coverImageUrl from platform options,
    // 2. an image attached alongside the video (API callers),
    // 3. the auto-extracted poster frame of the video itself.
    const explicitCover = post.platformSpecific?.coverImageUrl;
    const attachedImage = post.mediaFiles.find((f) => f.mimeType.startsWith('image/'));
    const coverImageUrl =
      (typeof explicitCover === 'string' && explicitCover.trim() ? explicitCover.trim() : undefined) ||
      attachedImage?.url ||
      videoFile?.posterUrl;
    if (!coverImageUrl) {
      return {
        success: false,
        error: 'A video pin needs a cover image and no frame could be extracted from this video. Set a cover image in Pinterest options and try again.',
      };
    }

    // Pinterest v5 does NOT accept a raw URL as media_id — the video must be registered
    // and uploaded first, and the pin then references the returned numeric media_id.
    const uploaded = await this.uploadVideoMedia(videoUrl, channel.accessToken);
    if ('error' in uploaded) return { success: false, error: uploaded.error };

    const pinPayload: Record<string, unknown> = {
      board_id: boardId,
      title: fields.title,
      description: fields.description,
      media_source: {
        source_type: 'video_id',
        cover_image_url: coverImageUrl,
        media_id: uploaded.mediaId,
      },
    };

    if (fields.link) {
      pinPayload.link = fields.link;
    }

    const dominantColor = post.platformSpecific?.dominantColor as string | undefined;
    if (dominantColor) {
      pinPayload.dominant_color = dominantColor;
    }

    return this.createPin(pinPayload, channel.accessToken);
  }

  /**
   * Register a video with Pinterest, upload its bytes, and wait for processing — returning
   * the numeric media_id the pin must reference. Pinterest v5 requires
   * register (POST /media) → upload bytes to the returned S3 upload_url → poll
   * GET /media/{id} until status='succeeded'; a raw media URL is not accepted.
   * Faithful to the documented flow + the Postiz reference — verify against the live
   * Pinterest API before relying on it in production.
   */
  private async uploadVideoMedia(
    videoUrl: string,
    accessToken: string,
  ): Promise<{ mediaId: string } | { error: string }> {
    // 1. Register the upload.
    let reg: { media_id: string; upload_url: string; upload_parameters: Record<string, string> };
    try {
      reg = await this.fetchJson<{ media_id: string; upload_url: string; upload_parameters: Record<string, string> }>(
        `${API_BASE}/media`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ media_type: 'video' }),
        },
      );
    } catch (error) {
      return { error: `Failed to register the video with Pinterest: ${error instanceof Error ? error.message : String(error)}` };
    }

    // 2. Fetch the video bytes and 3. upload them to the provided (S3) URL.
    try {
      const videoResp = await this.fetchRemoteMedia(videoUrl);
      if (!videoResp.ok) return { error: `Could not read the video for upload (${videoResp.status}).` };
      const videoBlob = await videoResp.blob();

      const form = new FormData();
      for (const [key, value] of Object.entries(reg.upload_parameters || {})) {
        form.append(key, value);
      }
      form.append('file', videoBlob);

      const uploadResp = await fetch(reg.upload_url, { method: 'POST', body: form });
      if (!uploadResp.ok) return { error: `Pinterest rejected the video upload (${uploadResp.status}).` };
    } catch (error) {
      return { error: `Pinterest video upload failed: ${error instanceof Error ? error.message : String(error)}` };
    }

    // 4. Poll until processing finishes. Bounded so a stuck upload never wedges a publish
    //    worker slot; poll first then wait so an already-ready video returns immediately.
    const MAX_ATTEMPTS = 24;
    const INTERVAL_MS = 5000;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const media = await this.fetchJson<{ status: string }>(
          `${API_BASE}/media/${reg.media_id}`,
          { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
          { quiet: true },
        );
        if (media.status === 'succeeded') return { mediaId: reg.media_id };
        if (media.status === 'failed') return { error: 'Pinterest could not process the uploaded video.' };
      } catch {
        // transient read error — keep polling within the cap
      }
      await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    }
    return { error: 'Pinterest is still processing the video. Please try publishing again shortly.' };
  }

  private async publishCarousel(
    post: PostData,
    channel: ChannelData,
    boardId: string,
  ): Promise<PublishResult> {
    const images = post.mediaFiles.filter((f) =>
      f.mimeType.startsWith('image/'),
    );
    const imageUrls = images.map((f) => f.url).filter(Boolean);

    if (imageUrls.length < 2) {
      return {
        success: false,
        error: 'A carousel requires at least 2 images.',
      };
    }

    if (imageUrls.length > 5) {
      return {
        success: false,
        error: 'A Pinterest carousel supports up to 5 images.',
      };
    }

    const fields = this.getPinFields(post);
    if ('error' in fields) return { success: false, error: fields.error };

    const carouselItems = imageUrls.map((url, index) => ({
      title: fields.title,
      description: fields.description,
      link: fields.link || undefined,
      id: index,
      media_source: {
        source_type: 'image_url',
        url: url,
      },
    }));

    const pinPayload: Record<string, unknown> = {
      board_id: boardId,
      title: fields.title,
      description: fields.description,
      carousel_data_json: JSON.stringify({ items: carouselItems }),
      media_source: {
        source_type: 'image_url',
        url: imageUrls[0],
      },
    };

    if (fields.link) {
      pinPayload.link = fields.link;
    }

    const dominantColor = post.platformSpecific?.dominantColor as string | undefined;
    if (dominantColor) {
      pinPayload.dominant_color = dominantColor;
    }

    return this.createPin(pinPayload, channel.accessToken);
  }

  private async createPin(
    payload: Record<string, unknown>,
    accessToken: string,
  ): Promise<PublishResult> {
    try {
      const result = await this.fetchJson<{
        id: string;
      }>(`${API_BASE}/pins`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const pinId = result.id;
      const pinUrl = `https://www.pinterest.com/pin/${pinId}`;

      this.logger.info(
        { pinId, url: pinUrl },
        'Pin published successfully',
      );

      return {
        success: true,
        postId: pinId,
        url: pinUrl,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: message }, 'Failed to publish pin');
      return { success: false, error: message };
    }
  }

  async getAccountAnalytics(
    channel: ChannelData,
  ): Promise<{ followers?: number; following?: number; impressions?: number; reach?: number; profileViews?: number; websiteClicks?: number; platformSpecific?: Record<string, number> } | null> {
    if (!channel.accessToken) return null;

    try {
      const data = await this.fetchJson<{
        follower_count?: number;
        following_count?: number;
        pin_count?: number;
        monthly_views?: number;
      }>(`${API_BASE}/user_account`, {
        headers: {
          Authorization: `Bearer ${channel.accessToken}`,
        },
      });

      return {
        followers: data.follower_count,
        following: data.following_count,
        platformSpecific: {
          ...(data.pin_count != null ? { pinCount: data.pin_count } : {}),
          ...(data.monthly_views != null ? { monthlyViews: data.monthly_views } : {}),
        },
      };
    } catch (error) {
      this.logger.warn({ error }, 'Failed to fetch Pinterest account analytics');
      return null;
    }
  }

  async getPostMetrics(
    channel: ChannelData,
    platformPostIds: string[],
  ): Promise<Map<string, MetricsData>> {
    const results = new Map<string, MetricsData>();
    if (!channel.accessToken || platformPostIds.length === 0) return results;

    // Pinterest LIFETIME metrics need a date range (max 90 days back)
    const today = new Date().toISOString().split('T')[0];
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 89);
    const startDate = ninetyDaysAgo.toISOString().split('T')[0];

    // Prefer the batch endpoint: 100 pins per request instead of one each.
    //
    // GET /pins/analytics is beta and gated per app. Pinterest API Support
    // granted it to our app on 2026-07-30; verified live the same day against
    // channel 12 — HTTP 200, and the per-pin figures matched the single-pin
    // endpoint exactly (IMPRESSION 50 / PIN_CLICK 1 both ways). Before the
    // grant it returned 401 code 3 "restricted feature".
    //
    // This turns a 136-pin account from 136 requests (~2.5 min of pacing) into
    // 2. It also gets its own rate-limit bucket — the live response carries
    // `100;w=1;name="multi_pins_analytics"` alongside the per-pin
    // `60;w=60;name="org_analytics_app_id_user_id"`.
    //
    // The grant is per app, but a 401 here must not lose an account's metrics,
    // so a restricted-feature rejection falls through to the per-pin path.
    const batchDone = await this.fetchPinMetricsBatched(
      channel,
      platformPostIds,
      startDate,
      today,
      results,
    );
    if (batchDone) return results;

    this.logger.warn(
      { channelId: channel.id },
      'Pinterest batch analytics unavailable — falling back to per-pin',
    );
    await this.fetchPinMetricsPerPin(
      channel,
      platformPostIds,
      startDate,
      today,
      results,
    );
    return results;
  }

  /**
   * Batch path — GET /pins/analytics, up to 100 pin ids per request.
   *
   * Returns false if the endpoint is not available to this app/token, meaning
   * the caller should use the per-pin path. Returns true otherwise, including
   * when a chunk fails for an ordinary reason (that chunk is simply skipped and
   * the next scheduled run retries it) — falling back to 136 individual
   * requests because one chunk 500'd would be worse than missing it once.
   */
  private async fetchPinMetricsBatched(
    channel: ChannelData,
    platformPostIds: string[],
    startDate: string,
    endDate: string,
    results: Map<string, MetricsData>,
  ): Promise<boolean> {
    // Which metric set works for this account. The video-inclusive set returns
    // strictly more, but video metric names are invalid for image pins and a
    // mixed chunk can 400 on them. Once the video set is seen to fail we stop
    // paying for the discovery — same stickiness the per-pin path uses.
    let preferredSetIndex = 0;
    let lastRequestAt = 0;

    for (let i = 0; i < platformPostIds.length; i += PIN_ANALYTICS_BATCH_SIZE) {
      const chunk = platformPostIds.slice(i, i + PIN_ANALYTICS_BATCH_SIZE);

      let data: BatchPinAnalytics | null = null;
      let lastError: unknown = null;

      for (let s = preferredSetIndex; s < METRIC_SETS.length; s++) {
        try {
          // Chunks are few, so hold the same conservative spacing rather than
          // trusting the 100/s batch bucket — the call is also billed against
          // the shared per-user org_analytics budget.
          const wait = PIN_ANALYTICS_MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          lastRequestAt = Date.now();

          data = await this.fetchJson<BatchPinAnalytics>(
            `${API_BASE}/pins/analytics?` +
              `pin_ids=${chunk.join(',')}` +
              `&start_date=${startDate}&end_date=${endDate}` +
              `&metric_types=${METRIC_SETS[s]}` +
              `&app_types=ALL&split_field=NO_SPLIT`,
            { headers: { Authorization: `Bearer ${channel.accessToken}` } },
            // Only surface the final attempt's failure.
            { quiet: s !== METRIC_SETS.length - 1 },
          );
          preferredSetIndex = s;
          break;
        } catch (error) {
          lastError = error;
          // Not available to this app — the whole batch path is unusable, so
          // report that rather than burning the remaining chunks discovering
          // the same thing.
          if (isRestrictedFeature(error)) return false;
          // A 429 is about pace, not about this metric set.
          if (isRateLimited(error)) break;
          if (s === 0) preferredSetIndex = 1;
        }
      }

      const isFirstChunk = i === 0;

      if (!data) {
        if (isRateLimited(lastError)) {
          this.logger.warn(
            { fetched: results.size, remaining: platformPostIds.length - results.size },
            'Pinterest rate limit reached — stopping this channel early',
          );
          return true;
        }
        // The first chunk failing outright means the endpoint is not working
        // for this account, whatever the reason — a shape change, a 500, a
        // rejected parameter. Hand off to the per-pin path rather than losing
        // every pin. A LATER chunk failing is an isolated blip: keep what we
        // have and let the next scheduled run retry it, since re-running all
        // of it per-pin would cost far more than the missed chunk.
        if (isFirstChunk) {
          this.logger.warn(
            { error: lastError },
            'Pinterest batch analytics failed on the first chunk — falling back',
          );
          return false;
        }
        this.logger.warn(
          { error: lastError, pins: chunk.length },
          'Failed to fetch Pinterest pin metrics batch',
        );
        continue;
      }

      // Pinterest omits pins it has no data for, so iterate what came back.
      const before = results.size;
      for (const [pinId, analytics] of Object.entries(data)) {
        const metrics = parsePinMetrics(analytics);
        if (metrics) results.set(pinId, metrics);
      }

      // A 200 that yields nothing for the first chunk is the signature of a
      // response-shape change — exactly how the 2026-07-29 regression silently
      // zeroed 732 rows. An account with genuinely no analytics data gets the
      // same treatment (the per-pin path returns nothing either, just slower),
      // which is the old behaviour and therefore not a regression.
      if (isFirstChunk && results.size === before) {
        this.logger.warn(
          { pins: chunk.length, keys: Object.keys(data).slice(0, 3) },
          'Pinterest batch analytics returned no usable metrics — falling back',
        );
        return false;
      }
    }

    return true;
  }

  /**
   * Per-pin fallback — one GET /pins/{id}/analytics per pin, paced.
   *
   * Pinterest bills it under `org_analytics`: 60 requests per 60s per app+user
   * (see PIN_ANALYTICS_MIN_INTERVAL_MS). This loop previously fired one request
   * per pin with no delay at all; an account with 148 pins burst all of them
   * and reliably 429'd partway.
   */
  private async fetchPinMetricsPerPin(
    channel: ChannelData,
    platformPostIds: string[],
    startDate: string,
    endDate: string,
    results: Map<string, MetricsData>,
  ): Promise<void> {
    let lastRequestAt = 0;
    const pace = async () => {
      const wait = PIN_ANALYTICS_MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastRequestAt = Date.now();
    };

    // Which metric set actually works for this account. The video-inclusive set
    // is tried first because it returns strictly more, but it can 400 on image
    // pins — and on an image-only account that meant EVERY pin cost two
    // requests, doubling the rate-limit spend for nothing. Once a set succeeds
    // (or the video set is seen to fail) we stop paying for the discovery.
    let preferredSetIndex = 0;

    for (const pinId of platformPostIds) {
      try {
        let data: PinAnalytics | null = null;
        let lastError: unknown = null;
        // Start from the set that last worked for this account, so an
        // image-only account stops re-probing the video set on every pin.
        for (let i = preferredSetIndex; i < METRIC_SETS.length; i++) {
          try {
            await pace();
            data = await this.fetchJson<PinAnalytics>(
              `${API_BASE}/pins/${pinId}/analytics?` +
                `start_date=${startDate}&end_date=${endDate}` +
                `&metric_types=${METRIC_SETS[i]}` +
                `&app_types=ALL&split_field=NO_SPLIT`,
              { headers: { Authorization: `Bearer ${channel.accessToken}` } },
              // Only surface the final attempt's failure.
              { quiet: i !== METRIC_SETS.length - 1 },
            );
            preferredSetIndex = i;
            break;
          } catch (e) {
            lastError = e;
            // A 429 is about pace, not about this metric set — falling through
            // to the next set would spend another request against a limit we
            // have already exceeded.
            if (isRateLimited(e)) throw e;
            // The video set is unusable for this account; don't try it again.
            if (i === 0) preferredSetIndex = 1;
          }
        }
        if (!data) throw lastError;

        const metrics = parsePinMetrics(data);
        if (metrics) results.set(pinId, metrics);
      } catch (error) {
        if (isRateLimited(error)) {
          // base.ts has already retried this request up to 3 times honouring
          // Retry-After. Still limited means the window is genuinely spent, and
          // the remaining pins would each burn another 3 attempts for nothing —
          // slowing the whole org's sync while making the limit worse. Stop and
          // keep what we have; the next scheduled run resumes.
          this.logger.warn(
            { pinId, fetched: results.size, remaining: platformPostIds.length - results.size },
            'Pinterest rate limit reached — stopping this channel early',
          );
          break;
        }
        this.logger.warn({ error, pinId }, 'Failed to fetch Pinterest pin metrics');
      }
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
      }>(`${API_BASE}/oauth/token`, {
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
      this.logger.error({ error }, 'Failed to refresh Pinterest token');
      return null;
    }
  }

  /**
   * Fetches the list of boards for the authenticated user.
   */
  async getBoards(
    accessToken: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const data = await this.fetchJson<{
      items: Array<{ id: string; name: string }>;
    }>(`${API_BASE}/boards`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    return (data.items || []).map((board) => ({
      id: board.id,
      name: board.name,
    }));
  }

  private async getOrCreateDefaultBoard(accessToken: string): Promise<string | null> {
    const DEFAULT_BOARD_NAME = 'openPublish';

    try {
      const boards = await this.getBoards(accessToken);
      const existing = boards.find(
        (b) => b.name.toLowerCase() === DEFAULT_BOARD_NAME.toLowerCase(),
      );
      if (existing) return existing.id;

      // Create the board
      const data = await this.fetchJson<{ id: string }>(
        `${API_BASE}/boards`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: DEFAULT_BOARD_NAME,
            description: 'Posts/ Media uploaded using openPublish.com',
          }),
        },
      );

      this.logger.info({ boardId: data.id }, 'Created default openPublish board');
      return data.id;
    } catch (error) {
      this.logger.error({ error }, 'Failed to get or create default board');
      return null;
    }
  }

  /**
   * Pinterest API v5 has no endpoint for reading a Pin's comments or its
   * savers. Analytics returns aggregate counts only, which is what the metrics
   * sync already uses.
   */
  async getPostEngagement(): Promise<EngagementData> {
    // `unsupported` keeps the UI from rendering an empty panel for it.
    return { comments: [], reactions: [], unsupported: true, notice: 'Pinterest does not expose comments through its API.' };
  }
}
