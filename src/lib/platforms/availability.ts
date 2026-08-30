/**
 * Per-platform availability gating.
 *
 * Every social platform has a three-state switch driven by a single env var,
 * `PLATFORM_<NAME>` (e.g. `PLATFORM_LINKEDIN`, `PLATFORM_GMB`):
 *
 *   on          — fully available (the default when the var is unset)
 *   connect_off — existing channels keep working, NEW connections are blocked.
 *                 This is the "pending application" state: the platform app
 *                 isn't approved yet (or approval lapsed), but the users
 *                 already connected must not be disrupted.
 *   off         — full kill switch. The platform disappears from the connect
 *                 UI, existing channels go read-only, and scheduled posts are
 *                 HELD (not failed) so they publish once we flip it back on.
 *   admin_only  — staged rollout: hidden from everyone except users whose
 *                 GLOBAL site role is 'admin' (user.role — not org owner/admin),
 *                 who see and connect it normally. Publishing is allowed, so an
 *                 admin's test channels behave exactly like production. Role-
 *                 aware surfaces resolve it via resolveAvailabilityForRole().
 *
 * Defaulting to `on` is deliberate: a deploy that hasn't had the new vars added
 * to the environment yet must not silently black out 14 working platforms. You turn a
 * platform OFF explicitly; you never turn one ON by accident.
 *
 * Independently, every OAuth-app platform needs app-level credentials before it
 * can be connected at all. Missing credentials resolve to `connect_off` — there
 * is nothing to grandfather, and it keeps a half-configured deploy from showing
 * a Connect button that can only fail.
 *
 * Some platforms are really two integrations wearing one name, approved (or not)
 * separately by the vendor. Those get a **variant** flag scoped to a channel's
 * `accountType`, e.g. `PLATFORM_LINKEDIN_PAGES` for LinkedIn company pages —
 * LinkedIn's Community Management API lives in its own app with its own review,
 * so pages can be pending approval while personal profiles publish fine. A
 * variant is only ever MORE restrictive than its parent: turning the parent off
 * turns every variant off, but not the reverse.
 *
 * Platforms NOT listed in PLATFORM_REQUIRED_ENV need no app-level credentials
 * and are always credential-satisfied: Telegram (per-user @BotFather bot token),
 * Bluesky (app password), and Mastodon (per-instance app registration).
 */

import type { PlatformName } from './types';
import { platformDisplayName, ALL_PLATFORMS } from './types';

/**
 * Every platform the app knows about, in connect-grid display order.
 * Re-exported from ./types so browser code can import the list without pulling
 * this env-reading module into a client bundle.
 */
export { ALL_PLATFORMS };

// Self-hosted: every OAuth-app platform is credential-gated, so a fresh
// install only shows the platforms the operator has actually configured.
// Telegram (per-user bot token), Bluesky (app password) and Mastodon
// (per-instance app) need no app credentials and stay always available.
const PLATFORM_REQUIRED_ENV: Record<string, string[]> = {
  x: ['X_CLIENT_ID', 'X_CLIENT_SECRET'],
  linkedin: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
  facebook: ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'],
  instagram: ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET'],
  threads: ['THREADS_APP_ID', 'THREADS_APP_SECRET'],
  tiktok: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'],
  youtube: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'],
  pinterest: ['PINTEREST_APP_ID', 'PINTEREST_APP_SECRET'],
  gmb: ['GMB_CLIENT_ID', 'GMB_CLIENT_SECRET'],
  reddit: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
  discord: ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN'],
  tumblr: ['TUMBLR_CLIENT_ID', 'TUMBLR_CLIENT_SECRET'],
  snapchat: ['SNAPCHAT_CLIENT_ID', 'SNAPCHAT_CLIENT_SECRET'],
};

/**
 * Sub-platform variants gated independently of their parent platform, keyed by
 * the channel `accountType` they apply to. `envSuffix` builds the flag name
 * (`PLATFORM_LINKEDIN` + `PAGES` → `PLATFORM_LINKEDIN_PAGES`); `label` is the
 * user-facing noun, since "LinkedIn is paused" would be wrong when only pages
 * are.
 */
const PLATFORM_VARIANTS: Record<
  string,
  Record<string, { envSuffix: string; label: string; requiredEnv?: string[] }>
> = {
  linkedin: {
    organization: {
      envSuffix: 'PAGES',
      label: 'LinkedIn Company Pages',
      // App B's credentials. Personal profiles use LINKEDIN_CLIENT_ID and are
      // unaffected by these being absent.
      requiredEnv: ['LINKEDIN_PAGES_CLIENT_ID', 'LINKEDIN_PAGES_CLIENT_SECRET'],
    },
  },
};

export type PlatformState = 'on' | 'connect_off' | 'off' | 'admin_only';

/** Why a platform is in its current state — drives the message users see. */
export type PlatformStateReason =
  | 'enabled'
  /** Explicit `PLATFORM_<NAME>=connect_off` — pending application / paused signups. */
  | 'flag_connect_off'
  /** Explicit `PLATFORM_<NAME>=off` — kill switch. */
  | 'flag_off'
  /** App-level OAuth credentials aren't set (e.g. no Reddit app registered yet). */
  | 'unconfigured'
  /** Explicit `PLATFORM_<NAME>=admin_only` — staged rollout, site admins only. */
  | 'admin_only';

export interface PlatformAvailability {
  platform: PlatformName;
  state: PlatformState;
  reason: PlatformStateReason;
  /** May a NEW channel be connected right now? */
  canConnect: boolean;
  /** May already-connected channels publish right now? */
  canPublish: boolean;
  /** User-facing explanation. Null when the platform is fully enabled. */
  message: string | null;
  /**
   * Set only when this result was narrowed by a variant flag (e.g. LinkedIn
   * company pages) — the `accountType` the variant covers. Absent means the
   * result describes the platform as a whole.
   */
  variant?: string;
}

/**
 * The env var that controls a platform, e.g. `PLATFORM_LINKEDIN`. Tolerates a
 * null/undefined platform (callers derive it from DB joins that can miss) —
 * the lookup then just misses and the platform resolves to the default `on`,
 * which is the same behaviour those call sites had before gating existed.
 */
export function platformFlagEnvVar(platform: string): string {
  return `PLATFORM_${String(platform ?? '').toUpperCase()}`;
}

/**
 * Parse a flag value into a state. Unset/blank/unrecognised → `on` (see the
 * default-on rationale above). Generous with aliases so a `false` or `0` in
 * the environment does what the person typing it obviously meant.
 */
function parseFlag(raw: string | undefined): PlatformState {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return 'on';

  if (['off', 'false', '0', 'no', 'disabled'].includes(value)) return 'off';
  if (
    ['connect_off', 'connect-off', 'existing_only', 'existing-only', 'grandfathered', 'paused'].includes(
      value,
    )
  ) {
    return 'connect_off';
  }
  if (['admin_only', 'admin-only', 'admins', 'preview'].includes(value)) return 'admin_only';
  return 'on';
}

/** True when the platform's required app credentials are all present (or it needs none). */
export function isPlatformConfigured(platform: string): boolean {
  const required = PLATFORM_REQUIRED_ENV[platform];
  if (!required) return true;
  return required.every((key) => !!process.env[key]);
}

/**
 * Resolve a platform's full availability. Order matters: an explicit `off` wins
 * over everything (it's the kill switch), then missing credentials, then an
 * explicit `connect_off`.
 */
export function getPlatformAvailability(platform: string): PlatformAvailability {
  const name = platform as PlatformName;
  const label = platformDisplayName(platform);
  const flag = parseFlag(process.env[platformFlagEnvVar(platform)]);

  if (flag === 'off') {
    return {
      platform: name,
      state: 'off',
      reason: 'flag_off',
      canConnect: false,
      canPublish: false,
      message: `${label} is temporarily unavailable. Scheduled posts are on hold and will publish once it's back.`,
    };
  }

  if (!isPlatformConfigured(platform)) {
    return {
      platform: name,
      state: 'connect_off',
      reason: 'unconfigured',
      canConnect: false,
      canPublish: true,
      message: `${label} isn't configured on this instance. Add its API credentials in .env to enable it, or use openPublish in cloud mode.`,
    };
  }

  if (flag === 'connect_off') {
    return {
      platform: name,
      state: 'connect_off',
      reason: 'flag_connect_off',
      canConnect: false,
      canPublish: true,
      message: `New ${label} connections are paused. Channels you've already connected keep working.`,
    };
  }

  // Staged rollout: invisible to regular users (role-aware surfaces upgrade it
  // to `on` for site admins via resolveAvailabilityForRole). canPublish stays
  // true so an admin's test channels publish like any other channel.
  if (flag === 'admin_only') {
    return {
      platform: name,
      state: 'admin_only',
      reason: 'admin_only',
      canConnect: false,
      canPublish: true,
      message: `${label} isn't available yet.`,
    };
  }

  return {
    platform: name,
    state: 'on',
    reason: 'enabled',
    canConnect: true,
    canPublish: true,
    message: null,
  };
}

/** The variants a platform defines, keyed by the `accountType` each covers. */
export function getPlatformVariants(
  platform: string,
): Record<string, { envSuffix: string; label: string; requiredEnv?: string[] }> {
  return PLATFORM_VARIANTS[platform] ?? {};
}

/** The env var controlling a variant, e.g. `PLATFORM_LINKEDIN_PAGES`. */
export function platformVariantFlagEnvVar(platform: string, accountType: string): string | null {
  const variant = getPlatformVariants(platform)[accountType];
  if (!variant) return null;
  return `${platformFlagEnvVar(platform)}_${variant.envSuffix}`;
}

/** Restrictiveness ranking — a variant may narrow its parent, never widen it. */
const STATE_RANK: Record<PlatformState, number> = { on: 0, admin_only: 1, connect_off: 2, off: 3 };

/**
 * Availability for a specific *kind* of channel on a platform — the parent
 * `PLATFORM_<NAME>` flag combined with the variant flag for that `accountType`,
 * whichever is more restrictive. Platforms with no variant (or callers with no
 * accountType to hand) get exactly {@link getPlatformAvailability}, so this is a
 * safe drop-in everywhere a channel's accountType is known.
 */
export function getPlatformAvailabilityFor(
  platform: string,
  accountType?: string | null,
): PlatformAvailability {
  const parent = getPlatformAvailability(platform);
  if (!accountType) return parent;

  const variant = getPlatformVariants(platform)[accountType];
  if (!variant) return parent;

  const flag = parseFlag(process.env[platformVariantFlagEnvVar(platform, accountType)!]);

  // An explicit variant flag that's stricter than the parent is the binding
  // constraint — report it in its own words, so the user isn't told all of
  // LinkedIn is down when only pages are.
  if (STATE_RANK[flag] > STATE_RANK[parent.state]) {
    if (flag === 'off') {
      return {
        platform: platform as PlatformName,
        state: 'off',
        reason: 'flag_off',
        canConnect: false,
        canPublish: false,
        variant: accountType,
        message: `${variant.label} are temporarily unavailable. Scheduled posts are on hold and will publish once they're back.`,
      };
    }
    return {
      platform: platform as PlatformName,
      state: 'connect_off',
      reason: 'flag_connect_off',
      canConnect: false,
      canPublish: true,
      variant: accountType,
      message: `New ${variant.label} connections are paused. Pages you've already connected keep working.`,
    };
  }

  // Missing app credentials block NEW connections only — same reasoning as the
  // platform-level rule: nothing to grandfather, but don't strand channels
  // connected while the credentials were present.
  const unconfigured =
    !!variant.requiredEnv && !variant.requiredEnv.every((key) => !!process.env[key]);
  if (unconfigured && parent.state === 'on') {
    return {
      platform: platform as PlatformName,
      state: 'connect_off',
      reason: 'unconfigured',
      canConnect: false,
      canPublish: true,
      variant: accountType,
      message: `${variant.label} aren't available yet.`,
    };
  }

  return parent;
}

/** Availability for every known platform, keyed by name. */
export function getAllPlatformAvailability(
  role?: string | null,
): Record<PlatformName, PlatformAvailability> {
  const out = {} as Record<PlatformName, PlatformAvailability>;
  for (const platform of ALL_PLATFORMS) {
    out[platform] = resolveAvailabilityForRole(getPlatformAvailability(platform), role);
  }
  return out;
}

/**
 * Availability for every declared variant, as `{ platform: { accountType: … } }`.
 * Feeds the connect UI so a paused variant (LinkedIn pages) renders its own
 * state without a second round-trip.
 */
export function getAllPlatformVariantAvailability(): Record<
  string,
  Record<string, PlatformAvailability>
> {
  const out: Record<string, Record<string, PlatformAvailability>> = {};
  for (const [platform, variants] of Object.entries(PLATFORM_VARIANTS)) {
    out[platform] = {};
    for (const accountType of Object.keys(variants)) {
      out[platform][accountType] = getPlatformAvailabilityFor(platform, accountType);
    }
  }
  return out;
}

/**
 * Resolve an availability result for a specific viewer. The only role-sensitive
 * state is `admin_only`: a GLOBAL site admin (user.role === 'admin', not an org
 * owner/admin) sees the platform as fully `on`; everyone else keeps the
 * admin_only result (canConnect false, hidden from the grid). Every other state
 * passes through untouched.
 */
export function resolveAvailabilityForRole(
  availability: PlatformAvailability,
  role: string | null | undefined,
): PlatformAvailability {
  if (availability.state !== 'admin_only' || role !== 'admin') return availability;
  return {
    ...availability,
    state: 'on',
    reason: 'enabled',
    canConnect: true,
    canPublish: true,
    message: null,
  };
}

/** May a NEW channel be connected on this platform? */
export function canConnectPlatform(platform: string): boolean {
  return getPlatformAvailability(platform).canConnect;
}

/**
 * May already-connected channels on this platform publish? False only for the
 * full `off` kill switch — the publish worker holds those posts rather than
 * failing them.
 */
export function canPublishPlatform(platform: string): boolean {
  return getPlatformAvailability(platform).canPublish;
}

/**
 * Platforms to hide from the connect grid entirely — the `off` kill switch and
 * platforms with no app credentials configured (nothing to show a user yet).
 * An explicit `connect_off` is NOT hidden: it stays visible with its reason, so
 * users can see the platform exists and that signups are paused.
 */
export function getHiddenPlatforms(role?: string | null): string[] {
  return ALL_PLATFORMS.filter((p) => {
    const { state, reason } = resolveAvailabilityForRole(getPlatformAvailability(p), role);
    return state === 'off' || reason === 'unconfigured' || state === 'admin_only';
  });
}

/**
 * @deprecated Use {@link getHiddenPlatforms}. Kept so existing call sites keep
 * compiling; returns only the credential-missing platforms, as it always did.
 */
export function getUnconfiguredPlatforms(): string[] {
  return Object.keys(PLATFORM_REQUIRED_ENV).filter((p) => !isPlatformConfigured(p));
}
