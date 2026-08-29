import type { APIRoute } from 'astro';
import { db } from '@lib/db';
import { posts } from '@lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { logActivity } from '@lib/activity/log';
import { captureApiError } from '@lib/errors';
import { can } from '@lib/team/permissions';
import { notifyUser } from '@lib/team/approvals';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------- POST: Reject a pending post ----------
//
// The post drops back to draft (it must not sit 'scheduled' while rejected)
// and keeps approvalStatus='rejected' + the reason so the author sees why.
// Editing and rescheduling it resubmits for approval.

export const POST: APIRoute = async ({ locals, params, request }) => {
  const { user } = locals.auth;
  if (!user) {
    return json({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } }, 401);
  }

  if (!can(locals.auth.organizationRole, 'post:approve')) {
    return json(
      { error: { message: 'Your role cannot reject posts', code: 'FORBIDDEN' } },
      403,
    );
  }

  const postId = params.id ? parseInt(params.id, 10) : null;
  if (!postId || Number.isNaN(postId)) {
    return json({ error: { message: 'Invalid post ID', code: 'VALIDATION_ERROR' } }, 400);
  }

  try {
    let reason: string | null = null;
    try {
      const body = await request.json();
      if (typeof body?.reason === 'string' && body.reason.trim()) {
        reason = body.reason.trim().slice(0, 2000);
      }
    } catch {
      // empty body is fine — reason is optional
    }

    const [post] = await db
      .select()
      .from(posts)
      .where(and(eq(posts.id, postId), eq(posts.organizationId, locals.auth.organizationId)));

    if (!post) {
      return json({ error: { message: 'Post not found', code: 'NOT_FOUND' } }, 404);
    }

    if (post.approvalStatus !== 'pending') {
      return json(
        { error: { message: 'Only posts awaiting approval can be rejected', code: 'VALIDATION_ERROR' } },
        400,
      );
    }

    const [updated] = await db
      .update(posts)
      .set({
        approvalStatus: 'rejected',
        rejectionReason: reason,
        status: 'draft',
        approvedBy: null,
        approvedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(posts.id, postId))
      .returning();

    notifyUser({
      userId: post.userId,
      organizationId: locals.auth.organizationId,
      title: 'Post rejected',
      message: reason
        ? `${user.name || user.email || 'An approver'} rejected your post: ${reason}`
        : `${user.name || user.email || 'An approver'} rejected your post.`,
      data: { postId, kind: 'approval_rejected', reason },
    }).catch((err) => captureApiError('notifyUser(reject)', err));

    logActivity({
      userId: user.id,
      organizationId: locals.auth.organizationId,
      action: 'post.rejected',
      resourceId: postId,
      details: reason ? { reason } : undefined,
    });

    return json(updated);
  } catch (error) {
    captureApiError('POST /api/posts/[id]/reject', error);
    return json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, 500);
  }
};
