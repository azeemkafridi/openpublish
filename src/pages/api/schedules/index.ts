import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { recurringSchedules, channels, mediaFiles } from '@/lib/db/schema';
import { eq, desc, and, inArray } from 'drizzle-orm';
import { logActivity } from '@/lib/activity/log';
import { checkRecurringScheduleQuota, getOrgPlan } from '@/lib/quotas/check';
import { quotaExceededResponse } from '@/lib/quotas/errors';
import { calculateNextRunAt } from '@/lib/schedules/next-run';
import { isChannelIdList } from '@/lib/channels/validate';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET: APIRoute = async ({ locals }) => {
  const { user, organizationId } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const schedules = await db
    .select()
    .from(recurringSchedules)
    .where(eq(recurringSchedules.organizationId, organizationId))
    .orderBy(desc(recurringSchedules.createdAt));

  return json(schedules);
};

export const POST: APIRoute = async ({ request, locals }) => {
  const { user, organizationId } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

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
    postFormat,
    threadParts,
    requireApproval,
  } = body;

  // Check recurring schedule quota
  const quota = await checkRecurringScheduleQuota(organizationId);
  if (!quota.allowed) {
    const plan = await getOrgPlan(organizationId);
    return quotaExceededResponse(quota, plan);
  }

  if (!name || !frequency || !timeOfDay) {
    return json({ error: 'name, frequency, and timeOfDay are required' }, 400);
  }

  if (!['daily', 'weekly', 'biweekly', 'monthly'].includes(frequency)) {
    return json({ error: 'Invalid frequency' }, 400);
  }

  if (postFormat !== undefined && !['post', 'thread'].includes(postFormat)) {
    return json({ error: 'Invalid postFormat' }, 400);
  }
  if (postFormat === 'thread' && (!Array.isArray(threadParts) || threadParts.length < 2)) {
    return json({ error: 'Thread schedules require at least 2 threadParts' }, 400);
  }

  if (!channelIds || !Array.isArray(channelIds) || channelIds.length === 0) {
    return json({ error: 'At least one channelId is required' }, 400);
  }
  // channels.id is bigint — a non-integer id would make Postgres throw (500); 400 instead.
  if (!isChannelIdList(channelIds)) {
    return json({ error: 'channelIds must be numeric channel ids (get them from GET /api/channels)' }, 400);
  }

  // Validate channel ownership
  {
    const ownedChannels = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(inArray(channels.id, channelIds), eq(channels.organizationId, organizationId)));
    if (ownedChannels.length !== channelIds.length) {
      return json({ error: 'Some channels do not belong to you' }, 403);
    }
  }

  // Validate media ownership
  if (mediaFileIds && Array.isArray(mediaFileIds) && mediaFileIds.length > 0) {
    const ownedMedia = await db
      .select({ id: mediaFiles.id })
      .from(mediaFiles)
      .where(and(inArray(mediaFiles.id, mediaFileIds), eq(mediaFiles.organizationId, organizationId)));
    if (ownedMedia.length !== mediaFileIds.length) {
      return json({ error: 'Some media files do not belong to you' }, 403);
    }
  }

  const tz = timezone || 'UTC';
  const nextRunAt = calculateNextRunAt(frequency, dayOfWeek, dayOfMonth, timeOfDay, tz);

  const [schedule] = await db
    .insert(recurringSchedules)
    .values({
      userId: user.id,
      organizationId,
      name,
      frequency,
      dayOfWeek: dayOfWeek ?? null,
      dayOfMonth: dayOfMonth ?? null,
      timeOfDay,
      timezone: tz,
      channelIds,
      mediaFileIds: mediaFileIds || [],
      contentTemplate: contentTemplate || '',
      postTypeOverrides: postTypeOverrides || {},
      platformSpecific: platformSpecific || {},
      isActive: isActive !== undefined ? isActive : true,
      // Approval-gated schedule: every generated occurrence waits for an approver.
      requireApproval: requireApproval === true,
      postFormat: postFormat || 'post',
      threadParts: postFormat === 'thread' ? threadParts : null,
      nextRunAt,
    })
    .returning();

  logActivity({
    userId: user.id,
    organizationId,
    action: 'schedule.created',
    resource: 'schedule',
    resourceId: schedule.id,
    details: { name, frequency },
  });

  return json(schedule, 201);
};
