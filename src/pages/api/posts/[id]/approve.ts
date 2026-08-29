import type { APIRoute } from 'astro';
import { db } from '@lib/db';
import { posts } from '@lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { addPublishJob } from '@lib/jobs/queue';
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

// ---------- POST: Approve a pending post ----------
//
// Approval is orthogonal to the publish lifecycle: the post keeps its
// draft/scheduled status; approving simply unblocks the scheduler. If the
// scheduled time has already passed, the post publishes immediately.

export const POST: APIRoute = async ({ locals, params }) => {
  const { user } = locals.auth;
  if (!user) {
    return json({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } }, 401);
  }

  if (!can(locals.auth.organizationRole, 'post:approve')) {
    return json(
      { error: { message: 'Your role cannot approve posts', code: 'FORBIDDEN' } },
      403,
    );
  }

  const postId = params.id ? parseInt(params.id, 10) : null;
  if (!postId || Number.isNaN(postId)) {
    return json({ error: { message: 'Invalid post ID', code: 'VALIDATION_ERROR' } }, 400);
  }

  try {
    const [post] = await db
      .select()
      .from(posts)
      .where(and(eq(posts.id, postId), eq(posts.organizationId, locals.auth.organizationId)));

    if (!post) {
      return json({ error: { message: 'Post not found', code: 'NOT_FOUND' } }, 404);
    }

    if (post.approvalStatus !== 'pending') {
      return json(
        { error: { message: 'Only posts awaiting approval can be approved', code: 'VALIDATION_ERROR' } },
        400,
      );
    }

    let [updated] = await db
      .update(posts)
      .set({
        approvalStatus: 'approved',
        approvedBy: user.id,
        approvedAt: new Date(),
        rejectionReason: null,
        updatedAt: new Date(),
      })
      .where(eq(posts.id, postId))
      .returning();

    // Overdue scheduled post (e.g. an ASAP submission): publish right away.
    // CAS on status so a concurrent scheduler pickup can't double-enqueue.
    if (updated.status === 'scheduled' && updated.scheduledAt && updated.scheduledAt.getTime() <= Date.now()) {
      const [claimed] = await db
        .update(posts)
        .set({ status: 'publishing', updatedAt: new Date() })
        .where(and(eq(posts.id, postId), eq(posts.status, 'scheduled')))
        .returning();
      if (claimed) {
        await addPublishJob(postId);
        updated = claimed;
      }
    }

    notifyUser({
      userId: post.userId,
      organizationId: locals.auth.organizationId,
      title: 'Post approved',
      message: `${user.name || user.email || 'An approver'} approved your post.`,
      data: { postId, kind: 'approval_approved' },
    }).catch((err) => captureApiError('notifyUser(approve)', err));

    logActivity({
      userId: user.id,
      organizationId: locals.auth.organizationId,
      action: 'post.approved',
      resourceId: postId,
    });

    return json(updated);
  } catch (error) {
    captureApiError('POST /api/posts/[id]/approve', error);
    return json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, 500);
  }
};
