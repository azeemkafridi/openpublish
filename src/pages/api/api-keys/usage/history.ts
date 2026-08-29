import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { apiUsageDaily } from '@/lib/db/schema';
import { eq, and, gte, desc } from 'drizzle-orm';
import { getDailyApiUsage } from '@/lib/rate-limit';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=60' },
  });
}

export const GET: APIRoute = async ({ locals, url }) => {
  const { user, organizationId } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const days = Math.min(parseInt(url.searchParams.get('days') ?? '30', 10), 90);
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);

  // Get historical data from DB
  const rows = await db
    .select({
      date: apiUsageDaily.date,
      count: apiUsageDaily.count,
    })
    .from(apiUsageDaily)
    .where(and(
      eq(apiUsageDaily.organizationId, organizationId),
      gte(apiUsageDaily.date, sinceStr),
    ))
    .orderBy(desc(apiUsageDaily.date));

  // Add today's live count from Redis (may not be persisted yet)
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = await getDailyApiUsage(organizationId);
  const hasToday = rows.some((r) => r.date === today);

  const history = hasToday
    ? rows.map((r) => r.date === today ? { ...r, count: todayCount } : r)
    : [{ date: today, count: todayCount }, ...rows];

  // Fill missing days with 0
  const filled: Array<{ date: string; count: number }> = [];
  const dateMap = new Map(history.map((r) => [r.date, r.count]));
  const cursor = new Date();
  for (let i = 0; i < days; i++) {
    const d = cursor.toISOString().slice(0, 10);
    filled.push({ date: d, count: dateMap.get(d) ?? 0 });
    cursor.setDate(cursor.getDate() - 1);
  }

  return json({ history: filled.reverse() });
};
