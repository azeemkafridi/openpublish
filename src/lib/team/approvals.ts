/**
 * Post-approval helpers (team roles Phase 2).
 *
 * Approval is a per-post flag orthogonal to the publish lifecycle: a post can be
 * `scheduled` while `approvalStatus` is `pending`, and the scheduler skips it
 * until an approver moves it to `approved`. The `can()` matrix in
 * `./permissions.ts` decides who publishes directly vs. who submits for review.
 */
import { db } from '@lib/db';
import { notifications, organizationMembers, organizations } from '@lib/db/schema';
import { eq } from 'drizzle-orm';
import { can, type OrgRole } from './permissions';
import { sendPushToUser, sendPushToUsers } from '@lib/push/expo';

export type PostApprovalStatus = 'none' | 'pending' | 'approved' | 'rejected';

/** Approval statuses the scheduler is allowed to publish. */
export const PUBLISHABLE_APPROVAL_STATUSES: PostApprovalStatus[] = ['none', 'approved'];

/**
 * Resolve the approval status a post should carry after a create/edit that
 * leaves it in `targetStatus`.
 *
 * Rules:
 * - Scheduling without `post:publish` always forces `pending` (the role gate).
 * - `requestApproval: true` opts any scheduled post into review, even for
 *   members who could publish directly (e.g. agent-created posts).
 * - A publisher scheduling over a `rejected` post clears it to `none`.
 * - Moving a post back to draft retracts a pending/approved state (`none`)
 *   but keeps `rejected` so the author still sees the reviewer's reason.
 * - Otherwise the existing state is preserved (an approver editing a pending
 *   post does NOT implicitly approve it — approval is an explicit action).
 */
export function resolveApprovalStatus(opts: {
  role: OrgRole | string;
  targetStatus: string | null;
  requestApproval: boolean | undefined;
  existing: PostApprovalStatus;
}): PostApprovalStatus {
  const { role, targetStatus, requestApproval, existing } = opts;
  const canPublish = can(role, 'post:publish');

  if (targetStatus === 'scheduled') {
    if (requestApproval === true || !canPublish) return 'pending';
    if (existing === 'rejected') return 'none';
    return existing;
  }

  // Draft (and failed/partial resets): pending/approved are retracted; a
  // rejection sticks so the reason stays visible until resubmission.
  if (existing === 'pending' || existing === 'approved') return 'none';
  return existing;
}

/**
 * In-app notify every org member who can approve posts (minus the actor).
 * Uses the generic `system` notification type — approval events ride the
 * existing notification bell without a new enum value.
 */
export async function notifyApprovers(opts: {
  organizationId: number;
  excludeUserId: string;
  title: string;
  message: string;
  data?: Record<string, unknown>;
}) {
  const members = await db
    .select({ userId: organizationMembers.userId, role: organizationMembers.role })
    .from(organizationMembers)
    .where(eq(organizationMembers.organizationId, opts.organizationId));

  // The org owner may not have a membership row — include them explicitly.
  const [org] = await db
    .select({ ownerId: organizations.ownerId })
    .from(organizations)
    .where(eq(organizations.id, opts.organizationId))
    .limit(1);

  const targets = new Set<string>();
  for (const m of members) {
    if (can(m.role, 'post:approve')) targets.add(m.userId);
  }
  if (org?.ownerId) targets.add(org.ownerId);
  targets.delete(opts.excludeUserId);

  if (targets.size === 0) return;
  await db.insert(notifications).values(
    [...targets].map((userId) => ({
      userId,
      organizationId: opts.organizationId,
      type: 'system' as const,
      title: opts.title,
      message: opts.message,
      data: opts.data,
    })),
  );

  // Mirror to mobile push — approvals are time-sensitive and the bell alone
  // is easy to miss. Batched (one token query, one chunked Expo send) and
  // fire-and-forget: a push failure must never fail the submit.
  sendPushToUsers([...targets], {
    title: opts.title,
    body: opts.message,
    data: opts.data,
  }).catch(() => {});
}

/** In-app notify a single user (the post author on approve/reject). */
export async function notifyUser(opts: {
  userId: string;
  organizationId: number;
  title: string;
  message: string;
  data?: Record<string, unknown>;
}) {
  await db.insert(notifications).values({
    userId: opts.userId,
    organizationId: opts.organizationId,
    type: 'system' as const,
    title: opts.title,
    message: opts.message,
    data: opts.data,
  });

  sendPushToUser(opts.userId, {
    title: opts.title,
    body: opts.message,
    data: opts.data,
  }).catch(() => {});
}
