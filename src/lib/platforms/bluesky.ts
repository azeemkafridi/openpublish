import { readFileSync } from 'node:fs';
import sharp from 'sharp';
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

const DEFAULT_PDS = 'https://bsky.social';

/** Resolve the PDS base URL from channel metadata, falling back to bsky.social */
function getApiBase(channel?: ChannelData): string {
  const pds = (channel?.metadata?.pdsUrl as string) || DEFAULT_PDS;
  return `${pds.replace(/\/+$/, '')}/xrpc`;
}

// Legacy constant for methods that don't have channel context (exchangeCodeForToken)
const API_BASE = `${DEFAULT_PDS}/xrpc`;

const config: PlatformConfig = {
  name: 'bluesky',
  displayName: 'Bluesky',
  icon: 'bluesky',
  color: '#0085FF',
  authType: 'credentials',
  postTypes: [
    {
      value: 'post',
      label: 'Post',
      description: 'Post text, images, or video to Bluesky',
      maxMedia: 4,
      allowedMediaTypes: ['image', 'video'],
    },
  ],
  mediaRules: {
    image: {
      maxSizeMB: 10, // auto-resized to <976KB before upload
      formats: ['jpg', 'jpeg', 'png', 'webp'],
      maxCount: 4,
    },
    video: {
      maxSizeMB: 100,
      formats: ['mp4'],
      maxCount: 1,
      maxDurationSec: 60,
    },
  },
};

interface BlueskySession {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
}

interface BlueskyBlob {
  $type: 'blob';
  ref: { $link: string };
  mimeType: string;
  size: number;
}

interface BlueskyFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: string; uri?: string; did?: string }>;
}

export class BlueskyHandler extends PlatformHandler {
  constructor() {
    super(config);
  }

  async getOAuthUrl(
    _redirectUri: string,
    _state: string,
  ): Promise<string> {
    throw new Error('Bluesky uses credential-based auth, not OAuth');
  }

  async exchangeCodeForToken(
    code: string,
    _redirectUri: string,
  ): Promise<TokenData> {
    // The "code" parameter contains JSON-encoded credentials
    let credentials: { identifier: string; appPassword: string };

    try {
      credentials = JSON.parse(code);
    } catch {
      throw new Error(
        'Invalid credentials format. Expected JSON with identifier and appPassword.',
      );
    }

    if (!credentials.identifier || !credentials.appPassword) {
      throw new Error(
        'Both identifier (handle or email) and appPassword are required.',
      );
    }

    const session = await this.createSession(
      credentials.identifier,
      credentials.appPassword,
    );

    return {
      accessToken: session.accessJwt,
      refreshToken: session.refreshJwt,
      userId: session.did,
    };
  }

  async getAccountInfo(accessToken: string): Promise<AccountInfo> {
    // Decode the DID from the JWT access token
    const did = this.extractDidFromJwt(accessToken);

    const data = await this.fetchJson<{
      handle: string;
      did: string;
      didDoc?: {
        service?: Array<{ type: string; serviceEndpoint: string }>;
      };
    }>(`${API_BASE}/com.atproto.repo.describeRepo?repo=${encodeURIComponent(did)}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    return {
      id: data.did,
      name: data.handle,
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
      'Bluesky publish started',
    );

    if (!channel.accessToken) {
      return { success: false, error: 'No access token for Bluesky account' };
    }

    const apiBase = getApiBase(channel);
    const did = channel.metadata?.did as string || channel.accountId;
    const handle = channel.accountName;
    const accessToken = channel.accessToken;

    const mediaFiles = post.mediaFiles;

    // Validate media constraints
    const images = mediaFiles.filter((f) => f.mimeType.startsWith('image/'));
    const videos = mediaFiles.filter((f) => f.mimeType.startsWith('video/'));

    if (images.length > 0 && videos.length > 0) {
      return {
        success: false,
        error: "Bluesky doesn't support mixing images and videos in a single post.",
      };
    }

    if (images.length > 4) {
      return {
        success: false,
        error: 'Bluesky allows a maximum of 4 images per post.',
      };
    }

    if (videos.length > 1) {
      return {
        success: false,
        error: 'Bluesky allows a maximum of 1 video per post.',
      };
    }

    // Build the post record
    const record: Record<string, unknown> = {
      $type: 'app.bsky.feed.post',
      text: post.content,
      createdAt: new Date().toISOString(),
    };

    // Extract rich text facets (links + @mentions)
    const facets = this.extractFacets(post.content);
    if (facets.length > 0) {
      await this.resolveMentionFacets(facets, accessToken, apiBase);
      if (facets.length > 0) record.facets = facets;
    }

    // Handle image embeds
    if (images.length > 0) {
      const imageEmbeds: Array<{ alt: string; image: BlueskyBlob }> = [];

      for (const imageFile of images) {
        try {
          const blob = await this.uploadBlob(
            imageFile.localPath,
            imageFile.mimeType,
            accessToken,
            apiBase,
          );
          imageEmbeds.push({
            alt: imageFile.altText || '',
            image: blob,
          });
          this.logger.debug(
            { mimeType: imageFile.mimeType },
            'Image blob uploaded to Bluesky',
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error({ error: message }, 'Failed to upload image to Bluesky');
          return { success: false, error: `Failed to upload image: ${message}` };
        }
      }

      record.embed = {
        $type: 'app.bsky.embed.images',
        images: imageEmbeds,
      };
    }

    // Handle video embeds
    if (videos.length === 1) {
      try {
        const blob = await this.uploadBlob(
          videos[0].localPath,
          videos[0].mimeType,
          accessToken,
          apiBase,
        );
        record.embed = {
          $type: 'app.bsky.embed.video',
          video: blob,
        };
        this.logger.debug('Video blob uploaded to Bluesky');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error({ error: message }, 'Failed to upload video to Bluesky');
        return { success: false, error: `Failed to upload video: ${message}` };
      }
    }

    // Handle link card when no media
    if (!images.length && !videos.length && post.linkPreview) {
      const lp = post.linkPreview;
      let thumbBlob: BlueskyBlob | undefined;

      // Try to fetch and upload the OG image as thumbnail
      if (lp.image) {
        try {
          // lp.image is the og:image scraped from an arbitrary page the user
          // linked — attacker-controlled. Guarded fetch only (second-order SSRF).
          const imgRes = await this.fetchRemoteMedia(lp.image);
          if (imgRes.ok) {
            const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
            const response = await this.fetchWithFile(
              `${apiBase}/com.atproto.repo.uploadBlob`,
              imgBuffer,
              {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': imgRes.headers.get('content-type') || 'image/jpeg',
              },
            );
            if (response.ok) {
              const blobData = await response.json() as { blob: BlueskyBlob };
              thumbBlob = blobData.blob;
            }
          }
        } catch {
          // Thumbnail fetch failed, proceed without it
        }
      }

      record.embed = {
        $type: 'app.bsky.embed.external',
        external: {
          uri: lp.url,
          title: lp.title || '',
          description: lp.description || '',
          ...(thumbBlob ? { thumb: thumbBlob } : {}),
        },
      };
    }

    // Create the post record
    try {
      const result = await this.fetchJson<{
        uri: string;
        cid: string;
      }>(`${apiBase}/com.atproto.repo.createRecord`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          repo: did,
          collection: 'app.bsky.feed.post',
          record: record,
        }),
      });

      // Extract rkey from the AT URI (at://did:plc:xxx/app.bsky.feed.post/rkey)
      const rkey = result.uri.split('/').pop();
      const postUrl = `https://bsky.app/profile/${handle}/post/${rkey}`;

      this.logger.info(
        { uri: result.uri, cid: result.cid, url: postUrl },
        'Bluesky post published successfully',
      );

      return {
        success: true,
        postId: result.uri,
        url: postUrl,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: message }, 'Failed to publish Bluesky post');
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
      'Bluesky thread publish started',
    );

    if (!channel.accessToken) {
      return { success: false, error: 'No access token for Bluesky account' };
    }

    // Bluesky thread replies require each parent post's CID, which we don't persist in
    // threadPostIds (only the URI). So a partial thread can't be safely auto-resumed —
    // refuse rather than re-post from the top and duplicate the already-live segments.
    if (alreadyPosted?.length) {
      return {
        success: false,
        posts: alreadyPosted,
        error: 'This Bluesky thread was partially posted and can\'t be auto-resumed; please add the remaining parts manually to avoid duplicates.',
      };
    }

    const apiBase = getApiBase(channel);
    const did = (channel.metadata?.did as string) || channel.accountId;
    const handle = channel.accountName;
    const accessToken = channel.accessToken;

    const publishedPosts: ThreadPublishResult['posts'] = [];
    let rootRef: { uri: string; cid: string } | undefined;
    let parentRef: { uri: string; cid: string } | undefined;

    for (const segment of segments) {
      const record: Record<string, unknown> = {
        $type: 'app.bsky.feed.post',
        text: segment.content,
        createdAt: new Date().toISOString(),
      };

      // Extract rich text facets (links + @mentions)
      const facets = this.extractFacets(segment.content);
      if (facets.length > 0) {
        await this.resolveMentionFacets(facets, accessToken, apiBase);
        if (facets.length > 0) record.facets = facets;
      }

      // Add reply reference for chain
      if (rootRef && parentRef) {
        record.reply = { root: rootRef, parent: parentRef };
      }

      // Handle image embeds
      const images = segment.mediaFiles.filter((f) => f.mimeType.startsWith('image/'));
      const videos = segment.mediaFiles.filter((f) => f.mimeType.startsWith('video/'));

      if (images.length > 0) {
        const imageEmbeds: Array<{ alt: string; image: BlueskyBlob }> = [];
        for (const imageFile of images) {
          try {
            const blob = await this.uploadBlob(imageFile.localPath, imageFile.mimeType, accessToken, apiBase);
            imageEmbeds.push({ alt: imageFile.altText || '', image: blob });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, posts: publishedPosts, error: `Part ${segment.sequence + 1} image upload failed: ${message}` };
          }
        }
        record.embed = { $type: 'app.bsky.embed.images', images: imageEmbeds };
      } else if (videos.length === 1) {
        try {
          const blob = await this.uploadBlob(videos[0].localPath, videos[0].mimeType, accessToken, apiBase);
          record.embed = { $type: 'app.bsky.embed.video', video: blob };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { success: false, posts: publishedPosts, error: `Part ${segment.sequence + 1} video upload failed: ${message}` };
        }
      }

      try {
        const result = await this.fetchJson<{ uri: string; cid: string }>(
          `${apiBase}/com.atproto.repo.createRecord`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              repo: did,
              collection: 'app.bsky.feed.post',
              record,
            }),
          },
        );

        const rkey = result.uri.split('/').pop();
        const postUrl = `https://bsky.app/profile/${handle}/post/${rkey}`;

        publishedPosts!.push({
          sequence: segment.sequence,
          postId: result.uri,
          url: postUrl,
          parentId: parentRef?.uri,
        });

        // Update refs for chain
        if (!rootRef) {
          rootRef = { uri: result.uri, cid: result.cid };
        }
        parentRef = { uri: result.uri, cid: result.cid };

        this.logger.debug({ uri: result.uri, sequence: segment.sequence }, 'Thread post published');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error({ error: message, sequence: segment.sequence }, 'Thread post failed');
        return { success: false, posts: publishedPosts, error: `Part ${segment.sequence + 1} failed: ${message}` };
      }
    }

    this.logger.info({ count: publishedPosts!.length }, 'Bluesky thread published successfully');
    return { success: true, posts: publishedPosts };
  }

  async searchUsers(
    channel: ChannelData,
    query: string,
  ): Promise<Array<{ id: string; handle: string; name: string; profileImage?: string }>> {
    if (!channel.accessToken || !query) return [];

    const apiBase = getApiBase(channel);

    try {
      const params = new URLSearchParams({
        q: query,
        limit: '5',
      });

      const data = await this.fetchJson<{
        actors: Array<{
          did: string;
          handle: string;
          displayName?: string;
          avatar?: string;
        }>;
      }>(`${apiBase}/app.bsky.actor.searchActorsTypeahead?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${channel.accessToken}`,
        },
      });

      return data.actors.map((actor) => ({
        id: actor.did,
        handle: `@${actor.handle}`,
        name: actor.displayName || actor.handle,
        profileImage: actor.avatar,
      }));
    } catch (error) {
      this.logger.warn({ error, query }, 'Failed to search Bluesky users');
      return [];
    }
  }

  async refreshToken(refreshTokenValue: string): Promise<TokenData | null> {
    try {
      const session = await this.fetchJson<{
        accessJwt: string;
        refreshJwt: string;
        did: string;
        handle: string;
      }>(`${API_BASE}/com.atproto.server.refreshSession`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${refreshTokenValue}`,
        },
      });

      return {
        accessToken: session.accessJwt,
        refreshToken: session.refreshJwt,
        userId: session.did,
      };
    } catch (error) {
      this.logger.error({ error }, 'Failed to refresh Bluesky session');
      return null;
    }
  }

  private async createSession(
    identifier: string,
    appPassword: string,
  ): Promise<BlueskySession> {
    const session = await this.fetchJson<BlueskySession>(
      `${API_BASE}/com.atproto.server.createSession`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          identifier: identifier,
          password: appPassword,
        }),
      },
    );

    this.logger.info(
      { did: session.did, handle: session.handle },
      'Bluesky session created',
    );

    return session;
  }

  private async uploadBlob(
    localPath: string,
    mimeType: string,
    accessToken: string,
    apiBase: string,
  ): Promise<BlueskyBlob> {
    const originalBuffer = readFileSync(localPath);
    let uploadBuffer: Buffer = originalBuffer;
    let uploadMimeType = mimeType;

    // Auto-resize images over 976KB (Bluesky's practical limit)
    const MAX_IMAGE_BYTES = 976 * 1024;
    if (mimeType.startsWith('image/') && originalBuffer.length > MAX_IMAGE_BYTES) {
      this.logger.info(
        { originalSize: originalBuffer.length, limit: MAX_IMAGE_BYTES },
        'Image exceeds Bluesky size limit, auto-resizing',
      );

      // Progressively reduce quality until under the limit
      let quality = 85;
      let resized = await sharp(originalBuffer).jpeg({ quality, mozjpeg: true }).toBuffer();
      while (resized.length > MAX_IMAGE_BYTES && quality >= 20) {
        quality -= 10;
        resized = await sharp(originalBuffer).jpeg({ quality, mozjpeg: true }).toBuffer();
      }

      // If still too large, also reduce dimensions
      if (resized.length > MAX_IMAGE_BYTES) {
        const metadata = await sharp(originalBuffer).metadata();
        const scale = 0.7;
        const newWidth = Math.round((metadata.width || 1000) * scale);
        resized = await sharp(originalBuffer).resize(newWidth).jpeg({ quality: 60, mozjpeg: true }).toBuffer();
      }

      this.logger.info(
        { originalSize: originalBuffer.length, resizedSize: resized.length },
        'Image resized for Bluesky',
      );
      uploadBuffer = resized;
      uploadMimeType = 'image/jpeg';
    }

    const response = await this.fetchWithFile(
      `${apiBase}/com.atproto.repo.uploadBlob`,
      uploadBuffer,
      {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': uploadMimeType,
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Blob upload failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      blob: BlueskyBlob;
    };

    return data.blob;
  }

  private extractFacets(text: string): BlueskyFacet[] {
    const facets: BlueskyFacet[] = [];
    const encoder = new TextEncoder();

    // Detect URLs
    const urlRegex = /https?:\/\/[^\s\])<>]+/g;
    let match: RegExpExecArray | null;

    while ((match = urlRegex.exec(text)) !== null) {
      const url = match[0];
      const byteStart = encoder.encode(text.slice(0, match.index)).length;
      const byteEnd = byteStart + encoder.encode(url).length;

      facets.push({
        index: { byteStart, byteEnd },
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }],
      });
    }

    // Detect @mentions (e.g. @handle.bsky.social)
    const mentionRegex = /(^|[\s(])@([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?/g;

    while ((match = mentionRegex.exec(text)) !== null) {
      // The match may include a leading space/paren — the mention starts at @
      const fullMatch = match[0];
      const prefixLen = fullMatch.length - fullMatch.trimStart().length;
      const mention = fullMatch.trimStart(); // starts with @
      const handle = mention.slice(1); // remove @

      const mentionStart = match.index + prefixLen;
      const byteStart = encoder.encode(text.slice(0, mentionStart)).length;
      const byteEnd = byteStart + encoder.encode(mention).length;

      facets.push({
        index: { byteStart, byteEnd },
        features: [{ $type: 'app.bsky.richtext.facet#mention', did: handle }],
      });
    }

    return facets;
  }

  /**
   * Resolve mention handles to DIDs by calling the Bluesky API.
   * Mutates facets in-place, replacing handle strings with actual DIDs.
   */
  private async resolveMentionFacets(facets: BlueskyFacet[], accessToken: string, apiBase: string): Promise<void> {
    for (const facet of facets) {
      for (const feature of facet.features) {
        if (feature.$type === 'app.bsky.richtext.facet#mention' && feature.did) {
          // feature.did currently holds the handle — resolve to actual DID
          const handle = feature.did;
          try {
            const data = await this.fetchJson<{ did: string }>(
              `${apiBase}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
              { headers: { Authorization: `Bearer ${accessToken}` } },
            );
            feature.did = data.did;
          } catch {
            this.logger.warn({ handle }, 'Failed to resolve Bluesky mention handle');
            // Remove the unresolved mention feature
            feature.$type = '';
          }
        }
      }
    }
    // Remove facets with empty/unresolved features
    for (let i = facets.length - 1; i >= 0; i--) {
      facets[i].features = facets[i].features.filter((f) => f.$type !== '');
      if (facets[i].features.length === 0) facets.splice(i, 1);
    }
  }

  async publishComment(
    channel: ChannelData,
    platformPostId: string,
    comment: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const apiBase = getApiBase(channel);
      const did = (channel.metadata?.did as string) || channel.accountId;
      const accessToken = channel.accessToken;

      // Fetch the parent post to get its uri and cid for the reply reference
      const parts = platformPostId.split('/');
      const repo = parts[2]; // did:plc:xxx
      const rkey = parts[4]; // record key

      const parentPost = await this.fetchJson<{
        uri: string;
        cid: string;
      }>(
        `${apiBase}/com.atproto.repo.getRecord?` +
        `repo=${encodeURIComponent(repo)}` +
        `&collection=app.bsky.feed.post` +
        `&rkey=${encodeURIComponent(rkey)}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );

      // For replies, root and parent can be the same if replying to a top-level post.
      // If the parent itself is a reply, we'd ideally use its root — but for a first
      // comment on our own post, the parent IS the root.
      const ref = { uri: parentPost.uri, cid: parentPost.cid };

      const record: Record<string, unknown> = {
        $type: 'app.bsky.feed.post',
        text: comment,
        createdAt: new Date().toISOString(),
        reply: {
          root: ref,
          parent: ref,
        },
      };

      // Extract rich text facets (links + @mentions)
      const facets = this.extractFacets(comment);
      if (facets.length > 0) {
        await this.resolveMentionFacets(facets, accessToken, apiBase);
        if (facets.length > 0) record.facets = facets;
      }

      const result = await this.fetchJson<{ uri: string; cid: string }>(
        `${apiBase}/com.atproto.repo.createRecord`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            repo: did,
            collection: 'app.bsky.feed.post',
            record,
          }),
        },
      );

      if (!result.uri) return { success: false, error: 'Failed to create reply' };
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async repost(
    channel: ChannelData,
    platformPostId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const apiBase = getApiBase(channel);
      const did = (channel.metadata?.did as string) || channel.accountId;
      const accessToken = channel.accessToken;

      // platformPostId is an AT URI like at://did:plc:xxx/app.bsky.feed.post/rkey
      // We need uri + cid for the repost record subject
      const parts = platformPostId.split('/');
      const repo = parts[2]; // did:plc:xxx
      const rkey = parts[4]; // record key

      const parentPost = await this.fetchJson<{
        uri: string;
        cid: string;
      }>(
        `${apiBase}/com.atproto.repo.getRecord?` +
        `repo=${encodeURIComponent(repo)}` +
        `&collection=app.bsky.feed.post` +
        `&rkey=${encodeURIComponent(rkey)}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );

      await this.fetchJson<{ uri: string; cid: string }>(
        `${apiBase}/com.atproto.repo.createRecord`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            repo: did,
            collection: 'app.bsky.feed.repost',
            record: {
              $type: 'app.bsky.feed.repost',
              subject: {
                uri: parentPost.uri,
                cid: parentPost.cid,
              },
              createdAt: new Date().toISOString(),
            },
          }),
        },
      );

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

    const apiBase = getApiBase(channel);
    const batchSize = 25;

    // Bluesky access JWTs expire in ~2h and (unlike OAuth platforms) carry no
    // tokenExpiresAt, so the token-refresh worker skips them — by metrics-sync
    // time the stored access token is usually dead. Refresh the session in-run
    // with the long-lived refreshJwt and retry once on an auth failure.
    let accessToken = channel.accessToken;
    let refreshed = false;

    type GetPostsResp = {
      posts?: Array<{
        uri: string;
        likeCount?: number;
        replyCount?: number;
        repostCount?: number;
        quoteCount?: number;
        // Bookmarks are on app.bsky.feed.defs#postView — the closest Bluesky
        // equivalent of a save.
        bookmarkCount?: number;
      }>;
    };

    const fetchBatch = (batch: string[], token: string) => {
      const params = batch.map((uri) => `uris=${encodeURIComponent(uri)}`).join('&');
      return this.fetchJson<GetPostsResp>(`${apiBase}/app.bsky.feed.getPosts?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      }, { quiet: true });
    };

    for (let i = 0; i < platformPostIds.length; i += batchSize) {
      const batch = platformPostIds.slice(i, i + batchSize);
      let data: GetPostsResp | null = null;
      try {
        data = await fetchBatch(batch, accessToken);
      } catch (error) {
        // Likely an expired access JWT — refresh once with the refresh token and retry.
        if (!refreshed && channel.refreshToken) {
          refreshed = true;
          const tokens = await this.refreshToken(channel.refreshToken);
          if (tokens?.accessToken) {
            accessToken = tokens.accessToken;
            try {
              data = await fetchBatch(batch, accessToken);
            } catch (retryError) {
              this.logger.warn({ error: retryError, batchStart: i }, 'Bluesky metrics batch failed after refresh');
            }
          } else {
            this.logger.warn({ error, batchStart: i }, 'Bluesky session refresh failed during metrics sync');
          }
        } else {
          this.logger.warn({ error, batchStart: i }, 'Failed to fetch Bluesky post metrics batch');
        }
      }

      for (const post of data?.posts || []) {
        results.set(post.uri, {
          likes: post.likeCount ?? 0,
          comments: post.replyCount ?? 0,
          shares: post.repostCount ?? 0,
          saves: post.bookmarkCount ?? 0,
          // Quotes deliberately stay out of `shares`: repostCount excludes
          // them, and X keeps the same split — folding them in would make the
          // two platforms' "shares" mean different things.
          extra: { quotes: post.quoteCount ?? 0 },
        });
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
      const apiBase = getApiBase(channel);
      const data = await this.fetchJson<{
        followersCount?: number;
        followsCount?: number;
        postsCount?: number;
      }>(
        `${apiBase}/app.bsky.actor.getProfile?actor=${encodeURIComponent(channel.accountId)}`,
        { headers: { Authorization: `Bearer ${channel.accessToken}` } },
      );

      return {
        followers: data.followersCount,
        following: data.followsCount,
        platformSpecific: {
          ...(data.postsCount != null ? { postsCount: data.postsCount } : {}),
        },
      };
    } catch (error) {
      this.logger.warn({ error }, 'Failed to fetch Bluesky account analytics');
      return null;
    }
  }

  private extractDidFromJwt(jwt: string): string {
    try {
      const parts = jwt.split('.');
      if (parts.length !== 3) {
        throw new Error('Invalid JWT format');
      }

      const payload = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString('utf-8'),
      );

      if (payload.sub && typeof payload.sub === 'string') {
        return payload.sub;
      }

      throw new Error('No DID (sub) found in JWT');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to extract DID from access token: ${message}`);
    }
  }

  /**
   * Bluesky replies and likes are public — `getPostThread` returns the reply
   * tree with author handles/avatars; `getLikes` lists the likers.
   * platformPostId is the post's AT URI (at://did:.../app.bsky.feed.post/...).
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
    const headers = { Authorization: `Bearer ${channel.accessToken}` };
    const base = getApiBase(channel);
    const uri = encodeURIComponent(platformPostId);
    const result: EngagementData = { comments: [], reactions: [] };

    type BskyAuthor = {
      did: string;
      handle: string;
      displayName?: string;
      avatar?: string;
    };

    try {
      type BskyNode = {
        post?: {
          uri?: string;
          indexedAt?: string;
          likeCount?: number;
          author?: BskyAuthor;
          record?: { text?: string };
        };
        replies?: BskyNode[];
      };

      const data = await this.fetchJson<{ thread?: BskyNode }>(
        // depth=6: a reply to a reply is still a reply to this post. depth=1
        // returned only direct replies, so nested conversation was invisible.
        `${base}/app.bsky.feed.getPostThread?uri=${uri}&depth=6`,
        { headers },
      );

      // Flatten the tree depth-first, carrying each node's parent so the UI can
      // nest them.
      const flat: Array<{ node: BskyNode; parentId?: string }> = [];
      const walk = (nodes: BskyNode[], parentId?: string) => {
        for (const n of nodes) {
          flat.push({ node: n, parentId });
          if (n.replies?.length) walk(n.replies, n.post?.uri);
        }
      };
      walk(data.thread?.replies ?? []);

      // Filter first, THEN slice. Blocked/deleted nodes and image-only replies
      // have no author or text; slicing first let them consume the budget and
      // under-deliver. Dropping a parent would also orphan its children, so a
      // reply-to-a-reply would silently render as a direct reply.
      const usable = flat.filter(({ node }) => node.post?.author && node.post?.record?.text);
      const kept = new Set(usable.map(({ node }) => node.post!.uri).filter(Boolean) as string[]);

      for (const { node, parentId } of usable.slice(0, commentsLimit)) {
        const p = node.post!;
        const author = p.author!;
        result.comments.push({
          id: p.uri ?? `${author.did}:${p.indexedAt}`,
          text: p.record!.text!,
          createdAt: p.indexedAt,
          likeCount: p.likeCount,
          // Only keep a parent link if that parent survived the filter.
          parentId: parentId && kept.has(parentId) ? parentId : undefined,
          actor: {
            id: author.did,
            name: author.displayName || author.handle,
            handle: author.handle,
            profileImage: author.avatar,
            profileUrl: `https://bsky.app/profile/${author.handle}`,
          },
        });
      }
      // Counts what we could actually render, not every descendant — a single
      // top-level reply with 30 nested ones is not "more comments".
      result.hasMoreComments = usable.length > commentsLimit;
    } catch (error) {
      this.logger.warn({ error, platformPostId }, 'Bluesky replies fetch failed');
      result.notice = 'Replies unavailable';
      result.commentsNotice = 'Replies unavailable';
    }

    try {
      const data = await this.fetchJson<{
        likes?: Array<{
          actor: BskyAuthor;
          createdAt?: string;
        }>;
        cursor?: string;
      }>(`${base}/app.bsky.feed.getLikes?uri=${uri}&limit=${reactionsLimit}`, { headers });

      for (const l of data.likes ?? []) {
        result.reactions.push({
          id: `${l.actor.did}:like`,
          type: 'LIKE',
          createdAt: l.createdAt,
          actor: {
            id: l.actor.did,
            name: l.actor.displayName || l.actor.handle,
            handle: l.actor.handle,
            profileImage: l.actor.avatar,
            profileUrl: `https://bsky.app/profile/${l.actor.handle}`,
          },
        });
      }
      result.hasMoreReactions = !!data.cursor;
    } catch (error) {
      this.logger.warn({ error, platformPostId }, 'Bluesky likes fetch failed');
      result.notice = result.notice
        ? `${result.notice}; likes unavailable`
        : 'Likes unavailable';
    }

    return result;
  }
}
