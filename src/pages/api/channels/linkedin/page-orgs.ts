import type { APIRoute } from 'astro';
import '@/lib/platforms/init';
import { LinkedInHandler } from '@/lib/platforms/linkedin';
import { peekLinkedInPageSession } from '@/lib/oauth/linkedin-page-session';
import { getPlatformAvailabilityFor } from '@/lib/platforms/availability';

/**
 * List the LinkedIn organizations the freshly-authorized user administers, using the
 * org-scoped token stashed during the page OAuth callback. The session is peeked (not
 * consumed) so the user can still finalize a selection afterwards.
 */
export const GET: APIRoute = async ({ locals, url }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  // Company-page gate (`PLATFORM_LINKEDIN_PAGES`) — no point listing orgs the
  // user won't be allowed to finalize.
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

  const sessionKey = url.searchParams.get('session');
  if (!sessionKey) return json({ error: 'Missing session key' }, 400);

  const session = await peekLinkedInPageSession(sessionKey);
  if (!session) {
    return json({ error: 'Your LinkedIn authorization expired. Please connect again.' }, 410);
  }
  if (session.userId !== user.id || session.organizationId !== locals.auth.organizationId) {
    return json({ error: 'This authorization does not belong to your account' }, 403);
  }

  try {
    const handler = new LinkedInHandler();
    const orgs = await handler.getAdminOrganizations(session.accessToken);
    return json({ items: orgs });
  } catch (error) {
    console.error('GET /api/channels/linkedin/page-orgs failed:', error);
    return json({ error: 'Could not load LinkedIn organizations. Please try again.' }, 500);
  }
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
