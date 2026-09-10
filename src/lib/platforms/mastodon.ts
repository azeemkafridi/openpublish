import { readFileSync } from 'node:fs';
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
} from './types';

const config: PlatformConfig = {
  name: 'mastodon',
  displayName: 'Mastodon',
  icon: 'mastodon',
  color: '#6364FF',
  authType: 'oauth',
  postTypes: [
    {
      value: 'post',
      label: 'Post',
      description: 'Post text, images, or video to Mastodon',
      maxMedia: 4,
      allowedMediaTypes: ['image', 'video'],
    },
  ],
  mediaRules: {
    image: {
      maxSizeMB: 16,
      formats: ['jpg', 'jpeg', 'png', 'webp', 'avif', 'heif', 'gif'],
      maxCount: 4,
    },
    video: {
      maxSizeMB: 99,
      formats: ['mp4'],
      maxCount: 1,
      maxDurationSec: 300,
    },
  },
};

export class MastodonHandler extends PlatformHandler {
  constructor() {
    super(config);
  }

  async getOAuthUrl(
    _redirectUri: string,
    _state: string,
  ): Promise<string> {
    throw new Error('Mastodon uses per-instance OAuth. Use the connect flow instead.');
  }

  async exchangeCodeForToken(
    _code: string,
    _redirectUri: string,
  ): Promise<TokenData> {
    throw new Error('Mastodon token exchange is handled in the connect flow.');
  }

  async getAccountInfo(_accessToken: string): Promise<AccountInfo> {
    throw new Error('Mastodon account info is fetched in the connect flow.');
  }

  async publishPost(
    post: PostData,
    channel: ChannelData,
  ): Promise<PublishResult> {
    const instanceUrl = channel.metadata?.instanceUrl as string;
    if (!instanceUrl) {
      return { success: false, error: 'Missing Mastodon instance URL for this account' };
    }

    if (!channel.accessToken) {
      return { success: false, error: 'No access token for Mastodon account' };
    }

    this.logger.info(
      {
        accountId: channel.accountId,
        instanceUrl,
        hasMedia: post.mediaFiles.length > 0,
        mediaCount: post.mediaFiles.length,
      },
      'Mastodon publish started',
    );

    const apiBase = `https://${instanceUrl}/api`;
    const accessToken = channel.accessToken;

    // Validate media constraints
    const images = post.mediaFiles.filter((f) => f.mimeType.startsWith('image/'));
    const videos = post.mediaFiles.filter((f) => f.mimeType.startsWith('video/'));

    if (images.length > 0 && videos.length > 0) {
      return {
        success: false,
        error: "Mastodon doesn't support mixing images and videos in a single post.",
      };
    }

    if (images.length > 4) {
      return {
        success: false,
        error: 'Mastodon allows a maximum of 4 images per post.',
      };
    }

    if (videos.length > 1) {
      return {
        success: false,
        error: 'Mastodon allows a maximum of 1 video per post.',
      };
    }

    // Upload media files
    const mediaIds: string[] = [];
    for (const file of post.mediaFiles) {
      try {
        const mediaId = await this.uploadMedia(file.localPath, file.mimeType, apiBase, accessToken);
        mediaIds.push(mediaId);
        this.logger.debug({ mimeType: file.mimeType }, 'Media uploaded to Mastodon');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error({ error: message }, 'Failed to upload media to Mastodon');
        return { success: false, error: `Failed to upload media: ${message}` };
      }
    }

    // Build status params
    const params: Record<string, unknown> = {
      status: post.content,
    };

    if (mediaIds.length > 0) {
      params.media_ids = mediaIds;
    }

    // Platform-specific options
    const specific = post.platformSpecific || {};
    if (specific.visibility) params.visibility = specific.visibility;
    if (specific.spoilerText) params.spoiler_text = specific.spoilerText;
    if (specific.language) params.language = specific.language;

    try {
      const result = await this.fetchJson<{
        id: string;
        url: string;
      }>(`${apiBase}/v1/statuses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
      });

      this.logger.info(
        { postId: result.id, url: result.url },
        'Mastodon post published successfully',
      );

      return {
        success: true,
        postId: result.id,
        url: result.url,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: message }, 'Failed to publish Mastodon post');
      return { success: false, error: message };
    }
  }

  async publishThread(
    segments: Array<PostData & { sequence: number }>,
    channel: ChannelData,
    alreadyPosted?: ThreadPublishResult['posts'],
  ): Promise<ThreadPublishResult> {
    const instanceUrl = channel.metadata?.instanceUrl as string;
    if (!instanceUrl) {
      return { success: false, error: 'Missing Mastodon instance URL for this account' };
    }

    if (!channel.accessToken) {
      return { success: false, error: 'No access token for Mastodon account' };
    }

    this.logger.info(
      { accountId: channel.accountId, instanceUrl, segmentCount: segments.length },
      'Mastodon thread publish started',
    );

    const apiBase = `https://${instanceUrl}/api`;
    const accessToken = channel.accessToken;
    // Resume a partially-posted thread on retry (skip the live segments, reply-chain from the
    // last one) instead of re-posting the head segments.
    const remaining = alreadyPosted?.length ? segments.slice(alreadyPosted.length) : segments;
    const publishedPosts: ThreadPublishResult['posts'] = alreadyPosted?.length ? [...alreadyPosted] : [];
    let lastPostId: string | undefined = alreadyPosted?.length ? alreadyPosted[alreadyPosted.length - 1].postId : undefined;

    for (const segment of remaining) {
      // Upload media for this segment
      const mediaIds: string[] = [];
      for (const file of segment.mediaFiles) {
        try {
          const mediaId = await this.uploadMedia(file.localPath, file.mimeType, apiBase, accessToken);
          mediaIds.push(mediaId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            posts: publishedPosts,
            error: `Part ${segment.sequence + 1} media upload failed: ${message}`,
          };
        }
      }

      const params: Record<string, unknown> = {
        status: segment.content,
      };

      if (mediaIds.length > 0) params.media_ids = mediaIds;
      if (lastPostId) params.in_reply_to_id = lastPostId;

      try {
        const result = await this.fetchJson<{ id: string; url: string }>(
          `${apiBase}/v1/statuses`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(params),
          },
        );

        publishedPosts!.push({
          sequence: segment.sequence,
          postId: result.id,
          url: result.url,
          parentId: lastPostId,
        });

        lastPostId = result.id;
        this.logger.debug({ id: result.id, sequence: segment.sequence }, 'Thread post published');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error({ error: message, sequence: segment.sequence }, 'Thread post failed');
        return {
          success: false,
          posts: publishedPosts,
          error: `Part ${segment.sequence + 1} failed: ${message}`,
        };
      }
    }

    this.logger.info({ count: publishedPosts!.length }, 'Mastodon thread published successfully');
    return { success: true, posts: publishedPosts };
  }

  async refreshToken(_refreshToken: string): Promise<TokenData | null> {
    // Mastodon tokens don't expire until revoked
    return null;
  }

  /**
   * fetch with a 30 s timeout for the write paths that bypass fetchJson
   * because they read the status themselves. A hung instance used to block
   * the status creation step indefinitely.
   */
  private async timedFetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async uploadMedia(
    localPath: string,
    mimeType: string,
    apiBase: string,
    accessToken: string,
  ): Promise<string> {
    const fileBuffer = readFileSync(localPath);

    // Use FormData for media upload
    const formData = new FormData();
    const blob = new Blob([fileBuffer], { type: mimeType });
    formData.append('file', blob, 'media');

    const response = await this.fetchWithFile(
      `${apiBase}/v2/media`,
      formData,
      {
        Authorization: `Bearer ${accessToken}`,
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Media upload failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as { id: string; url: string };
    // 202 means the attachment (every video) is still being processed; a
    // status created now is refused with "Cannot attach files that have not
    // finished processing" — a permanent failure for every Mastodon video.
    // GET /api/v1/media/:id answers 206 while processing and 200 when ready.
    if (response.status === 202) {
      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const check = await this.fetchJson<{ id: string; url?: string | null }>(
          `${apiBase}/v1/media/${data.id}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        ).catch(() => null);
        if (check && check.url) return data.id;
      }
      throw new Error('Mastodon is still processing the uploaded media; try again later');
    }
    return data.id;
  }

  async publishComment(
    channel: ChannelData,
    platformPostId: string,
    comment: string,
  ): Promise<{ success: boolean; error?: string }> {
    const instanceUrl = channel.metadata?.instanceUrl as string;
    if (!instanceUrl) return { success: false, error: 'Missing Mastodon instance URL' };

    try {
      const url = `https://${instanceUrl}/api/v1/statuses`;
      const response = await this.timedFetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${channel.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status: comment,
          in_reply_to_id: platformPostId,
          visibility: 'public',
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        return { success: false, error: `Mastodon comment failed (${response.status}): ${err}` };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getPostMetrics(
    channel: ChannelData,
    platformPostIds: string[],
  ): Promise<Map<string, MetricsData>> {
    const results = new Map<string, MetricsData>();
    if (!channel.accessToken || platformPostIds.length === 0) return results;

    const instanceUrl = channel.metadata?.instanceUrl as string;
    if (!instanceUrl) return results;

    for (const postId of platformPostIds) {
      try {
        const data = await this.fetchJson<{
          favourites_count?: number;
          reblogs_count?: number;
          replies_count?: number;
        }>(`https://${instanceUrl}/api/v1/statuses/${postId}`, {
          headers: { Authorization: `Bearer ${channel.accessToken}` },
        });

        results.set(postId, {
          likes: data.favourites_count ?? 0,
          shares: data.reblogs_count ?? 0,
          comments: data.replies_count ?? 0,
        });
      } catch (error) {
        this.logger.warn({ error, postId }, 'Failed to fetch Mastodon post metrics');
      }
    }

    return results;
  }

  async getAccountAnalytics(
    channel: ChannelData,
  ): Promise<{
    followers?: number;
    following?: number;
    impressions?: number;
    reach?: number;
    profileViews?: number;
    websiteClicks?: number;
    platformSpecific?: Record<string, number>;
  } | null> {
    if (!channel.accessToken) return null;

    const instanceUrl = channel.metadata?.instanceUrl as string;
    if (!instanceUrl) return null;

    try {
      const data = await this.fetchJson<{
        followers_count?: number;
        following_count?: number;
        statuses_count?: number;
      }>(`https://${instanceUrl}/api/v1/accounts/verify_credentials`, {
        headers: { Authorization: `Bearer ${channel.accessToken}` },
      });

      return {
        followers: data.followers_count,
        following: data.following_count,
        platformSpecific: {
          ...(data.statuses_count != null ? { statusesCount: data.statuses_count } : {}),
        },
      };
    } catch (error) {
      this.logger.warn({ error }, 'Failed to fetch Mastodon account analytics');
      return null;
    }
  }

  /**
   * Mastodon replies live under `/statuses/{id}/context.descendants`; favourites
   * and reblogs each have their own endpoint. All return the actor inline.
   */
  async getPostEngagement(
    channel: ChannelData,
    platformPostId: string,
    opts?: { commentsLimit?: number; reactionsLimit?: number },
  ): Promise<EngagementData> {
    if (!channel.accessToken) {
      return { comments: [], reactions: [], notice: 'No access token', commentsNotice: 'No access token' };
    }
    const instanceUrl = channel.metadata?.instanceUrl as string | undefined;
    if (!instanceUrl) {
      return { comments: [], reactions: [], notice: 'Missing Mastodon instance URL', commentsNotice: 'Missing Mastodon instance URL' };
    }
    const commentsLimit = Math.min(opts?.commentsLimit ?? 25, 80);
    const reactionsLimit = Math.min(opts?.reactionsLimit ?? 25, 80);
    const apiBase = `https://${instanceUrl}/api`;
    const headers = { Authorization: `Bearer ${channel.accessToken}` };
    const result: EngagementData = { comments: [], reactions: [] };

    type MastoAccount = {
      id: string;
      username: string;
      acct?: string;
      display_name?: string;
      avatar?: string;
      url?: string;
      note?: string;
    };

    try {
      const data = await this.fetchJson<{
        descendants?: Array<{
          id: string;
          content?: string;
          created_at?: string;
          favourites_count?: number;
          account?: MastoAccount;
        }>;
      }>(`${apiBase}/v1/statuses/${encodeURIComponent(platformPostId)}/context`, { headers });

      const descendants = data.descendants ?? [];
      for (const d of descendants.slice(0, commentsLimit)) {
        if (!d.account || !d.content) continue;
        result.comments.push({
          id: d.id,
          text: d.content.replace(/<[^>]+>/g, '').trim(),
          createdAt: d.created_at,
          likeCount: d.favourites_count,
          actor: {
            id: d.account.id,
            name: d.account.display_name || d.account.username,
            handle: d.account.acct,
            profileImage: d.account.avatar,
            profileUrl: d.account.url,
          },
        });
      }
      result.hasMoreComments = descendants.length > commentsLimit;
    } catch (error) {
      this.logger.warn({ error, platformPostId }, 'Mastodon replies fetch failed');
      result.notice = 'Replies unavailable';
      result.commentsNotice = 'Replies unavailable';
    }

    try {
      const data = await this.fetchJson<MastoAccount[]>(
        `${apiBase}/v1/statuses/${encodeURIComponent(platformPostId)}/favourited_by?limit=${reactionsLimit}`,
        { headers },
      );
      for (const a of data ?? []) {
        result.reactions.push({
          id: `${a.id}:favourite`,
          type: 'FAVOURITE',
          actor: {
            id: a.id,
            name: a.display_name || a.username,
            handle: a.acct,
            profileImage: a.avatar,
            profileUrl: a.url,
          },
        });
      }
      result.hasMoreReactions = (data?.length ?? 0) >= reactionsLimit;
    } catch (error) {
      this.logger.warn({ error, platformPostId }, 'Mastodon favourites fetch failed');
      result.notice = result.notice
        ? `${result.notice}; favourites unavailable`
        : 'Favourites unavailable';
    }

    // Boosters have their own endpoint (same 80-per-page cap as favourites).
    // Without this the Reactors tab silently showed favouriters only, while
    // the comment above promised both.
    try {
      const data = await this.fetchJson<MastoAccount[]>(
        `${apiBase}/v1/statuses/${encodeURIComponent(platformPostId)}/reblogged_by?limit=${reactionsLimit}`,
        { headers },
      );
      for (const a of data ?? []) {
        result.reactions.push({
          id: `${a.id}:reblog`,
          type: 'REBLOG',
          actor: {
            id: a.id,
            name: a.display_name || a.username,
            handle: a.acct,
            profileImage: a.avatar,
            profileUrl: a.url,
          },
        });
      }
      result.hasMoreReactions =
        result.hasMoreReactions || (data?.length ?? 0) >= reactionsLimit;
    } catch (error) {
      this.logger.warn({ error, platformPostId }, 'Mastodon boosts fetch failed');
      result.notice = result.notice
        ? `${result.notice}; boosts unavailable`
        : 'Boosts unavailable';
    }

    return result;
  }
}
