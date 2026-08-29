import type { APIRoute } from 'astro';
import { db } from '@lib/db';
import { posts, postPlatforms, postLabels, recurringSchedules } from '@lib/db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
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

// ---------- POST: Bulk actions on posts ----------

export const POST: APIRoute = async ({ locals, request }) => {
  const { user } = locals.auth;
  if (!user) {
    return json({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } }, 401);
  }

  // Post writes require `post:create` — `viewer` is read-only by definition and
  // must not be able to create, edit, or delete posts (or consume post quota).
  if (!can(locals.auth.organizationRole, 'post:create')) {
    return json({ error: { message: 'Your role is read-only and cannot modify posts.', code: 'FORBIDDEN' } }, 403);
  }

  try {
    const body = await request.json();
    const { action, postIds, scheduledAt } = body;

    if (!action || !['delete', 'retry', 'reschedule'].includes(action)) {
      return json(
        {
          error: {
            message: 'Action must be one of: delete, retry, reschedule',
            code: 'VALIDATION_ERROR',
          },
        },
        400,
      );
    }

    if (!postIds || !Array.isArray(postIds) || postIds.length === 0) {
      return json(
        { error: { message: 'postIds must be a non-empty array', code: 'VALIDATION_ERROR' } },
        400,
      );
    }

    // Verify all posts belong to the user
    const userPosts = await db
      .select({ id: posts.id, status: posts.status, recurringScheduleId: posts.recurringScheduleId })
      .from(posts)
      .where(and(inArray(posts.id, postIds), eq(posts.organizationId, locals.auth.organizationId)));

    const ownedIds = userPosts.map((p) => p.id);
    if (ownedIds.length === 0) {
      return json({ error: { message: 'No matching posts found', code: 'NOT_FOUND' } }, 404);
    }

    switch (action) {
      case 'delete': {
        // Deactivate linked recurring schedules before deleting posts
        const scheduleIds = userPosts
          .map((p) => p.recurringScheduleId)
          .filter((id): id is number => id !== null && id !== undefined);
        if (scheduleIds.length > 0) {
          await db
            .update(recurringSchedules)
            .set({ isActive: false })
            .where(inArray(recurringSchedules.id, scheduleIds));
        }

        // Delete related records first
        await db.delete(postLabels).where(inArray(postLabels.postId, ownedIds));
        await db.delete(postPlatforms).where(inArray(postPlatforms.postId, ownedIds));
        await db.delete(posts).where(inArray(posts.id, ownedIds));

        logActivity({
          userId: user.id,
          organizationId: locals.auth.organizationId,
          action: 'post.bulk_deleted',
          details: { count: ownedIds.length },
        });

        return json({
          success: true,
          action: 'delete',
          affected: ownedIds.length,
        });
      }

      case 'retry': {
        // Retrying re-publishes — same gate as the publish endpoint.
        if (!can(locals.auth.organizationRole, 'post:publish')) {
          return json(
            { error: { message: 'Your role cannot publish posts', code: 'APPROVAL_REQUIRED' } },
            403,
          );
        }
        // Only retry posts that have failed platforms
        const failedPosts = userPosts.filter(
          (p) => p.status === 'failed' || p.status === 'partial',
        );

        if (failedPosts.length === 0) {
          return json(
            { error: { message: 'No failed posts to retry', code: 'VALIDATION_ERROR' } },
            400,
          );
        }

        const failedPostIds = failedPosts.map((p) => p.id);
        let totalRetried = 0;

        for (const pid of failedPostIds) {
          // Reset failed platforms to pending
          const result = await db
            .update(postPlatforms)
            .set({
              status: 'pending',
              errorMessage: null,
              retryCount: sql`${postPlatforms.retryCount} + 1`,
            })
            .where(
              and(
                eq(postPlatforms.postId, pid),
                eq(postPlatforms.status, 'failed'),
              ),
            )
            .returning();

          if (result.length > 0) {
            // Mark post as publishing
            await db
              .update(posts)
              .set({ status: 'publishing', updatedAt: new Date() })
              .where(eq(posts.id, pid));

            await addPublishJob(pid);
            totalRetried++;
          }
        }

        logActivity({
          userId: user.id,
          organizationId: locals.auth.organizationId,
          action: 'post.bulk_retried',
          details: { count: totalRetried },
        });

        return json({
          success: true,
          action: 'retry',
          affected: totalRetried,
        });
      }

      case 'reschedule': {
        if (!scheduledAt) {
          return json(
            {
              error: {
                message: 'scheduledAt is required for reschedule action',
                code: 'VALIDATION_ERROR',
              },
            },
            400,
          );
        }

        // Only reschedule draft or scheduled posts
        const reschedulable = userPosts.filter(
          (p) => p.status === 'draft' || p.status === 'scheduled',
        );

        if (reschedulable.length === 0) {
          return json(
            {
              error: {
                message: 'No draft or scheduled posts to reschedule',
                code: 'VALIDATION_ERROR',
              },
            },
            400,
          );
        }

        const reschedulableIds = reschedulable.map((p) => p.id);

        // Non-publishers can move their drafts into the queue, but only as
        // pending-approval — the scheduler won't pick those up until approved.
        const bulkApproval = can(locals.auth.organizationRole, 'post:publish')
          ? undefined
          : ('pending' as const);
        await db
          .update(posts)
          .set({
            scheduledAt: new Date(scheduledAt),
            status: 'scheduled',
            ...(bulkApproval ? { approvalStatus: bulkApproval, approvedBy: null, approvedAt: null, rejectionReason: null } : {}),
            updatedAt: new Date(),
          })
          .where(inArray(posts.id, reschedulableIds));

        logActivity({
          userId: user.id,
          organizationId: locals.auth.organizationId,
          action: 'post.bulk_rescheduled',
          details: { count: reschedulableIds.length, scheduledAt },
        });

        return json({
          success: true,
          action: 'reschedule',
          affected: reschedulableIds.length,
          scheduledAt,
        });
      }

      default:
        return json(
          { error: { message: 'Unknown action', code: 'VALIDATION_ERROR' } },
          400,
        );
    }
  } catch (error) {
    captureApiError('POST /api/posts/bulk', error);
    return json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, 500);
  }
};
