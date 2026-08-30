import type { APIRoute } from 'astro';
import {
  ALL_PLATFORMS,
  getPlatformAvailability,
  resolveAvailabilityForRole,
  getPlatformAvailabilityFor,
  getPlatformVariants,
  platformFlagEnvVar,
  platformVariantFlagEnvVar,
} from '@/lib/platforms/availability';
import { platformDisplayName } from '@/lib/platforms/types';
import { PLATFORM_DISPLAY } from '@/lib/platforms/registry';

/**
 * GET /api/platforms — capability endpoint.
 *
 * Reports every platform the app supports along with its current availability,
 * so clients (webapp, mobile, SDKs, integrations) can render an accurate
 * "temporarily unavailable" / "signups paused" state instead of a platform
 * silently vanishing from the list. Disabled platforms are always INCLUDED here
 * with `enabled: false` — never omitted — so consumers can tell "off right now"
 * apart from "never existed".
 *
 * `envVar` is included only for org owners/admins: it tells the person who can
 * actually fix it which environment variable to flip, without exposing ops
 * surface to every member.
 */
export const GET: APIRoute = async ({ locals }) => {
  const { user, organizationRole } = locals.auth;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const isAdmin = organizationRole === 'owner' || organizationRole === 'admin';

  const platforms = ALL_PLATFORMS.map((platform) => {
    // Site admins see an `admin_only` platform as fully on (staged rollout).
    const availability = resolveAvailabilityForRole(getPlatformAvailability(platform), user.role);

    // Sub-platform variants gated on their own (LinkedIn company pages, whose
    // Community Management API is reviewed separately from personal profiles).
    // Present only for platforms that declare one, keyed by channel accountType.
    const variantEntries = Object.entries(getPlatformVariants(platform)).map(
      ([accountType, def]) => {
        const va = getPlatformAvailabilityFor(platform, accountType);
        return [
          accountType,
          {
            label: def.label,
            enabled: va.state === 'on',
            state: va.state,
            reason: va.reason,
            canConnect: va.canConnect,
            canPublish: va.canPublish,
            message: va.message,
            ...(isAdmin ? { envVar: platformVariantFlagEnvVar(platform, accountType) } : {}),
          },
        ];
      },
    );

    return {
      platform,
      displayName: platformDisplayName(platform),
      color: PLATFORM_DISPLAY[platform]?.color ?? null,
      /** Convenience boolean: fully available. Equivalent to `state === 'on'`. */
      enabled: availability.state === 'on',
      state: availability.state,
      reason: availability.reason,
      canConnect: availability.canConnect,
      canPublish: availability.canPublish,
      message: availability.message,
      ...(isAdmin ? { envVar: platformFlagEnvVar(platform) } : {}),
      ...(variantEntries.length ? { variants: Object.fromEntries(variantEntries) } : {}),
    };
  });

  return json({ platforms }, 200, { 'Cache-Control': 'no-store' });
};

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders ?? {}) },
  });
}
