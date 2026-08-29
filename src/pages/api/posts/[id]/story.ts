import type { APIRoute } from 'astro';
import { db } from '@lib/db';
import { posts, postPlatforms, channels, mediaFiles } from '@lib/db/schema';
import { eq, and } from 'drizzle-orm';
import '@lib/platforms/init';
import { getPlatformHandler } from '@lib/platforms/registry';
import type { PlatformName, ChannelData, PostData } from '@lib/platforms/types';
import { decrypt } from '@lib/auth/crypto';
import { getMediaPublicUrl } from '@lib/media/upload';
import { captureApiError } from '@lib/errors';
import { can } from '@lib/team/permissions';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * POST /api/posts/:id/story
 * Publish the post's first media as a story to a specific platform.
 * Body: { platform: 'facebook' | 'instagram' }
 */
export const POST: APIRoute = async ({ locals, params, request }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  // Publishing a story is direct publishing — same role gate as /publish.
  if (!can(locals.auth.organizationRole, 'post:publish')) {
    return json({ error: 'Your role cannot publish posts' }, 403);
  }

  const postId = Number(params.id);
  if (!postId || isNaN(postId)) return json({ error: 'Invalid post ID' }, 400);

  const body = await request.json().catch(() => null);
  const platform = body?.platform;
  if (platform !== 'facebook' && platform !== 'instagram') {
    return json({ error: 'platform must be "facebook" or "instagram"' }, 400);
  }

  try {
    // Fetch the post
    const [post] = await db
      .select()
      .from(posts)
      .where(and(eq(posts.id, postId), eq(posts.organizationId, locals.auth.organizationId)));
    if (!post) return json({ error: 'Post not found' }, 404);

    // Must have media
    const mediaIds = (post.mediaFiles as unknown[]) || [];
    if (mediaIds.length === 0) return json({ error: 'Post has no media' }, 400);

    // Find the channel for this platform
    const [pp] = await db
      .select()
      .from(postPlatforms)
      .where(and(eq(postPlatforms.postId, postId), eq(postPlatforms.platform, platform)));
    if (!pp) return json({ error: `Post has no ${platform} platform` }, 400);

    const [channel] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.id, pp.channelId), eq(channels.isActive, true), eq(channels.organizationId, locals.auth.organizationId)));
    if (!channel?.accessToken) return json({ error: 'Channel not found or inactive' }, 400);

    // Resolve first media file URL
    const firstMediaRef = mediaIds[0];
    const mediaId = typeof firstMediaRef === 'number' ? firstMediaRef : (firstMediaRef as any)?.id;
    if (!mediaId) return json({ error: 'Invalid media reference' }, 400);

    const [media] = await db.select().from(mediaFiles).where(and(eq(mediaFiles.id, mediaId), eq(mediaFiles.organizationId, locals.auth.organizationId)));
    if (!media) return json({ error: 'Media file not found' }, 400);

    const mediaUrl = getMediaPublicUrl(media.originalPath);

    // Build story post data
    const handler = getPlatformHandler(platform as PlatformName);
    const channelData: ChannelData = {
      id: channel.id,
      platform: channel.platform as PlatformName,
      accountId: channel.accountId,
      accountName: channel.accountName,
      accountType: channel.accountType || undefined,
      accessToken: decrypt(channel.accessToken),
      refreshToken: channel.refreshToken ? decrypt(channel.refreshToken) : undefined,
      metadata: channel.metadata as Record<string, unknown> | undefined,
    };

    const storyData: PostData = {
      content: '',
      postType: 'story',
      mediaFiles: [{
        url: mediaUrl,
        localPath: media.originalPath,
        mimeType: media.mimeType,
        width: media.width ?? undefined,
        height: media.height ?? undefined,
        sizeBytes: media.sizeBytes ?? undefined,
      }],
      mediaUrls: [mediaUrl],
      platformSpecific: {},
    };

    const result = await handler.publishPost(storyData, channelData);

    if (!result.success) {
      return json({ error: result.error || 'Story publish failed' }, 422);
    }

    return json({
      success: true,
      postId: result.postId,
      url: result.url,
    });
  } catch (error) {
    captureApiError('POST /api/posts/[id]/story', error);
    // Don't leak the raw error to the client; it's captured above.
    return json({ error: 'Failed to publish story. Please try again.' }, 500);
  }
};
