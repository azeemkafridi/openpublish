import type { APIRoute } from 'astro';

/**
 * JSON 404 for unmatched /api/* paths.
 *
 * Without this rest route, an unknown API path fell through to Astro's
 * built-in 404 — an HTML page, which API clients and agents can't parse
 * (every real endpoint returns `{ error: { message, code } }`). Astro ranks
 * rest params below every static and named route, so this can never shadow a
 * real endpoint; it only catches paths no endpoint claims.
 *
 * Unauthenticated probes never reach here — the middleware answers them with
 * its own JSON 401 — so this route only shapes the authenticated-but-wrong-
 * path case (and keeps the error contract consistent for both).
 */
const notFound: APIRoute = ({ url }) =>
  new Response(
    JSON.stringify({
      error: {
        message: `No API endpoint at ${url.pathname}`,
        code: 'NOT_FOUND',
        hint: 'The API reference is at https://your instance/docs and the machine-readable spec at https://your instance/openapi.json',
      },
    }),
    { status: 404, headers: { 'Content-Type': 'application/json' } },
  );

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
