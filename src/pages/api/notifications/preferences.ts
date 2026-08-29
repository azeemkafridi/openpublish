import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { notificationPreferences } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { logActivity } from '@/lib/activity/log';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET: APIRoute = async ({ locals }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const [prefs] = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, user.id))
    .limit(1);

  if (!prefs) {
    const [created] = await db
      .insert(notificationPreferences)
      .values({ userId: user.id })
      .returning();
    return json(created);
  }

  return json(prefs);
};

export const PUT: APIRoute = async ({ request, locals }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const body = await request.json();
  const {
    emailOnFailure,
    emailOnTokenExpiry,
    inAppPublished,
    inAppFailed,
    inAppScheduleReminder,
    inAppTokenExpiry,
  } = body;

  const updateData: Record<string, unknown> = {};
  if (emailOnFailure !== undefined) updateData.emailOnFailure = emailOnFailure;
  if (emailOnTokenExpiry !== undefined) updateData.emailOnTokenExpiry = emailOnTokenExpiry;
  if (inAppPublished !== undefined) updateData.inAppPublished = inAppPublished;
  if (inAppFailed !== undefined) updateData.inAppFailed = inAppFailed;
  if (inAppScheduleReminder !== undefined) updateData.inAppScheduleReminder = inAppScheduleReminder;
  if (inAppTokenExpiry !== undefined) updateData.inAppTokenExpiry = inAppTokenExpiry;

  const existing = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, user.id))
    .limit(1);

  let result;
  if (existing.length === 0) {
    [result] = await db
      .insert(notificationPreferences)
      .values({ userId: user.id, ...updateData })
      .returning();
  } else {
    [result] = await db
      .update(notificationPreferences)
      .set(updateData)
      .where(eq(notificationPreferences.userId, user.id))
      .returning();
  }

  logActivity({
    userId: user.id,
    organizationId: locals.auth.organizationId,
    action: 'settings.notifications_updated',
    resource: 'settings',
  });

  return json(result);
};
