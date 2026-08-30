import type { APIRoute } from 'astro';
import { db } from '@lib/db';
import {
  posts,
  postPlatforms,
  postLabels,
  labels,
  channels,
  mediaFiles as mediaFilesTable,
} from '@lib/db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { getMediaPublicUrl } from '@lib/media/upload';
import { logActivity } from '@lib/activity/log';
import { captureApiError } from '@lib/errors';
import { validatePlatformContentShape, validatePlatformSpecificShape, validatePostTypeOverridesShape, validateThreadPartsShape, validatePostMediaForPlatforms } from '@lib/platforms/validation';
import type { PlatformName } from '@lib/platforms/types';
import { checkPlatformAllowed } from '@lib/quotas/check';
import { can } from '@lib/team/permissions';
import { resolveApprovalStatus, notifyApprovers } from '@lib/team/approvals';
import { isChannelIdList } from '@lib/channels/validate';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getPostId(params: Record<string, string | undefined>): number | null {
  const raw = params.id;
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

// ---------- GET: Single post with all relations ----------

export const GET: APIRoute = async ({ locals, params }) => {
  const { user } = locals.auth;
  if (!user) {
    return json({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } }, 401);
  }

  const postId = getPostId(params);
  if (!postId) {
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

    const platforms = await db
      .select()
      .from(postPlatforms)
      .where(eq(postPlatforms.postId, post.id));

    const postLabelRows = await db
      .select({
        postId: postLabels.postId,
        label: labels,
      })
      .from(postLabels)
      .innerJoin(labels, eq(postLabels.labelId, labels.id))
      .where(eq(postLabels.postId, post.id));

    // Resolve media file IDs into full objects
    const rawMediaIds = Array.isArray(post.mediaFiles) ? post.mediaFiles : [];
    const mediaIds = rawMediaIds.map((id: any) => (typeof id === 'number' ? id : typeof id === 'object' && id?.id ? id.id : Number(id))).filter((id: number) => !Number.isNaN(id));
    let resolvedMedia: any[] = [];
    if (mediaIds.length > 0) {
      const rows = await db
        .select()
        .from(mediaFilesTable)
        .where(and(inArray(mediaFilesTable.id, mediaIds), eq(mediaFilesTable.organizationId, locals.auth.organizationId)));
      // Maintain original order
      const byId = new Map(rows.map((r) => [r.id, r]));
      resolvedMedia = mediaIds
        .map((id: number) => byId.get(id))
        .filter(Boolean)
        .map((f: any) => ({
          id: f.id,
          originalUrl: getMediaPublicUrl(f.originalPath),
          thumbnailUrl: f.thumbnailPath ? getMediaPublicUrl(f.thumbnailPath) : null,
          previewUrl: f.previewPath ? getMediaPublicUrl(f.previewPath) : undefined,
          largeUrl: f.largePath ? getMediaPublicUrl(f.largePath) : undefined,
          fileName: f.fileName,
          mimeType: f.mimeType,
          sizeBytes: f.sizeBytes,
          width: f.width,
          height: f.height,
          duration: f.duration,
          isOriginalDeleted: f.isOriginalDeleted,
        }));
    }


    return json({
      ...post,
      mediaFiles: resolvedMedia,
      postPlatforms: platforms,
      labels: postLabelRows.map((r) => r.label),
    });
  } catch (error) {
    captureApiError('GET /api/posts/[id]', error);
    return json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, 500);
  }
};

// ---------- PUT: Update post (only draft or scheduled) ----------

export const PUT: APIRoute = async ({ locals, params, request }) => {
  const { user } = locals.auth;
  if (!user) {
    return json({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } }, 401);
  }

  // Post writes require `post:create` — `viewer` is read-only by definition and
  // must not be able to create, edit, or delete posts (or consume post quota).
  if (!can(locals.auth.organizationRole, 'post:create')) {
    return json({ error: { message: 'Your role is read-only and cannot modify posts.', code: 'FORBIDDEN' } }, 403);
  }

  const postId = getPostId(params);
  if (!postId) {
    return json({ error: { message: 'Invalid post ID', code: 'VALIDATION_ERROR' } }, 400);
  }

  try {
    // Fetch existing post
    const [existing] = await db
      .select()
      .from(posts)
      .where(and(eq(posts.id, postId), eq(posts.organizationId, locals.auth.organizationId)));

    if (!existing) {
      return json({ error: { message: 'Post not found', code: 'NOT_FOUND' } }, 404);
    }

    const editableStatuses = ['draft', 'scheduled', 'failed', 'partial'];
    if (!existing.status || !editableStatuses.includes(existing.status)) {
      return json(
        {
          error: {
            message: 'Only draft, scheduled, or failed posts can be updated',
            code: 'VALIDATION_ERROR',
          },
        },
        400,
      );
    }

    const body = await request.json();

    const {
      content,
      mediaFiles,
      scheduledAt,
      timezone,
      status: requestedStatus,
      channels: channelEntries,
      labels: labelIds,
      postFormat,
      postTypeOverrides,
      platformSpecific,
      deleteMediaAfterPublish,
      linkTrackingOverride,
      threadParts,
      platformContent,
      platformThreadParts,
      autoPlugEnabled,
      autoPlugText,
      autoPlugThreshold,
      autoRepostEnabled,
      autoRepostThreshold,
      requestApproval,
    } = body;

    if (content !== undefined && content !== null && typeof content !== 'string') {
      return json(
        { error: { message: 'content must be a string', code: 'VALIDATION_ERROR' } },
        400,
      );
    }
    {
      const shapeError =
        validatePlatformContentShape(platformContent) ??
        validateThreadPartsShape(threadParts, platformThreadParts) ??
        validatePlatformSpecificShape(platformSpecific) ??
        validatePostTypeOverridesShape(postTypeOverrides);
      if (shapeError) {
        return json({ error: { message: shapeError, code: 'VALIDATION_ERROR' } }, 400);
      }
    }

    // Status transitions via edit are limited to draft <-> scheduled. Other statuses
    // (published/publishing/processing/failed/partial) are owned by the publish pipeline,
    // not user edits. Previously `status` was silently ignored here, so scheduling a draft
    // from an edit left it stuck as a draft and it never published.
    if (
      requestedStatus !== undefined &&
      requestedStatus !== 'draft' &&
      requestedStatus !== 'scheduled'
    ) {
      return json(
        { error: { message: 'status can only be set to draft or scheduled', code: 'VALIDATION_ERROR' } },
        400,
      );
    }
    // Effective status once this edit lands (failed/partial auto-reset to draft below).
    const targetStatus =
      requestedStatus ??
      (existing.status === 'failed' || existing.status === 'partial' ? 'draft' : existing.status);
    // Moving a post into `scheduled` (from a draft, or keeping a scheduled post scheduled)
    // requires a real future time, or the scheduler would never pick it up.
    if (requestedStatus === 'scheduled') {
      const effScheduledAt = scheduledAt !== undefined ? scheduledAt : existing.scheduledAt;
      if (!effScheduledAt || new Date(effScheduledAt).getTime() <= Date.now()) {
        return json(
          { error: { message: 'Scheduled posts need a future date and time', code: 'VALIDATION_ERROR' } },
          400,
        );
      }
    }

    // Validate media ownership — ensure all media IDs belong to the current user
    if (mediaFiles !== undefined && Array.isArray(mediaFiles) && mediaFiles.length > 0) {
      const mediaIds = mediaFiles
        .map((entry: any) => (typeof entry === 'number' ? entry : entry?.id))
        .filter((id: any) => typeof id === 'number' && !Number.isNaN(id));

      if (mediaIds.length > 0) {
        const ownedMedia = await db
          .select({ id: mediaFilesTable.id })
          .from(mediaFilesTable)
          .where(and(inArray(mediaFilesTable.id, mediaIds), eq(mediaFilesTable.organizationId, locals.auth.organizationId)));

        const ownedIds = new Set(ownedMedia.map((m) => m.id));
        const unauthorized = mediaIds.filter((id: number) => !ownedIds.has(id));
        if (unauthorized.length > 0) {
          return json(
            { error: { message: 'Some media files do not belong to you', code: 'FORBIDDEN' } },
            403,
          );
        }
      }
    }

    // Validate channel ownership
    if (channelEntries !== undefined && Array.isArray(channelEntries) && channelEntries.length > 0) {
      const channelIds = channelEntries.map((ch: { channelId: number }) => ch.channelId);
      // channels.id is bigint — a non-integer id would make Postgres throw (500); 400 instead.
      if (!isChannelIdList(channelIds)) {
        return json(
          { error: { message: 'Each channel must be a numeric channelId (get ids from GET /api/channels)', code: 'VALIDATION_ERROR' } },
          400,
        );
      }
      const ownedChannels = await db
        .select({ id: channels.id })
        .from(channels)
        .where(and(inArray(channels.id, channelIds), eq(channels.organizationId, locals.auth.organizationId)));
      if (ownedChannels.length !== channelIds.length) {
        return json(
          { error: { message: 'Some channels do not belong to you', code: 'FORBIDDEN' } },
          403,
        );
      }

      // Re-check plan-allowed platforms when channels change — otherwise a downgraded org
      // could retarget a now-restricted platform by editing an existing post (the create
      // path enforces this; the edit path previously did not).
      const uniquePlatforms = Array.from(new Set(channelEntries.map((ch: { platform: string }) => ch.platform)));
      for (const platform of uniquePlatforms) {
        const check = await checkPlatformAllowed(locals.auth.organizationId, platform);
        if (!check.allowed) {
          return json(
            { error: { message: `${platform} is not available on your current plan`, code: 'FEATURE_DISABLED' } },
            403,
          );
        }
      }
    }

    // Validate label ownership
    if (labelIds !== undefined && Array.isArray(labelIds) && labelIds.length > 0) {
      const ownedLabels = await db
        .select({ id: labels.id })
        .from(labels)
        .where(and(inArray(labels.id, labelIds), eq(labels.organizationId, locals.auth.organizationId)));
      if (ownedLabels.length !== labelIds.length) {
        return json(
          { error: { message: 'Some labels do not belong to you', code: 'FORBIDDEN' } },
          403,
        );
      }
    }

    // Validate threadParts for thread format
    const effectiveFormat = postFormat !== undefined ? postFormat : existing.postFormat;
    if (effectiveFormat === 'thread' && threadParts !== undefined) {
      if (!Array.isArray(threadParts) || threadParts.length < 2) {
        return json(
          { error: { message: 'Threads require at least 2 parts', code: 'VALIDATION_ERROR' } },
          400,
        );
      }
      const threadMediaIds = threadParts
        .flatMap((p: any) => p.mediaFileIds || [])
        .filter((id: any) => typeof id === 'number' && !Number.isNaN(id));
      if (threadMediaIds.length > 0) {
        const ownedMedia = await db
          .select({ id: mediaFilesTable.id })
          .from(mediaFilesTable)
          .where(and(inArray(mediaFilesTable.id, threadMediaIds), eq(mediaFilesTable.organizationId, locals.auth.organizationId)));
        const ownedIds = new Set(ownedMedia.map((m) => m.id));
        const unauthorized = threadMediaIds.filter((id: number) => !ownedIds.has(id));
        if (unauthorized.length > 0) {
          return json(
            { error: { message: 'Some thread media files do not belong to you', code: 'FORBIDDEN' } },
            403,
          );
        }
      }
    }

    // Pre-publish media validation — only when the edit leaves the post in a
    // publish-bound (scheduled) state, whether it was already scheduled or is being
    // scheduled from a draft now. failed/partial posts reset to draft (and drafts may be
    // incomplete), so those skip the gate. Effective values merge the incoming body with
    // the existing row (undefined field = unchanged).
    if (targetStatus === 'scheduled') {
      const effContent = content !== undefined ? content : existing.content;
      const effOverrides = (postTypeOverrides !== undefined ? postTypeOverrides : existing.postTypeOverrides) as Record<string, string> | null;
      const effPlatformContent = (platformContent !== undefined ? platformContent : existing.platformContent) as Record<string, string> | null;
      const effMediaRaw = mediaFiles !== undefined ? mediaFiles : (existing.mediaFiles as unknown);
      const effMediaIds = (Array.isArray(effMediaRaw) ? effMediaRaw : [])
        .map((entry: any) => (typeof entry === 'number' ? entry : entry?.id))
        .filter((id: any) => typeof id === 'number' && !Number.isNaN(id));

      // Effective target platforms: the incoming channel set if provided, else the current ones.
      let effPlatforms: PlatformName[];
      if (channelEntries !== undefined && Array.isArray(channelEntries)) {
        const cids = channelEntries.map((ch: { channelId: number }) => ch.channelId);
        const rows = cids.length > 0
          ? await db.select({ platform: channels.platform }).from(channels)
              .where(and(inArray(channels.id, cids), eq(channels.organizationId, locals.auth.organizationId)))
          : [];
        effPlatforms = rows.map((r) => r.platform as PlatformName);
      } else {
        const rows = await db.select({ platform: postPlatforms.platform }).from(postPlatforms).where(eq(postPlatforms.postId, postId));
        effPlatforms = rows.map((r) => r.platform as PlatformName);
      }

      // A scheduled post with no channels would publish nowhere — block it (a draft can
      // legitimately have zero channels, but scheduling one cannot).
      if (effPlatforms.length === 0) {
        return json(
          { error: { message: 'Add at least one channel before scheduling', code: 'VALIDATION_ERROR' } },
          400,
        );
      }

      let media: { mimeType: string; width: number | null; height: number | null }[] = [];
      if (effMediaIds.length > 0) {
        media = await db.select({ mimeType: mediaFilesTable.mimeType, width: mediaFilesTable.width, height: mediaFilesTable.height }).from(mediaFilesTable)
          .where(and(inArray(mediaFilesTable.id, effMediaIds), eq(mediaFilesTable.organizationId, locals.auth.organizationId)));
      }

      const mediaErrors = validatePostMediaForPlatforms({
        content: effContent,
        platformContent: effPlatformContent,
        media,
        postFormat: effectiveFormat,
        postTypeOverrides: effOverrides,
        platforms: effPlatforms,
      });
      if (mediaErrors.length > 0) {
        return json({ error: { message: mediaErrors.map((e) => e.message).join('; '), code: 'VALIDATION_ERROR' } }, 400);
      }
    }

    // Build update fields
    const updateFields: Record<string, unknown> = { updatedAt: new Date() };

    // Reset failed/partial posts to draft so they can be re-published
    if (existing.status === 'failed' || existing.status === 'partial') {
      updateFields.status = 'draft';
      // Reset all failed platform entries
      await db
        .update(postPlatforms)
        .set({ status: 'pending', errorMessage: null, retryCount: 0 })
        .where(and(eq(postPlatforms.postId, postId), eq(postPlatforms.status, 'failed')));
    }

    // Apply an explicit draft<->scheduled transition last, so it overrides the
    // failed/partial->draft reset above (the platform reset already ran).
    if (requestedStatus !== undefined) {
      updateFields.status = requestedStatus;
    }

    // Approval gate (team roles Phase 2): re-resolve the approval state for the
    // post's post-edit status. Non-publishers keeping a post scheduled always land
    // back in 'pending' — an already-approved post edited by a contributor must be
    // re-reviewed, or approval would cover content the approver never saw.
    const newApprovalStatus = resolveApprovalStatus({
      role: locals.auth.organizationRole,
      targetStatus: (updateFields.status as string | undefined) ?? existing.status,
      requestApproval,
      existing: (existing.approvalStatus ?? 'none') as any,
    });
    if (newApprovalStatus !== existing.approvalStatus) {
      updateFields.approvalStatus = newApprovalStatus;
      if (newApprovalStatus === 'pending' || newApprovalStatus === 'none') {
        updateFields.approvedBy = null;
        updateFields.approvedAt = null;
        updateFields.rejectionReason = null;
      }
    }

    if (content !== undefined) updateFields.content = content;
    if (mediaFiles !== undefined) updateFields.mediaFiles = mediaFiles;
    if (scheduledAt !== undefined) updateFields.scheduledAt = scheduledAt ? new Date(scheduledAt) : null;
    if (timezone !== undefined) updateFields.timezone = timezone;
    if (postFormat !== undefined) updateFields.postFormat = postFormat;
    if (postTypeOverrides !== undefined) updateFields.postTypeOverrides = postTypeOverrides;
    if (platformSpecific !== undefined) updateFields.platformSpecific = platformSpecific;
    if (platformContent !== undefined) updateFields.platformContent = platformContent;
    if (deleteMediaAfterPublish !== undefined) {
      updateFields.deleteMediaAfterPublish = deleteMediaAfterPublish;
    }
    // Tri-state: `null` is a real value here ("inherit the org setting"), so it
    // must be distinguished from the field being absent. Only `undefined` means
    // "leave alone"; a non-boolean, non-null value resets to inherit.
    if (linkTrackingOverride !== undefined) {
      updateFields.linkTrackingOverride =
        typeof linkTrackingOverride === 'boolean' ? linkTrackingOverride : null;
    }
    if (threadParts !== undefined) updateFields.threadParts = effectiveFormat === 'thread' ? threadParts : null;
    if (platformThreadParts !== undefined) updateFields.platformThreadParts = effectiveFormat === 'thread' ? platformThreadParts : {};
    if (autoPlugEnabled !== undefined) updateFields.autoPlugEnabled = autoPlugEnabled;
    if (autoPlugText !== undefined) updateFields.autoPlugText = autoPlugText || null;
    if (autoPlugThreshold !== undefined) updateFields.autoPlugThreshold = autoPlugThreshold;
    if (autoRepostEnabled !== undefined) updateFields.autoRepostEnabled = autoRepostEnabled;
    if (autoRepostThreshold !== undefined) updateFields.autoRepostThreshold = autoRepostThreshold;
    // Reset fired flags when automation settings change so they can re-trigger
    if (autoPlugEnabled !== undefined || autoPlugThreshold !== undefined) {
      updateFields.autoPlugFired = false;
    }
    if (autoRepostEnabled !== undefined || autoRepostThreshold !== undefined) {
      updateFields.autoRepostFired = false;
    }

    // Update the post record
    const [updatedPost] = await db
      .update(posts)
      .set(updateFields)
      .where(eq(posts.id, postId))
      .returning();


    // When channels change, replace postPlatform entries. Atomic delete+reinsert so a
    // failure mid-way can't strip every channel off the post (which would then publish
    // nowhere / silently fail).
    let platforms: (typeof postPlatforms.$inferSelect)[];
    if (channelEntries !== undefined && Array.isArray(channelEntries)) {
      platforms = await db.transaction(async (tx) => {
        await tx.delete(postPlatforms).where(eq(postPlatforms.postId, postId));
        if (channelEntries.length > 0) {
          const platformEntries = channelEntries.map(
            (ch: { channelId: number; platform: string }) => ({
              postId,
              channelId: ch.channelId,
              platform: ch.platform as any,
              status: 'pending' as const,
            }),
          );
          return await tx.insert(postPlatforms).values(platformEntries).returning();
        }
        return [];
      });
    } else {
      platforms = await db
        .select()
        .from(postPlatforms)
        .where(eq(postPlatforms.postId, postId));
    }

    // When labels change, replace postLabel entries (atomic delete+reinsert).
    let postLabelResults: { postId: number; labelId: number }[];
    if (labelIds !== undefined && Array.isArray(labelIds)) {
      postLabelResults = await db.transaction(async (tx) => {
        await tx.delete(postLabels).where(eq(postLabels.postId, postId));
        if (labelIds.length > 0) {
          const labelEntries = labelIds.map((lid: number) => ({
            postId,
            labelId: lid,
          }));
          return await tx.insert(postLabels).values(labelEntries).returning();
        }
        return [];
      });
    } else {
      postLabelResults = await db
        .select()
        .from(postLabels)
        .where(eq(postLabels.postId, postId));
    }

    // Fetch full label objects for the response
    const labelRows = await db
      .select({ label: labels })
      .from(postLabels)
      .innerJoin(labels, eq(postLabels.labelId, labels.id))
      .where(eq(postLabels.postId, postId));

    if (newApprovalStatus === 'pending' && existing.approvalStatus !== 'pending') {
      notifyApprovers({
        organizationId: locals.auth.organizationId,
        excludeUserId: user.id,
        title: 'Post awaiting approval',
        message: `${user.name || user.email || 'A teammate'} submitted a post for approval.`,
        data: { postId, kind: 'approval_requested' },
      }).catch((err) => captureApiError('notifyApprovers', err));
    }

    // Determine specific action
    let action = 'post.edited';
    if (scheduledAt !== undefined && scheduledAt && !existing.scheduledAt) {
      action = 'post.scheduled';
    } else if (scheduledAt !== undefined && scheduledAt && existing.scheduledAt) {
      action = 'post.rescheduled';
    } else if (scheduledAt === null && existing.scheduledAt) {
      action = 'post.unscheduled';
    }

    logActivity({
      userId: user.id,
      organizationId: locals.auth.organizationId,
      action,
      resourceId: postId,
    });

    return json({
      ...updatedPost,
      postPlatforms: platforms,
      labels: labelRows.map((r) => r.label),
    });
  } catch (error) {
    captureApiError('PUT /api/posts/[id]', error);
    return json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, 500);
  }
};

// ---------- DELETE// ---------- DELETE: Delete post and related records ----------

export const DELETE: APIRoute = async ({ locals, params }) => {
  const { user } = locals.auth;
  if (!user) {
    return json({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } }, 401);
  }

  // Post writes require `post:create` — `viewer` is read-only by definition and
  // must not be able to create, edit, or delete posts (or consume post quota).
  if (!can(locals.auth.organizationRole, 'post:create')) {
    return json({ error: { message: 'Your role is read-only and cannot modify posts.', code: 'FORBIDDEN' } }, 403);
  }

  const postId = getPostId(params);
  if (!postId) {
    return json({ error: { message: 'Invalid post ID', code: 'VALIDATION_ERROR' } }, 400);
  }

  try {
    // Verify ownership
    const [existing] = await db
      .select()
      .from(posts)
      .where(and(eq(posts.id, postId), eq(posts.organizationId, locals.auth.organizationId)));

    if (!existing) {
      return json({ error: { message: 'Post not found', code: 'NOT_FOUND' } }, 404);
    }

    // Delete related records first, then the post
    await db.delete(postLabels).where(eq(postLabels.postId, postId));
    await db.delete(postPlatforms).where(eq(postPlatforms.postId, postId));
    await db.delete(posts).where(eq(posts.id, postId));

    logActivity({
      userId: user.id,
      organizationId: locals.auth.organizationId,
      action: 'post.deleted',
      resourceId: postId,
    });

    return json({ success: true });
  } catch (error) {
    captureApiError('DELETE /api/posts/[id]', error);
    return json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, 500);
  }
};
