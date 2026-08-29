import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { apiKeys } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { getDailyApiUsage } from '@/lib/rate-limit';
import { PLAN_LIMITS, type PlanTier } from '@/lib/quotas/plans';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const GET: APIRoute = async ({ locals }) => {
  const { user, organizationId } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const plan = locals.auth.organizationPlan as PlanTier;
  const limits = PLAN_LIMITS[plan];

  // Get org-level daily usage
  const todayTotal = await getDailyApiUsage(organizationId);

  // Get all active keys for this org
  const keys = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.isActive, true)));

  // Get per-key daily usage
  const perKey = await Promise.all(
    keys.map(async (k) => ({
      id: k.id,
      name: k.name,
      today: await getDailyApiUsage(organizationId, k.id),
      lastUsedAt: k.lastUsedAt,
      expiresAt: k.expiresAt,
    })),
  );

  return json({
    today: todayTotal,
    limit: limits.apiRequestsPerDay,
    plan,
    perKey,
  });
};
