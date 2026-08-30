import type { APIRoute } from 'astro';
import { ALL_PLATFORMS, getPlatformAvailability } from '@/lib/platforms/availability';
import { platformDisplayName } from '@/lib/platforms/types';
import { PLATFORM_DISPLAY } from '@/lib/platforms/registry';

/**
 * GET /api/platforms/public — the *advertisable* platform list. No auth.
 *
 * This is what the marketing site builds its platform grid, hero icons, and
 * copy from, so that we never promise a platform we can't actually deliver.
 * The rule is deliberately stricter than `/api/platforms`: only platforms in
 * state `on` are returned. A platform that is `connect_off` — pending vendor
 * approval (Reddit), or missing its app credentials (Tumblr) — is omitted
 * entirely rather than listed with a caveat, because a visitor who hasn't
 * signed up yet has no existing channel to grandfather; to them "paused" and
 * "doesn't exist" are the same thing, and only one of them is a broken promise.
 *
 * Unlike `/api/platforms` this exposes no `envVar`, no `reason`, and no
 * disabled entries — an anonymous caller learns which platforms we sell, and
 * nothing about our ops surface or what we're waiting on approval for.
 *
 * Cached for 5 minutes at the edge. Flipping a `PLATFORM_<NAME>` flag in
 * the environment is reflected here within that window, but reaching a static
 * *site* additionally requires a marketing rebuild — the site is static HTML
 * and reads this endpoint at build time. See marketing/src/lib/platforms.ts.
 */
export const GET: APIRoute = async () => {
  const platforms = ALL_PLATFORMS.filter(
    (platform) => getPlatformAvailability(platform).state === 'on',
  ).map((platform) => ({
    platform,
    displayName: platformDisplayName(platform),
    color: PLATFORM_DISPLAY[platform]?.color ?? null,
  }));

  return new Response(JSON.stringify({ platforms }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Public, non-personalised, and cheap to recompute — but a stale answer
      // here becomes a stale claim on the website, so keep the window short.
      'Cache-Control': 'public, max-age=300',
      // The marketing site is a different origin (the marketing origin →
      // your instance). The build fetch is server-side and unaffected,
      // but this keeps the endpoint usable from a browser too.
      'Access-Control-Allow-Origin': '*',
    },
  });
};
