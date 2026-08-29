import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import { db } from '@/lib/db';
import { apiKeys } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { logActivity } from '@/lib/activity/log';
import { checkApiKeyQuota, getOrgPlan } from '@/lib/quotas/check';
import { quotaExceededResponse } from '@/lib/quotas/errors';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET: APIRoute = async ({ locals }) => {
  const { user, organizationId } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const keys = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      isActive: apiKeys.isActive,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.organizationId, organizationId))
    .orderBy(desc(apiKeys.createdAt));

  const sanitized = keys.map((key) => ({
    id: key.id,
    name: key.name,
    keyPreview: key.keyPrefix + '...',
    lastUsedAt: key.lastUsedAt,
    expiresAt: key.expiresAt,
    isActive: key.isActive,
    createdAt: key.createdAt,
  }));

  return json(sanitized);
};

export const POST: APIRoute = async ({ request, locals }) => {
  const { user, organizationId } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  // Check API key quota
  const quota = await checkApiKeyQuota(organizationId);
  if (!quota.allowed) {
    const plan = await getOrgPlan(organizationId);
    return quotaExceededResponse(quota, plan);
  }

  const body = await request.json();
  const { name, expiresAt, expires_in_days } = body;

  if (!name) {
    return json({ error: 'Name is required' }, 400);
  }

  // Calculate expiration: accept either a date string or days-from-now number
  let computedExpiresAt: Date | null = null;
  if (expiresAt) {
    computedExpiresAt = new Date(expiresAt);
  } else if (expires_in_days != null && expires_in_days > 0) {
    computedExpiresAt = new Date();
    computedExpiresAt.setDate(computedExpiresAt.getDate() + Number(expires_in_days));
  }

  const rawKey = 'bp_' + crypto.randomBytes(32).toString('hex');
  const keyPrefix = rawKey.slice(0, 7); // "bp_" + first 4 hex chars
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  const [apiKey] = await db
    .insert(apiKeys)
    .values({
      userId: user.id,
      organizationId,
      name,
      keyHash,
      keyPrefix,
      expiresAt: computedExpiresAt,
    })
    .returning();

  logActivity({
    userId: user.id,
    organizationId,
    action: 'api_key.created',
    resource: 'api_key',
    resourceId: apiKey.id,
    details: { name },
  });

  return json(
    {
      id: apiKey.id,
      name: apiKey.name,
      key: rawKey,
      keyPrefix: apiKey.keyPrefix,
      expiresAt: apiKey.expiresAt,
      createdAt: apiKey.createdAt,
    },
    201,
  );
};
