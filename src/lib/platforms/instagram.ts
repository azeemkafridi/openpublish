import { PlatformHandler } from './base';
import { decrypt } from '../auth/crypto';
import type {
  TokenData,
  AccountInfo,
  PublishResult,
  StatusResult,
  PostData,
  ChannelData,
  PlatformConfig,
  MetricsData,
  EngagementData,
} from './types';

const API_VERSION = 'v21.0';
const GRAPH_URL = `https://graph.instagram.com/${API_VERSION}`;

// Back-off schedule for Instagram media container polling.
// Small images finish in <1s, so start fast and slow down for videos.
// Total timeout: ~60s (matches previous 30 × 2000ms budget).
const POLL_DELAYS_MS = [500, 500, 1000, 1000, 1500, 1500];
const POLL_FALLBACK_MS = 2000;
const POLL_MAX_ATTEMPTS = 30;

const config: PlatformConfig = {
  name: 'instagram',
  displayName: 'Instagram',
  icon: 'instagram',
  color: '#E4405F',
  authType: 'oauth',
  postTypes: [
    {
      value: 'feed_photo',
      label: 'Feed Photo',
      description: 'Single photo post to your feed',
      mediaRequired: true,
      maxMedia: 1,
      allowedMediaTypes: ['image'],
    },
    {
      value: 'feed_video',
      label: 'Feed Video',
      description: 'Single video post to your feed',
      mediaRequired: true,
      maxMedia: 1,
      allowedMediaTypes: ['video'],
    },
    {
      value: 'reel',
      label: 'Reel',
      description: 'Short-form vertical video',
      mediaRequired: true,
      maxMedia: 1,
      allowedMediaTypes: ['video'],
    },
    {
      value: 'story',
      label: 'Story',
      description: 'Photo or video story (disappears after 24h)',
      mediaRequired: true,
      maxMedia: 1,
      allowedMediaTypes: ['image', 'video'],
    },
    {
      value: 'carousel',
      label: 'Carousel',
      description: 'Multiple photos/videos in a swipeable post',
      mediaRequired: true,
      maxMedia: 10,
      allowedMediaTypes: ['image', 'video'],
    },
  ],
  mediaRules: {
    image: {
      maxSizeMB: 8,
      formats: ['jpg', 'jpeg'],
      maxCount: 10,
    },
    video: {
      maxSizeMB: 1024,
      formats: ['mp4', 'mov'],
      maxCount: 10,
    },
  },
};

interface ContainerStatusResponse {
  id: string;
  status_code: 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';
  status?: string;
}

interface MediaContainerResponse {
  id: string;
}

interface MediaPublishResponse {
  id: string;
}

export class InstagramHandler extends PlatformHandler {
  constructor() {
    super(config);
  }

  async getOAuthUrl(redirectUri: string, state: string): Promise<string> {
    const clientId = process.env.INSTAGRAM_APP_ID;
    if (!clientId) throw new Error('INSTAGRAM_APP_ID not configured');

    const scopes = 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights';
    return (
      `https://www.instagram.com/oauth/authorize?` +
      `client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${state}` +
      `&scope=${scopes}` +
      `&response_type=code`
    );
  }

  async exchangeCodeForToken(
    code: string,
    redirectUri: string,
  ): Promise<TokenData> {
    const clientId = process.env.INSTAGRAM_APP_ID!;
    const clientSecret = process.env.INSTAGRAM_APP_SECRET!;

    // Step 1: Exchange code for short-lived token (form-urlencoded POST)
    const shortLivedParams = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    });

    // Business Login returns the token nested in a `data` array:
    //   { "data": [ { access_token, user_id, permissions } ] }
    // It used to be top-level, and some responses still are, so read the
    // wrapper first and fall back. Reading only the old shape is what broke
    // every Instagram connect from 2026-07-23 onward.
    const shortLivedRaw = await this.fetchJson<{
      data?: Array<{ access_token?: string; user_id?: number | string }>;
      access_token?: string;
      user_id?: number | string;
    }>('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      body: shortLivedParams,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const shortLived = shortLivedRaw.data?.[0] ?? shortLivedRaw;
    const shortLivedToken = this.requireOAuthField(
      shortLived.access_token,
      'access_token',
    );
    const shortLivedUserId = this.requireOAuthField(shortLived.user_id, 'user_id');

    // Step 2: Exchange short-lived token for long-lived token
    const longLivedUrl =
      `https://graph.instagram.com/access_token?` +
      `grant_type=ig_exchange_token` +
      `&client_secret=${clientSecret}` +
      `&access_token=${shortLivedToken}`;

    const longLived = await this.fetchJson<{
      access_token?: string;
      token_type?: string;
      expires_in?: number;
    }>(longLivedUrl);

    const longLivedToken = this.requireOAuthField(longLived.access_token, 'access_token');

    return {
      accessToken: longLivedToken,
      // The long-lived token IS the refresh credential (Meta has no separate refresh
      // token); store it so the token-refresh sweep includes this channel and renews it
      // before the ~60-day expiry instead of letting it die silently.
      refreshToken: longLivedToken,
      expiresIn: longLived.expires_in,
      userId: String(shortLivedUserId),
    };
  }

  async refreshToken(refreshTokenValue: string): Promise<TokenData | null> {
    try {
      // Instagram long-lived tokens are refreshed with the token itself (must be ≥24h old);
      // returns a fresh ~60-day token. https://developers.facebook.com/docs/instagram-platform
      const data = await this.fetchJson<{ access_token?: string; expires_in?: number }>(
        `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${refreshTokenValue}`,
      );
      // Assert before returning: an unparsed response here would overwrite a
      // working token with `undefined` and silently kill the channel. Throwing
      // is caught below and returns null, which leaves the good token in place.
      const token = this.requireOAuthField(data.access_token, 'access_token');
      return {
        accessToken: token,
        refreshToken: token,
        expiresIn: data.expires_in,
      };
    } catch (error) {
      this.logger.error({ error }, 'Failed to refresh Instagram token');
      // A 5xx, 429 or network failure says nothing about the refresh token;
      // returning null for it read as "cannot be refreshed" and flagged
      // reconnect after one blip. Only a rejection returns null.
      if (this.isTransientRefreshFailure(error)) throw error;
      return null;
    }
  }

  async getAccountInfo(accessToken: string): Promise<AccountInfo> {
    const url =
      `https://graph.instagram.com/me?` +
      `fields=user_id,username,account_type,profile_picture_url` +
      `&access_token=${accessToken}`;

    const data = await this.fetchJson<{
      user_id: string;
      username: string;
      account_type: string;
      profile_picture_url?: string;
    }>(url);

    // Validate account type - only BUSINESS or MEDIA_CREATOR accounts can publish
    if (data.account_type !== 'BUSINESS' && data.account_type !== 'MEDIA_CREATOR') {
      throw new Error(
        `Instagram account type "${data.account_type}" is not supported. ` +
        'Only Business or Creator accounts can publish via the API. ' +
        'Please convert your account to a Business or Creator account in Instagram settings.',
      );
    }

    return {
      id: data.user_id,
      name: data.username,
      profileImage: data.profile_picture_url,
      accountType: data.account_type,
    };
  }

  async publishPost(
    post: PostData,
    channel: ChannelData,
  ): Promise<PublishResult> {
    const postType = post.postType || 'feed_photo';
    const userId = channel.accountId;
    const accessToken = channel.accessToken;

    this.logger.info(
      {
        accountId: userId,
        postType,
        hasMedia: post.mediaFiles.length > 0,
        mediaCount: post.mediaFiles.length,
      },
      'Instagram publish started',
    );

    if (!accessToken) {
      return { success: false, error: 'No access token for Instagram account' };
    }

    try {
      switch (postType) {
        case 'feed_photo':
          return await this.publishFeedPhoto(post, userId, accessToken);
        case 'feed_video':
          return await this.publishFeedVideo(post, userId, accessToken);
        case 'reel':
          return await this.publishReel(post, userId, accessToken);
        case 'story':
          return await this.publishStory(post, userId, accessToken);
        case 'carousel':
          return await this.publishCarousel(post, userId, accessToken);
        default:
          return { success: false, error: `Unsupported post type: ${postType}` };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: message, postType }, 'Instagram publish failed');
      return { success: false, error: message };
    }
  }

  async checkPublishStatus(
    channel: ChannelData,
    publishId: string,
  ): Promise<StatusResult> {
    try {
      const status = await this.pollContainerStatus(publishId, channel.accessToken);

      if (status.status_code === 'PUBLISHED') {
        // Container was already published in a previous finalization attempt.
        // `publishId` here is the container ID, not the real media ID — metrics
        // queries against it fail. Best-effort: a permalink lookup on the id
        // sometimes resolves (and gives the user a working link); fall back to
        // the container id if not.
        const permalink = await this.getPermalink(publishId, channel.accessToken);
        return {
          status: 'published',
          postId: publishId,
          ...(permalink ? { url: permalink } : {}),
        };
      }

      if (status.status_code === 'FINISHED') {
        // Container is ready — finalize the publish now and return the REAL post ID.
        const result = await this.publishContainer(channel.accountId, publishId, channel.accessToken);
        const permalink = await this.getPermalink(result.id, channel.accessToken);
        this.logger.info({ containerId: publishId, postId: result.id }, 'Instagram container finalized via status-check');
        return {
          status: 'published',
          postId: result.id,
          url: permalink || `https://www.instagram.com/p/${result.id}/`,
        };
      }

      if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
        return {
          status: 'failed',
          message: `Container status: ${status.status_code}${status.status ? ` — ${status.status}` : ''}`,
        };
      }

      return {
        status: 'processing',
        message: `Container status: ${status.status_code}`,
      };
    } catch (error) {
      // Transient errors propagate so the status-check worker retries;
      // only a 4xx rejection is terminal (see isTransientApiError).
      if (this.isTransientApiError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      // Code 9007 / 2207027: the container is FINISHED but media_publish
      // says "Media ID is not available" — Meta's advice is to wait a
      // minute and retry, and the container stays publishable for ~24h.
      if (/media id is not available/i.test(message)) {
        return { status: 'processing', message };
      }
      return { status: 'failed', message };
    }
  }

  async getPostMetrics(
    channel: ChannelData,
    platformPostIds: string[],
  ): Promise<Map<string, MetricsData>> {
    const results = new Map<string, MetricsData>();
    if (!channel.accessToken || platformPostIds.length === 0) return results;

    for (const postId of platformPostIds) {
      try {
        // A single unsupported metric 400s the whole insights call, and the valid
        // set differs by media product type + creation date. Meta deprecated
        // `impressions` and `plays` for media made after mid-2024 in favour of
        // `views`. So try the modern view-based set first, then the legacy
        // impression-based set, then minimal Story metrics — first non-empty wins.
        const metricSets = [
          'views,reach,saved,likes,comments,shares,total_interactions', // modern feed/reel
          'impressions,reach,saved,likes,comments,shares,total_interactions', // legacy feed
          'views,reach,replies', // story (modern)
          'impressions,reach,replies', // story (legacy)
        ];

        let matched = false;
        for (const set of metricSets) {
          const metrics = await this.fetchInsightsForPost(postId, set, channel.accessToken);
          if (Object.keys(metrics).length > 0) {
            results.set(postId, metrics);
            matched = true;
            break;
          }
        }
        if (matched) continue;

        // Insights unavailable (no instagram_manage_insights permission) —
        // fall back to basic media fields which only need instagram_basic
        try {
          const basic = await this.fetchJson<{
            like_count?: number;
            comments_count?: number;
          }>(
            `${GRAPH_URL}/${postId}?fields=like_count,comments_count` +
            `&access_token=${channel.accessToken}`,
          );

          if (basic.like_count != null || basic.comments_count != null) {
            results.set(postId, {
              likes: basic.like_count ?? 0,
              comments: basic.comments_count ?? 0,
            });
          }
        } catch {
          // Basic fields also unavailable — skip this post
        }
      } catch (error) {
        this.logger.warn({ error, postId }, 'Failed to fetch Instagram post metrics');
      }
    }

    return results;
  }

  private async fetchInsightsForPost(
    postId: string,
    metricList: string,
    accessToken: string,
  ): Promise<MetricsData> {
    const metrics: MetricsData = {};

    try {
      const data = await this.fetchJson<{
        data?: Array<{
          name: string;
          values?: Array<{ value: number }>;
          total_value?: { value: number };
        }>;
      }>(
        `${GRAPH_URL}/${postId}/insights?` +
        `metric=${metricList}` +
        `&access_token=${accessToken}`,
        {},
        { quiet: true }, // metric sets are probed in a cascade — failures are expected
      );

      for (const item of data.data || []) {
        const value = item.total_value?.value ?? item.values?.[0]?.value ?? 0;
        switch (item.name) {
          case 'impressions': metrics.impressions = value; break;
          case 'views': metrics.impressions = value; break;  // Reels/Stories use 'views'
          case 'reach': metrics.reach = value; break;
          case 'saved': metrics.saves = value; break;
          case 'likes': metrics.likes = value; break;
          case 'comments': metrics.comments = value; break;
          case 'shares': metrics.shares = value; break;
          case 'replies': metrics.comments = value; break;   // Stories use 'replies'
          case 'plays':
            metrics.videoViews = value;
            break;
          case 'total_interactions':
            if (!metrics.extra) metrics.extra = {};
            metrics.extra.totalInteractions = value;
            break;
          case 'exits':
          case 'taps_forward':
          case 'taps_back':
            if (!metrics.extra) metrics.extra = {};
            metrics.extra[item.name] = value;
            break;
        }
      }
    } catch {
      // Metric set not available for this media type — return empty
    }

    return metrics;
  }

  // ---------------------------------------------------------------------------
  // Private: post type handlers
  // ---------------------------------------------------------------------------

  private async publishFeedPhoto(
    post: PostData,
    userId: string,
    accessToken: string,
  ): Promise<PublishResult> {
    if (post.mediaFiles.length === 0) {
      return { success: false, error: 'Feed photo requires an image' };
    }

    const imageUrl = post.mediaFiles[0].url;

    // Create media container
    const containerParams: Record<string, string> = {
      image_url: imageUrl,
      access_token: accessToken,
    };
    if (post.content) {
      containerParams.caption = post.content;
    }

    this.applyCollaborators(containerParams, post);

    const container = await this.createMediaContainer(userId, containerParams);

    // Return immediately; the status-check worker finalizes (polls → publishContainer → permalink).
    // This frees the publish worker from a 2-10s blocking wait on Instagram processing.
    this.logger.info({ containerId: container.id }, 'Instagram feed photo container created, deferring finalization');
    return {
      success: true,
      processing: true,
      processingId: container.id,
    };
  }

  /**
   * Tag co-authors on the post.
   *
   * Instagram accepts `collaborators` on a single image, a video/Reel and the
   * PARENT container of a carousel — not on a Story, which has no co-author
   * concept. The composer offered the field for every Instagram post type
   * while only the first three honoured it, so a carousel's collaborators were
   * accepted, saved and then dropped at publish with no error anywhere.
   */
  private applyCollaborators(containerParams: Record<string, string>, post: PostData): void {
    const raw = post.platformSpecific?.collaborators;
    const names = typeof raw === 'string'
      ? raw.split(',').map((s: string) => s.trim()).filter(Boolean)
      : Array.isArray(raw) ? raw : [];
    if (names.length > 0) {
      containerParams.collaborators = JSON.stringify(names);
    }
  }

  /**
   * Choose the still Instagram shows before a video plays.
   *
   * Two ways to say it, and Instagram accepts only one at a time: `cover_url`
   * is any public image, `thumb_offset` is a moment in the video itself. When
   * both are set the image wins — it is the more specific instruction.
   *
   * Both the feed video and the Reel go through this. They were not the same
   * before: a Reel honoured thumb_offset and a feed video silently ignored it,
   * even though both post as media_type REELS through the identical container.
   */
  private applyVideoCover(containerParams: Record<string, string>, post: PostData): void {
    const coverUrl = post.platformSpecific?.coverUrl;
    if (typeof coverUrl === 'string' && coverUrl.trim()) {
      containerParams.cover_url = coverUrl.trim();
      return;
    }

    const thumbOffset = post.platformSpecific?.thumbnailTimestamp;
    if (typeof thumbOffset === 'number' && thumbOffset > 0) {
      containerParams.thumb_offset = String(Math.round(thumbOffset * 1000)); // seconds → ms
    }
  }

  private async publishFeedVideo(
    post: PostData,
    userId: string,
    accessToken: string,
  ): Promise<PublishResult> {
    if (post.mediaFiles.length === 0) {
      return { success: false, error: 'Feed video requires a video file' };
    }

    const videoUrl = post.mediaFiles[0].url;

    const containerParams: Record<string, string> = {
      media_type: 'REELS',
      video_url: videoUrl,
      access_token: accessToken,
    };
    if (post.content) {
      containerParams.caption = post.content;
    }

    this.applyCollaborators(containerParams, post);

    this.applyVideoCover(containerParams, post);

    const container = await this.createMediaContainer(userId, containerParams);

    // Defer finalization to status-check worker.
    this.logger.info({ containerId: container.id }, 'Instagram feed video container created, deferring finalization');
    return {
      success: true,
      processing: true,
      processingId: container.id,
    };
  }

  private async publishReel(
    post: PostData,
    userId: string,
    accessToken: string,
  ): Promise<PublishResult> {
    if (post.mediaFiles.length === 0) {
      return { success: false, error: 'Reel requires a video file' };
    }

    const videoUrl = post.mediaFiles[0].url;

    const containerParams: Record<string, string> = {
      media_type: 'REELS',
      video_url: videoUrl,
      access_token: accessToken,
    };
    if (post.content) {
      containerParams.caption = post.content;
    }

    this.applyCollaborators(containerParams, post);

    // Trial Reels — test content with non-followers before going public
    if (post.platformSpecific?.trialReel) {
      const strategy = post.platformSpecific.graduationStrategy === 'auto' ? 'SS_PERFORMANCE' : 'MANUAL';
      containerParams.trial_params = JSON.stringify({ graduation_strategy: strategy });
    }

    this.applyVideoCover(containerParams, post);

    const container = await this.createMediaContainer(userId, containerParams);

    // Defer finalization to status-check worker.
    this.logger.info({ containerId: container.id, trialReel: !!post.platformSpecific?.trialReel }, 'Instagram reel container created, deferring finalization');
    return {
      success: true,
      processing: true,
      processingId: container.id,
    };
  }

  private async publishStory(
    post: PostData,
    userId: string,
    accessToken: string,
  ): Promise<PublishResult> {
    if (post.mediaFiles.length === 0) {
      return { success: false, error: 'Story requires a photo or video' };
    }

    const mediaFile = post.mediaFiles[0];
    const isVideo = mediaFile.mimeType.startsWith('video/');

    const containerParams: Record<string, string> = {
      media_type: 'STORIES',
      access_token: accessToken,
    };

    if (isVideo) {
      containerParams.video_url = mediaFile.url;
    } else {
      containerParams.image_url = mediaFile.url;
    }

    const container = await this.createMediaContainer(userId, containerParams);

    // Defer finalization to status-check worker.
    this.logger.info({ containerId: container.id }, 'Instagram story container created, deferring finalization');
    return {
      success: true,
      processing: true,
      processingId: container.id,
    };
  }

  private async publishCarousel(
    post: PostData,
    userId: string,
    accessToken: string,
  ): Promise<PublishResult> {
    if (post.mediaFiles.length < 2) {
      return { success: false, error: 'Carousel requires at least 2 media items' };
    }

    if (post.mediaFiles.length > 10) {
      return { success: false, error: 'Carousel supports a maximum of 10 media items' };
    }

    // Step 1: Create child containers for each media item
    const childIds: string[] = [];

    for (const [index, mediaFile] of post.mediaFiles.entries()) {
      const isVideo = mediaFile.mimeType.startsWith('video/');

      const childParams: Record<string, string> = {
        is_carousel_item: 'true',
        access_token: accessToken,
      };

      if (isVideo) {
        childParams.media_type = 'VIDEO';
        childParams.video_url = mediaFile.url;
      } else {
        childParams.image_url = mediaFile.url;
      }

      const child = await this.createMediaContainer(userId, childParams);
      this.logger.debug({ index, containerId: child.id }, 'Carousel child container created');

      // Poll each child until ready
      await this.waitForContainer(child.id, accessToken);
      childIds.push(child.id);
    }

    // Step 2: Create the carousel parent container
    const carouselParams: Record<string, string> = {
      media_type: 'CAROUSEL',
      children: childIds.join(','),
      access_token: accessToken,
    };
    if (post.content) {
      carouselParams.caption = post.content;
    }
    // Co-authors go on the parent, never on the children.
    this.applyCollaborators(carouselParams, post);

    const carouselContainer = await this.createMediaContainer(userId, carouselParams);
    this.logger.debug({ containerId: carouselContainer.id }, 'Carousel parent container created');

    // Step 3: Poll carousel container
    await this.waitForContainer(carouselContainer.id, accessToken);

    // Step 4: Publish
    const result = await this.publishContainer(userId, carouselContainer.id, accessToken);

    this.logger.info({ postId: result.id, itemCount: childIds.length }, 'Instagram carousel published');
    const permalink = await this.getPermalink(result.id, accessToken);
    return {
      success: true,
      postId: result.id,
      url: permalink || `https://www.instagram.com/p/${result.id}/`,
    };
  }

  // ---------------------------------------------------------------------------
  // Private: fetch permalink (shortcode-based URL) from media ID
  // ---------------------------------------------------------------------------

  private async getPermalink(mediaId: string, accessToken: string): Promise<string | undefined> {
    try {
      // Try Instagram Graph API first (works with Instagram user tokens)
      const url = `${GRAPH_URL}/${mediaId}?fields=permalink&access_token=${accessToken}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as { permalink?: string };
        if (data.permalink) return data.permalink;
      }
      // Fallback to Facebook Graph API (works with Facebook Page tokens)
      const fbUrl = `https://graph.facebook.com/${API_VERSION}/${mediaId}?fields=permalink&access_token=${accessToken}`;
      const fbRes = await fetch(fbUrl);
      if (fbRes.ok) {
        const fbData = (await fbRes.json()) as { permalink?: string };
        if (fbData.permalink) return fbData.permalink;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: container API helpers
  // ---------------------------------------------------------------------------

  private async createMediaContainer(
    userId: string,
    params: Record<string, string>,
  ): Promise<MediaContainerResponse> {
    const url = `${GRAPH_URL}/${userId}/media`;
    const body = new URLSearchParams(params);

    return this.fetchJson<MediaContainerResponse>(url, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  private async publishContainer(
    userId: string,
    containerId: string,
    accessToken: string,
  ): Promise<MediaPublishResponse> {
    const url = `${GRAPH_URL}/${userId}/media_publish`;
    const body = new URLSearchParams({
      creation_id: containerId,
      access_token: accessToken,
    });

    return this.fetchJson<MediaPublishResponse>(url, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  private async pollContainerStatus(
    containerId: string,
    accessToken: string,
  ): Promise<ContainerStatusResponse> {
    const url =
      `${GRAPH_URL}/${containerId}?` +
      `fields=status_code,status` +
      `&access_token=${accessToken}`;

    return this.fetchJson<ContainerStatusResponse>(url);
  }

  private async waitForContainer(
    containerId: string,
    accessToken: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      const status = await this.pollContainerStatus(containerId, accessToken);

      if (status.status_code === 'FINISHED') {
        return;
      }

      if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
        throw new Error(
          `Instagram media container ${containerId} failed with status: ${status.status_code}${status.status ? ` — ${status.status}` : ''}`,
        );
      }

      // Still IN_PROGRESS, wait before next poll
      this.logger.debug(
        { containerId, attempt: attempt + 1, status: status.status_code },
        'Waiting for container to be ready',
      );

      await this.sleep(POLL_DELAYS_MS[attempt] ?? POLL_FALLBACK_MS);
    }

    // Nothing has been published: the container is still transcoding. Worded
    // as a retry, not a timeout — "timed out" classifies as an unknown
    // outcome and marked the post unconfirmed with no media_publish sent.
    throw new Error(
      `Instagram is still processing media container ${containerId} after ${POLL_MAX_ATTEMPTS} checks; try again later`,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async getAccountAnalytics(
    channel: ChannelData,
  ): Promise<{ followers?: number; following?: number; impressions?: number; reach?: number; profileViews?: number; websiteClicks?: number; platformSpecific?: Record<string, number> } | null> {
    if (!channel.accessToken) return null;

    try {
      const userId = channel.accountId;

      // Fetch basic profile counts
      const profile = await this.fetchJson<{
        followers_count?: number;
        follows_count?: number;
        media_count?: number;
      }>(
        `${GRAPH_URL}/${userId}?fields=followers_count,follows_count,media_count&access_token=${channel.accessToken}`,
      );

      const result: { followers?: number; following?: number; impressions?: number; reach?: number; profileViews?: number; websiteClicks?: number; platformSpecific?: Record<string, number> } = {
        followers: profile.followers_count,
        following: profile.follows_count,
      };

      if (profile.media_count != null) {
        result.platformSpecific = { mediaCount: profile.media_count };
      }

      // Account-level insights (requires instagram_business_manage_insights).
      //
      // Two calls, not one. `profile_views` and `website_clicks` were removed
      // from the IG User insights metric set — the replacements are `views` and
      // `profile_links_taps`, and those are `total_value` metrics that cannot be
      // requested with `period=day`. Meta rejects a request if ANY metric in the
      // list is invalid or mismatches the metric_type, so the single combined
      // call was 400ing outright and Instagram accounts recorded no reach,
      // impressions, profile views or website clicks at all.
      type InsightsResponse = {
        data?: Array<{
          name: string;
          values?: Array<{ value: number }>;
          total_value?: { value: number };
        }>;
      };
      const readInsights = async (query: string) => {
        try {
          const insights = await this.fetchJson<InsightsResponse>(
            `${GRAPH_URL}/${userId}/insights?${query}&access_token=${channel.accessToken}`,
            {},
            { quiet: true }, // permission is often absent — not worth an error log
          );
          for (const metric of insights.data ?? []) {
            const value = metric.total_value?.value ?? metric.values?.[0]?.value ?? 0;
            switch (metric.name) {
              case 'reach':
                result.reach = value;
                break;
              case 'views':
                result.impressions = value;
                break;
              case 'profile_links_taps':
                result.websiteClicks = value;
                break;
            }
          }
        } catch {
          // One family failing must not take the other down with it.
        }
      };

      await readInsights('metric=reach&period=day');
      await readInsights('metric=views,profile_links_taps&metric_type=total_value&period=day');

      // `views` is the closest thing IG still exposes to impressions; fall back
      // to reach so the card isn't blank when only the day-period call succeeds.
      if (result.impressions == null && result.reach != null) result.impressions = result.reach;

      return result;
    } catch (error) {
      this.logger.warn({ error }, 'Failed to fetch Instagram account analytics');
      return null;
    }
  }

  async publishComment(
    channel: ChannelData,
    platformPostId: string,
    comment: string,
  ): Promise<{ success: boolean; error?: string }> {
    // FB-Login (business) accounts comment via the FB Graph API with a Page token stored
    // in metadata; Instagram-Login accounts have no Page token and comment directly with
    // the Instagram token on graph.instagram.com (this path was previously broken — it
    // hard-required a Page token, so first-comment / auto-plug never worked for IG-Login).
    const rawPageToken = (channel.metadata as any)?.pageAccessToken;
    const pageToken = rawPageToken ? decrypt(rawPageToken) : undefined;
    const url = pageToken
      ? `https://graph.facebook.com/v21.0/${platformPostId}/comments`
      : `https://graph.instagram.com/${platformPostId}/comments`;
    const token = pageToken || channel.accessToken;
    if (!token) {
      return { success: false, error: 'No access token available for Instagram comments. Please reconnect the account.' };
    }

    try {
      const params = new URLSearchParams({
        message: comment,
        access_token: token,
      });
      const res = await fetch(url, { method: 'POST', body: params });
      const data = (await res.json()) as { id?: string; error?: { message: string } };
      if (data.error) return { success: false, error: data.error.message };
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Instagram exposes commenters (with username) but no per-user liker list —
   * the API only returns aggregate like counts. We surface commenters only.
   */
  async getPostEngagement(
    channel: ChannelData,
    platformPostId: string,
    opts?: { commentsLimit?: number },
  ): Promise<EngagementData> {
    if (!channel.accessToken) {
      return { comments: [], reactions: [], notice: 'No access token', commentsNotice: 'No access token' };
    }
    const limit = Math.min(opts?.commentsLimit ?? 25, 50);

    // Same branch as publishComment: a stored Page token talks to the FB Graph,
    // otherwise the IG-Login token talks to graph.instagram.com.
    const rawPageTok = (channel.metadata as Record<string, unknown> | undefined)?.pageAccessToken as string | undefined;
    const pageTok = rawPageTok ? decrypt(rawPageTok) : undefined;
    const commentsBase = pageTok
      ? `https://graph.facebook.com/${API_VERSION}`
      : 'https://graph.instagram.com';
    const commentsToken = pageTok || channel.accessToken;
    const result: EngagementData = {
      comments: [],
      reactions: [],
      reactionsUnsupported: true,
      notice: 'Instagram only shows who commented, not who liked.',
    };

    try {
      const data = await this.fetchJson<{
        data?: Array<{
          id: string;
          text?: string;
          timestamp?: string;
          like_count?: number;
          username?: string;
          from?: { id?: string; username?: string };
          replies?: {
            data?: Array<{
              id: string;
              text?: string;
              timestamp?: string;
              like_count?: number;
              username?: string;
              from?: { id?: string; username?: string };
            }>;
          };
        }>;
        paging?: { next?: string };
      }>(
        // The `replies` expansion is required — /comments returns only
        // top-level comments, so replies to a comment never appeared.
        // Host must follow the token: an Instagram-Login token is not valid on
        // graph.facebook.com. publishComment already branches this way; this
        // call hardcoded the FB host, so for IG-Login channels (all of ours)
        // it threw and the tab silently showed no comments at all.
        `${commentsBase}/${encodeURIComponent(platformPostId)}/comments?fields=id,text,timestamp,like_count,username,from{id,username},replies{id,text,timestamp,like_count,username,from{id,username}}&limit=${limit}&access_token=${commentsToken}`,
      );

      let truncated = false;
      for (const c of data.data ?? []) {
        if (result.comments.length >= limit) { truncated = true; break; }
        if (!c.text) continue;
        const username = c.username ?? c.from?.username;
        result.comments.push({
          id: c.id,
          text: c.text,
          createdAt: c.timestamp,
          likeCount: c.like_count,
          actor: {
            id: c.from?.id ?? c.id,
            name: username ?? 'Instagram User',
            handle: username,
            profileUrl: username ? `https://instagram.com/${username}` : undefined,
          },
        });

        for (const r of c.replies?.data ?? []) {
          if (result.comments.length >= limit) { truncated = true; break; }
          if (!r.text) continue;
          const rUser = r.username ?? r.from?.username;
          result.comments.push({
            id: r.id,
            text: r.text,
            createdAt: r.timestamp,
            likeCount: r.like_count,
            parentId: c.id,
            actor: {
              id: r.from?.id ?? r.id,
              name: rUser ?? 'Instagram User',
              handle: rUser,
              profileUrl: rUser ? `https://instagram.com/${rUser}` : undefined,
            },
          });
        }
      }
      // `||`, not `=`: replies are appended into the same budget as top-level
      // comments, so hitting `limit` mid-thread is also "there is more". A bare
      // assignment from `paging.next` erased that and hid the truncation.
      result.hasMoreComments = truncated || !!data.paging?.next;
    } catch (error) {
      this.logger.warn({ error, platformPostId }, 'Instagram comments fetch failed');
      result.notice = 'Comments unavailable';
      result.commentsNotice = 'Comments unavailable';
    }

    return result;
  }
}
