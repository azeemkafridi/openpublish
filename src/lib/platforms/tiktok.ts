import { PlatformHandler } from './base';
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
import { idToString } from './json-bigint';
import { bareHandle } from './profile-urls';

const API_BASE = 'https://open.tiktokapis.com/v2';

/**
 * Public URL for a TikTok video.
 *
 * `channel.accountName` is stored WITH its leading '@' (e.g. '@surah.pk'), so
 * interpolating it into `.../@${accountName}/...` produced '/@@surah.pk/',
 * which 404s. Strip any leading '@' before adding our own.
 */
export function tiktokVideoUrl(accountName: string, videoId: string): string {
  return `https://www.tiktok.com/@${bareHandle(accountName)}/video/${videoId}`;
}

/**
 * TikTok's documented `fail_reason` values, mapped to something a user can act
 * on. The raw values are lowercase snake_case identifiers ("internal",
 * "spam_risk_text") that we used to surface verbatim — "TikTok processing
 * failed: internal" told nobody anything.
 *
 * `retryable` marks the ones TikTok itself describes as transient, so the
 * status-check worker re-publishes automatically instead of failing the post:
 *   - `internal` — docs: "Some parts of the TikTok server may currently be
 *     unavailable. This is a retryable error."
 *   - `video_pull_failed` / `photo_pull_failed` — a connection error or timeout
 *     while TikTok downloaded the media from our CDN. Same class of transient
 *     network failure the publish worker already retries (classifyPublishError).
 *
 * Source: https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
 */
const TIKTOK_FAIL_REASONS: Record<string, { message: string; retryable?: boolean }> = {
  internal: {
    message: 'TikTok had a temporary problem on their side while processing this post.',
    retryable: true,
  },
  video_pull_failed: {
    message: 'TikTok could not download the video from openPublish (connection error or timeout).',
    retryable: true,
  },
  photo_pull_failed: {
    message: 'TikTok could not download the photos from openPublish (connection error or timeout).',
    retryable: true,
  },
  file_format_check_failed: {
    message: 'TikTok rejected this file format. Use an MP4 or MOV video, or JPEG/WebP images.',
  },
  duration_check_failed: {
    message: "The video's duration is outside the limit TikTok allows for this account.",
  },
  frame_rate_check_failed: {
    message: "TikTok rejected the video's frame rate. Re-export it at a standard rate (e.g. 30fps).",
  },
  picture_size_check_failed: {
    message: 'TikTok rejected the image dimensions. Images must be at most 1080px on the long edge.',
  },
  publish_cancelled: {
    message: 'The upload was cancelled before TikTok finished publishing it.',
  },
  auth_removed: {
    message: 'TikTok access was revoked while this post was publishing. Reconnect the account and try again.',
  },
  spam_risk_too_many_posts: {
    message: "This account hit TikTok's daily posting limit. Try again tomorrow.",
  },
  spam_risk_user_banned_from_posting: {
    message: 'TikTok has banned this account from posting.',
  },
  spam_risk_text: {
    message: 'TikTok flagged the caption as spam. Edit the text and try again.',
  },
  spam_risk: {
    message: 'TikTok flagged this post as spam and refused to publish it.',
  },
};

/**
 * Turn a TikTok `fail_reason` into `{ message, retryable }`. Unknown reasons
 * (TikTok adds them without notice) keep the raw value in the message so
 * support can still see what happened, and are treated as terminal.
 */
export function describeTikTokFailure(failReason: string | undefined): {
  message: string;
  retryable: boolean;
} {
  // hasOwn, not a bare lookup: a reason like "constructor" would otherwise hit
  // Object.prototype and yield an entry with no message.
  const known = failReason && Object.hasOwn(TIKTOK_FAIL_REASONS, failReason)
    ? TIKTOK_FAIL_REASONS[failReason]
    : undefined;
  if (known) {
    return { message: known.message, retryable: known.retryable === true };
  }
  return {
    message: `TikTok rejected this post (${failReason || 'unknown reason'}).`,
    retryable: false,
  };
}

const config: PlatformConfig = {
  name: 'tiktok',
  displayName: 'TikTok',
  icon: 'tiktok',
  color: '#000000',
  authType: 'oauth',
  postTypes: [
    {
      value: 'video',
      label: 'Video',
      description: 'Upload a video to TikTok',
      mediaRequired: true,
      maxMedia: 1,
      allowedMediaTypes: ['video'],
    },
    {
      value: 'photo_slideshow',
      label: 'Photo Slideshow',
      description: 'Create a photo slideshow post (up to 35 images)',
      mediaRequired: true,
      maxMedia: 35,
      allowedMediaTypes: ['image'],
    },
  ],
  mediaRules: {
    video: {
      maxSizeMB: 4096,
      formats: ['mp4', 'mov'],
      maxCount: 1,
    },
    image: {
      maxSizeMB: 20,
      formats: ['jpg', 'jpeg', 'webp'],
      maxCount: 35,
      maxDimension: 1080,
    },
  },
};

export class TikTokHandler extends PlatformHandler {
  constructor() {
    super(config);
  }

  private getClientKey(): string {
    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    if (!clientKey) throw new Error('TIKTOK_CLIENT_KEY not configured');
    return clientKey;
  }

  private getClientSecret(): string {
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
    if (!clientSecret) throw new Error('TIKTOK_CLIENT_SECRET not configured');
    return clientSecret;
  }

  async getOAuthUrl(redirectUri: string, state: string): Promise<string> {
    const clientKey = this.getClientKey();

    // Every scope below is approved on the TikTok app. TikTok rejects the entire
    // login with a "scope" error if we request ANY scope the app isn't approved for,
    // so only add a scope here once it's live in the approved set.
    const scope = [
      'user.info.basic', //   Login Kit — basic profile (open id, avatar, display name)
      'user.info.profile', // creator @username + profile metadata (account label)
      'user.info.stats', //   account analytics — follower/following/likes/video counts
      'video.publish', //     Content Posting API — direct publish
      'video.upload', //      Content Posting API — draft upload
      'video.list', //        per-post analytics via /v2/video/query/
    ].join(',');

    const params = new URLSearchParams({
      client_key: clientKey,
      scope,
      response_type: 'code',
      redirect_uri: redirectUri,
      state: state,
      // Always show TikTok's authorization screen. Without this, TikTok
      // auto-approves whichever account is already logged in to the browser and
      // never offers an account picker — so a user adding a SECOND TikTok
      // channel silently gets the same open_id back, and our upsert just
      // updates the existing row (see channels_unique_account). To them it
      // looks like the connect button does nothing.
      disable_auto_auth: '1',
    });

    return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
  }

  async exchangeCodeForToken(
    code: string,
    redirectUri: string,
  ): Promise<TokenData> {
    const clientKey = this.getClientKey();
    const clientSecret = this.getClientSecret();

    const body = new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });

    const tokenData = await this.fetchJson<{
      open_id: string;
      access_token: string;
      refresh_token: string;
      expires_in: number;
      token_type: string;
    }>(`${API_BASE}/oauth/token/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    return {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresIn: tokenData.expires_in,
      openId: tokenData.open_id,
    };
  }

  async getAccountInfo(accessToken: string): Promise<AccountInfo> {
    const data = await this.fetchJson<{
      data: {
        user: {
          open_id: string;
          union_id: string;
          avatar_url: string;
          display_name: string;
        };
      };
    }>(`${API_BASE}/user/info/?fields=open_id,union_id,avatar_url,display_name`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    let name = data.data.user.display_name;

    // Best-effort: label the channel with the creator's @username via user.info.profile
    // (an approved scope). Wrapped in try/catch so an older token issued before this
    // scope existed — an account connected pre-analytics that hasn't reconnected yet —
    // never blocks connecting the account.
    try {
      const profile = await this.fetchJson<{ data: { user: { username?: string } } }>(
        `${API_BASE}/user/info/?fields=username`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const username = profile.data.user?.username;
      if (username) name = `@${username}`;
    } catch (error) {
      this.logger.warn({ error }, 'TikTok user.info.profile fetch failed (scope not granted?)');
    }

    return {
      id: data.data.user.open_id,
      name,
      profileImage: data.data.user.avatar_url,
      accountType: 'creator',
    };
  }

  /**
   * TikTok's required pre-post query (Content Sharing Guidelines): must be called
   * when rendering the "Post to TikTok" UI so the composer can show the creator's
   * nickname, offer only the privacy levels TikTok returns, grey out interactions
   * the creator disabled in-app, and enforce the max video duration.
   */
  async getCreatorInfo(accessToken: string): Promise<{
    nickname: string;
    avatarUrl: string;
    privacyLevelOptions: string[];
    commentDisabled: boolean;
    duetDisabled: boolean;
    stitchDisabled: boolean;
    maxVideoPostDurationSec: number;
  }> {
    const result = await this.fetchJson<{
      data: {
        creator_nickname: string;
        creator_avatar_url: string;
        creator_username: string;
        privacy_level_options: string[];
        comment_disabled: boolean;
        duet_disabled: boolean;
        stitch_disabled: boolean;
        max_video_post_duration_sec: number;
      };
      error: { code: string; message: string };
    }>(`${API_BASE}/post/publish/creator_info/query/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
    });

    if (result.error && result.error.code !== 'ok') {
      // Per guidelines: when the posting limit is hit, stop the attempt and tell
      // the user to try later rather than letting them compose a doomed post.
      if (result.error.code === 'spam_risk_too_many_posts' || result.error.code === 'spam_risk_user_banned_from_posting') {
        throw new Error('TikTok is not accepting new posts from this account right now. Please try again later.');
      }
      throw new Error(`TikTok creator info failed: ${result.error.message}`);
    }

    return {
      nickname: result.data.creator_nickname,
      avatarUrl: result.data.creator_avatar_url,
      privacyLevelOptions: result.data.privacy_level_options ?? [],
      commentDisabled: !!result.data.comment_disabled,
      duetDisabled: !!result.data.duet_disabled,
      stitchDisabled: !!result.data.stitch_disabled,
      maxVideoPostDurationSec: result.data.max_video_post_duration_sec,
    };
  }

  async publishPost(
    post: PostData,
    channel: ChannelData,
  ): Promise<PublishResult> {
    this.logger.info(
      {
        accountId: channel.accountId,
        postType: post.postType,
        hasMedia: post.mediaFiles.length > 0,
        mediaCount: post.mediaFiles.length,
      },
      'TikTok publish started',
    );

    if (!channel.accessToken) {
      return { success: false, error: 'No access token for TikTok account' };
    }

    // Read TikTok-specific options
    const ttOpts = (post.platformSpecific?.tiktok ?? post.platformSpecific ?? {}) as Record<string, unknown>;
    // Fallback for API/MCP-created posts that omit privacy. The composer UI never
    // relies on this — TikTok's UX guidelines require the user to pick a privacy
    // level manually (no default), enforced by validatePlatformOptions.
    const privacyLevel = (ttOpts.privacyLevel as string) || (post.platformSpecific?.privacy_level as string) || 'PUBLIC_TO_EVERYONE';
    const postInfo: Record<string, unknown> = {
      privacy_level: privacyLevel,
    };

    // Content interaction controls
    if (ttOpts.disableDuet === true) postInfo.disable_duet = true;
    if (ttOpts.disableStitch === true) postInfo.disable_stitch = true;
    if (ttOpts.disableComment === true) postInfo.disable_comment = true;

    // Content disclosure flags
    if (ttOpts.isAigc === true) postInfo.is_aigc = true;
    if (ttOpts.brandContentToggle === true) postInfo.brand_content_toggle = true;
    if (ttOpts.brandOrganicToggle === true) postInfo.brand_organic_toggle = true;

    // Auto-detect post type from media if not explicitly set
    const hasVideo = post.mediaFiles.some((f) => f.mimeType?.startsWith('video/'));
    const hasImages = post.mediaFiles.some((f) => f.mimeType?.startsWith('image/'));

    if (post.postType === 'photo_slideshow' || (!hasVideo && hasImages)) {
      // Photo-only field. Off unless the user opted in — TikTok otherwise picks a
      // random recommended track and the post lands with unexpected background music.
      if (ttOpts.autoAddMusic === true) postInfo.auto_add_music = true;
      return this.publishPhotoSlideshow(post, channel, postInfo);
    }

    return this.publishVideo(post, channel, postInfo);
  }

  private async publishVideo(
    post: PostData,
    channel: ChannelData,
    postInfo: Record<string, unknown>,
  ): Promise<PublishResult> {
    const videoFile = post.mediaFiles.find((f) => f.mimeType.startsWith('video/'));
    if (!videoFile) {
      return { success: false, error: 'No video file provided for TikTok video post' };
    }

    const videoUrl = videoFile.url;
    if (!videoUrl) {
      return { success: false, error: 'No video URL available for TikTok upload' };
    }

    try {
      const result = await this.fetchJson<{
        data: {
          publish_id: string;
        };
        error: {
          code: string;
          message: string;
        };
      }>(`${API_BASE}/post/publish/video/init/`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${channel.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          post_info: {
            ...postInfo,
            title: post.content,
          },
          source_info: {
            source: 'PULL_FROM_URL',
            video_url: videoUrl,
            ...(typeof post.platformSpecific?.thumbnailTimestamp === 'number' && post.platformSpecific.thumbnailTimestamp > 0
              ? { video_cover_timestamp_ms: Math.round(Number(post.platformSpecific.thumbnailTimestamp) * 1000) }
              : {}),
          },
        }),
      });

      if (result.error && result.error.code !== 'ok') {
        this.logger.error(
          { error: result.error },
          'TikTok video publish init failed',
        );
        return {
          success: false,
          error: `TikTok publish failed: ${result.error.message}`,
        };
      }

      const publishId = result.data.publish_id;

      this.logger.info(
        { publishId },
        'TikTok video publish initiated, processing',
      );

      return {
        success: true,
        processing: true,
        processingId: publishId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: message }, 'Failed to publish video to TikTok');
      return { success: false, error: message };
    }
  }

  private async publishPhotoSlideshow(
    post: PostData,
    channel: ChannelData,
    postInfo: Record<string, unknown>,
  ): Promise<PublishResult> {
    const imageFiles = post.mediaFiles.filter((f) =>
      f.mimeType.startsWith('image/'),
    );

    if (imageFiles.length === 0) {
      return {
        success: false,
        error: 'No image files provided for TikTok photo slideshow',
      };
    }

    if (imageFiles.length > 35) {
      return {
        success: false,
        error: 'TikTok photo slideshows support a maximum of 35 images',
      };
    }

    const photoUrls = imageFiles.map((file) => file.url);

    try {
      const result = await this.fetchJson<{
        data: {
          publish_id: string;
        };
        error: {
          code: string;
          message: string;
        };
      }>(`${API_BASE}/post/publish/content/init/`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${channel.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          media_type: 'PHOTO',
          post_mode: 'DIRECT_POST',
          post_info: {
            ...postInfo,
            ...(post.content ? { title: post.content.slice(0, 90), description: post.content } : {}),
          },
          source_info: {
            source: 'PULL_FROM_URL',
            photo_images: photoUrls,
            photo_cover_index: 0,
          },
        }),
      });

      if (result.error && result.error.code !== 'ok') {
        this.logger.error(
          { error: result.error },
          'TikTok photo slideshow publish init failed',
        );
        return {
          success: false,
          error: `TikTok publish failed: ${result.error.message}`,
        };
      }

      const publishId = result.data.publish_id;

      this.logger.info(
        { publishId },
        'TikTok photo slideshow publish initiated, processing',
      );

      return {
        success: true,
        processing: true,
        processingId: publishId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { error: message },
        'Failed to publish photo slideshow to TikTok',
      );
      return { success: false, error: message };
    }
  }

  async checkPublishStatus(
    channel: ChannelData,
    publishId: string,
  ): Promise<StatusResult> {
    try {
      const result = await this.fetchJson<{
        data: {
          status: string;
          publish_id: string;
          uploaded_bytes?: number;
          // Declared `string[]` but TikTok sends bare JSON numbers — hence
          // preserveBigInts + idToString below. See json-bigint.ts.
          publicaly_available_post_id?: Array<string | number>;
          fail_reason?: string;
        };
        error: {
          code: string;
          message: string;
        };
      }>(`${API_BASE}/post/publish/status/fetch/`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${channel.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          publish_id: publishId,
        }),
      }, { preserveBigInts: true });

      if (result.error && result.error.code !== 'ok') {
        return {
          status: 'failed',
          message: result.error.message,
        };
      }

      const tiktokStatus = result.data.status;

      if (tiktokStatus === 'PUBLISH_COMPLETE') {
        const videoId = idToString(result.data.publicaly_available_post_id?.[0]);
        this.logger.info({ publishId, videoId }, 'TikTok publish complete');
        return {
          status: 'published',
          postId: videoId || publishId,
          url: videoId ? tiktokVideoUrl(channel.accountName, videoId) : undefined,
        };
      }

      if (tiktokStatus === 'SEND_TO_USER_INBOX') {
        this.logger.warn({ publishId }, 'TikTok sent video to user inbox — not published to profile');
        return {
          status: 'failed',
          message: 'TikTok sent the video to your inbox instead of publishing it. Open TikTok app to review and post it manually.',
        };
      }

      if (tiktokStatus === 'FAILED') {
        const failReason = result.data.fail_reason;
        const { message, retryable } = describeTikTokFailure(failReason);
        this.logger.error(
          { publishId, failReason, retryable, fullResult: result },
          'TikTok publish failed',
        );
        return {
          status: 'failed',
          // `error.message` is empty on a FAILED status (error.code is 'ok' —
          // the *request* succeeded), so fail_reason is the only signal.
          message: result.error?.message ? `${message} (${result.error.message})` : message,
          retryable,
        };
      }

      // PROCESSING_DOWNLOAD, PROCESSING_UPLOAD, or other intermediate states
      this.logger.debug(
        { publishId, tiktokStatus },
        'TikTok publish still processing',
      );
      return {
        status: 'processing',
        message: `TikTok is processing your content (${tiktokStatus})`,
      };
    } catch (error) {
      // Transient errors (5xx/429/network) propagate so the status-check
      // worker retries — the upload may still be processing or even already
      // live. Only a 4xx rejection is terminal here.
      if (this.isTransientApiError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { error: message, publishId },
        'Failed to check TikTok publish status',
      );
      return {
        status: 'failed',
        message: `Failed to check status: ${message}`,
      };
    }
  }

  async getAccountAnalytics(
    channel: ChannelData,
  ): Promise<{ followers?: number; following?: number; impressions?: number; reach?: number; profileViews?: number; websiteClicks?: number; platformSpecific?: Record<string, number> } | null> {
    if (!channel.accessToken) return null;

    try {
      const data = await this.fetchJson<{
        data: {
          user: {
            follower_count?: number;
            following_count?: number;
            likes_count?: number;
            video_count?: number;
          };
        };
      }>(`${API_BASE}/user/info/?fields=follower_count,following_count,likes_count,video_count`, {
        headers: {
          Authorization: `Bearer ${channel.accessToken}`,
        },
      });

      const user = data.data.user;

      return {
        followers: user.follower_count,
        following: user.following_count,
        platformSpecific: {
          ...(user.likes_count != null ? { likesCount: user.likes_count } : {}),
          ...(user.video_count != null ? { videoCount: user.video_count } : {}),
        },
      };
    } catch (error) {
      this.logger.warn({ error }, 'Failed to fetch TikTok account analytics');
      return null;
    }
  }

  /**
   * The account's own videos, newest first, as exact id strings.
   *
   * Used by the repair path for rows written before the big-int parse fix, whose
   * stored `platform_post_id` was rounded by JSON.parse and no longer matches any
   * real video. A rounded id is recoverable because the rounding is deterministic:
   * String(Number(realId)) reproduces exactly what we stored.
   */
  async listVideos(
    channel: ChannelData,
    maxCount = 20,
  ): Promise<Array<{ id: string; createTime?: number }>> {
    if (!channel.accessToken) return [];
    const out: Array<{ id: string; createTime?: number }> = [];
    let cursor: number | undefined;

    // TikTok caps max_count at 20 per page; page until exhausted or we hit maxCount.
    for (let page = 0; page < 20 && out.length < maxCount; page++) {
      const data = await this.fetchJson<{
        data: {
          videos?: Array<{ id: string | number; create_time?: number }>;
          cursor?: number;
          has_more?: boolean;
        };
        error: { code: string; message: string };
      }>(`${API_BASE}/video/list/?fields=id,create_time`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${channel.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          max_count: Math.min(20, maxCount - out.length),
          ...(cursor ? { cursor } : {}),
        }),
      }, { preserveBigInts: true });

      for (const v of data.data?.videos ?? []) {
        const id = idToString(v.id);
        if (id) out.push({ id, createTime: v.create_time });
      }

      if (!data.data?.has_more || !data.data.cursor) break;
      cursor = data.data.cursor;
    }

    return out;
  }

  async getPostMetrics(
    channel: ChannelData,
    platformPostIds: string[],
  ): Promise<Map<string, MetricsData>> {
    const results = new Map<string, MetricsData>();
    if (!channel.accessToken || platformPostIds.length === 0) return results;

    // TikTok's /video/query/ needs the numeric video ID. Posts published SELF_ONLY
    // (private — required while the app is unaudited) get no public video ID, so we
    // store the publish_id ("v_pub_url~v2-..."); skip non-numeric IDs since they're
    // not queryable and TikTok rejects them ("Video ID ... must be an integer").
    const queryableIds = platformPostIds.filter((id) => /^\d+$/.test(id));
    if (queryableIds.length === 0) return results;

    // TikTok video/query supports up to 20 IDs per request
    const batchSize = 20;
    for (let i = 0; i < queryableIds.length; i += batchSize) {
      const batch = queryableIds.slice(i, i + batchSize);

      try {
        const data = await this.fetchJson<{
          data: {
            videos: Array<{
              // Also a bare JSON number on the wire — without preserveBigInts
              // the key we set here would not match the id we asked for.
              id: string | number;
              like_count?: number;
              comment_count?: number;
              share_count?: number;
              view_count?: number;
            }>;
          };
          error: { code: string; message: string };
        }>(`${API_BASE}/video/query/?fields=id,like_count,comment_count,share_count,view_count`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${channel.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            filters: { video_ids: batch },
          }),
        }, { preserveBigInts: true });

        if (data.data?.videos) {
          for (const video of data.data.videos) {
            const videoId = idToString(video.id);
            if (!videoId) continue;
            results.set(videoId, {
              impressions: video.view_count ?? 0,
              videoViews: video.view_count ?? 0,
              likes: video.like_count ?? 0,
              comments: video.comment_count ?? 0,
              shares: video.share_count ?? 0,
            });
          }
        }
      } catch (error) {
        this.logger.warn({ error, batch: batch.slice(0, 3) }, 'Failed to fetch TikTok metrics batch');
      }
    }

    return results;
  }

  /**
   * Re-resolve a stored publish_id ("v_pub_url~v2-...") to its public numeric video
   * id by re-querying the publish status. A post can reach PUBLISH_COMPLETE before
   * TikTok exposes `publicaly_available_post_id`, leaving us with a publish_id that
   * /video/query/ can't read. Returns null when no public id exists yet (e.g. private
   * post) or the publish_id has expired. Mirrors Postiz's postAnalytics re-resolution.
   */
  async resolvePublishId(
    channel: ChannelData,
    publishId: string,
  ): Promise<string | null> {
    if (!channel.accessToken) return null;

    try {
      const result = await this.fetchJson<{
        data: { publicaly_available_post_id?: Array<string | number> };
        error: { code: string; message: string };
      }>(`${API_BASE}/post/publish/status/fetch/`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${channel.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ publish_id: publishId }),
      }, { preserveBigInts: true });

      if (result.error && result.error.code !== 'ok') return null;

      const videoId = idToString(result.data?.publicaly_available_post_id?.[0]);
      return videoId && /^\d+$/.test(videoId) ? videoId : null;
    } catch (error) {
      this.logger.warn({ error, publishId }, 'TikTok publish_id resolution failed');
      return null;
    }
  }

  async refreshToken(refreshTokenValue: string): Promise<TokenData | null> {
    try {
      const clientKey = this.getClientKey();
      const clientSecret = this.getClientSecret();

      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshTokenValue,
        client_key: clientKey,
        client_secret: clientSecret,
      });

      const tokenData = await this.fetchJson<{
        open_id: string;
        access_token: string;
        refresh_token: string;
        expires_in: number;
      }>(`${API_BASE}/oauth/token/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      return {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresIn: tokenData.expires_in,
        openId: tokenData.open_id,
      };
    } catch (error) {
      this.logger.error({ error }, 'Failed to refresh TikTok token');
      return null;
    }
  }

  /**
   * TikTok exposes no comment or liker data to third-party apps. The Display
   * API covers user info and a video list; comments live only in the Research
   * API, which is restricted to approved academic applicants. Explicit here so
   * the omission is a documented decision rather than a gap.
   */
  async getPostEngagement(): Promise<EngagementData> {
    // `unsupported` keeps the UI from rendering an empty panel for it.
    return { comments: [], reactions: [], unsupported: true, notice: 'TikTok does not expose comments to third-party apps.' };
  }
}
