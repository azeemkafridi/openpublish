import { PlatformHandler } from './base';
import type {
  TokenData,
  AccountInfo,
  PublishResult,
  StatusResult,
  PostData,
  ChannelData,
  PlatformConfig,
  ThreadPublishResult,
  MetricsData,
  EngagementData,
} from './types';
import { bareHandle } from './profile-urls';

const GRAPH_URL = 'https://graph.threads.net/v1.0';

// Back-off schedule for Threads media container polling.
// Start fast for small posts, slow down for videos. Total timeout ~60s.
const POLL_DELAYS_MS = [500, 500, 1000, 1000, 1500, 1500];
const POLL_FALLBACK_MS = 2000;
const POLL_MAX_ATTEMPTS = 30;

/** Fetch the authoritative permalink for a published Threads post (best-effort, never throws). */
/**
 * Newest thread on the account, if it was posted recently enough to be the one
 * we just published.
 *
 * Used to recover the real media ID when a container reports PUBLISHED and we
 * therefore never saw the publish response. Threads' container-status endpoint
 * exposes only `status` and `error_message` — no media ID — so listing the
 * account is the only route.
 *
 * The freshness window is what keeps this honest: without it, a post that was
 * published and then deleted would silently adopt the previous, unrelated
 * thread's ID and start reporting its metrics as ours.
 */
const RECENT_THREAD_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2h

export async function resolveRecentThreadId(
  userId: string,
  accessToken: string | undefined,
  now: number = Date.now(),
): Promise<{ id: string; permalink?: string } | undefined> {
  if (!accessToken) return undefined;
  const controller = new AbortController();
  // Cleared in `finally`: on the throw path an un-cleared timer stays pending
  // and fires abort() against a request nobody is waiting for.
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(
      `${GRAPH_URL}/${userId}/threads?fields=id,permalink,timestamp&limit=5` +
        `&access_token=${accessToken}`,
      { signal: controller.signal },
    );
    if (!res.ok) return undefined;
    const body = (await res.json()) as {
      data?: Array<{ id: string; permalink?: string; timestamp?: string }>;
    };
    const newest = body.data?.[0];
    if (!newest?.id) return undefined;
    if (newest.timestamp) {
      const age = now - new Date(newest.timestamp).getTime();
      if (!Number.isFinite(age) || age > RECENT_THREAD_MAX_AGE_MS) return undefined;
    }
    return { id: newest.id, permalink: newest.permalink };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchThreadsPermalink(threadId: string, accessToken: string): Promise<string | undefined> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${GRAPH_URL}/${threadId}?fields=id,permalink&access_token=${accessToken}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      const data = (await res.json()) as { permalink?: string };
      return data.permalink;
    }
  } catch { /* best-effort — fall back to constructed URL */ }
  return undefined;
}

const config: PlatformConfig = {
  name: 'threads',
  displayName: 'Threads',
  icon: 'threads',
  color: '#000000',
  authType: 'oauth',
  postTypes: [
    {
      value: 'text',
      label: 'Text',
      description: 'Text-only post (up to 500 characters)',
      mediaRequired: false,
      maxMedia: 0,
      allowedMediaTypes: [],
    },
    {
      value: 'image',
      label: 'Image',
      description: 'Single image post with optional text',
      mediaRequired: true,
      maxMedia: 1,
      allowedMediaTypes: ['image'],
    },
    {
      value: 'video',
      label: 'Video',
      description: 'Single video post with optional text',
      mediaRequired: true,
      maxMedia: 1,
      allowedMediaTypes: ['video'],
    },
    {
      value: 'carousel',
      label: 'Carousel',
      description: 'Multiple images/videos in a swipeable post',
      mediaRequired: true,
      maxMedia: 20,
      allowedMediaTypes: ['image', 'video'],
    },
  ],
  mediaRules: {
    image: {
      maxSizeMB: 8,
      formats: ['jpg', 'jpeg', 'png'],
      maxCount: 20,
    },
    video: {
      maxSizeMB: 500,
      formats: ['mp4', 'mov'],
      maxCount: 20,
    },
  },
};

interface ContainerStatusResponse {
  id: string;
  status: 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';
  error_message?: string;
}

interface ThreadContainerResponse {
  id: string;
}

interface ThreadPublishResponse {
  id: string;
}

export class ThreadsHandler extends PlatformHandler {
  constructor() {
    super(config);
  }

  async getOAuthUrl(redirectUri: string, state: string): Promise<string> {
    const appId = process.env.THREADS_APP_ID;
    if (!appId) throw new Error('THREADS_APP_ID not configured');

    const scopes = 'threads_basic,threads_content_publish,threads_read_replies,threads_manage_replies,threads_manage_insights';
    return (
      `https://threads.net/oauth/authorize?` +
      `client_id=${appId}` +
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
    const appId = process.env.THREADS_APP_ID!;
    const appSecret = process.env.THREADS_APP_SECRET!;

    // Step 1: Exchange code for short-lived token
    const shortLivedParams = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    });

    // Threads still returns these top-level (unlike Instagram, which moved to a
    // `data[]` wrapper). Read the wrapper anyway if it ever appears, and assert
    // the fields rather than interpolating `undefined` into step 2.
    const shortLivedRaw = await this.fetchJson<{
      data?: Array<{ access_token?: string; user_id?: number | string }>;
      access_token?: string;
      user_id?: number | string;
    }>(`${GRAPH_URL}/oauth/access_token`, {
      method: 'POST',
      body: shortLivedParams,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const shortLived = shortLivedRaw.data?.[0] ?? shortLivedRaw;
    const shortLivedToken = this.requireOAuthField(shortLived.access_token, 'access_token');
    const shortLivedUserId = this.requireOAuthField(shortLived.user_id, 'user_id');

    // Step 2: Exchange short-lived token for long-lived token
    const longLivedUrl =
      `${GRAPH_URL}/access_token?` +
      `grant_type=th_exchange_token` +
      `&client_secret=${appSecret}` +
      `&access_token=${shortLivedToken}`;

    const longLived = await this.fetchJson<{
      access_token?: string;
      token_type?: string;
      expires_in?: number;
    }>(longLivedUrl);

    const longLivedToken = this.requireOAuthField(longLived.access_token, 'access_token');

    return {
      accessToken: longLivedToken,
      // The long-lived token IS the refresh credential (no separate refresh token); store
      // it so the token-refresh sweep includes this channel and renews it before the
      // ~60-day expiry instead of letting it die silently.
      refreshToken: longLivedToken,
      expiresIn: longLived.expires_in,
      userId: String(shortLivedUserId),
    };
  }

  async refreshToken(refreshTokenValue: string): Promise<TokenData | null> {
    try {
      // Threads long-lived tokens are refreshed with the token itself (must be ≥24h old);
      // returns a fresh ~60-day token.
      const data = await this.fetchJson<{ access_token?: string; expires_in?: number }>(
        `${GRAPH_URL}/refresh_access_token?grant_type=th_refresh_token&access_token=${refreshTokenValue}`,
      );
      // Assert before returning — see the note in the Instagram handler: an
      // unparsed response would overwrite a working token with `undefined`.
      const token = this.requireOAuthField(data.access_token, 'access_token');
      return {
        accessToken: token,
        refreshToken: token,
        expiresIn: data.expires_in,
      };
    } catch (error) {
      this.logger.error({ error }, 'Failed to refresh Threads token');
      // A 5xx, 429 or network failure says nothing about the refresh token;
      // returning null for it read as "cannot be refreshed" and flagged
      // reconnect after one blip. Only a rejection returns null.
      if (this.isTransientRefreshFailure(error)) throw error;
      return null;
    }
  }

  async getAccountInfo(accessToken: string): Promise<AccountInfo> {
    const url =
      `${GRAPH_URL}/me?` +
      `fields=id,username,threads_profile_picture_url` +
      `&access_token=${accessToken}`;

    const data = await this.fetchJson<{
      id: string;
      username: string;
      threads_profile_picture_url?: string;
    }>(url);

    return {
      id: data.id,
      name: data.username,
      profileImage: data.threads_profile_picture_url,
    };
  }

  async publishPost(
    post: PostData,
    channel: ChannelData,
  ): Promise<PublishResult> {
    const postType = post.postType || 'text';
    const userId = channel.accountId;
    const accessToken = channel.accessToken;

    this.logger.info(
      {
        accountId: userId,
        postType,
        hasMedia: post.mediaFiles.length > 0,
        mediaCount: post.mediaFiles.length,
      },
      'Threads publish started',
    );

    if (!accessToken) {
      return { success: false, error: 'No access token for Threads account' };
    }

    try {
      switch (postType) {
        case 'text':
          return await this.publishText(post, userId, accessToken);
        case 'image':
          return await this.publishImage(post, userId, accessToken);
        case 'video':
          return await this.publishVideo(post, userId, accessToken);
        case 'carousel':
          return await this.publishCarousel(post, userId, accessToken);
        default:
          return { success: false, error: `Unsupported post type: ${postType}` };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: message, postType }, 'Threads publish failed');
      return { success: false, error: message };
    }
  }

  async checkPublishStatus(
    channel: ChannelData,
    publishId: string,
  ): Promise<StatusResult> {
    try {
      const status = await this.pollContainerStatus(publishId, channel.accessToken);

      if (status.status === 'PUBLISHED') {
        // Already published on a prior finalization attempt, so we never saw the
        // publish response that carries the real media ID.
        //
        // Storing `publishId` here is wrong: it is the CONTAINER id, and a
        // container is not addressable once published. Verified against the live
        // API — the one production row written this way holds
        // 18125312440780701, and both /{id}?fields=id and /{id}/insights return
        //   400 "Object with ID ... does not exist, cannot be loaded due to
        //        missing permissions, or does not support this operation"
        // so the post had no metrics and no permalink, permanently.
        //
        // Recover it the same way as TikTok: ask the account for its own
        // threads and take the newest. The freshness guard stops us adopting an
        // unrelated older post when the real one is missing (e.g. deleted).
        const resolved = await resolveRecentThreadId(
          channel.accountId,
          channel.accessToken,
        );
        if (resolved) {
          this.logger.info(
            { containerId: publishId, postId: resolved.id },
            'Resolved Threads container to its published post ID',
          );
          return { status: 'published', postId: resolved.id, url: resolved.permalink };
        }

        // Unresolvable. Keep the container id so the row still records a
        // publish, but say plainly that metrics will not work for it.
        this.logger.warn(
          { containerId: publishId },
          'Threads container is PUBLISHED but its post ID could not be resolved. ' +
            'Storing the container id; metrics and permalink will be unavailable',
        );
        return { status: 'published', postId: publishId };
      }

      if (status.status === 'FINISHED') {
        // Container is ready — finalize with publishThreadContainer for the real post ID.
        const result = await this.publishThreadContainer(channel.accountId, publishId, channel.accessToken);
        const permalink = await fetchThreadsPermalink(result.id, channel.accessToken);
        this.logger.info({ containerId: publishId, postId: result.id }, 'Threads container finalized via status-check');
        return {
          status: 'published',
          postId: result.id,
          url: permalink || `https://www.threads.net/@${bareHandle(channel.accountName)}/post/${result.id}`,
        };
      }

      if (status.status === 'ERROR' || status.status === 'EXPIRED') {
        return {
          status: 'failed',
          message: status.error_message || `Container status: ${status.status}`,
        };
      }

      return {
        status: 'processing',
        message: `Container status: ${status.status}`,
      };
    } catch (error) {
      // Transient errors propagate so the status-check worker retries;
      // only a 4xx rejection is terminal (see isTransientApiError).
      if (this.isTransientApiError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
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
        const data = await this.fetchJson<{
          data?: Array<{
            name: string;
            values?: Array<{ value: number }>;
            total_value?: { value: number };
          }>;
        }>(
          // Media-level insight metrics are exactly: views, likes, replies,
          // reposts, quotes, shares. `reach` is a USER-level metric only — Meta
          // rejects the whole request when any member of the list is invalid, so
          // including it made every Threads post metrics call fail (caught and
          // logged as a warning, leaving Threads with no metrics at all).
          `${GRAPH_URL}/${postId}/insights?` +
          `metric=views,likes,replies,reposts,quotes,shares` +
          `&access_token=${channel.accessToken}`,
        );

        const metrics: MetricsData = {};
        for (const item of data.data || []) {
          const value = item.total_value?.value ?? item.values?.[0]?.value ?? 0;
          switch (item.name) {
            case 'views': metrics.impressions = value; break;
            case 'likes': metrics.likes = value; break;
            case 'replies': metrics.comments = value; break;
            // Reposts and shares are distinct on Threads: a repost is an
            // in-network reshare, a share is an off-Threads share. Both are
            // shares for our purposes, so sum rather than overwrite.
            case 'reposts':
            case 'shares':
              metrics.shares = (metrics.shares ?? 0) + value;
              break;
            case 'quotes':
              if (!metrics.extra) metrics.extra = {};
              metrics.extra.quotes = value;
              break;
          }
        }

        if (Object.keys(metrics).length > 0) {
          results.set(postId, metrics);
        }
      } catch (error) {
        this.logger.warn({ error, postId }, 'Failed to fetch Threads post metrics');
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

    try {
      const data = await this.fetchJson<{
        data?: Array<{
          name: string;
          total_value?: { value: number };
          values?: Array<{ value: number }>;
        }>;
      }>(
        `${GRAPH_URL}/${channel.accountId}/threads_insights?` +
        `metric=views,likes,replies,reposts,quotes,followers_count` +
        `&period=day` +
        `&access_token=${channel.accessToken}`,
      );

      let followers: number | undefined;
      let impressions: number | undefined;
      const platformSpecific: Record<string, number> = {};

      for (const item of data.data || []) {
        const value = item.total_value?.value ?? item.values?.[0]?.value ?? 0;
        switch (item.name) {
          case 'followers_count': followers = value; break;
          case 'views': impressions = value; break;
          case 'likes': platformSpecific.likes = value; break;
          case 'replies': platformSpecific.replies = value; break;
          case 'reposts': platformSpecific.reposts = value; break;
          case 'quotes': platformSpecific.quotes = value; break;
        }
      }

      return {
        followers,
        impressions,
        platformSpecific: Object.keys(platformSpecific).length > 0 ? platformSpecific : undefined,
      };
    } catch (error) {
      this.logger.warn({ error }, 'Failed to fetch Threads account analytics');
      return null;
    }
  }

  async publishThread(
    segments: Array<PostData & { sequence: number }>,
    channel: ChannelData,
    alreadyPosted?: ThreadPublishResult['posts'],
  ): Promise<ThreadPublishResult> {
    const userId = channel.accountId;
    const accessToken = channel.accessToken;

    this.logger.info(
      { accountId: userId, segmentCount: segments.length },
      'Threads thread publish started',
    );

    if (!accessToken) {
      return { success: false, error: 'No access token for Threads account' };
    }

    // Resume a partially-posted thread on retry (skip the live segments, reply-chain from the
    // last one) instead of re-posting the head segments.
    const remaining = alreadyPosted?.length ? segments.slice(alreadyPosted.length) : segments;
    const publishedPosts: ThreadPublishResult['posts'] = alreadyPosted?.length ? [...alreadyPosted] : [];
    let replyToId: string | undefined = alreadyPosted?.length ? alreadyPosted[alreadyPosted.length - 1].postId : undefined;

    for (const segment of remaining) {
      try {
        // Determine media type and params for this segment
        const containerParams: Record<string, string> = {
          access_token: accessToken,
        };

        if (segment.mediaFiles.length > 0) {
          const file = segment.mediaFiles[0];
          if (file.mimeType.startsWith('video/')) {
            containerParams.media_type = 'VIDEO';
            containerParams.video_url = file.url;
          } else {
            containerParams.media_type = 'IMAGE';
            containerParams.image_url = file.url;
          }
          if (segment.content) containerParams.text = segment.content;
        } else {
          containerParams.media_type = 'TEXT';
          containerParams.text = segment.content;
        }

        // Add reply_to_id for chained replies
        if (replyToId) {
          containerParams.reply_to_id = replyToId;
        }

        const container = await this.createThreadContainer(userId, containerParams);
        await this.waitForContainer(container.id, accessToken);
        const result = await this.publishThreadContainer(userId, container.id, accessToken);

        publishedPosts!.push({
          sequence: segment.sequence,
          postId: result.id,
          url: await fetchThreadsPermalink(result.id, accessToken) || `https://www.threads.net/@${userId}/post/${result.id}`,
          parentId: replyToId,
        });

        replyToId = result.id;
        this.logger.debug({ postId: result.id, sequence: segment.sequence }, 'Thread reply published');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error({ error: message, sequence: segment.sequence }, 'Thread reply failed');
        return { success: false, posts: publishedPosts, error: `Part ${segment.sequence + 1} failed: ${message}` };
      }
    }

    this.logger.info({ count: publishedPosts!.length }, 'Threads thread published successfully');
    return { success: true, posts: publishedPosts };
  }

  // ---------------------------------------------------------------------------
  // Private: post type handlers
  // ---------------------------------------------------------------------------

  private async publishText(
    post: PostData,
    userId: string,
    accessToken: string,
  ): Promise<PublishResult> {
    if (!post.content) {
      return { success: false, error: 'Text post requires content' };
    }

    if (post.content.length > 500) {
      return {
        success: false,
        error: `Text exceeds maximum length of 500 characters (current: ${post.content.length})`,
      };
    }

    const containerParams: Record<string, string> = {
      media_type: 'TEXT',
      text: post.content,
      access_token: accessToken,
    };
    if (post.platformSpecific?.quotePostId) {
      containerParams.quote_post_id = post.platformSpecific.quotePostId as string;
    }

    const container = await this.createThreadContainer(userId, containerParams);

    // Defer finalization to status-check worker (poll → publishThreadContainer → permalink).
    this.logger.info({ containerId: container.id }, 'Threads text container created, deferring finalization');
    return {
      success: true,
      processing: true,
      processingId: container.id,
    };
  }

  private async publishImage(
    post: PostData,
    userId: string,
    accessToken: string,
  ): Promise<PublishResult> {
    if (post.mediaFiles.length === 0) {
      return { success: false, error: 'Image post requires an image' };
    }

    const imageUrl = post.mediaFiles[0].url;

    const containerParams: Record<string, string> = {
      media_type: 'IMAGE',
      image_url: imageUrl,
      access_token: accessToken,
    };
    if (post.content) {
      containerParams.text = post.content;
    }
    if (post.platformSpecific?.quotePostId) {
      containerParams.quote_post_id = post.platformSpecific.quotePostId as string;
    }

    const container = await this.createThreadContainer(userId, containerParams);

    // Defer finalization to status-check worker.
    this.logger.info({ containerId: container.id }, 'Threads image container created, deferring finalization');
    return {
      success: true,
      processing: true,
      processingId: container.id,
    };
  }

  private async publishVideo(
    post: PostData,
    userId: string,
    accessToken: string,
  ): Promise<PublishResult> {
    if (post.mediaFiles.length === 0) {
      return { success: false, error: 'Video post requires a video' };
    }

    const videoUrl = post.mediaFiles[0].url;

    const containerParams: Record<string, string> = {
      media_type: 'VIDEO',
      video_url: videoUrl,
      access_token: accessToken,
    };
    if (post.content) {
      containerParams.text = post.content;
    }
    if (post.platformSpecific?.quotePostId) {
      containerParams.quote_post_id = post.platformSpecific.quotePostId as string;
    }

    const container = await this.createThreadContainer(userId, containerParams);

    // Defer finalization to status-check worker. Video-processing latency is
    // now fully owned by the async status-check path rather than blocking the
    // publish worker for 5-30s.
    this.logger.info({ containerId: container.id }, 'Threads video container created, deferring finalization');
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

    if (post.mediaFiles.length > 20) {
      return { success: false, error: 'Carousel supports a maximum of 20 media items' };
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
        childParams.media_type = 'IMAGE';
        childParams.image_url = mediaFile.url;
      }

      const child = await this.createThreadContainer(userId, childParams);
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
      carouselParams.text = post.content;
    }
    if (post.platformSpecific?.quotePostId) {
      carouselParams.quote_post_id = post.platformSpecific.quotePostId as string;
    }

    const carouselContainer = await this.createThreadContainer(userId, carouselParams);
    this.logger.debug({ containerId: carouselContainer.id }, 'Carousel parent container created');

    // Step 3: Poll carousel container
    await this.waitForContainer(carouselContainer.id, accessToken);

    // Step 4: Publish
    const result = await this.publishThreadContainer(userId, carouselContainer.id, accessToken);

    this.logger.info(
      { postId: result.id, itemCount: childIds.length },
      'Threads carousel published',
    );
    return {
      success: true,
      postId: result.id,
      url: await fetchThreadsPermalink(result.id, accessToken) || `https://www.threads.net/@${userId}/post/${result.id}`,
    };
  }

  // ---------------------------------------------------------------------------
  // Private: container API helpers
  // ---------------------------------------------------------------------------

  private async createThreadContainer(
    userId: string,
    params: Record<string, string>,
  ): Promise<ThreadContainerResponse> {
    const url = `${GRAPH_URL}/${userId}/threads`;
    const body = new URLSearchParams(params);

    return this.fetchJson<ThreadContainerResponse>(url, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  private async publishThreadContainer(
    userId: string,
    containerId: string,
    accessToken: string,
  ): Promise<ThreadPublishResponse> {
    const url = `${GRAPH_URL}/${userId}/threads_publish`;
    const body = new URLSearchParams({
      creation_id: containerId,
      access_token: accessToken,
    });

    return this.fetchJson<ThreadPublishResponse>(url, {
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
      `fields=status,error_message` +
      `&access_token=${accessToken}`;

    return this.fetchJson<ContainerStatusResponse>(url);
  }

  private async waitForContainer(
    containerId: string,
    accessToken: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      const status = await this.pollContainerStatus(containerId, accessToken);

      if (status.status === 'FINISHED') {
        return;
      }

      if (status.status === 'ERROR' || status.status === 'EXPIRED') {
        throw new Error(
          `Threads container ${containerId} failed with status: ${status.status}` +
          (status.error_message ? ` - ${status.error_message}` : ''),
        );
      }

      // Still IN_PROGRESS, wait before next poll
      this.logger.debug(
        { containerId, attempt: attempt + 1, status: status.status },
        'Waiting for container to be ready',
      );

      await this.sleep(POLL_DELAYS_MS[attempt] ?? POLL_FALLBACK_MS);
    }

    // See the Instagram counterpart: nothing was published, so this must
    // classify as a retry rather than an unknown outcome.
    throw new Error(
      `Threads is still processing container ${containerId} after ${POLL_MAX_ATTEMPTS} checks; try again later`,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async publishComment(
    channel: ChannelData,
    platformPostId: string,
    comment: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const userId = channel.accountId;
      const accessToken = channel.accessToken;

      // Create a text reply container with reply_to_id
      const containerParams: Record<string, string> = {
        media_type: 'TEXT',
        text: comment,
        reply_to_id: platformPostId,
        access_token: accessToken,
      };

      const container = await this.createThreadContainer(userId, containerParams);
      await this.waitForContainer(container.id, accessToken);
      await this.publishThreadContainer(userId, container.id, accessToken);

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Threads exposes top-level replies via `{thread-id}/replies` with the author
   * username inline. Reactions/likes are aggregate only — no per-user list.
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
    const result: EngagementData = {
      comments: [],
      reactions: [],
      reactionsUnsupported: true,
      notice: 'Threads only shows who replied, not who liked.',
    };

    try {
      const data = await this.fetchJson<{
        data?: Array<{
          id: string;
          text?: string;
          timestamp?: string;
          username?: string;
          permalink?: string;
          replied_to?: { id?: string };
          hide_status?: string;
        }>;
        paging?: { next?: string };
      }>(
        // /conversation returns the whole thread (nested replies included);
        // /replies returns only direct replies to the post, so a reply to a
        // reply never appeared. `replied_to` lets the UI nest them.
        `${GRAPH_URL}/${encodeURIComponent(platformPostId)}/conversation?fields=id,text,timestamp,username,permalink,replied_to,hide_status&reverse=false&limit=${limit}&access_token=${channel.accessToken}`,
      );

      for (const r of data.data ?? []) {
        // /conversation returns replies the user hid or that are blocked;
        // re-surfacing them in openPublish would undo their moderation.
        if (r.hide_status && r.hide_status !== 'NOT_HUSHED' && r.hide_status !== 'UNHUSHED') continue;
        // A media-only reply has no `text`. Skipping it made real replies
        // vanish from the list — show a placeholder instead.
        result.comments.push({
          id: r.id,
          text: r.text || '(media reply)',
          createdAt: r.timestamp,
          // Only mark a parent when it's another reply in this list — the root
          // post itself is not rendered as a comment.
          parentId: r.replied_to?.id && r.replied_to.id !== platformPostId ? r.replied_to.id : undefined,
          actor: {
            id: r.username ?? r.id,
            name: r.username ?? 'Threads User',
            handle: r.username,
            profileUrl: r.username ? `https://www.threads.net/@${r.username}` : undefined,
          },
        });
      }
      result.hasMoreComments = !!data.paging?.next;
    } catch (error) {
      this.logger.warn({ error, platformPostId }, 'Threads replies fetch failed');
      result.notice = 'Replies unavailable';
      result.commentsNotice = 'Replies unavailable';
    }

    return result;
  }
}
