import type { APIRoute } from 'astro';
import { db } from '@lib/db';
import { posts, postPlatforms, channels, mediaFiles as mediaFilesTable, recurringSchedules, type MediaFileRef } from '@lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { addPublishJob } from '@lib/jobs/queue';
import { findNextQueueSlots } from '@lib/queue/scheduler';
import { rehostUrlToMedia, RemoteMediaError } from '@lib/media/remote';
import { calculateNextRunAt } from '@lib/schedules/next-run';
import { checkPostQuotasBatch, checkPlatformAllowed, checkRecurringScheduleQuota, checkScheduledPerDayQuota, checkMediaStorageQuota, type QuotaCheckResult } from '@lib/quotas/check';
import { quotaExceededResponse } from '@lib/quotas/errors';
import { getPlatformAvailabilityFor } from '@lib/platforms/availability';
import { PLATFORM_CHAR_LIMITS, validatePlatformSpecificShape, validatePostMediaForPlatforms } from '@lib/platforms/validation';
import { platformLength } from '@lib/url';
import type { PlatformName } from '@lib/platforms/types';
import { logActivity } from '@lib/activity/log';
import { captureApiError } from '@lib/errors';
import { can } from '@lib/team/permissions';

/**
 * POST /api/posts/bulk-create
 *
 * Create many posts in one request (Bulk Create / Bulk Import).
 * Mirrors POST /api/posts validation (ownership, platform limits, char limits)
 * but batched: ownership is checked once across the whole batch, quota is checked
 * for the whole batch up-front (block-with-remaining), and all rows are inserted
 * in a single transaction. Posts scheduled for now-or-past are queued to publish.
 */

const MAX_BATCH = 100;
const MAX_MEDIA_URLS = 40; // per batch — each URL is fetched + uploaded, so keep it bounded

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Derive recurring-schedule fields (HH:MM, weekday, day-of-month) from an ISO time in a tz. */
function recurringPartsInTz(iso: string, tz: string): { timeOfDay: string; dayOfWeek: number; dayOfMonth: number } {
  const date = new Date(iso);
  const dayStr = date.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
  const timeOfDay = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date); // HH:MM
  const [y, m, d] = dayStr.split('-').map(Number);
  return { timeOfDay, dayOfWeek: new Date(y, m - 1, d).getDay(), dayOfMonth: d };
}

const RESOURCE_LABELS: Record<string, string> = {
  posts_per_day: 'posts today',
  posts_per_month: 'posts this month',
  pending_scheduled: 'scheduled posts',
  scheduled_per_day: 'scheduled posts on that day',
  recurring_schedules: 'recurring schedules',
};

interface IncomingChannel {
  channelId: number;
  platform?: string;
}
interface IncomingPost {
  content?: string;
  mediaFiles?: number[];
  mediaUrls?: string[];
  channels?: IncomingChannel[] | null;
  scheduledAt?: string | null;
  status?: 'draft' | 'scheduled';
  platformSpecific?: Record<string, unknown>;
  platformContent?: Record<string, string>;
  postTypeOverrides?: Record<string, string>;
  postFormat?: 'post' | 'thread';
  threadParts?: Array<{ content?: string; mediaFileIds?: number[] }> | null;
  autoPlugEnabled?: boolean;
  autoPlugText?: string;
  autoPlugThreshold?: number;
  autoRepostEnabled?: boolean;
  autoRepostThreshold?: number;
}

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
  const orgId = locals.auth.organizationId;

  try {
    const body = await request.json().catch(() => null);
    const defaults = (body?.defaults ?? {}) as {
      channels?: IncomingChannel[];
      timezone?: string;
      status?: string;
      useQueue?: boolean;
      repeatSchedule?: { frequency?: string } | null;
    };
    const incoming: IncomingPost[] = Array.isArray(body?.posts) ? body.posts : [];

    const defaultStatus: 'draft' | 'scheduled' = defaults.status === 'scheduled' ? 'scheduled' : 'draft';
    const timezone = typeof defaults.timezone === 'string' && defaults.timezone ? defaults.timezone : 'UTC';
    const defaultChannels: IncomingChannel[] = Array.isArray(defaults.channels) ? defaults.channels : [];

    // "Add to queue": auto-assign each post the next open queue slot (scheduled posts only).
    const useQueue = defaults.useQueue === true && defaultStatus === 'scheduled';
    // "Repeat": create a recurring schedule per scheduled post.
    const VALID_FREQ = new Set(['daily', 'weekly', 'biweekly', 'monthly']);
    const repeatFreq =
      defaults.repeatSchedule && typeof defaults.repeatSchedule.frequency === 'string' && VALID_FREQ.has(defaults.repeatSchedule.frequency)
        ? defaults.repeatSchedule.frequency
        : null;

    if (incoming.length === 0) {
      return json({ error: { message: 'No posts provided', code: 'VALIDATION_ERROR' } }, 400);
    }
    if (incoming.length > MAX_BATCH) {
      return json({ error: { message: `Too many posts in one batch (max ${MAX_BATCH})`, code: 'VALIDATION_ERROR' } }, 400);
    }

    // Resolve each post's effective fields (per-post channels override the shared set).
    const toId = (c: IncomingChannel | number) => (typeof c === 'number' ? c : c?.channelId);
    const resolved = incoming.map((p) => {
      const chans = Array.isArray(p.channels) && p.channels.length > 0 ? p.channels : defaultChannels;
      const status: 'draft' | 'scheduled' = p.status === 'scheduled' || p.status === 'draft' ? p.status : defaultStatus;
      const media = Array.isArray(p.mediaFiles)
        ? p.mediaFiles.map(Number).filter((id) => Number.isInteger(id))
        : [];
      const mediaUrls = Array.isArray(p.mediaUrls)
        ? p.mediaUrls.map((u) => (typeof u === 'string' ? u.trim() : '')).filter(Boolean)
        : [];
      const channelIds = chans.map(toId).filter((id): id is number => Number.isInteger(id));
      const platformSpecific: Record<string, Record<string, unknown>> =
        p.platformSpecific && typeof p.platformSpecific === 'object' && !Array.isArray(p.platformSpecific)
          ? (p.platformSpecific as Record<string, Record<string, unknown>>)
          : {};
      // Drop non-string values: platform_content/post_type_overrides are jsonb,
      // and a nested-object value would survive to the publish worker and crash
      // string handling there (prod: {"youtube": {"content": ...}} → content.split TypeError).
      const asRecord = (v: unknown): Record<string, string> =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).filter(([, val]) => typeof val === 'string'))
          : {};
      const postFormat: 'post' | 'thread' = p.postFormat === 'thread' ? 'thread' : 'post';
      return {
        content: typeof p.content === 'string' ? p.content : '',
        media,
        mediaUrls,
        channelIds,
        status,
        scheduledAt: typeof p.scheduledAt === 'string' && p.scheduledAt ? p.scheduledAt : null,
        platformSpecific,
        platformContent: asRecord(p.platformContent),
        postTypeOverrides: asRecord(p.postTypeOverrides),
        postFormat,
        threadParts: postFormat === 'thread' && Array.isArray(p.threadParts)
          ? p.threadParts.map((tp) => ({
              content: typeof tp?.content === 'string' ? tp.content : '',
              mediaFileIds: Array.isArray(tp?.mediaFileIds) ? tp.mediaFileIds.map(Number).filter((id) => Number.isInteger(id)) : [],
            }))
          : null,
        autoPlugEnabled: p.autoPlugEnabled === true,
        autoPlugText: typeof p.autoPlugText === 'string' && p.autoPlugText ? p.autoPlugText : null,
        autoPlugThreshold: Number.isInteger(p.autoPlugThreshold) ? (p.autoPlugThreshold as number) : 50,
        autoRepostEnabled: p.autoRepostEnabled === true,
        autoRepostThreshold: Number.isInteger(p.autoRepostThreshold) ? (p.autoRepostThreshold as number) : 100,
      };
    });

    // Per-post shape validation
    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i];
      const n = i + 1;
      if (!r.content.trim() && r.media.length === 0 && r.mediaUrls.length === 0) {
        return json({ error: { message: `Post ${n} is empty. Add text or media.`, code: 'VALIDATION_ERROR' } }, 400);
      }
      if (r.channelIds.length === 0) {
        return json({ error: { message: `Post ${n} has no channels selected.`, code: 'VALIDATION_ERROR' } }, 400);
      }
      if (r.status === 'scheduled' && !r.scheduledAt && !useQueue) {
        return json({ error: { message: `Post ${n} is missing a scheduled time.`, code: 'VALIDATION_ERROR' } }, 400);
      }
      if (r.scheduledAt && Number.isNaN(new Date(r.scheduledAt).getTime())) {
        return json({ error: { message: `Post ${n} has an invalid scheduled time.`, code: 'VALIDATION_ERROR' } }, 400);
      }
      if (r.postFormat === 'thread' && (!r.threadParts || r.threadParts.length < 2)) {
        return json({ error: { message: `Post ${n}: threads require at least 2 threadParts.`, code: 'VALIDATION_ERROR' } }, 400);
      }
      // Same platformSpecific validation the single-post routes run (enums +
      // URL-typed fields the worker fetches). Bulk was the one door where an
      // off-spec value — or an internal thumbnail URL — went straight to jsonb.
      const psError = validatePlatformSpecificShape(r.platformSpecific);
      if (psError) {
        return json({ error: { message: `Post ${n}: ${psError}`, code: 'VALIDATION_ERROR' } }, 400);
      }
    }

    // Validate ALL channels belong to the org (one query) and resolve platforms from DB.
    const allChannelIds = Array.from(new Set(resolved.flatMap((r) => r.channelIds)));
    const ownedChannels = await db
      .select({ id: channels.id, platform: channels.platform, accountType: channels.accountType })
      .from(channels)
      .where(and(inArray(channels.id, allChannelIds), eq(channels.organizationId, orgId)));
    const channelPlatformMap = new Map(ownedChannels.map((c) => [c.id, c.platform]));
    if (allChannelIds.some((id) => !channelPlatformMap.has(id))) {
      return json({ error: { message: 'Some channels do not belong to you', code: 'FORBIDDEN' } }, 403);
    }

    // Kill switch first — a switched-off platform isn't a plan problem. Checked
    // per channel, not per platform, so a paused variant (LinkedIn company
    // pages) is caught while personal profiles on the same platform go through.
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

    // Platform availability on the current plan (once per unique platform).
    for (const platform of Array.from(new Set(ownedChannels.map((c) => c.platform)))) {
      const check = await checkPlatformAllowed(orgId, platform);
      if (!check.allowed) {
        return json({ error: { message: `${platform} is not available on your current plan`, code: 'FEATURE_DISABLED' } }, 403);
      }
    }

    // Validate ALL media belong to the org (one query).
    const allMediaIds = Array.from(new Set(resolved.flatMap((r) => [
      ...r.media,
      ...(r.threadParts ?? []).flatMap((tp) => tp.mediaFileIds),
    ])));
    if (allMediaIds.length > 0) {
      const ownedMedia = await db
        .select({ id: mediaFilesTable.id })
        .from(mediaFilesTable)
        .where(and(inArray(mediaFilesTable.id, allMediaIds), eq(mediaFilesTable.organizationId, orgId)));
      const ownedSet = new Set(ownedMedia.map((m) => m.id));
      if (allMediaIds.some((id) => !ownedSet.has(id))) {
        return json({ error: { message: 'Some media files do not belong to you', code: 'FORBIDDEN' } }, 403);
      }
    }

    // Per-platform character limits.
    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i];
      for (const cid of r.channelIds) {
        const platform = channelPlatformMap.get(cid) as PlatformName;
        const limit = PLATFORM_CHAR_LIMITS[platform];
        const len = platformLength(r.content, platform);
        if (limit && len > limit) {
          return json(
            { error: { message: `Post ${i + 1} exceeds ${platform}'s ${limit}-character limit (${len}).`, code: 'VALIDATION_ERROR' } },
            400,
          );
        }
      }
    }

    // ---- Batch quota check: block the whole batch if it would exceed, and report remaining. ----
    const q = await checkPostQuotasBatch(orgId);
    const total = resolved.length;
    const scheduledTotal = resolved.filter((r) => r.status === 'scheduled').length;
    // "Publish now" arrives as scheduled-at-now and is enqueued immediately, so it does NOT
    // occupy a pending-scheduled slot. Count only queued posts and genuinely-future ones.
    const nowMs = Date.now();
    const pendingScheduled = useQueue
      ? scheduledTotal
      : resolved.filter((r) => r.status === 'scheduled' && r.scheduledAt && new Date(r.scheduledAt).getTime() > nowMs + 60_000).length;
    const remaining = (qr: QuotaCheckResult) => (qr.limit === -1 ? Infinity : Math.max(0, qr.limit - qr.current));

    const quotaBlock = (resource: string, requested: number, qr: QuotaCheckResult) => {
      const rem = remaining(qr);
      return json(
        {
          error: {
            message: `This batch needs ${requested} ${RESOURCE_LABELS[resource]}, but only ${rem} remaining on your ${q.plan} plan.`,
            code: 'QUOTA_EXCEEDED',
          },
          quota: { resource, plan: q.plan, requested, remaining: rem, current: qr.current, limit: qr.limit },
        },
        409,
      );
    };

    if (total > remaining(q.daily)) return quotaBlock('posts_per_day', total, q.daily);
    if (total > remaining(q.monthly)) return quotaBlock('posts_per_month', total, q.monthly);
    if (pendingScheduled > remaining(q.scheduled)) return quotaBlock('pending_scheduled', pendingScheduled, q.scheduled);

    // Recurring-schedule quota: "Repeat" creates one schedule per scheduled post.
    if (repeatFreq) {
      const rq = await checkRecurringScheduleQuota(orgId);
      if (rq.limit === 0) {
        return json({ error: { message: `Recurring schedules aren't available on your ${q.plan} plan.`, code: 'FEATURE_DISABLED' } }, 403);
      }
      if (rq.limit !== -1 && rq.current + scheduledTotal > rq.limit) {
        const rem = Math.max(0, rq.limit - rq.current);
        return json(
          {
            error: { message: `This batch needs ${scheduledTotal} recurring schedules, but only ${rem} remaining on your ${q.plan} plan.`, code: 'QUOTA_EXCEEDED' },
            quota: { resource: 'recurring_schedules', plan: q.plan, requested: scheduledTotal, remaining: rem, current: rq.current, limit: rq.limit },
          },
          409,
        );
      }
    }

    // ---- "Add to queue": assign each post the next open queue slot. ----
    if (useQueue) {
      try {
        const slots = await findNextQueueSlots(orgId, timezone, resolved.length);
        resolved.forEach((r, i) => { r.scheduledAt = slots[i].scheduledAt; });
      } catch (err) {
        return json({ error: { message: err instanceof Error ? err.message : 'No available queue slots.', code: 'NO_QUEUE_SLOTS' } }, 409);
      }
    }

    // ---- Per-day scheduled-post limit. Group the scheduled posts by calendar day (now
    // that queue slots are assigned) and ensure each day stays within scheduledPerDay,
    // counting both what's already scheduled for that day and this batch's additions.
    // Pro/Business have unlimited pending-scheduled, so this is their only per-day bound. ----
    {
      const byDay = new Map<string, { date: Date; count: number }>();
      for (const r of resolved) {
        if (r.status !== 'scheduled' || !r.scheduledAt) continue;
        const d = new Date(r.scheduledAt);
        if (Number.isNaN(d.getTime())) continue;
        const key = d.toLocaleDateString('en-CA', { timeZone: timezone });
        const existing = byDay.get(key);
        if (existing) existing.count++;
        else byDay.set(key, { date: d, count: 1 });
      }
      for (const { date, count } of byDay.values()) {
        const perDay = await checkScheduledPerDayQuota(orgId, date, timezone);
        if (perDay.limit !== -1 && perDay.current + count > perDay.limit) {
          return quotaBlock('scheduled_per_day', count, perDay);
        }
      }
    }

    // ---- Re-host any CSV media URLs to org storage, then attach to their post. ----
    const totalMediaUrls = resolved.reduce((n, r) => n + r.mediaUrls.length, 0);
    if (totalMediaUrls > MAX_MEDIA_URLS) {
      return json({ error: { message: `Too many media URLs in one batch (max ${MAX_MEDIA_URLS}).`, code: 'VALIDATION_ERROR' } }, 400);
    }
    if (totalMediaUrls > 0) {
      // Storage quota gate — rehostUrlToMedia writes to org storage without
      // checking it; every other upload path (presign/multipart/direct) checks
      // before accepting bytes, so URL imports must too.
      const storage = await checkMediaStorageQuota(orgId);
      if (!storage.allowed) {
        return quotaExceededResponse(storage, q.plan);
      }
    }
    for (let i = 0; i < resolved.length; i++) {
      for (const mediaUrl of resolved[i].mediaUrls) {
        try {
          const stored = await rehostUrlToMedia(mediaUrl, user.id, orgId);
          resolved[i].media.push(stored.id);
        } catch (err) {
          const why = err instanceof RemoteMediaError ? err.message : 'could not be imported';
          return json({ error: { message: `Post ${i + 1}: media URL ${why}: ${mediaUrl}`, code: 'MEDIA_URL_ERROR' } }, 400);
        }
      }
    }

    // ---- Pre-publish media validation (scheduled posts only; drafts may be
    // incomplete). Runs after URL re-hosting so each post's media IDs are final
    // and their mime types are known. Catches e.g. a text-only or image-only
    // post sent to YouTube — which bulk-create otherwise creates as a typeless
    // 'post', so it would fail later in the worker with a cryptic handler error.
    if (resolved.some((r) => r.status === 'scheduled')) {
      const finalMediaIds = Array.from(new Set(resolved.flatMap((r) => r.media)));
      const typeRows = finalMediaIds.length > 0
        ? await db
            .select({ id: mediaFilesTable.id, mimeType: mediaFilesTable.mimeType, width: mediaFilesTable.width, height: mediaFilesTable.height })
            .from(mediaFilesTable)
            .where(and(inArray(mediaFilesTable.id, finalMediaIds), eq(mediaFilesTable.organizationId, orgId)))
        : [];
      const mediaById = new Map(typeRows.map((m) => [m.id, m]));

      for (let i = 0; i < resolved.length; i++) {
        const r = resolved[i];
        if (r.status !== 'scheduled') continue;
        const mediaErrors = validatePostMediaForPlatforms({
          content: r.content,
          platformContent: r.platformContent,
          media: r.media.map((id) => {
            const m = mediaById.get(id);
            return { mimeType: m?.mimeType ?? '', width: m?.width ?? null, height: m?.height ?? null };
          }),
          postFormat: r.postFormat,
          postTypeOverrides: r.postTypeOverrides,
          platforms: r.channelIds.map((cid) => channelPlatformMap.get(cid) as PlatformName),
        });
        if (mediaErrors.length > 0) {
          return json(
            { error: { message: `Post ${i + 1}: ${mediaErrors.map((e) => e.message).join('; ')}`, code: 'VALIDATION_ERROR' } },
            400,
          );
        }
      }
    }

    // ---- Insert all posts + their platform rows atomically. ----
    const created = await db.transaction(async (tx) => {
      const postRows = resolved.map((r) => ({
        userId: user.id,
        organizationId: orgId,
        content: r.content,
        // Column is typed MediaFileRef[] but legitimately stores raw number[] ids too
        // (see schema note); they're resolved to full refs on read.
        mediaFiles: r.media as unknown as MediaFileRef[],
        status: r.status,
        // Approval gate: non-publishers' scheduled posts land as pending-approval
        // (the scheduler skips them; an approver releases the batch).
        approvalStatus:
          r.status === 'scheduled' && !can(locals.auth.organizationRole, 'post:publish')
            ? ('pending' as const)
            : ('none' as const),
        scheduledAt: r.scheduledAt ? new Date(r.scheduledAt) : null,
        timezone,
        postFormat: r.postFormat,
        postTypeOverrides: r.postTypeOverrides,
        platformSpecific: r.platformSpecific,
        platformContent: r.platformContent,
        // Keep all media — it's reclaimed by the 3-month retention sweep, not deleted
        // right after publishing (repeats especially need it, since the recurring
        // schedule re-uses the same media every run).
        deleteMediaAfterPublish: false,
        threadParts: r.threadParts,
        platformThreadParts: {},
        autoPlugEnabled: r.autoPlugEnabled,
        autoPlugText: r.autoPlugText,
        autoPlugThreshold: r.autoPlugThreshold,
        autoPlugFired: false,
        autoRepostEnabled: r.autoRepostEnabled,
        autoRepostThreshold: r.autoRepostThreshold,
        autoRepostFired: false,
      }));

      const insertedPosts = await tx.insert(posts).values(postRows).returning({ id: posts.id });

      const platformRows = insertedPosts.flatMap((row, idx) =>
        resolved[idx].channelIds.map((cid) => ({
          postId: row.id,
          channelId: cid,
          platform: channelPlatformMap.get(cid) as any,
          status: 'pending' as const,
        })),
      );
      if (platformRows.length > 0) {
        await tx.insert(postPlatforms).values(platformRows);
      }

      // "Repeat": one recurring schedule per scheduled post, linked back to it.
      if (repeatFreq) {
        for (let idx = 0; idx < insertedPosts.length; idx++) {
          const r = resolved[idx];
          if (r.status !== 'scheduled' || !r.scheduledAt) continue;
          const parts = recurringPartsInTz(r.scheduledAt, timezone);
          const dow = repeatFreq === 'weekly' || repeatFreq === 'biweekly' ? parts.dayOfWeek : null;
          const dom = repeatFreq === 'monthly' ? parts.dayOfMonth : null;
          const [sched] = await tx
            .insert(recurringSchedules)
            .values({
              userId: user.id,
              organizationId: orgId,
              name: (r.content || 'Repeat Post').slice(0, 50),
              frequency: repeatFreq as 'daily' | 'weekly' | 'biweekly' | 'monthly',
              dayOfWeek: dow,
              dayOfMonth: dom,
              timeOfDay: parts.timeOfDay,
              timezone,
              channelIds: r.channelIds,
              mediaFileIds: r.media,
              contentTemplate: r.content || '',
              postFormat: r.postFormat,
              threadParts: r.threadParts,
              isActive: true,
              nextRunAt: calculateNextRunAt(repeatFreq, dow, dom, parts.timeOfDay, timezone),
            })
            .returning({ id: recurringSchedules.id });
          await tx.update(posts).set({ recurringScheduleId: sched.id }).where(eq(posts.id, insertedPosts[idx].id));
        }
      }

      return insertedPosts.map((row, idx) => ({
        id: row.id,
        status: resolved[idx].status,
        scheduledAt: resolved[idx].scheduledAt,
      }));
    });

    // ---- Queue publish for posts whose time is now or in the past. ----
    const now = Date.now();
    // Pending-approval posts must not publish immediately — approval releases them.
    const heldForApproval = !can(locals.auth.organizationRole, 'post:publish');
    const results: { id: number; status: string }[] = [];
    for (const c of created) {
      let status: string = c.status;
      if (!heldForApproval && c.status === 'scheduled' && c.scheduledAt && new Date(c.scheduledAt).getTime() <= now) {
        try {
          await addPublishJob(c.id);
          await db.update(posts).set({ status: 'publishing' }).where(eq(posts.id, c.id));
          status = 'publishing';
        } catch {
          // Leave as 'scheduled'; the per-minute scheduler will pick it up.
        }
      }
      results.push({ id: c.id, status });
    }

    logActivity({
      userId: user.id,
      organizationId: orgId,
      action: 'post.bulk_created',
      resourceId: created[0]?.id ?? 0,
      details: { count: created.length, scheduled: scheduledTotal },
    });

    return json({ count: results.length, created: results }, 201);
  } catch (error) {
    captureApiError('POST /api/posts/bulk-create', error);
    return json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, 500);
  }
};
