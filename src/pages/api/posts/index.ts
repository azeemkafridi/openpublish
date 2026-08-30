import type { APIRoute } from 'astro';
import { db } from '@lib/db';
import {
  posts,
  postPlatforms,
  postLabels,
  labels,
  channels,
  mediaFiles as mediaFilesTable,
  postMetrics,
} from '@lib/db/schema';
import {
  eq,
  and,
  or,
  desc,
  lte,
  gte,
  sql,
  inArray,
  ilike,
} from 'drizzle-orm';
import { addPublishJob } from '@lib/jobs/queue';
import { getMediaPublicUrl } from '@lib/media/upload';
import { logActivity } from '@lib/activity/log';
import { checkPostQuotasBatch, checkScheduledPerDayQuota, checkPlatformAllowed, getOrgPlan } from '@lib/quotas/check';
import { quotaExceededResponse } from '@lib/quotas/errors';
import { PLATFORM_CHAR_LIMITS, validatePlatformContentShape, validatePlatformSpecificShape, validatePostTypeOverridesShape, validateThreadPartsShape, validatePostMediaForPlatforms } from '@lib/platforms/validation';
import { getPlatformAvailabilityFor } from '@lib/platforms/availability';
import { platformLength } from '@lib/url';
import { isChannelIdList } from '@lib/channels/validate';

/**
 * A status chip can cover more than one stored status. `published` includes
 * `partial` — the post is live, just not on every channel — matching how the
 * rest of the app reads success (lib/posts/contentLabel.ts). `processing` is
 * deliberately NOT included: the platform has accepted the upload but hasn't
 * confirmed it, so it gets its own chip rather than being claimed as live.
 */
const STATUS_FILTER_ALIASES: Record<string, string[]> = {
  published: ['published', 'partial'],
};

/**
 * Newest-first by the timestamp that actually matters for each post: when it
 * went live, else when it is due, else when it was written.
 *
 * Ordering by `createdAt` alone buried scheduled posts once they published — a
 * post written on Jul 16 and published Aug 1 sorted among Jul 16 posts, 92 rows
 * down the Published list (page 5 at 20/page), so the Published tab looked like
 * it was missing everything that came from a schedule.
 *
 * Interpolates only column references, so it carries no bound parameters and
 * renders identically wherever it is reused.
 */
const POST_TIMELINE_ORDER = sql`COALESCE(${posts.publishedAt}, ${posts.scheduledAt}, ${posts.createdAt}) DESC`;
import type { PlatformName } from '@lib/platforms/types';
import { captureApiError } from '@lib/errors';
import { can } from '@lib/team/permissions';
import { resolveApprovalStatus, notifyApprovers } from '@lib/team/approvals';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------- GET: List posts with pagination and filters ----------

export const GET: APIRoute = async ({ locals, url }) => {
  const { user } = locals.auth;
  if (!user) {
    return json({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } }, 401);
  }

  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));
  const status = url.searchParams.get('status');
  const channelId = url.searchParams.get('channelId');
  const labelId = url.searchParams.get('labelId');
  const labelIdsParam = url.searchParams.get('labelIds');
  const labelModeParam = url.searchParams.get('labelMode') || 'or';
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const scheduledFrom = url.searchParams.get('scheduledFrom');
  const scheduledTo = url.searchParams.get('scheduledTo');
  const search = url.searchParams.get('search');

  try {
    // Build where conditions
    const conditions: ReturnType<typeof eq>[] = [eq(posts.organizationId, locals.auth.organizationId)];

    if (status) {
      // "Published" covers `partial` too — the post went live, just not on
      // every channel. Filtering on `= 'published'` alone hid posts that are
      // live on the platform (see STATUS_FILTER_ALIASES).
      const statuses = STATUS_FILTER_ALIASES[status] ?? [status];
      conditions.push(
        statuses.length === 1
          ? eq(posts.status, statuses[0] as any)
          : inArray(posts.status, statuses as any),
      );
    }

    const approvalStatusFilter = url.searchParams.get('approvalStatus');
    if (approvalStatusFilter) {
      conditions.push(eq(posts.approvalStatus, approvalStatusFilter as any));
    }


    if (from) {
      conditions.push(gte(posts.createdAt, new Date(from)));
    }

    if (to) {
      // A bare date parses to midnight UTC, which made `to` exclusive of the
      // whole day it names (from=to matched a zero-width instant — the
      // Overview "Today" tab was permanently empty). Same expansion as
      // scheduledTo below.
      const toDate = new Date(to);
      if (!to.includes('T')) {
        toDate.setUTCHours(23, 59, 59, 999);
      }
      conditions.push(lte(posts.createdAt, toDate));
    }

    if (scheduledFrom && scheduledTo) {
      const fromDate = new Date(scheduledFrom);
      const toDate = new Date(scheduledTo);
      if (!scheduledTo.includes('T')) {
        toDate.setUTCHours(23, 59, 59, 999);
      }
      // Match posts where scheduledAt OR publishedAt falls in the range
      // so published posts appear on the calendar even if scheduledAt is null
      conditions.push(
        or(
          and(gte(posts.scheduledAt, fromDate), lte(posts.scheduledAt, toDate)),
          and(gte(posts.publishedAt, fromDate), lte(posts.publishedAt, toDate)),
        )!,
      );
    } else if (scheduledFrom) {
      conditions.push(
        or(
          gte(posts.scheduledAt, new Date(scheduledFrom)),
          gte(posts.publishedAt, new Date(scheduledFrom)),
        )!,
      );
    } else if (scheduledTo) {
      const toDate = new Date(scheduledTo);
      if (!scheduledTo.includes('T')) {
        toDate.setUTCHours(23, 59, 59, 999);
      }
      conditions.push(
        or(
          lte(posts.scheduledAt, toDate),
          lte(posts.publishedAt, toDate),
        )!,
      );
    }

    if (search) {
      conditions.push(ilike(posts.content, `%${search}%`));
    }

    // If filtering by channelId, verify ownership then get postIds
    if (channelId) {
      const [ownedChannel] = await db
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.id, parseInt(channelId, 10)), eq(channels.organizationId, locals.auth.organizationId)))
        .limit(1);
      if (!ownedChannel) {
        return json({ posts: [], total: 0, page, limit, totalPages: 0 });
      }
      const channelPostIds = await db
        .select({ postId: postPlatforms.postId })
        .from(postPlatforms)
        .where(eq(postPlatforms.channelId, ownedChannel.id));

      const ids = channelPostIds.map((r) => r.postId);
      if (ids.length === 0) {
        return json({ posts: [], total: 0, page, limit, totalPages: 0 });
      }
      conditions.push(inArray(posts.id, ids));
    }

    // If filtering by labelId, verify ownership then get postIds
    if (labelId) {
      const [ownedLabel] = await db
        .select({ id: labels.id })
        .from(labels)
        .where(and(eq(labels.id, parseInt(labelId, 10)), eq(labels.organizationId, locals.auth.organizationId)))
        .limit(1);
      if (!ownedLabel) {
        return json({ posts: [], total: 0, page, limit, totalPages: 0 });
      }
      const labelPostIds = await db
        .select({ postId: postLabels.postId })
        .from(postLabels)
        .where(eq(postLabels.labelId, ownedLabel.id));

      const ids = labelPostIds.map((r) => r.postId);
      if (ids.length === 0) {
        return json({ posts: [], total: 0, page, limit, totalPages: 0 });
      }
      conditions.push(inArray(posts.id, ids));
    }

    // Multi-label filtering: ?labelIds=1,2,3&labelMode=or|and
    if (labelIdsParam) {
      const labelIdList = labelIdsParam
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));

      if (labelIdList.length > 0) {
        // Verify all labels belong to the current org
        const ownedLabels = await db
          .select({ id: labels.id })
          .from(labels)
          .where(and(inArray(labels.id, labelIdList), eq(labels.organizationId, locals.auth.organizationId)));
        if (ownedLabels.length !== labelIdList.length) {
          return json({ posts: [], total: 0, page, limit, totalPages: 0 });
        }

        if (labelModeParam === 'and') {
          // AND: posts must have ALL selected labels — single query with GROUP BY HAVING
          const matchingPosts = await db
            .select({
              postId: postLabels.postId,
              matchCount: sql<number>`count(*)::int`,
            })
            .from(postLabels)
            .where(inArray(postLabels.labelId, labelIdList))
            .groupBy(postLabels.postId)
            .having(sql`count(*) = ${labelIdList.length}`);

          const ids = matchingPosts.map((r) => r.postId);
          if (ids.length === 0) {
            return json({ posts: [], total: 0, page, limit, totalPages: 0 });
          }
          conditions.push(inArray(posts.id, ids));
        } else {
          // OR: posts with ANY of the selected labels
          const labelPostIds = await db
            .select({ postId: postLabels.postId })
            .from(postLabels)
            .where(inArray(postLabels.labelId, labelIdList));
          const ids = [...new Set(labelPostIds.map((r) => r.postId))];
          if (ids.length === 0) {
            return json({ posts: [], total: 0, page, limit, totalPages: 0 });
          }
          conditions.push(inArray(posts.id, ids));
        }
      }
    }

    const whereClause = and(...conditions);

    const offset = (page - 1) * limit;

    // Total count + the page itself are independent (offset doesn't need the count),
    // so run them concurrently instead of serially — halves the round-trip latency on
    // this hot, polled endpoint. Both are org-scoped via whereClause.
    const [countRows, postRows] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(posts).where(whereClause),
      db
        .select()
        .from(posts)
        .where(whereClause)
        .orderBy(POST_TIMELINE_ORDER, desc(posts.id))
        .limit(limit)
        .offset(offset),
    ]);
    const total = countRows[0]?.count ?? 0;
    const totalPages = Math.ceil(total / limit);

    // Fetch postPlatforms for all returned posts
    let platformsMap: Record<number, (typeof postPlatforms.$inferSelect)[]> = {};
    if (postRows.length > 0) {
      const postIds = postRows.map((p) => p.id);
      const platforms = await db
        .select()
        .from(postPlatforms)
        .where(inArray(postPlatforms.postId, postIds));

      for (const pp of platforms) {
        if (!platformsMap[pp.postId]) {
          platformsMap[pp.postId] = [];
        }
        platformsMap[pp.postId].push(pp);
      }
    }

    // Fetch labels for all returned posts
    let labelsMap: Record<number, (typeof labels.$inferSelect)[]> = {};
    if (postRows.length > 0) {
      const postIds = postRows.map((p) => p.id);
      const postLabelRows = await db
        .select({
          postId: postLabels.postId,
          label: labels,
        })
        .from(postLabels)
        .innerJoin(labels, eq(postLabels.labelId, labels.id))
        .where(inArray(postLabels.postId, postIds));

      for (const row of postLabelRows) {
        if (!labelsMap[row.postId]) {
          labelsMap[row.postId] = [];
        }
        labelsMap[row.postId].push(row.label);
      }
    }

    // Resolve media file IDs into full objects
    const allMediaIds = new Set<number>();
    for (const post of postRows) {
      const raw = Array.isArray(post.mediaFiles) ? post.mediaFiles : [];
      for (const entry of raw) {
        const id = typeof entry === 'number' ? entry : typeof entry === 'object' && (entry as any)?.id ? (entry as any).id : Number(entry);
        if (!Number.isNaN(id)) allMediaIds.add(id);
      }
    }

    let mediaMap = new Map<number, any>();
    if (allMediaIds.size > 0) {
      const mediaRows = await db
        .select()
        .from(mediaFilesTable)
        .where(and(inArray(mediaFilesTable.id, [...allMediaIds]), eq(mediaFilesTable.organizationId, locals.auth.organizationId)));
      for (const f of mediaRows) {
        mediaMap.set(f.id, {
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
        });
      }
    }

    // Aggregate metrics per post — take ONLY the latest snapshot per post_platform
    // (sync worker inserts a new row each cycle; SUM would over-count by N snapshots),
    // then sum across platforms for the same post.
    const metricsMap = new Map<number, { impressions: number; likes: number; comments: number; shares: number }>();
    const allPostIds = postRows.map((p) => p.id);
    if (allPostIds.length > 0) {
      // DISTINCT ON (post_platform_id) lets Postgres pick the latest row per
      // post_platform via the (post_platform_id, fetched_at DESC) index, instead
      // of scanning every historical snapshot and deduping in JS.
      const latestSnapshots = await db
        .selectDistinctOn(
          [postMetrics.postPlatformId],
          {
            postPlatformId: postMetrics.postPlatformId,
            postId: postMetrics.postId,
            impressions: postMetrics.impressions,
            likes: postMetrics.likes,
            comments: postMetrics.comments,
            shares: postMetrics.shares,
          },
        )
        .from(postMetrics)
        // Defense-in-depth org scope (post_metrics_org_idx) — postIds are already
        // org-filtered, but this guards against future refactors leaking cross-tenant.
        .where(and(inArray(postMetrics.postId, allPostIds), eq(postMetrics.organizationId, locals.auth.organizationId)))
        .orderBy(postMetrics.postPlatformId, desc(postMetrics.fetchedAt));

      for (const row of latestSnapshots) {
        const existing = metricsMap.get(row.postId) || { impressions: 0, likes: 0, comments: 0, shares: 0 };
        existing.impressions += row.impressions || 0;
        existing.likes += row.likes || 0;
        existing.comments += row.comments || 0;
        existing.shares += row.shares || 0;
        metricsMap.set(row.postId, existing);
      }

      // Drop entries that ended up with no engagement data
      for (const [id, m] of metricsMap) {
        if (m.impressions === 0 && m.likes === 0 && m.comments === 0 && m.shares === 0) {
          metricsMap.delete(id);
        }
      }
    }

    const postsWithRelations = postRows.map((post) => {
      const rawIds = Array.isArray(post.mediaFiles) ? post.mediaFiles : [];
      const resolvedMedia = rawIds
        .map((entry: any) => {
          const id = typeof entry === 'number' ? entry : typeof entry === 'object' && entry?.id ? entry.id : Number(entry);
          return mediaMap.get(id);
        })
        .filter(Boolean);

      return {
        ...post,
        mediaFiles: resolvedMedia,
        postPlatforms: platformsMap[post.id] || [],
        labels: labelsMap[post.id] || [],
        metrics: metricsMap.get(post.id) ?? null,
      };
    });

    return json({ posts: postsWithRelations, total, page, limit, totalPages });
  } catch (error) {
    captureApiError('GET /api/posts', error);
    return json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, 500);
  }
};

// ---------- POST: Create a new post ----------

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
    // TODO(security): TOCTOU race — concurrent requests can overshoot quota by +1. Advisory lock or atomic INSERT...SELECT needed.
    const quotas = await checkPostQuotasBatch(locals.auth.organizationId);
    if (!quotas.daily.allowed) return quotaExceededResponse(quotas.daily, quotas.plan);
    if (!quotas.monthly.allowed) return quotaExceededResponse(quotas.monthly, quotas.plan);

    const body = await request.json();

    let {
      content,
      mediaFiles,
      status: postStatus = 'draft',
      scheduledAt,
      timezone,
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

    // Approval gate (team roles Phase 2): members without `post:publish`
    // (contributors) can only SUBMIT scheduled posts — the post is created as
    // approvalStatus='pending' and the scheduler skips it until approved.
    // `requestApproval: true` opts anyone into the same review flow.
    const approvalStatus = resolveApprovalStatus({
      role: locals.auth.organizationRole,
      targetStatus: postStatus,
      requestApproval,
      existing: 'none',
    });

    // Validate media ownership — ensure all media IDs belong to the current user.
    // Capture mime types here so we can reuse them for pre-publish validation below.
    let resolvedMedia: { mimeType: string; width: number | null; height: number | null }[] = [];
    if (mediaFiles && Array.isArray(mediaFiles) && mediaFiles.length > 0) {
      const mediaIds = mediaFiles
        .map((entry: any) => (typeof entry === 'number' ? entry : entry?.id))
        .filter((id: any) => typeof id === 'number' && !Number.isNaN(id));

      if (mediaIds.length > 0) {
        const ownedMedia = await db
          .select({ id: mediaFilesTable.id, mimeType: mediaFilesTable.mimeType, width: mediaFilesTable.width, height: mediaFilesTable.height })
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
        resolvedMedia = ownedMedia.map((m) => ({ mimeType: m.mimeType, width: m.width, height: m.height }));
      }
    }

    // Validate required fields
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
    if (!postStatus || !['draft', 'scheduled'].includes(postStatus)) {
      return json(
        { error: { message: 'Status must be "draft" or "scheduled"', code: 'VALIDATION_ERROR' } },
        400,
      );
    }

    if (postStatus === 'scheduled' && !scheduledAt) {
      return json(
        { error: { message: 'scheduledAt is required for scheduled posts', code: 'VALIDATION_ERROR' } },
        400,
      );
    }

    // Enforce the advertised per-day scheduled-post limit, counted against the calendar
    // day this post is scheduled for (Pro/Business have unlimited pending-scheduled, so
    // this is the only bound on how many can be queued for a single day).
    if (postStatus === 'scheduled' && scheduledAt) {
      const perDay = await checkScheduledPerDayQuota(locals.auth.organizationId, new Date(scheduledAt), timezone || 'UTC');
      if (!perDay.allowed) return quotaExceededResponse(perDay, quotas.plan);
    }

    if (!channelEntries || !Array.isArray(channelEntries) || channelEntries.length === 0) {
      return json(
        { error: { message: 'At least one channel is required', code: 'VALIDATION_ERROR' } },
        400,
      );
    }

    // Normalize channels: accept plain IDs [15, 23], objects without platform [{channelId: 15}],
    // or full objects [{channelId: 15, platform: "facebook"}]. Auto-resolve platform from DB.
    const channelIds = channelEntries.map((ch: any) =>
      typeof ch === 'number' ? ch : ch.channelId,
    );
    // Reject non-integer ids BEFORE the query — channels.id is bigint, so a
    // stray string (a prod client once sent the account handle) makes Postgres
    // throw at parse time and the request 500s instead of 400ing.
    if (!isChannelIdList(channelIds)) {
      return json(
        { error: { message: 'Each channel must be a numeric channelId (get ids from GET /api/channels)', code: 'VALIDATION_ERROR' } },
        400,
      );
    }

    // Validate channel ownership — ensure all channels belong to the current user
    const ownedChannels = await db
      .select({ id: channels.id, platform: channels.platform, accountType: channels.accountType })
      .from(channels)
      .where(and(inArray(channels.id, channelIds), eq(channels.organizationId, locals.auth.organizationId)));
    if (ownedChannels.length !== channelIds.length) {
      return json(
        { error: { message: 'Some channels do not belong to you', code: 'FORBIDDEN' } },
        403,
      );
    }

    // Build a map of channelId -> platform from DB (source of truth)
    const channelPlatformMap = new Map(ownedChannels.map((c) => [c.id, c.platform]));

    // Re-normalize channelEntries with DB-resolved platforms
    channelEntries = channelIds.map((id: number) => ({
      channelId: id,
      platform: channelPlatformMap.get(id)!,
    }));

    // Validate platform restrictions — ensure channels' platforms are allowed on current plan
    {
      const platforms: string[] = channelEntries.map((ch: { platform: string }) => ch.platform);
      const uniquePlatforms: string[] = Array.from(new Set(platforms));

      // Kill switch first, evaluated per (platform, accountType) so a paused
      // variant (LinkedIn company pages) is caught while its siblings publish.
      for (const ch of ownedChannels) {
        const availability = getPlatformAvailabilityFor(ch.platform, ch.accountType);
        if (!availability.canPublish) {
          return json(
            {
              error: {
                message: availability.message,
                code: 'PLATFORM_DISABLED',
                platform: ch.platform,
                ...(availability.variant ? { accountType: availability.variant } : {}),
                state: availability.state,
                reason: availability.reason,
              },
            },
            403,
          );
        }
      }

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

    // Validate label ownership — ensure all labels belong to the current user
    if (labelIds && Array.isArray(labelIds) && labelIds.length > 0) {
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
    if (postFormat === 'thread') {
      if (!threadParts || !Array.isArray(threadParts) || threadParts.length < 2) {
        return json(
          { error: { message: 'Threads require at least 2 parts', code: 'VALIDATION_ERROR' } },
          400,
        );
      }
      // Validate media IDs in thread parts belong to org
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

    // Validate content length per platform
    {
      const text = content || '';
      const errors: string[] = [];
      for (const ch of channelEntries) {
        const platform = ch.platform as PlatformName;
        const limit = PLATFORM_CHAR_LIMITS[platform];
        const len = platformLength(text, platform);
        if (limit && len > limit) {
          errors.push(`${platform}: content exceeds ${limit} character limit (${len})`);
        }
      }
      // Also check per-platform content overrides
      if (platformContent && typeof platformContent === 'object') {
        for (const [platform, pcText] of Object.entries(platformContent)) {
          if (typeof pcText === 'string' && pcText.length > 0) {
            const limit = PLATFORM_CHAR_LIMITS[platform as PlatformName];
            const len = platformLength(pcText, platform);
            if (limit && len > limit) {
              errors.push(`${platform}: content exceeds ${limit} character limit (${len})`);
            }
          }
        }
      }
      if (errors.length > 0) {
        return json(
          { error: { message: errors.join('; '), code: 'VALIDATION_ERROR' } },
          400,
        );
      }
    }

    // Pre-publish media validation — only for posts that will actually publish
    // (scheduled/now). Drafts are allowed to be incomplete so work-in-progress
    // can be saved. This rejects e.g. a text-only YouTube post up front with a
    // clear message instead of letting it fail later in the worker.
    if (postStatus === 'scheduled') {
      const mediaErrors = validatePostMediaForPlatforms({
        content,
        platformContent: platformContent as Record<string, string> | null,
        media: resolvedMedia,
        postFormat,
        postTypeOverrides: postTypeOverrides as Record<string, string> | null,
        platforms: channelEntries.map((ch: { platform: string }) => ch.platform as PlatformName),
      });
      if (mediaErrors.length > 0) {
        return json(
          { error: { message: mediaErrors.map((e) => e.message).join('; '), code: 'VALIDATION_ERROR' } },
          400,
        );
      }
    }

    // Check pending scheduled quota (free plan: 10 scheduled posts at a time)
    if (postStatus === 'scheduled' && !quotas.scheduled.allowed) {
      return quotaExceededResponse(quotas.scheduled, quotas.plan);
    }

    // Create the post
    const [newPost] = await db
      .insert(posts)
      .values({
        userId: user.id,
        organizationId: locals.auth.organizationId,
        content: content || '',
        mediaFiles: mediaFiles || [],
        status: postStatus,
        approvalStatus,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        timezone: timezone || 'UTC',
        postFormat: postFormat || 'post',
        postTypeOverrides: postTypeOverrides || {},
        platformSpecific: platformSpecific || {},
        platformContent: platformContent || {},
        // Default KEEP (reclaimed by the 3-month retention sweep); a client may opt
        // in to delete-after-publish.
        deleteMediaAfterPublish: deleteMediaAfterPublish ?? false,
        // Tri-state: only a real boolean is an override. Anything else (absent,
        // null, junk) stores NULL, meaning "inherit the org setting".
        linkTrackingOverride: typeof linkTrackingOverride === 'boolean' ? linkTrackingOverride : null,
        threadParts: postFormat === 'thread' && threadParts ? threadParts : null,
        platformThreadParts: postFormat === 'thread' && platformThreadParts ? platformThreadParts : {},
        autoPlugEnabled: autoPlugEnabled ?? false,
        autoPlugText: autoPlugText || null,
        autoPlugThreshold: autoPlugThreshold ?? 50,
        autoPlugFired: false,
        autoRepostEnabled: autoRepostEnabled ?? false,
        autoRepostThreshold: autoRepostThreshold ?? 100,
        autoRepostFired: false,
      })
      .returning();

    // Create postPlatform entries for each channel
    const platformEntries = channelEntries.map(
      (ch: { channelId: number; platform: string }) => ({
        postId: newPost.id,
        channelId: ch.channelId,
        platform: ch.platform as any,
        status: 'pending' as const,
      }),
    );

    const createdPlatforms = await db
      .insert(postPlatforms)
      .values(platformEntries)
      .returning();

    // Create postLabel entries
    let createdLabels: { postId: number; labelId: number }[] = [];
    if (labelIds && Array.isArray(labelIds) && labelIds.length > 0) {
      const labelEntries = labelIds.map((lid: number) => ({
        postId: newPost.id,
        labelId: lid,
      }));
      createdLabels = await db
        .insert(postLabels)
        .values(labelEntries)
        .returning();
    }

    // If scheduled and scheduledAt is in the past or now, immediately queue publish.
    // Queue the job BEFORE updating the DB status: if the queue call fails, the post
    // stays in 'scheduled' and the per-minute scheduler will pick it up next cycle.
    // A pending-approval post must NEVER publish immediately — it waits for an
    // approver even when scheduledAt is now/past (the approve route publishes it).
    if (postStatus === 'scheduled' && scheduledAt && approvalStatus !== 'pending') {
      const scheduledTime = new Date(scheduledAt).getTime();
      const now = Date.now();
      if (scheduledTime <= now) {
        await addPublishJob(newPost.id);
        await db
          .update(posts)
          .set({ status: 'publishing' })
          .where(eq(posts.id, newPost.id));
        newPost.status = 'publishing';
      }
    }

    if (approvalStatus === 'pending') {
      // Fire-and-forget: a notification failure must not fail the create.
      notifyApprovers({
        organizationId: locals.auth.organizationId,
        excludeUserId: user.id,
        title: 'Post awaiting approval',
        message: `${user.name || user.email || 'A teammate'} submitted a post for approval.`,
        data: { postId: newPost.id, kind: 'approval_requested' },
      }).catch((err) => captureApiError('notifyApprovers', err));
    }

    logActivity({
      userId: user.id,
      organizationId: locals.auth.organizationId,
      action:
        approvalStatus === 'pending'
          ? 'post.submitted_for_approval'
          : postStatus === 'scheduled'
            ? 'post.scheduled'
            : 'post.drafted',
      resourceId: newPost.id,
      details: { status: postStatus, approvalStatus, channels: channelEntries.length },
    });

    return json(
      {
        ...newPost,
        postPlatforms: createdPlatforms,
        labels: createdLabels,
      },
      201,
    );
  } catch (error) {
    captureApiError('POST /api/posts', error);
    return json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, 500);
  }
};

