import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { notifications, organizations } from '@/lib/db/schema';
import { eq, and, ne, desc, inArray, count } from 'drizzle-orm';
import { invalidateUnreadCount } from './count';

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export const GET: APIRoute = async ({ locals, url }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const unreadOnly = url.searchParams.get('unreadOnly') === 'true';
  const offset = (page - 1) * limit;

  // 'post_published' (success) notifications are intentionally hidden — a successful
  // publish is the expected outcome and already shown in the queue, so we don't clutter
  // the bell with it. Failures, warnings, and system/info still surface.
  const conditions = [eq(notifications.userId, user.id), ne(notifications.type, 'post_published')];
  if (unreadOnly) {
    conditions.push(eq(notifications.isRead, false));
  }

  const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

  // Unread count over the WHOLE set, not the current page. The bell rendered
  // `notifications.filter(!read).length` off a limit=10 fetch, so a user with 40
  // unread saw "10 unread" and "Mark all read" left 30 behind.
  // Independent of `unreadOnly` so the number means the same thing on every tab.
  const unreadWhere = and(
    eq(notifications.userId, user.id),
    ne(notifications.type, 'post_published'),
    eq(notifications.isRead, false),
  );

  const [items, [{ total }], [{ unreadTotal }]] = await Promise.all([
    db
      .select({
        id: notifications.id,
        userId: notifications.userId,
        organizationId: notifications.organizationId,
        organizationName: organizations.name,
        type: notifications.type,
        title: notifications.title,
        message: notifications.message,
        data: notifications.data,
        isRead: notifications.isRead,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .leftJoin(organizations, eq(notifications.organizationId, organizations.id))
      .where(whereClause)
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: count() })
      .from(notifications)
      .where(whereClause),
    db
      .select({ unreadTotal: count() })
      .from(notifications)
      .where(unreadWhere),
  ]);

  return json({
    notifications: items,
    unreadTotal,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  }, 200, { 'Cache-Control': 'private, no-store' });
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const body = await request.json();
  const { ids, all } = body;

  if (!ids && !all) {
    return json({ error: 'Provide ids array or { all: true }' }, 400);
  }

  if (all === true) {
    await db
      .update(notifications)
      .set({ isRead: true })
      .where(and(eq(notifications.userId, user.id), eq(notifications.isRead, false)));
  } else if (Array.isArray(ids) && ids.length > 0) {
    await db
      .update(notifications)
      .set({ isRead: true })
      .where(
        and(
          eq(notifications.userId, user.id),
          inArray(notifications.id, ids.map(Number)),
        ),
      );
  } else {
    return json({ error: 'ids must be a non-empty array' }, 400);
  }

  // Mark-read changes the unread badge immediately — drop the cached count.
  await invalidateUnreadCount(user.id);

  return json({ success: true });
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const body = await request.json();
  const { ids, all } = body;

  if (!ids && !all) {
    return json({ error: 'Provide ids array or { all: true }' }, 400);
  }

  if (all === true) {
    await db
      .delete(notifications)
      .where(eq(notifications.userId, user.id));
  } else if (Array.isArray(ids) && ids.length > 0) {
    await db
      .delete(notifications)
      .where(
        and(
          eq(notifications.userId, user.id),
          inArray(notifications.id, ids.map(Number)),
        ),
      );
  } else {
    return json({ error: 'ids must be a non-empty array' }, 400);
  }

  await invalidateUnreadCount(user.id);

  return json({ success: true });
};
