import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { notifications } from '@/lib/db/schema';
import { eq, and, ne, count } from 'drizzle-orm';
import { cached, invalidateCache } from '@/lib/cache';

/**
 * Cheap unread-badge endpoint. The full GET /api/notifications runs three
 * queries (page + total + unread); clients that only need the bell number
 * (mobile Home, the web bell poll) should hit this instead.
 *
 * Internal-only (like bulk-create): deliberately NOT in openapi.json — the
 * public list endpoint already returns unreadTotal, and this one exists purely
 * so first-party badge polling stays cheap.
 */

export const unreadCountCacheKey = (userId: string) => `cache:notifcount:${userId}`;

/** Drop a user's cached unread count (call after mark-read/delete/insert). */
export function invalidateUnreadCount(userId: string): Promise<void> {
  return invalidateCache(unreadCountCacheKey(userId)).catch(() => {});
}

export const GET: APIRoute = async ({ locals }) => {
  const { user } = locals.auth;
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const unreadTotal = await cached(unreadCountCacheKey(user.id), 30, async () => {
    const [{ unreadTotal }] = await db
      .select({ unreadTotal: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, user.id),
          // Matches GET /api/notifications: successful publishes never surface.
          ne(notifications.type, 'post_published'),
          eq(notifications.isRead, false),
        ),
      );
    return unreadTotal;
  });

  return new Response(JSON.stringify({ unreadTotal }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=15' },
  });
};
