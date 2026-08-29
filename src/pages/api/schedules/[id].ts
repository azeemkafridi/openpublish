import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { recurringSchedules, channels, mediaFiles, posts } from '@/lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { logActivity } from '@/lib/activity/log';
import { calculateNextRunAt } from '@/lib/schedules/next-run';
import { isChannelIdList } from '@/lib/channels/validate';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const PUT: APIRoute = async ({ request, locals, params }) => {
  const { user, organizationId } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const id = Number(params.id);
  if (isNaN(id)) return json({ error: 'Invalid schedule ID' }, 400);

  const existing = await db
    .select()
    .from(recurringSchedules)
    .where(and(eq(recurringSchedules.id, id), eq(recurringSchedules.organizationId, organizationId)))
    .limit(1);

  if (existing.length === 0) {
    return json({ error: 'Schedule not found' }, 404);
  }

  const body = await request.json();
  const {
    name,
    frequency,
    dayOfWeek,
    dayOfMonth,
    timeOfDay,
    timezone,
    channelIds,
    mediaFileIds,
    contentTemplate,
    postTypeOverrides,
    platformSpecific,
    isActive,
    requireApproval,
    postFormat,
    threadParts,
  } = body;

  if (postFormat !== undefined && !['post', 'thread'].includes(postFormat)) {
    return json({ error: 'Invalid postFormat' }, 400);
  }
  const effectiveFormat = postFormat !== undefined ? postFormat : existing[0].postFormat;
  if (effectiveFormat === 'thread' && threadParts !== undefined && (!Array.isArray(threadParts) || threadParts.length < 2)) {
    return json({ error: 'Thread schedules require at least 2 threadParts' }, 400);
  }

  // Validate channel ownership and active status
  if (channelIds !== undefined && Array.isArray(channelIds) && channelIds.length > 0) {
    // channels.id is bigint — a non-integer id would make Postgres throw (500); 400 instead.
    if (!isChannelIdList(channelIds)) {
      return json({ error: 'channelIds must be numeric channel ids (get them from GET /api/channels)' }, 400);
    }
    const ownedChannels = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(inArray(channels.id, channelIds), eq(channels.organizationId, organizationId), eq(channels.isActive, true)));
    if (ownedChannels.length !== channelIds.length) {
      return json({ error: 'Some channels do not belong to you or are no longer active' }, 403);
    }
  }

  // Validate media ownership
  if (mediaFileIds !== undefined && Array.isArray(mediaFileIds) && mediaFileIds.length > 0) {
    const ownedMedia = await db
      .select({ id: mediaFiles.id })
      .from(mediaFiles)
      .where(and(inArray(mediaFiles.id, mediaFileIds), eq(mediaFiles.organizationId, organizationId)));
    if (ownedMedia.length !== mediaFileIds.length) {
      return json({ error: 'Some media files do not belong to you' }, 403);
    }
  }

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (frequency !== undefined) updateData.frequency = frequency;
  if (dayOfWeek !== undefined) updateData.dayOfWeek = dayOfWeek;
  if (dayOfMonth !== undefined) updateData.dayOfMonth = dayOfMonth;
  if (timeOfDay !== undefined) updateData.timeOfDay = timeOfDay;
  if (timezone !== undefined) updateData.timezone = timezone;
  if (channelIds !== undefined) updateData.channelIds = channelIds;
  if (mediaFileIds !== undefined) updateData.mediaFileIds = mediaFileIds;
  if (contentTemplate !== undefined) updateData.contentTemplate = contentTemplate;
  if (postTypeOverrides !== undefined) updateData.postTypeOverrides = postTypeOverrides;
  if (platformSpecific !== undefined) updateData.platformSpecific = platformSpecific;
  if (isActive !== undefined) updateData.isActive = isActive;
  if (requireApproval !== undefined) updateData.requireApproval = requireApproval === true;
  if (postFormat !== undefined) updateData.postFormat = postFormat;
  if (threadParts !== undefined) updateData.threadParts = effectiveFormat === 'thread' ? threadParts : null;

  // Recalculate nextRunAt server-side whenever timing fields change or schedule is reactivated
  const timingChanged =
    frequency !== undefined ||
    dayOfWeek !== undefined ||
    dayOfMonth !== undefined ||
    timeOfDay !== undefined ||
    timezone !== undefined;
  const reactivated = isActive === true && existing[0].isActive === false;

  if (timingChanged || reactivated) {
    const sched = existing[0];
    updateData.nextRunAt = calculateNextRunAt(
      (frequency ?? sched.frequency) as string,
      dayOfWeek !== undefined ? dayOfWeek : sched.dayOfWeek,
      dayOfMonth !== undefined ? dayOfMonth : sched.dayOfMonth,
      (timeOfDay ?? sched.timeOfDay) as string,
      (timezone ?? sched.timezone ?? 'UTC') as string,
    );
  }

  const [updated] = await db
    .update(recurringSchedules)
    .set(updateData)
    .where(and(eq(recurringSchedules.id, id), eq(recurringSchedules.organizationId, organizationId)))
    .returning();

  logActivity({
    userId: user.id,
    organizationId,
    action: 'schedule.updated',
    resource: 'schedule',
    resourceId: id,
  });

  return json(updated);
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  const { user, organizationId } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const id = Number(params.id);
  if (isNaN(id)) return json({ error: 'Invalid schedule ID' }, 400);

  const existing = await db
    .select()
    .from(recurringSchedules)
    .where(and(eq(recurringSchedules.id, id), eq(recurringSchedules.organizationId, organizationId)))
    .limit(1);

  if (existing.length === 0) {
    return json({ error: 'Schedule not found' }, 404);
  }

  // Clear the now-dangling reference on any posts this schedule created, then delete it —
  // atomically, so a failure can't leave posts pointing at a schedule that no longer exists.
  await db.transaction(async (tx) => {
    await tx.update(posts).set({ recurringScheduleId: null }).where(eq(posts.recurringScheduleId, id));
    await tx
      .delete(recurringSchedules)
      .where(and(eq(recurringSchedules.id, id), eq(recurringSchedules.organizationId, organizationId)));
  });

  logActivity({
    userId: user.id,
    organizationId,
    action: 'schedule.deleted',
    resource: 'schedule',
    resourceId: id,
    details: { name: existing[0].name },
  });

  return json({ success: true });
};
