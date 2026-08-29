import type { APIRoute } from 'astro';
import { checkRateLimit, rateLimitResponse } from '@lib/rate-limit';
import { getClientIp } from '@lib/http/client-ip';
import { getAuthContext } from '@lib/auth/middleware';
import { logActivity } from '@lib/activity/log';

/**
 * POST /api/events — client-side product-event beacon (see src/lib/track.ts).
 *
 * Listed in PUBLIC_PATHS so pre-auth pages (login, register) can report page
 * views and signup outcomes; when a session cookie is present the event is
 * attributed to the user in-route. Events are written to activity_logs with a
 * `ux.` action prefix, so they show up in the existing admin Activity tab and
 * charts and age out with the same retention sweep.
 *
 * Anonymous by design ⇒ everything here is untrusted: names are shape-checked,
 * props are size-capped, and writes are rate-limited per IP.
 */

// e.g. "page_view", "oauth_connect_result", "composer.submit_failed"
const NAME_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
const MAX_NAME_LEN = 60;
const MAX_BODY_LEN = 4096;
const MAX_PROPS_JSON_LEN = 1000;
const MAX_PATH_LEN = 200;

export const POST: APIRoute = async ({ request, clientAddress }) => {
  let peerAddress: string | null = null;
  try {
    peerAddress = clientAddress;
  } catch {
    // clientAddress throws outside a real server context (e.g. prerender)
  }
  const ip = getClientIp(request.headers, peerAddress);

  const rl = await checkRateLimit(`rl:ux:${ip}`, 60, 60);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter ?? 60);

  const raw = await request.text().catch(() => '');
  if (!raw || raw.length > MAX_BODY_LEN) {
    return jsonError('Invalid body', 400);
  }

  let body: { name?: unknown; props?: unknown; path?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonError('Invalid JSON', 400);
  }

  const name = body.name;
  if (typeof name !== 'string' || name.length > MAX_NAME_LEN || !NAME_RE.test(name)) {
    return jsonError('Invalid event name', 400);
  }

  // Props: plain object only, capped after serialization; anything else dropped.
  let props: Record<string, unknown> | undefined;
  if (body.props && typeof body.props === 'object' && !Array.isArray(body.props)) {
    const serialized = JSON.stringify(body.props);
    if (serialized.length <= MAX_PROPS_JSON_LEN) {
      props = body.props as Record<string, unknown>;
    }
  }

  const path =
    typeof body.path === 'string' && body.path.startsWith('/') && body.path.length <= MAX_PATH_LEN
      ? body.path
      : undefined;

  // Attribute to the user when a session cookie is present. Failure to resolve
  // (or no session at all) still records the event — anonymous funnel steps
  // (login/register page views) are exactly what we're missing today.
  const auth = await getAuthContext(request).catch(() => null);

  logActivity({
    userId: auth?.userId,
    organizationId: auth?.organizationId,
    action: `ux.${name}`,
    resource: 'ux',
    details: { ...(path ? { path } : {}), ...props },
  });

  return new Response(null, { status: 202 });
};

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
