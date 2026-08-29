import type { APIRoute } from 'astro';
import { db } from '@lib/db';
import { posts, postPlatforms } from '@lib/db/schema';
import { eq, and, ne, sql, inArray } from 'drizzle-orm';
import { addPublishJob } from '@lib/jobs/queue';
import { logActivity } from '@lib/activity/log';
import { captureApiError } from '@lib/errors';
import { can } from '@lib/team/permissions';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------- POST: Retry failed platforms for a post ----------

export const POST: APIRoute = async ({ locals, params, request }) => {
  const { user } = locals.auth;
  if (!user) {
    return json({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } }, 401);
  }

  const postId = params.id ? parseInt(params.id, 10) : null;
  if (!postId || Number.isNaN(postId)) {
    return json({ error: { message: 'Invalid post ID', code: 'VALIDATION_ERROR' } }, 400);
  }

  // Retrying re-publishes — same role gate as the publish endpoint.
  if (!can(locals.auth.organizationRole, 'post:publish')) {
    return json(
      { error: { message: 'Your role cannot publish posts', code: 'APPROVAL_REQUIRED' } },
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

    // `republish: true` is the explicit opt-in for retrying UNCONFIRMED
    // platforms — ones whose publish request may have already gone through
    // (the response was lost). Without the flag those are never touched, so
    // an automation can't accidentally double-post. The 400 below doubles as
    // the confirmation dialog for API/agent callers.
    let republish = false;
    try {
      const body = await request.json();
      republish = body?.republish === true;
    } catch {
      /* empty body is fine */
    }

    // One query for both categories; unconfirmed rows only become retryable
    // when the caller explicitly opted in.
    const candidates = await db
      .select()
      .from(postPlatforms)
      .where(
        and(
          eq(postPlatforms.postId, postId),
          inArray(postPlatforms.status, ['failed', 'unconfirmed']),
        ),
      );

    const failedPlatforms = candidates.filter(
      (fp) => fp.status === 'failed' || (republish && fp.status === 'unconfirmed'),
    );
    const blockedUnconfirmed = !republish && candidates.some((fp) => fp.status === 'unconfirmed');

    if (failedPlatforms.length === 0) {
      return json(
        {
          error: {
            message: blockedUnconfirmed
              ? 'This post has platforms whose publish could not be confirmed, so it may already be live. ' +
                'Check the account first, then pass "republish": true to retry anyway (this can duplicate the post).'
              : 'No failed platforms to retry',
            code: blockedUnconfirmed ? 'UNCONFIRMED_REQUIRES_REPUBLISH' : 'VALIDATION_ERROR',
          },
        },
        400,
      );
    }

    // Check retry limits and reset failed platforms to pending
    const retryableIds: number[] = [];
    const maxedOutIds: number[] = [];

    for (const fp of failedPlatforms) {
      if (fp.retryCount !== null && fp.maxRetries !== null && fp.retryCount >= fp.maxRetries) {
        maxedOutIds.push(fp.id);
      } else {
        retryableIds.push(fp.id);
      }
    }

    if (retryableIds.length === 0) {
      return json(
        {
          error: {
            message: 'All failed platforms have exceeded their maximum retry count, try editing the post again using the Edit button.',
            code: 'VALIDATION_ERROR',
          },
        },
        400,
      );
    }

    // Reset status and increment retry count for retryable platforms
    for (const id of retryableIds) {
      await db
        .update(postPlatforms)
        .set({
          status: 'pending',
          errorMessage: null,
          retryCount: sql`${postPlatforms.retryCount} + 1`,
        })
        .where(eq(postPlatforms.id, id));
    }

    // Atomically flip to 'publishing'. If a concurrent retry/publish already did, the
    // conditional returns no row and we don't enqueue a second job (would double-publish).
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

    // Fetch all platforms for the response
    const allPlatforms = await db
      .select()
      .from(postPlatforms)
      .where(eq(postPlatforms.postId, postId));

    logActivity({
      userId: user.id,
      organizationId: locals.auth.organizationId,
      action: 'post.retried',
      resourceId: postId,
      details: { retriedCount: retryableIds.length },
    });

    return json({
      ...updatedPost,
      postPlatforms: allPlatforms,
      retriedCount: retryableIds.length,
      skippedMaxRetries: maxedOutIds.length,
    });
  } catch (error) {
    captureApiError('POST /api/posts/[id]/retry', error);
    return json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, 500);
  }
};
