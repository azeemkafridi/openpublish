import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { pushTokens } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Expo push tokens look like ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx].
// (Bare ExpoPushToken[...] is a legacy alias Expo still emits in places.)
const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/;

export function isValidExpoPushToken(token: unknown): token is string {
  return typeof token === 'string' && token.length <= 255 && EXPO_TOKEN_RE.test(token);
}

/**
 * POST /api/push/tokens — register (or refresh) the device's Expo push token
 * for the authenticated user. Upserts on the token string: re-registering an
 * existing token reassigns it to the current user and bumps lastSeenAt, so a
 * device that switches accounts stops receiving the previous user's pushes.
 */
export const POST: APIRoute = async ({ locals, request }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { token, platform, deviceName } = body ?? {};

  if (!isValidExpoPushToken(token)) {
    return json({ error: 'token must be an Expo push token (ExponentPushToken[...])' }, 400);
  }
  if (platform !== 'ios' && platform !== 'android') {
    return json({ error: "platform must be 'ios' or 'android'" }, 400);
  }
  const device =
    typeof deviceName === 'string' && deviceName.trim() ? deviceName.trim().slice(0, 255) : null;

  const now = new Date();
  await db
    .insert(pushTokens)
    .values({
      userId: user.id,
      organizationId: locals.auth.organizationId ?? null,
      token,
      platform,
      deviceName: device,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: pushTokens.token,
      set: {
        userId: user.id,
        organizationId: locals.auth.organizationId ?? null,
        platform,
        deviceName: device,
        lastSeenAt: now,
      },
    });

  return json({ success: true });
};

/**
 * DELETE /api/push/tokens — unregister a token (e.g. on logout). Only removes
 * the row if it belongs to the authenticated user.
 */
export const DELETE: APIRoute = async ({ locals, request }) => {
  const { user } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { token } = body ?? {};
  if (!isValidExpoPushToken(token)) {
    return json({ error: 'token must be an Expo push token (ExponentPushToken[...])' }, 400);
  }

  await db
    .delete(pushTokens)
    .where(and(eq(pushTokens.token, token), eq(pushTokens.userId, user.id)));

  return json({ success: true });
};
