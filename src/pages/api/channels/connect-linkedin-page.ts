import type { APIRoute } from 'astro';
import '@/lib/platforms/init';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { encrypt } from '@/lib/auth/crypto';
import { LinkedInHandler } from '@/lib/platforms/linkedin';
import { consumeLinkedInPageSession } from '@/lib/oauth/linkedin-page-session';
import { logActivity } from '@/lib/activity/log';
import { checkChannelQuota, getOrgPlan } from '@/lib/quotas/check';
import { quotaExceededResponse } from '@/lib/quotas/errors';
import type { PlanTier } from '@/lib/quotas/plans';
import { getPlatformAvailabilityFor } from '@/lib/platforms/availability';

export const POST: APIRoute = async ({ locals, request }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  // Re-check the company-page gate at the finalize step, not just when handing
  // out the OAuth URL — the flag can flip mid-flow, and this route is reachable
  // directly with a still-valid session key.
  const availability = getPlatformAvailabilityFor('linkedin', 'organization');
  if (!availability.canConnect) {
    return json(
      {
        error: {
          message: availability.message,
          code: 'PLATFORM_DISABLED',
          platform: 'linkedin',
          accountType: 'organization',
          state: availability.state,
          reason: availability.reason,
        },
      },
      403,
    );
  }

  const body = await request.json();
  const { session: sessionKey, organizationId: linkedinOrgId } = body as {
    session: string;
    organizationId: string;
  };

  if (!sessionKey || !linkedinOrgId) {
    return json({ error: 'session and organizationId are required' }, 400);
  }

  // Pull the org-scoped token captured during the page OAuth flow (App B).
  const session = await consumeLinkedInPageSession(sessionKey);
  if (!session) {
    return json({ error: 'Your LinkedIn authorization expired. Please connect again.' }, 410);
  }
  if (session.userId !== user.id || session.organizationId !== locals.auth.organizationId) {
    return json({ error: 'This authorization does not belong to your account' }, 403);
  }

  try {
    const accessToken = session.accessToken;

    // Verify the user actually administers the requested org with this token.
    const handler = new LinkedInHandler();
    const orgs = await handler.getAdminOrganizations(accessToken);
    const targetOrg = orgs.find((o) => o.id === linkedinOrgId);

    if (!targetOrg) {
      return json({ error: 'You are not an administrator of this LinkedIn organization' }, 403);
    }

    // Check if this org page is already connected (reconnection vs new channel)
    const existing = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.organizationId, locals.auth.organizationId),
          eq(channels.platform, 'linkedin'),
          eq(channels.accountId, linkedinOrgId),
        ),
      )
      .limit(1);

    // Enforce quota for new channels and revived (soft-deleted) ones
    if (existing.length === 0 || !existing[0].isActive) {
      const quota = await checkChannelQuota(locals.auth.organizationId, 'linkedin');
      if (!quota.allowed) {
        const plan = await getOrgPlan(locals.auth.organizationId) as PlanTier;
        return quotaExceededResponse(quota, plan);
      }
    }

    const tokenExpiresAt = session.expiresIn
      ? new Date(Date.now() + session.expiresIn * 1000)
      : null;
    const encryptedRefresh = session.refreshToken ? encrypt(session.refreshToken) : null;

    let newChannelId: number;

    if (existing.length > 0) {
      await db
        .update(channels)
        .set({
          accountName: targetOrg.name,
          accessToken: encrypt(accessToken),
          refreshToken: encryptedRefresh,
          tokenExpiresAt,
          profileImage: targetOrg.logoUrl || existing[0].profileImage,
          isActive: true,
          needsReconnect: false,
          updatedAt: new Date(),
        })
        .where(eq(channels.id, existing[0].id));
      newChannelId = existing[0].id;
    } else {
      const [inserted] = await db
        .insert(channels)
        .values({
          userId: user.id,
          organizationId: locals.auth.organizationId,
          platform: 'linkedin',
          accountName: targetOrg.name,
          accountId: linkedinOrgId,
          accountType: 'organization',
          accessToken: encrypt(accessToken),
          refreshToken: encryptedRefresh,
          tokenExpiresAt,
          profileImage: targetOrg.logoUrl,
          isActive: true,
          needsReconnect: false,
          metadata: { authorUrn: `urn:li:organization:${linkedinOrgId}` },
        })
        .returning({ id: channels.id });
      newChannelId = inserted.id;
    }

    logActivity({
      userId: user.id,
      organizationId: locals.auth.organizationId,
      action: existing.length > 0 ? 'channel.reconnected' : 'channel.connected',
      resource: 'channel',
      resourceId: newChannelId,
      details: { platform: 'linkedin', accountName: targetOrg.name, accountType: 'organization' },
    });

    return json({
      success: true,
      channelId: newChannelId,
      accountName: targetOrg.name,
    });
  } catch (error) {
    console.error('POST /api/channels/connect-linkedin-page failed:', error);
    return json({ error: 'Could not connect the LinkedIn page. Please try again.' }, 500);
  }
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
