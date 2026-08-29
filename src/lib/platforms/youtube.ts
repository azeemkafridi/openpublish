import fs from 'fs';
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

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';

const config: PlatformConfig = {
  name: 'youtube',
  displayName: 'YouTube',
  icon: 'youtube',
  color: '#FF0000',
  authType: 'oauth',
  postTypes: [
    {
      value: 'video',
      label: 'Video',
      description: 'Upload a video to YouTube',
      mediaRequired: true,
      maxMedia: 1,
      allowedMediaTypes: ['video'],
    },
    {
      value: 'short',
      label: 'Short',
      description: 'Upload a YouTube Short (vertical video, 3 minutes or less)',
      mediaRequired: true,
      maxMedia: 1,
      allowedMediaTypes: ['video'],
    },
  ],
  mediaRules: {
    video: {
      maxSizeMB: 128000,
      formats: ['mp4', 'mov', 'avi', 'wmv', 'flv', 'webm'],
      maxCount: 1,
    },
  },
};

export class YouTubeHandler extends PlatformHandler {
  constructor() {
    super(config);
  }

  private getClientId(): string {
    const clientId = process.env.YOUTUBE_CLIENT_ID;
    if (!clientId) throw new Error('YOUTUBE_CLIENT_ID not configured');
    return clientId;
  }

  private getClientSecret(): string {
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
    if (!clientSecret) throw new Error('YOUTUBE_CLIENT_SECRET not configured');
    return clientSecret;
  }

  async getOAuthUrl(redirectUri: string, state: string): Promise<string> {
    const clientId = this.getClientId();

    // force-ssl is what authorizes commentThreads.list. Without it every
    // comment read 403s (ACCESS_TOKEN_SCOPE_INSUFFICIENT) even though the
    // statistics call happily reports the video's commentCount.
    //
    // It is OFF by default: our Google OAuth app is verified for the three
    // base scopes only, and Google's guidance is explicit that deploying an
    // unverified scope to a public app disrupts users (unverified-app warning
    // screen) and burns the unverified-user quota. Set
    // YOUTUBE_COMMENTS_SCOPE=on ONLY once force-ssl has passed verification
    // (or in a staging/test project for the review recording). Channels
    // connected before the flag flips must be reconnected to grant it.
    const scopes = [
      'https://www.googleapis.com/auth/youtube',
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.readonly',
      ...(process.env.YOUTUBE_COMMENTS_SCOPE === 'on'
        ? ['https://www.googleapis.com/auth/youtube.force-ssl']
        : []),
    ];

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state: state,
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeCodeForToken(
    code: string,
    redirectUri: string,
  ): Promise<TokenData> {
    const clientId = this.getClientId();
    const clientSecret = this.getClientSecret();

    const body = new URLSearchParams({
      code: code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const tokenData = await this.fetchJson<{
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type: string;
    }>('https://oauth2.googleapis.com/token', {
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
    };
  }

  async getAccountInfo(accessToken: string): Promise<AccountInfo> {
    const data = await this.fetchJson<{
      items: Array<{
        id: string;
        snippet: {
          title: string;
          thumbnails?: {
            default?: { url: string };
          };
        };
      }>;
    }>(`${API_BASE}/channels?part=snippet&mine=true`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!data.items || data.items.length === 0) {
      throw new Error('No YouTube channel found for this account');
    }

    const channel = data.items[0];

    return {
      id: channel.id,
      name: channel.snippet.title,
      profileImage: channel.snippet.thumbnails?.default?.url,
      accountType: 'channel',
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
      'YouTube publish started',
    );

    if (!channel.accessToken) {
      return { success: false, error: 'No access token for YouTube account' };
    }

    const videoFile = post.mediaFiles.find((f) => f.mimeType.startsWith('video/'));
    if (!videoFile) {
      return { success: false, error: 'No video file provided for YouTube upload' };
    }

    if (!videoFile.localPath) {
      return { success: false, error: 'No local video file path available for YouTube upload' };
    }

    const isShort = post.postType === 'short';
    const ytOptions = (post.platformSpecific ?? {}) as Record<string, unknown>;

    // Title: use platform-specific title (required), fall back to first line of content
    const explicitTitle = typeof ytOptions.title === 'string' ? ytOptions.title.trim() : '';
    const content = post.content || '';
    const lines = content.split('\n').filter(Boolean);
    let title = (explicitTitle || lines[0] || content).slice(0, 100);

    if (!title) {
      return { success: false, error: 'YouTube requires a title. Please provide a video title.' };
    }
    let description = content;

    if (isShort) {
      if (!title.includes('#Shorts')) {
        title = `${title} #Shorts`.slice(0, 100);
      }
      if (!description.includes('#Shorts')) {
        description = `${description} #Shorts`;
      }
    }

    // Respect platform-specific options with sensible defaults
    const privacyStatus = (ytOptions.privacyStatus as string) || 'public';
    const categoryId = (ytOptions.categoryId as string) || '22';
    const madeForKids = (ytOptions.madeForKids as boolean) ?? false;
    const tags = Array.isArray(ytOptions.tags) ? ytOptions.tags as string[] : [];

    const metadata: Record<string, unknown> = {
      snippet: {
        title,
        description,
        categoryId,
        ...(tags.length > 0 ? { tags } : {}),
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: madeForKids,
      },
    };

    try {
      // Step 1: Initiate resumable upload session
      const fileStats = fs.statSync(videoFile.localPath);
      const fileSize = fileStats.size;

      const initParams = new URLSearchParams({
        uploadType: 'resumable',
        part: 'snippet,status',
      });

      const initResponse = await fetch(`${UPLOAD_URL}?${initParams.toString()}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${channel.accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(fileSize),
          'X-Upload-Content-Type': videoFile.mimeType,
        },
        body: JSON.stringify(metadata),
      });

      if (!initResponse.ok) {
        const errorText = await initResponse.text();
        this.logger.error(
          { status: initResponse.status, error: errorText },
          'YouTube upload init failed',
        );
        return {
          success: false,
          error: `YouTube upload initialization failed (${initResponse.status}): ${errorText}`,
        };
      }

      const uploadUri = initResponse.headers.get('Location');
      if (!uploadUri) {
        return {
          success: false,
          error: 'YouTube did not return an upload URI',
        };
      }

      // Step 2: Upload the video file using streaming (avoids loading entire file into memory)
      this.logger.info(
        { fileSize, mimeType: videoFile.mimeType },
        'Uploading video to YouTube',
      );

      const fileStream = fs.createReadStream(videoFile.localPath);

      // No timeout — uploads can take as long as needed depending on file size and connection speed.
      // fetch will reject naturally if the connection drops or the server errors.
      const uploadResponse = await fetch(uploadUri, {
        method: 'PUT',
        headers: {
          'Content-Type': videoFile.mimeType,
          'Content-Length': String(fileSize),
        },
        // @ts-ignore - Node fetch accepts ReadStream
        body: fileStream,
        // @ts-ignore - required for streaming request bodies
        duplex: 'half',
      });

      const uploadText = await uploadResponse.text();
      let uploadData: {
        id?: string;
        error?: { message: string; code: number };
      };

      try {
        uploadData = JSON.parse(uploadText);
      } catch {
        this.logger.error(
          { status: uploadResponse.status, text: uploadText },
          'Non-JSON response from YouTube upload',
        );
        return {
          success: false,
          error: `YouTube upload returned non-JSON response: ${uploadText.slice(0, 200)}`,
        };
      }

      if (!uploadResponse.ok || !uploadData.id) {
        const errorMessage =
          uploadData.error?.message || 'Unknown upload error';
        this.logger.error(
          { status: uploadResponse.status, error: uploadData.error },
          'YouTube video upload failed',
        );
        return { success: false, error: `YouTube upload failed: ${errorMessage}` };
      }

      const videoId = uploadData.id;
      const videoUrl = isShort
        ? `https://youtube.com/shorts/${videoId}`
        : `https://www.youtube.com/watch?v=${videoId}`;

      this.logger.info(
        { videoId, url: videoUrl, isShort },
        'YouTube video uploaded — waiting for processing',
      );

      // Add to playlist if specified
      const playlistId = typeof ytOptions.playlistId === 'string' ? ytOptions.playlistId.trim() : '';
      if (playlistId) {
        try {
          const plRes = await fetch(`${API_BASE}/playlistItems?part=snippet`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${channel.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              snippet: {
                playlistId,
                resourceId: { kind: 'youtube#video', videoId },
              },
            }),
          });

          if (plRes.ok) {
            this.logger.info({ videoId, playlistId }, 'Video added to playlist');
          } else {
            const plErr = await plRes.text();
            this.logger.warn({ videoId, playlistId, error: plErr }, 'Failed to add video to playlist');
          }
        } catch (plError) {
          this.logger.warn({ videoId, playlistId, error: String(plError) }, 'Playlist insert error');
        }
      }

      // Upload custom thumbnail if provided
      const thumbnailUrl = (ytOptions as Record<string, unknown>).thumbnailUrl as string | undefined;
      if (thumbnailUrl && videoId) {
        try {
          // thumbnailUrl comes from platformSpecific (user-supplied) — must go
          // through the SSRF-guarded fetch, never plain fetch.
          const thumbRes = await this.fetchRemoteMedia(thumbnailUrl);
          if (thumbRes.ok) {
            const thumbBuffer = Buffer.from(await thumbRes.arrayBuffer());
            const thumbContentType = thumbRes.headers.get('content-type') || 'image/jpeg';
            await fetch(
              `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}&uploadType=media`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${channel.accessToken}`,
                  'Content-Type': thumbContentType,
                },
                body: thumbBuffer,
              },
            );
            this.logger.info({ videoId }, 'YouTube thumbnail uploaded');
          }
        } catch (error) {
          // Don't fail the video upload if thumbnail fails
          this.logger.warn({ videoId, error }, 'YouTube thumbnail upload failed');
        }
      }

      // Return as processing — YouTube needs time to process the video
      return {
        success: true,
        processing: true,
        processingId: videoId,
        postId: videoId,
        url: videoUrl,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: message }, 'Failed to publish video to YouTube');
      return { success: false, error: message };
    }
  }

  async checkPublishStatus(
    channel: ChannelData,
    videoId: string,
  ): Promise<StatusResult> {
    try {
      const data = await this.fetchJson<{
        items: Array<{
          id: string;
          status: {
            uploadStatus: string;
            privacyStatus: string;
            failureReason?: string;
            rejectionReason?: string;
          };
        }>;
      }>(`${API_BASE}/videos?part=status&id=${videoId}`, {
        headers: {
          Authorization: `Bearer ${channel.accessToken}`,
        },
      });

      if (!data.items || data.items.length === 0) {
        return { status: 'failed', message: 'Video not found on YouTube' };
      }

      const videoStatus = data.items[0].status;

      if (videoStatus.uploadStatus === 'processed') {
        // `watch?v=` resolves for Shorts too (YouTube redirects), so it's a safe
        // permalink here even though we can't tell short-vs-long from status.
        return {
          status: 'published',
          postId: videoId,
          url: `https://www.youtube.com/watch?v=${videoId}`,
        };
      }

      if (videoStatus.uploadStatus === 'uploaded') {
        return { status: 'processing', message: 'YouTube is processing the video' };
      }

      if (
        videoStatus.uploadStatus === 'failed' ||
        videoStatus.uploadStatus === 'rejected' ||
        videoStatus.uploadStatus === 'deleted'
      ) {
        const reason =
          videoStatus.failureReason ||
          videoStatus.rejectionReason ||
          videoStatus.uploadStatus;
        return { status: 'failed', message: `YouTube processing failed: ${reason}` };
      }

      return { status: 'processing', message: `Upload status: ${videoStatus.uploadStatus}` };
    } catch (error) {
      // Transient errors propagate so the status-check worker retries;
      // only a 4xx rejection is terminal (see isTransientApiError).
      if (this.isTransientApiError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ videoId, error: message }, 'YouTube status check failed');
      return { status: 'failed', message };
    }
  }

  async getAccountAnalytics(
    channel: ChannelData,
  ): Promise<{ followers?: number; following?: number; impressions?: number; reach?: number; profileViews?: number; websiteClicks?: number; platformSpecific?: Record<string, number> } | null> {
    if (!channel.accessToken) return null;

    try {
      const data = await this.fetchJson<{
        items?: Array<{
          id: string;
          statistics?: {
            subscriberCount?: string;
            viewCount?: string;
            videoCount?: string;
            hiddenSubscriberCount?: boolean;
          };
        }>;
      }>(`${API_BASE}/channels?part=statistics&mine=true`, {
        headers: {
          Authorization: `Bearer ${channel.accessToken}`,
        },
      });

      if (!data.items || data.items.length === 0) return null;

      const stats = data.items[0].statistics;
      if (!stats) return null;

      const subscribers = parseInt(stats.subscriberCount || '0', 10);
      const totalViews = parseInt(stats.viewCount || '0', 10);
      const videoCount = parseInt(stats.videoCount || '0', 10);

      return {
        followers: subscribers,
        platformSpecific: {
          totalViews,
          videoCount,
          ...(stats.hiddenSubscriberCount ? { hiddenSubscriberCount: 1 } : {}),
        },
      };
    } catch (error) {
      this.logger.warn({ error }, 'Failed to fetch YouTube account analytics');
      return null;
    }
  }

  async getPostMetrics(
    channel: ChannelData,
    platformPostIds: string[],
  ): Promise<Map<string, MetricsData>> {
    const results = new Map<string, MetricsData>();
    if (!channel.accessToken || platformPostIds.length === 0) return results;

    // YouTube API allows up to 50 video IDs per request
    const batchSize = 50;
    for (let i = 0; i < platformPostIds.length; i += batchSize) {
      const batch = platformPostIds.slice(i, i + batchSize);
      const ids = batch.join(',');

      try {
        const data = await this.fetchJson<{
          items?: Array<{
            id: string;
            statistics?: {
              viewCount?: string;
              likeCount?: string;
              commentCount?: string;
              favoriteCount?: string;
            };
          }>;
        }>(`${API_BASE}/videos?part=statistics&id=${ids}`, {
          headers: { Authorization: `Bearer ${channel.accessToken}` },
        });

        if (data.items) {
          for (const video of data.items) {
            const s = video.statistics;
            if (!s) continue;
            const views = parseInt(s.viewCount || '0', 10);
            results.set(video.id, {
              impressions: views,
              videoViews: views,
              likes: parseInt(s.likeCount || '0', 10),
              comments: parseInt(s.commentCount || '0', 10),
              // statistics.favoriteCount is deliberately not stored: the
              // favorites feature was removed in 2015 and the field is a
              // documented always-0.
            });
          }
        }
      } catch (error) {
        this.logger.warn({ error, batch: ids.slice(0, 50) }, 'Failed to fetch YouTube metrics batch');
      }
    }

    return results;
  }

  async refreshToken(refreshTokenValue: string): Promise<TokenData | null> {
    try {
      const clientId = this.getClientId();
      const clientSecret = this.getClientSecret();

      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshTokenValue,
        client_id: clientId,
        client_secret: clientSecret,
      });

      const tokenData = await this.fetchJson<{
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        token_type: string;
      }>('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      return {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || refreshTokenValue,
        expiresIn: tokenData.expires_in,
      };
    } catch (error) {
      this.logger.error({ error }, 'Failed to refresh YouTube token');
      return null;
    }
  }

  async publishComment(
    channel: ChannelData,
    platformPostId: string,
    comment: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const url = 'https://www.googleapis.com/youtube/v3/commentThreads?part=snippet';
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${channel.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          snippet: {
            videoId: platformPostId,
            topLevelComment: {
              snippet: {
                textOriginal: comment,
              },
            },
          },
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({})) as any;
        const msg = err?.error?.message || `YouTube comment failed (${response.status})`;
        return { success: false, error: msg };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * YouTube exposes commenters but no per-user like list — likes are aggregate.
   * Uses `commentThreads.list` for top-level comments on the uploaded video.
   */
  async getPostEngagement(
    channel: ChannelData,
    platformPostId: string,
    opts?: { commentsLimit?: number },
  ): Promise<EngagementData> {
    if (!channel.accessToken) {
      return { comments: [], reactions: [], notice: 'No access token', commentsNotice: 'No access token' };
    }
    const limit = Math.min(opts?.commentsLimit ?? 25, 100);
    const result: EngagementData = {
      comments: [],
      reactions: [],
      reactionsUnsupported: true,
      notice: 'YouTube only shows who commented, not who liked.',
    };

    let truncatedReplies = false;

    try {
      const data = await this.fetchJson<{
        items?: Array<{
          id: string;
          snippet?: {
            topLevelComment?: {
              snippet?: {
                textDisplay?: string;
                authorDisplayName?: string;
                authorProfileImageUrl?: string;
                authorChannelUrl?: string;
                authorChannelId?: { value?: string };
                likeCount?: number;
                publishedAt?: string;
              };
            };
            totalReplyCount?: number;
          };
          replies?: {
            comments?: Array<{
              id: string;
              snippet?: {
                textDisplay?: string;
                authorDisplayName?: string;
                authorProfileImageUrl?: string;
                authorChannelUrl?: string;
                authorChannelId?: { value?: string };
                likeCount?: number;
                publishedAt?: string;
                parentId?: string;
              };
            }>;
          };
        }>;
        nextPageToken?: string;
      }>(
        // part=snippet alone returns only the top comment of each thread —
        // every reply was dropped. `replies` carries them.
        `${API_BASE}/commentThreads?part=snippet,replies&videoId=${encodeURIComponent(platformPostId)}&maxResults=${limit}&textFormat=plainText`,
        { headers: { Authorization: `Bearer ${channel.accessToken}` } },
      );

      for (const item of data.items ?? []) {
        const s = item.snippet?.topLevelComment?.snippet;
        if (!s?.textDisplay) continue;
        result.comments.push({
          id: item.id,
          text: s.textDisplay,
          createdAt: s.publishedAt,
          likeCount: s.likeCount,
          actor: {
            id: s.authorChannelId?.value ?? item.id,
            name: s.authorDisplayName ?? 'YouTube User',
            profileImage: s.authorProfileImageUrl,
            profileUrl: s.authorChannelUrl,
          },
        });

        // commentThreads inlines at most 5 replies per thread regardless of
        // maxResults, so a long reply chain is truncated. totalReplyCount tells
        // us when that happened; without it the UI claimed a partial thread was
        // complete.
        const inlined = item.replies?.comments ?? [];
        if ((item.snippet?.totalReplyCount ?? 0) > inlined.length) truncatedReplies = true;

        for (const reply of inlined) {
          if (result.comments.length >= limit) { truncatedReplies = true; break; }
          const rs = reply.snippet;
          if (!rs?.textDisplay) continue;
          result.comments.push({
            id: reply.id,
            text: rs.textDisplay,
            createdAt: rs.publishedAt,
            likeCount: rs.likeCount,
            parentId: item.id,
            actor: {
              id: rs.authorChannelId?.value ?? reply.id,
              name: rs.authorDisplayName ?? 'YouTube User',
              profileImage: rs.authorProfileImageUrl,
              profileUrl: rs.authorChannelUrl,
            },
          });
        }
      }
      result.hasMoreComments = !!data.nextPageToken || truncatedReplies;
    } catch (error) {
      this.logger.warn({ error, platformPostId }, 'YouTube comments fetch failed');
      // The statistics card can read "2 comments" (statistics.commentCount)
      // while commentThreads returns nothing, and the two most common reasons
      // are actionable by the user — say which one it was instead of a flat
      // "unavailable" the metrics appear to contradict.
      const msg = error instanceof Error ? error.message : '';
      result.commentsNotice = /disabled comments|commentsDisabled/i.test(msg)
        ? 'Comments are turned off on this video, so the thread cannot be read. The count above comes from YouTube statistics.'
        : /403|forbidden|insufficient/i.test(msg)
          // Reconnecting only helps once the OAuth request actually asks for
          // force-ssl; with the flag off the honest message is that comment
          // reading is not enabled yet.
          ? (process.env.YOUTUBE_COMMENTS_SCOPE === 'on'
              ? 'YouTube refused the comment read for this channel. Reconnect it on the Channels page to refresh its permissions.'
              : 'Reading YouTube comments is not enabled for this app yet. The count above comes from YouTube statistics.')
          : 'Comments unavailable';
      result.notice = result.commentsNotice;
    }

    return result;
  }
}
