import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { labels } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { logActivity } from '@/lib/activity/log';
import { checkLabelQuota, getOrgPlan } from '@/lib/quotas/check';
import { quotaExceededResponse } from '@/lib/quotas/errors';

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export const GET: APIRoute = async ({ locals, url }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const type = url.searchParams.get('type');
  const conditions = [eq(labels.organizationId, locals.auth.organizationId)];
  if (type === 'post' || type === 'media') {
    conditions.push(eq(labels.type, type));
  }

  const userLabels = await db
    .select()
    .from(labels)
    .where(and(...conditions))
    .orderBy(labels.name);

  return json(userLabels, 200, { 'Cache-Control': 'private, max-age=30' });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const body = await request.json();
  const { name, color, type } = body;
  const labelType = type === 'media' ? 'media' : 'post';

  if (!name) {
    return json({ error: 'Name is required' }, 400);
  }

  // Check label quota
  const quota = await checkLabelQuota(locals.auth.organizationId);
  if (!quota.allowed) {
    const plan = await getOrgPlan(locals.auth.organizationId);
    return quotaExceededResponse(quota, plan);
  }

  const existing = await db
    .select()
    .from(labels)
    .where(and(eq(labels.organizationId, locals.auth.organizationId), eq(labels.name, name), eq(labels.type, labelType)))
    .limit(1);

  if (existing.length > 0) {
    return json({
      error: {
        message: `A label named "${name}" already exists.`,
        hint: 'Choose a different name or edit the existing label instead.',
        code: 'DUPLICATE_NAME',
      },
    }, 409);
  }

  const [label] = await db
    .insert(labels)
    .values({
      userId: user.id,
      organizationId: locals.auth.organizationId,
      name,
      color: color || '#6366f1',
      type: labelType,
    })
    .returning();

  logActivity({
    userId: user.id,
    organizationId: locals.auth.organizationId,
    action: 'label.created',
    resource: 'label',
    resourceId: label.id,
    details: { name },
  });

  return json(label, 201);
};
