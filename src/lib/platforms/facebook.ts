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

const API_VERSION = 'v24.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

/**
 * Meta Graph error codes that mean "the platform, not your post": 1 = API
 * Unknown (the "reduce the amount of data you're asking for" throttle),
 * 2 = API Service, 4 = app-level rate limit, 17 = user-level rate limit,
 * 32 = page-level rate limit, 341 = temporary app-level limit,
 * 613 = calls-per-second limit. All resolve on their own.
 * https://developers.facebook.com/docs/graph-api/guides/error-handling
 */
const META_TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

/**
 * Errors that really are about the uploaded file, and only those, get the
 * format guidance appended.
 */
const MEDIA_ERROR_PATTERN =
  /\b(?:video|photo|image|media|file|upload|format|codec|aspect ratio|resolution|duration|too large|size)\b/i;

const config: PlatformConfig = {
  name: 'facebook',
  displayName: 'Facebook',
  icon: 'facebook',
  color: '#1877F2',
  authType: 'sdk',
  postTypes: [
    {
      value: 'post',
      label: 'Post',
      description: 'Text, photo, or video post to your page',
      maxMedia: 10,
      allowedMediaTypes: ['image', 'video'],
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
  ],
  mediaRules: {
    photo: { maxSizeMB: 10, formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'], maxCount: 10 },
    video: { maxSizeMB: 2048, formats: ['mp4', 'mov', 'avi', 'wmv'], maxCount: 1 },
  },
};

export class FacebookHandler extends PlatformHandler {
  constructor() {
    super(config);
  }

  // Facebook uses client-side SDK (Facebook Login for Business) — not server-side OAuth.
  // These stubs satisfy the abstract base class but are never called.
  async getOAuthUrl(): Promise<string> {
    throw new Error('Facebook uses client-side SDK authentication, not server-side OAuth.');
  }

  async exchangeCodeForToken(): Promise<{ accessToken: string; expiresIn: number; userId: string }> {
    throw new Error('Facebook uses client-side SDK authentication, not server-side OAuth.');
  }

  async getAccountInfo(accessToken: string): Promise<AccountInfo> {
    const data = await this.fetchJson<{
      id: string;
      name: string;
      picture?: { data?: { url?: string } };
    }>(`${BASE_URL}/me?fields=id,name,picture`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    return {
      id: data.id,
      name: data.name,
      profileImage: data.picture?.data?.url,
      accountType: 'page',
    };
  }

  async getPostMetrics(
    channel: ChannelData,
    platformPostIds: string[],
  ): Promise<Map<string, MetricsData>> {
    const results = new Map<string, MetricsData>();
    if (!channel.accessToken || platformPostIds.length === 0) return results;

    for (const postId of platformPostIds) {
      try {
        // Fetch basic engagement counts — try with shares first, retry without
        // (Reels don't have a shares field, causing a 400 error)
        let data: {
          id?: string;
          shares?: { count: number };
          likes?: { summary?: { total_count?: number } };
          comments?: { summary?: { total_count?: number } };
        };
        try {
          // `shares` is invalid on Reels/Stories and 400s — expected, so probe quietly.
          data = await this.fetchJson(
            // .filter(stream) — a bare comments.summary(true) counts TOP-LEVEL
            // comments only, so replies never showed up in the metric.
            `${BASE_URL}/${postId}?fields=shares,likes.summary(true),comments.filter(stream).summary(true)&access_token=${channel.accessToken}`,
            {},
            { quiet: true },
          );
        } catch {
          // shares field doesn't exist on Reels/Stories — retry without it
          data = await this.fetchJson(
            `${BASE_URL}/${postId}?fields=likes.summary(true),comments.filter(stream).summary(true)&access_token=${channel.accessToken}`,
            {},
            { quiet: true },
          );
        }

        const metrics: MetricsData = {
          likes: data.likes?.summary?.total_count ?? 0,
          comments: data.comments?.summary?.total_count ?? 0,
          shares: data.shares?.count ?? 0,
        };

        // Insights are addressed by the PAGE-QUALIFIED post id.
        //
        // We store the bare post id for most posts (34 of 39 production rows).
        // A bare id resolves fine as an object — GET /{bare}?fields=id returns
        // 200 — but the insights edge does not exist on it:
        //   400 (#100) "Tried accessing nonexisting field (insights)"
        // Prefixing with the page id makes the same call return real data
        // (verified live: 218 for post_total_media_view_unique on a post that
        // had been recording 0). This is why Facebook impressions/reach/clicks
        // were ~0 across the board while likes and comments worked — the basic
        // engagement fields above are happy with a bare id.
        //
        // Not a read_insights problem: that permission is granted and the
        // qualified call succeeds with the same token.
        const qualifiedId = postId.includes('_')
          ? postId
          : `${channel.accountId}_${postId}`;
        try {
          const insights = await this.fetchJson<{
            data?: Array<{
              name: string;
              /** 'lifetime' | 'day' | … — the same metric arrives once per period. */
              period?: string;
              values?: Array<{ value: number | Record<string, number> }>;
            }>;
          }>(
            // post_impressions/post_engaged_users/post_video_views were removed by Meta
            // on 2026-06-15 — confirmed still rejected on v23.0 with
            // "(#100) The value must be a valid insights metric".
            // post_total_media_view_unique (unique media views = reach) is the
            // v23.0+ replacement.
            `${BASE_URL}/${qualifiedId}/insights?metric=post_total_media_view_unique,post_clicks,post_reactions_by_type_total&access_token=${channel.accessToken}`,
            {},
            { quiet: true }, // insights can still fail (dead token, unsupported post type)
          );

          if (insights.data) {
            // Facebook returns the SAME metric more than once, one entry per
            // period, and a plain loop lets the last one win. Verified live:
            //
            //   post_total_media_view_unique  period=lifetime  value=474
            //   post_clicks                   period=lifetime  value=0
            //   post_total_media_view_unique  period=day       value=0, 0
            //
            // The day series is per-day and reads 0 for a post with no traffic
            // in the last 48h, so it silently overwrote the real lifetime 474
            // with 0. That zeroed impressions and reach on posts whose insights
            // were otherwise being fetched correctly.
            //
            // Keep the lifetime entry wherever one exists; these are cumulative
            // totals, which is what every consumer of these columns expects.
            const byName = new Map<string, (typeof insights.data)[number]>();
            for (const metric of insights.data) {
              const existing = byName.get(metric.name);
              if (!existing || metric.period === 'lifetime') byName.set(metric.name, metric);
            }

            for (const metric of byName.values()) {
              const rawValue = metric.values?.[0]?.value;
              const numericValue = typeof rawValue === 'number' ? rawValue : 0;

              switch (metric.name) {
                case 'post_total_media_view_unique':
                  metrics.impressions = numericValue;
                  metrics.reach = numericValue;
                  break;
                case 'post_clicks':
                  metrics.clicks = numericValue;
                  break;
                case 'post_reactions_by_type_total':
                  // rawValue is { like: N, love: N, wow: N, haha: N, sorry: N, anger: N }
                  if (rawValue && typeof rawValue === 'object') {
                    if (!metrics.extra) metrics.extra = {};
                    for (const [type, count] of Object.entries(rawValue)) {
                      metrics.extra[type] = count;
                    }
                  }
                  break;
              }
            }
          }
        } catch {
          // read_insights permission not available — basic metrics still stored
        }

        results.set(postId, metrics);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.warn({ error: msg, postId }, 'Failed to fetch Facebook metrics');
      }
    }

    return results;
  }

  async refreshToken(refreshTokenValue: string): Promise<TokenData | null> {
    try {
      const data = await this.fetchJson<{
        access_token: string;
        token_type: string;
        expires_in?: number;
      }>(
        `${BASE_URL}/oauth/access_token?` +
        `grant_type=fb_exchange_token` +
        `&client_id=${process.env.FACEBOOK_APP_ID}` +
        `&client_secret=${process.env.FACEBOOK_APP_SECRET}` +
        `&fb_exchange_token=${refreshTokenValue}`,
      );

      return {
        accessToken: data.access_token,
        expiresIn: data.expires_in,
      };
    } catch (error) {
      this.logger.error({ error }, 'Failed to refresh Facebook token');
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
        postType: post.postType,
      },
      'Facebook publish started',
    );

    if (!channel.accessToken) {
      return { success: false, error: 'No access token for Facebook account' };
    }

    // Route based on post type
    if (post.postType === 'reel') {
      const videoFile = post.mediaFiles.find((f) => f.mimeType.startsWith('video/'));
      if (!videoFile) {
        return { success: false, error: 'A Reel requires a video.' };
      }
      return this.publishReel(post, channel, videoFile.url);
    }

    if (post.postType === 'story') {
      if (post.mediaFiles.length === 0) {
        return { success: false, error: 'A Story requires an image or video.' };
      }
      const file = post.mediaFiles[0];
      const isVideo = file.mimeType.startsWith('video/');
      return this.publishStory(post, channel, file.url, isVideo);
    }

    // Default post behavior
    const mediaFiles = post.mediaFiles;

    if (mediaFiles.length === 0) {
      return this.publishTextPost(post, channel);
    }

    // Classify media
    const images = mediaFiles.filter((f) => f.mimeType.startsWith('image/'));
    const videos = mediaFiles.filter((f) => f.mimeType.startsWith('video/'));

    if (images.length > 0 && videos.length > 0) {
      return {
        success: false,
        error:
          "Facebook doesn't support mixing photos and videos in one post. Please post them separately.",
      };
    }

    if (videos.length > 1) {
      return {
        success: false,
        error:
          "Facebook doesn't support multiple videos in one post. Please post one video at a time.",
      };
    }

    if (videos.length === 1) {
      return this.publishVideo(post, channel, videos[0].url);
    }

    if (images.length === 1) {
      return this.publishPhoto(post, channel, images[0].url);
    }

    // Multiple images
    return this.publishMultiplePhotos(
      post,
      channel,
      images.map((i) => i.url),
    );
  }

  private async publishTextPost(
    post: PostData,
    channel: ChannelData,
  ): Promise<PublishResult> {
    const endpoint = `${BASE_URL}/${channel.accountId}/feed`;
    const params = new URLSearchParams({
      message: post.content,
      access_token: channel.accessToken,
    });

    if (post.linkPreview?.url) {
      params.set('link', post.linkPreview.url);
    }

    return this.makeRequest(endpoint, params, 'text post', channel);
  }

  private async publishPhoto(
    post: PostData,
    channel: ChannelData,
    photoUrl: string,
  ): Promise<PublishResult> {
    const endpoint = `${BASE_URL}/${channel.accountId}/photos`;
    const params = new URLSearchParams({
      url: photoUrl,
      access_token: channel.accessToken,
    });

    if (post.content) {
      params.set('caption', post.content);
    }

    return this.makeRequest(endpoint, params, 'photo', channel);
  }

  private async publishMultiplePhotos(
    post: PostData,
    channel: ChannelData,
    photoUrls: string[],
  ): Promise<PublishResult> {
    this.logger.info(
      { photoCount: photoUrls.length },
      'Publishing multiple photos to Facebook',
    );

    // Step 1: Upload each photo without publishing
    const attachedMedia: Array<{ media_fbid: string }> = [];

    for (const [index, photoUrl] of photoUrls.entries()) {
      const result = await this.uploadUnpublishedPhoto(
        channel.accountId,
        photoUrl,
        channel.accessToken,
      );

      if ('id' in result) {
        attachedMedia.push({ media_fbid: result.id });
        this.logger.debug({ index, photoId: result.id }, 'Photo uploaded');
      } else {
        this.logger.warn({ index, photoUrl, error: result.error }, 'Failed to upload photo');
      }
    }

    if (attachedMedia.length === 0) {
      return { success: false, error: 'Failed to upload photos to Facebook' };
    }

    // Step 2: Publish all photos together
    const endpoint = `${BASE_URL}/${channel.accountId}/feed`;
    const params = new URLSearchParams({
      attached_media: JSON.stringify(attachedMedia),
      access_token: channel.accessToken,
    });

    if (post.content) {
      params.set('message', post.content);
    }

    return this.makeRequest(endpoint, params, 'multiple photos', channel);
  }

  private async uploadUnpublishedPhoto(
    pageId: string,
    photoUrl: string,
    accessToken: string,
  ): Promise<{ id: string } | { error: string }> {
    const endpoint = `${BASE_URL}/${pageId}/photos`;
    const params = new URLSearchParams({
      url: photoUrl,
      published: 'false',
      access_token: accessToken,
    });

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        body: params,
      });
      const data = (await response.json()) as { id?: string; error?: { message?: string; code?: number } };
      if (!response.ok || data.error) {
        const fbMsg = data.error?.message || `HTTP ${response.status}`;
        this.logger.error({ status: response.status, fbError: data.error }, 'Facebook rejected unpublished photo upload');
        return { error: fbMsg };
      }
      return data.id ? { id: data.id } : { error: 'No photo ID returned' };
    } catch (error) {
      this.logger.error({ error }, 'Failed to upload unpublished photo');
      return { error: error instanceof Error ? error.message : 'Network error' };
    }
  }

  private async publishVideo(
    post: PostData,
    channel: ChannelData,
    videoUrl: string,
  ): Promise<PublishResult> {
    const endpoint = `${BASE_URL}/${channel.accountId}/videos`;
    const params = new URLSearchParams({
      file_url: videoUrl,
      access_token: channel.accessToken,
    });

    if (post.content) {
      params.set('description', post.content);
    }

    this.logger.info(
      { videoUrl, note: 'Vertical videos automatically shown as Reels' },
      'Publishing video to Facebook',
    );

    return this.makeRequest(endpoint, params, 'video', channel);
  }

  private async publishReel(
    post: PostData,
    channel: ChannelData,
    videoUrl: string,
  ): Promise<PublishResult> {
    const endpoint = `${BASE_URL}/${channel.accountId}/video_reels`;
    const params = new URLSearchParams({
      upload_phase: 'finish',
      video_url: videoUrl,
      access_token: channel.accessToken,
    });

    if (post.content) {
      params.set('description', post.content);
    }

    this.logger.info({ videoUrl }, 'Publishing Reel to Facebook');
    return this.makeRequest(endpoint, params, 'reel', channel);
  }

  private async publishStory(
    post: PostData,
    channel: ChannelData,
    mediaUrl: string,
    isVideo: boolean,
  ): Promise<PublishResult> {
    if (isVideo) {
      // Upload video first, then create story
      const videoEndpoint = `${BASE_URL}/${channel.accountId}/videos`;
      const videoParams = new URLSearchParams({
        file_url: mediaUrl,
        published: 'false',
        access_token: channel.accessToken,
      });

      try {
        const videoRes = await fetch(videoEndpoint, {
          method: 'POST',
          body: videoParams,
        });
        const videoData = (await videoRes.json()) as { id?: string };

        if (!videoData.id) {
          return { success: false, error: 'Failed to upload video for story' };
        }

        // Creating the story before the video finishes processing fails, so poll
        // its status first. Facebook may report 'upload_complete' before 'ready';
        // both are safe to publish from.
        const maxAttempts = 30;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const statusRes = await fetch(
            `${BASE_URL}/${videoData.id}?fields=status&access_token=${channel.accessToken}`,
          );
          const statusData = (await statusRes.json()) as {
            status?: { video_status?: string };
          };
          const videoStatus = statusData.status?.video_status ?? 'error';

          if (videoStatus === 'upload_complete' || videoStatus === 'ready') {
            break;
          }
          if (videoStatus === 'error') {
            return { success: false, error: 'Story video processing failed' };
          }
          if (attempt === maxAttempts - 1) {
            return { success: false, error: 'Timed out waiting for story video to process' };
          }
          await new Promise((resolve) => setTimeout(resolve, 10_000));
        }

        const storyEndpoint = `${BASE_URL}/${channel.accountId}/video_stories`;
        const storyParams = new URLSearchParams({
          video_id: videoData.id,
          access_token: channel.accessToken,
        });

        this.logger.info({ videoId: videoData.id }, 'Publishing video Story to Facebook');
        return this.makeRequest(storyEndpoint, storyParams, 'video story', channel, { skipPermalink: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: `Failed to create video story: ${message}` };
      }
    } else {
      // Upload photo as unpublished, then create story
      const photoResult = await this.uploadUnpublishedPhoto(
        channel.accountId,
        mediaUrl,
        channel.accessToken,
      );

      if ('error' in photoResult) {
        return { success: false, error: `Failed to upload photo for story: ${photoResult.error}` };
      }

      const storyEndpoint = `${BASE_URL}/${channel.accountId}/photo_stories`;
      const storyParams = new URLSearchParams({
        photo_id: photoResult.id,
        access_token: channel.accessToken,
      });

      this.logger.info({ photoId: photoResult.id }, 'Publishing photo Story to Facebook');
      return this.makeRequest(storyEndpoint, storyParams, 'photo story', channel, { skipPermalink: true });
    }
  }

  private async makeRequest(
    endpoint: string,
    params: URLSearchParams,
    contentType: string,
    channel: ChannelData,
    options?: { skipPermalink?: boolean },
  ): Promise<PublishResult> {
    try {
      const url = new URL(endpoint);
      // Only request permalink_url on /feed endpoint — photos, videos, stories don't support it
      const isFeedEndpoint = url.pathname.endsWith('/feed');
      if (!options?.skipPermalink && isFeedEndpoint) {
        url.searchParams.set('fields', 'id,permalink_url');
      }

      const response = await fetch(url.toString(), {
        method: 'POST',
        body: params,
      });

      const data = (await response.json()) as {
        id?: string;
        post_id?: string;
        success?: boolean;
        permalink_url?: string;
        error?: { message: string; code: number; type: string };
      };

      if (response.ok && data.id) {
        // Use API-returned permalink (authoritative), fall back to constructed URL
        let postUrl = data.permalink_url;
        if (!postUrl) {
          const [pageId, fbPostId] = data.id.split('_');
          postUrl = fbPostId
            ? `https://www.facebook.com/${pageId}/posts/${fbPostId}`
            : `https://www.facebook.com/${data.id}`;
        }

        this.logger.info(
          { postId: data.id, contentType },
          `Facebook ${contentType} published successfully`,
        );

        return {
          success: true,
          postId: data.id,
          url: postUrl,
        };
      }

      // Story endpoints (/photo_stories, /video_stories) return { success, post_id }
      // instead of { id } — without capturing post_id the row is stored with a NULL
      // platformPostId and is excluded from metrics/engagement/first-comment forever.
      if (response.ok && data.success) {
        const storyId = data.post_id;
        this.logger.info({ contentType, postId: storyId }, `Facebook ${contentType} published${storyId ? '' : ' (no post ID returned)'}`);
        return {
          success: true,
          ...(storyId ? { postId: storyId } : {}),
        };
      }

      const errorMessage = data.error?.message || `Facebook API returned no post ID (HTTP ${response.status})`;
      const errorCode = data.error?.code;

      this.logger.error(
        {
          status: response.status,
          errorMessage,
          errorCode,
          contentType,
          responseBody: JSON.stringify(data).slice(0, 500),
        },
        `Facebook ${contentType} publish failed`,
      );

      return {
        success: false,
        error: this.getUserFriendlyError(errorMessage, errorCode, contentType),
        // Graph API code 190 = access token expired/invalid/revoked (subcodes
        // 458/460/463/467) → the user must reconnect. Code 200 is a *permission*
        // problem (fix permissions, not the token), so it is NOT flagged here.
        authExpired: errorCode === 190,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: message }, 'Facebook API request failed');
      return { success: false, error: message };
    }
  }

  async getAccountAnalytics(
    channel: ChannelData,
  ): Promise<{ followers?: number; following?: number; impressions?: number; reach?: number; profileViews?: number; websiteClicks?: number; platformSpecific?: Record<string, number> } | null> {
    if (!channel.accessToken) return null;

    try {
      // Fetch page follower/fan counts
      const pageData = await this.fetchJson<{
        followers_count?: number;
        fan_count?: number;
      }>(
        `${BASE_URL}/${channel.accountId}?fields=followers_count,fan_count&access_token=${channel.accessToken}`,
      );

      const result: { followers?: number; impressions?: number; profileViews?: number; platformSpecific?: Record<string, number> } = {
        followers: pageData.followers_count ?? pageData.fan_count,
      };

      if (pageData.fan_count != null && pageData.followers_count != null) {
        result.platformSpecific = { fanCount: pageData.fan_count };
      }

      // Try to fetch page insights (requires read_insights permission)
      try {
        const insights = await this.fetchJson<{
          data?: Array<{
            name: string;
            values?: Array<{ value: number }>;
          }>;
        }>(
          // page_impressions_unique was removed by Meta on 2026-06-15;
          // page_total_media_view_unique (unique media views) is the v23.0+ replacement.
          `${BASE_URL}/${channel.accountId}/insights?metric=page_total_media_view_unique,page_views_total&period=day&access_token=${channel.accessToken}`,
        );

        if (insights.data) {
          for (const metric of insights.data) {
            const value = metric.values?.[0]?.value ?? 0;
            switch (metric.name) {
              case 'page_total_media_view_unique':
                result.impressions = value;
                break;
              case 'page_views_total':
                result.profileViews = value;
                break;
            }
          }
        }
      } catch {
        // read_insights permission not available — basic counts still returned
      }

      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn({ error: msg }, 'Failed to fetch Facebook account analytics');
      return null;
    }
  }

  async publishComment(
    channel: ChannelData,
    platformPostId: string,
    comment: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const url = `${BASE_URL}/${platformPostId}/comments`;
      const params = new URLSearchParams({
        message: comment,
        access_token: channel.accessToken,
      });
      const res = await fetch(url, { method: 'POST', body: params });
      const data = (await res.json()) as { id?: string; error?: { message: string } };
      if (data.error) return { success: false, error: data.error.message };
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private getUserFriendlyError(
    message: string,
    code: number | undefined,
    contentType: string,
  ): string {
    const errorMap: Record<number, string> = {
      190: 'Access token expired. Please reconnect your Facebook account.',
      200: 'Permission denied. Please re-authorize your Facebook account.',
      368: 'Temporarily blocked from posting. Please try again later.',
    };

    if (
      code === 100 &&
      message.includes('does not exist')
    ) {
      return 'Cannot post to this account. Only Facebook Pages can receive posts. Please connect a Facebook Page.';
    }

    if (code && errorMap[code]) {
      return errorMap[code];
    }

    // Meta's generic throttle/transient codes. Code 1 is the "Please reduce the
    // amount of data you're asking for, then retry your request" response — it
    // says nothing about the post, and prod carried a real Facebook video
    // failure reading "…retry your request Videos must be MP4/MOV format, under
    // 2GB", which sent the user off to re-encode a perfectly valid file.
    // The wording here is also what classifyPublishError() matches on to retry.
    if (code != null && META_TRANSIENT_CODES.has(code)) {
      return 'Facebook was temporarily unavailable or rate-limiting. Please try again later.';
    }

    // Only attach format guidance when the failure is actually about the media.
    // Appending it to every unmapped error turned unrelated platform faults into
    // confident, wrong advice about the user's file.
    if (MEDIA_ERROR_PATTERN.test(message)) {
      const guidance =
        contentType === 'video'
          ? ' Videos must be MP4/MOV format, under 2GB.'
          : contentType === 'photo'
            ? ' Photos must be JPG, PNG, or GIF format.'
            : '';
      // Meta messages don't end in punctuation, so a bare concat read as one
      // run-on sentence ("Missing or invalid image file Photos must be…").
      if (guidance) return `${message.replace(/\s*$/, '').replace(/\.?$/, '.')}${guidance}`;
    }

    return message;
  }

  /**
   * Fetch commenters + reactors on a page post. Uses Graph API edges
   * `{post-id}/comments` and `{post-id}/reactions` with `from{name,id,picture}`
   * — the page access token already carries `pages_read_engagement`.
   */
  async getPostEngagement(
    channel: ChannelData,
    platformPostId: string,
    opts?: { commentsLimit?: number; reactionsLimit?: number },
  ): Promise<EngagementData> {
    if (!channel.accessToken) {
      return { comments: [], reactions: [], notice: 'No access token', commentsNotice: 'No access token' };
    }
    const commentsLimit = Math.min(opts?.commentsLimit ?? 25, 100);
    const reactionsLimit = Math.min(opts?.reactionsLimit ?? 25, 100);
    const result: EngagementData = { comments: [], reactions: [] };

    try {
      const data = await this.fetchJson<{
        data?: Array<{
          id: string;
          message?: string;
          created_time?: string;
          like_count?: number;
          from?: { id: string; name?: string; picture?: { data?: { url?: string } } };
          parent?: { id?: string };
        }>;
        paging?: { next?: string };
      }>(
        // filter=stream returns replies as well as top-level comments — the
        // default (`toplevel`) silently hid every reply, so a comment thread
        // showed only its first message. `parent` lets the UI nest them.
        `${BASE_URL}/${encodeURIComponent(platformPostId)}/comments?fields=id,message,created_time,like_count,parent{id},from{id,name,picture}&filter=stream&order=chronological&limit=${commentsLimit}&access_token=${channel.accessToken}`,
      );

      for (const c of data.data ?? []) {
        if (!c.message) continue;
        result.comments.push({
          id: c.id,
          text: c.message,
          createdAt: c.created_time,
          likeCount: c.like_count,
          parentId: c.parent?.id,
          actor: {
            id: c.from?.id ?? 'unknown',
            name: c.from?.name ?? 'Facebook User',
            profileImage: c.from?.picture?.data?.url,
            profileUrl: c.from?.id ? `https://facebook.com/${c.from.id}` : undefined,
          },
        });
      }
      result.hasMoreComments = !!data.paging?.next;
    } catch (error) {
      this.logger.warn({ error, platformPostId }, 'Facebook comments fetch failed');
      result.notice = 'Comments unavailable';
      result.commentsNotice = 'Comments unavailable';
    }

    try {
      const data = await this.fetchJson<{
        data?: Array<{
          id: string;
          name?: string;
          type?: string;
          pic?: string;
        }>;
        paging?: { next?: string };
      }>(
        `${BASE_URL}/${encodeURIComponent(platformPostId)}/reactions?fields=id,name,type,pic&limit=${reactionsLimit}&access_token=${channel.accessToken}`,
      );

      for (const r of data.data ?? []) {
        result.reactions.push({
          id: `${r.id}:${r.type ?? 'LIKE'}`,
          type: r.type,
          actor: {
            id: r.id,
            name: r.name ?? 'Facebook User',
            profileImage: r.pic,
            profileUrl: `https://facebook.com/${r.id}`,
          },
        });
      }
      result.hasMoreReactions = !!data.paging?.next;
    } catch (error) {
      this.logger.warn({ error, platformPostId }, 'Facebook reactions fetch failed');
      result.notice = result.notice
        ? `${result.notice}; reactions unavailable`
        : 'Reactions unavailable';
    }

    return result;
  }
}
