import type { APIRoute } from 'astro';
import { db } from '@lib/db';
import { posts, postPlatforms, channels, mediaFiles as mediaFilesTable } from '@lib/db/schema';
import { eq, and, ne, inArray } from 'drizzle-orm';
import { addPublishJob } from '@lib/jobs/queue';
import { logActivity } from '@lib/activity/log';
import { captureApiError } from '@lib/errors';
import { validatePostMediaForPlatforms } from '@lib/platforms/validation';
import { getPlatformAvailabilityFor } from '@lib/platforms/availability';
import type { PlatformName } from '@lib/platforms/types';
import { can } from '@lib/team/permissions';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------- POST: Publish a draft post immediately ----------

export const POST: APIRoute = async ({ locals, params }) => {
  const { user } = locals.auth;
  if (!user) {
    return json({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } }, 401);
  }

  const postId = params.id ? parseInt(params.id, 10) : null;
  if (!postId || Number.isNaN(postId)) {
    return json({ error: { message: 'Invalid post ID', code: 'VALIDATION_ERROR' } }, 400);
  }

  // Approval gate: publishing directly requires `post:publish` — contributors
  // must submit for approval instead (Composer offers exactly that).
  if (!can(locals.auth.organizationRole, 'post:publish')) {
    return json(
      {
        error: {
          message: 'Your role cannot publish directly. Submit the post for approval instead.',
          code: 'APPROVAL_REQUIRED',
        },
      },
      403,
    );
  }

  try {
    // Fetch and verify ownership
    const [post] = await db
      .select()
      .from(posts)
      .where(and(eq(posts.id, postId), eq(posts.organizationId, locals.auth.organizationId)));

    if (!post) {
      return json({ error: { message: 'Post not found', code: 'NOT_FOUND' } }, 404);
    }

    const publishableStatuses = ['draft', 'scheduled', 'failed', 'partial'];
    if (!post.status || !publishableStatuses.includes(post.status)) {
      return json(
        {
          error: {
            message: 'Only draft, scheduled, or failed posts can be published',
            code: 'VALIDATION_ERROR',
          },
        },
        400,
      );
    }

    // Verify the post has at least one platform target
    const platforms = await db
      .select()
      .from(postPlatforms)
      .where(eq(postPlatforms.postId, postId));

    if (platforms.length === 0) {
      return json(
        {
          error: {
            message: 'Post has no target channels. Add at least one channel before publishing.',
            code: 'VALIDATION_ERROR',
          },
        },
        400,
      );
    }

    // Pre-publish media validation — reject a post that cannot possibly publish
    // (e.g. a text-only post sent to YouTube) with a clear, up-front error
    // instead of letting it fail deep in the worker. This is the universal gate
    // hit by both the UI "Publish now" and the agentic API.
    const rawMediaIds = Array.isArray(post.mediaFiles) ? post.mediaFiles : [];
    const mediaIds = rawMediaIds
      .map((entry: any) => (typeof entry === 'number' ? entry : entry?.id))
      .filter((id: any) => typeof id === 'number' && !Number.isNaN(id));
    let media: { mimeType: string; width: number | null; height: number | null }[] = [];
    if (mediaIds.length > 0) {
      media = await db
        .select({ mimeType: mediaFilesTable.mimeType, width: mediaFilesTable.width, height: mediaFilesTable.height })
        .from(mediaFilesTable)
        .where(and(inArray(mediaFilesTable.id, mediaIds), eq(mediaFilesTable.organizationId, locals.auth.organizationId)));
    }

    const mediaErrors = validatePostMediaForPlatforms({
      content: post.content,
      platformContent: post.platformContent as Record<string, string> | null,
      media,
      postFormat: post.postFormat,
      postTypeOverrides: post.postTypeOverrides as Record<string, string> | null,
      platforms: platforms.map((p) => p.platform as PlatformName),
    });
    if (mediaErrors.length > 0) {
      return json(
        { error: { message: mediaErrors.map((e) => e.message).join('; '), code: 'VALIDATION_ERROR' } },
        400,
      );
    }

    // Platform kill switch: refuse a "publish now" whose platform is switched off.
    // The worker would only hold the post, leaving it stuck in 'publishing' with no
    // feedback — an explicit 403 tells the user why nothing happened.
    // Resolved per target channel, not per platform: LinkedIn company pages are
    // gated separately from personal profiles (`PLATFORM_LINKEDIN_PAGES`).
    const targetChannels = await db
      .select({ id: channels.id, accountType: channels.accountType })
      .from(channels)
      .where(inArray(channels.id, platforms.map((p) => p.channelId)));
    const accountTypeByChannel = new Map(targetChannels.map((c) => [c.id, c.accountType]));

    const disabled = platforms
      .map((p) => getPlatformAvailabilityFor(p.platform, accountTypeByChannel.get(p.channelId)))
      .find((a) => !a.canPublish);
    if (disabled) {
      return json(
        {
          error: {
            message: disabled.message,
            code: 'PLATFORM_DISABLED',
            platform: disabled.platform,
            ...(disabled.variant ? { accountType: disabled.variant } : {}),
            state: disabled.state,
            reason: disabled.reason,
          },
        },
        403,
      );
    }

    // Publishing a pending/rejected post is an implicit approval (every role
    // with post:publish also has post:approve) — stamp it so the audit trail
    // shows who signed off.
    if (post.approvalStatus === 'pending' || post.approvalStatus === 'rejected') {
      await db
        .update(posts)
        .set({ approvalStatus: 'approved', approvedBy: user.id, approvedAt: new Date(), rejectionReason: null })
        .where(eq(posts.id, postId));
    }

    // Atomically flip to 'publishing'. If it is already publishing (a double-click or a
    // concurrent request), the conditional returns no row and we do NOT enqueue a second
    // job — two publish jobs for one post would publish every platform twice.
    const [updatedPost] = await db
      .update(posts)
      .set({ status: 'publishing', updatedAt: new Date() })
      .where(and(eq(posts.id, postId), ne(posts.status, 'publishing')))
      .returning();

    if (!updatedPost) {
      return json({ error: { message: 'This post is already being published.', code: 'ALREADY_PUBLISHING' } }, 409);
    }

    // Add publish job to queue
    await addPublishJob(postId);

    logActivity({
      userId: user.id,
      organizationId: locals.auth.organizationId,
      action: 'post.publish_queued',
      resourceId: postId,
      details: { platforms: platforms.length },
    });

    return json({
      ...updatedPost,
      postPlatforms: platforms,
    });
  } catch (error) {
    captureApiError('POST /api/posts/[id]/publish', error);
    return json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, 500);
  }
};
