import type { APIRoute } from 'astro';
import { auth } from '@/lib/auth';

/**
 * Catch-all endpoint for better-auth (sign-in, get-session, sign-in/social,
 * callback/*, sign-up, sign-out, etc.).
 *
 * We previously handled `/api/auth/*` exclusively in the onRequest middleware,
 * but in `@astrojs/node` middleware mode onRequest does NOT run for paths that
 * have no matching route file — so every better-auth route fell through to the
 * Express host and returned a 404 ("Cannot GET"), silently disabling all login
 * and session endpoints. Defining this route guarantees the request reaches
 * better-auth's handler. The middleware still applies its auth rate-limiting
 * when it runs; this endpoint is the authoritative handler.
 */
export const ALL: APIRoute = ({ request }) => auth.handler(request);
