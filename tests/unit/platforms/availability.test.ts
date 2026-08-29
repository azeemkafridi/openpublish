/**
 * Tests for per-platform availability gating (availability.ts).
 *
 * Covers:
 *   - default-on: an unset PLATFORM_<NAME> leaves the platform fully available
 *   - the three states (on / connect_off / off) and their aliases
 *   - precedence: an explicit `off` beats missing credentials beats `connect_off`
 *   - credential gating still applies (Reddit needs both keys, Discord three)
 *   - canConnect / canPublish semantics — `connect_off` grandfathers existing
 *     channels, `off` halts publishing too
 *   - getHiddenPlatforms hides `off` + unconfigured, but NOT explicit connect_off
 */

// Self-host gates every OAuth-app platform on credentials; give the suite a
// fully-credentialed environment so the flag-state tests keep their meaning.
for (const v of [
  'X_CLIENT_ID','X_CLIENT_SECRET','LINKEDIN_CLIENT_ID','LINKEDIN_CLIENT_SECRET',
  'FACEBOOK_APP_ID','FACEBOOK_APP_SECRET','INSTAGRAM_APP_ID','INSTAGRAM_APP_SECRET',
  'THREADS_APP_ID','THREADS_APP_SECRET','TIKTOK_CLIENT_KEY','TIKTOK_CLIENT_SECRET',
  'YOUTUBE_CLIENT_ID','YOUTUBE_CLIENT_SECRET','PINTEREST_APP_ID','PINTEREST_APP_SECRET',
  'GMB_CLIENT_ID','GMB_CLIENT_SECRET',
]) {
  process.env[v] = process.env[v] || 'test-credential';
}

import {
  ALL_PLATFORMS,
  getPlatformAvailability,
  getAllPlatformAvailability,
  canConnectPlatform,
  canPublishPlatform,
  getHiddenPlatforms,
  getUnconfiguredPlatforms,
  isPlatformConfigured,
  platformFlagEnvVar,
  platformVariantFlagEnvVar,
  getPlatformVariants,
  getPlatformAvailabilityFor,
  getAllPlatformVariantAvailability,
  resolveAvailabilityForRole,
} from '@/lib/platforms/availability';

export {};

const CRED_KEYS = [
  'REDDIT_CLIENT_ID',
  'REDDIT_CLIENT_SECRET',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_BOT_TOKEN',
];

const VARIANT_KEYS = [
  'PLATFORM_LINKEDIN_PAGES',
  'LINKEDIN_PAGES_CLIENT_ID',
  'LINKEDIN_PAGES_CLIENT_SECRET',
];

const FLAG_KEYS = ALL_PLATFORMS.map(platformFlagEnvVar);
const KEYS = [...CRED_KEYS, ...FLAG_KEYS, ...VARIANT_KEYS];

describe('platform availability', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe('default-on', () => {
    it('an unset flag leaves a credential-free platform fully available', () => {
      const a = getPlatformAvailability('facebook');
      expect(a.state).toBe('on');
      expect(a.reason).toBe('enabled');
      expect(a.canConnect).toBe(true);
      expect(a.canPublish).toBe(true);
      expect(a.message).toBeNull();
    });

    it('an unrecognised flag value falls back to on rather than blacking out a platform', () => {
      process.env.PLATFORM_LINKEDIN = 'banana';
      expect(getPlatformAvailability('linkedin').state).toBe('on');
    });

    it('a blank flag value is treated as unset', () => {
      process.env.PLATFORM_LINKEDIN = '   ';
      expect(getPlatformAvailability('linkedin').state).toBe('on');
    });
  });

  describe('the three states', () => {
    it('off is a full kill switch — no connect, no publish', () => {
      process.env.PLATFORM_LINKEDIN = 'off';
      const a = getPlatformAvailability('linkedin');
      expect(a.state).toBe('off');
      expect(a.reason).toBe('flag_off');
      expect(a.canConnect).toBe(false);
      expect(a.canPublish).toBe(false);
      expect(a.message).toMatch(/on hold/i);
    });

    it('connect_off blocks new connections but keeps existing channels publishing', () => {
      process.env.PLATFORM_TIKTOK = 'connect_off';
      const a = getPlatformAvailability('tiktok');
      expect(a.state).toBe('connect_off');
      expect(a.reason).toBe('flag_connect_off');
      expect(a.canConnect).toBe(false);
      expect(a.canPublish).toBe(true);
    });

    it('accepts the off aliases', () => {
      for (const value of ['false', '0', 'no', 'disabled', 'OFF']) {
        process.env.PLATFORM_X = value;
        expect(canPublishPlatform('x')).toBe(false);
      }
    });

    it('accepts the connect_off aliases', () => {
      for (const value of ['connect-off', 'existing_only', 'paused', 'GRANDFATHERED']) {
        process.env.PLATFORM_X = value;
        const a = getPlatformAvailability('x');
        expect(a.state).toBe('connect_off');
        expect(a.canPublish).toBe(true);
      }
    });
  });

  describe('credential gating', () => {
    it('platforms with no required app credentials are always configured', () => {
      expect(isPlatformConfigured('telegram')).toBe(true);
      expect(isPlatformConfigured('bluesky')).toBe(true);
      expect(isPlatformConfigured('mastodon')).toBe(true);
      // The long-standing platforms are intentionally NOT credential-gated.
      expect(isPlatformConfigured('facebook')).toBe(true);
    });

    it('reddit is configured only when both client id and secret are set', () => {
      expect(isPlatformConfigured('reddit')).toBe(false);
      process.env.REDDIT_CLIENT_ID = 'id';
      expect(isPlatformConfigured('reddit')).toBe(false); // secret still missing
      process.env.REDDIT_CLIENT_SECRET = 'secret';
      expect(isPlatformConfigured('reddit')).toBe(true);
    });

    it('discord requires client id, secret, AND bot token', () => {
      process.env.DISCORD_CLIENT_ID = 'id';
      process.env.DISCORD_CLIENT_SECRET = 'secret';
      expect(isPlatformConfigured('discord')).toBe(false); // bot token missing
      process.env.DISCORD_BOT_TOKEN = 'token';
      expect(isPlatformConfigured('discord')).toBe(true);
    });

    it('missing credentials resolve to connect_off — nothing to grandfather', () => {
      const a = getPlatformAvailability('reddit');
      expect(a.state).toBe('connect_off');
      expect(a.reason).toBe('unconfigured');
      expect(a.canConnect).toBe(false);
    });

    it('a platform with credentials present and no flag is fully on', () => {
      process.env.REDDIT_CLIENT_ID = 'id';
      process.env.REDDIT_CLIENT_SECRET = 'secret';
      expect(getPlatformAvailability('reddit').state).toBe('on');
      expect(canConnectPlatform('reddit')).toBe(true);
    });
  });

  describe('precedence', () => {
    it('an explicit off beats missing credentials', () => {
      process.env.PLATFORM_REDDIT = 'off';
      // Reddit creds left unset — 'off' must still win, since off also stops publishing.
      const a = getPlatformAvailability('reddit');
      expect(a.state).toBe('off');
      expect(a.reason).toBe('flag_off');
      expect(a.canPublish).toBe(false);
    });

    it('missing credentials beat an explicit connect_off (same state, clearer reason)', () => {
      process.env.PLATFORM_REDDIT = 'connect_off';
      const a = getPlatformAvailability('reddit');
      expect(a.state).toBe('connect_off');
      expect(a.reason).toBe('unconfigured');
    });
  });

  describe('hidden platforms', () => {
    it('hides kill-switched and unconfigured platforms, but not an explicit connect_off', () => {
      process.env.DISCORD_CLIENT_ID = 'id';
      process.env.DISCORD_CLIENT_SECRET = 'secret';
      process.env.DISCORD_BOT_TOKEN = 'token';
      process.env.PLATFORM_DISCORD = 'connect_off'; // paused signups — stays visible
      process.env.PLATFORM_X = 'off'; // kill switch — hidden
      // Reddit creds left unset — unconfigured, hidden.

      const hidden = getHiddenPlatforms();
      expect(hidden).toContain('reddit');
      expect(hidden).toContain('x');
      expect(hidden).not.toContain('discord');
      expect(hidden).not.toContain('telegram');
    });

    it('getUnconfiguredPlatforms still reports only credential-missing platforms', () => {
      process.env.DISCORD_CLIENT_ID = 'id';
      process.env.DISCORD_CLIENT_SECRET = 'secret';
      process.env.DISCORD_BOT_TOKEN = 'token';
      const unconfigured = getUnconfiguredPlatforms();
      expect(unconfigured).toContain('reddit');
      expect(unconfigured).not.toContain('discord');
    });
  });

  describe('getAllPlatformAvailability', () => {
    it('returns an entry for every known platform', () => {
      const all = getAllPlatformAvailability();
      expect(Object.keys(all).sort()).toEqual([...ALL_PLATFORMS].sort());
    });

    it('reflects per-platform flags independently', () => {
      process.env.PLATFORM_X = 'off';
      process.env.PLATFORM_TIKTOK = 'connect_off';
      const all = getAllPlatformAvailability();
      expect(all.x.state).toBe('off');
      expect(all.tiktok.state).toBe('connect_off');
      expect(all.facebook.state).toBe('on');
    });
  });

  /**
   * LinkedIn company pages ride a second LinkedIn app (Community Management
   * API) reviewed separately from personal profiles, so they gate on their own
   * `PLATFORM_LINKEDIN_PAGES` — able to narrow the parent flag, never widen it.
   */
  describe('sub-platform variants (LinkedIn company pages)', () => {
    // Present unless a test says otherwise: credential absence is its own case.
    beforeEach(() => {
      process.env.LINKEDIN_PAGES_CLIENT_ID = 'id';
      process.env.LINKEDIN_PAGES_CLIENT_SECRET = 'secret';
    });

    it('declares the organization variant and its env var', () => {
      expect(Object.keys(getPlatformVariants('linkedin'))).toEqual(['organization']);
      expect(platformVariantFlagEnvVar('linkedin', 'organization')).toBe('PLATFORM_LINKEDIN_PAGES');
      expect(platformVariantFlagEnvVar('facebook', 'page')).toBeNull();
    });

    it('pauses page connects while leaving personal profiles fully live', () => {
      process.env.PLATFORM_LINKEDIN = 'on';
      process.env.PLATFORM_LINKEDIN_PAGES = 'connect_off';

      const personal = getPlatformAvailabilityFor('linkedin', 'personal');
      expect(personal.state).toBe('on');
      expect(personal.canConnect).toBe(true);

      const page = getPlatformAvailabilityFor('linkedin', 'organization');
      expect(page.state).toBe('connect_off');
      expect(page.reason).toBe('flag_connect_off');
      expect(page.canConnect).toBe(false);
      // Already-connected pages keep publishing — this is the pending-review state.
      expect(page.canPublish).toBe(true);
      expect(page.variant).toBe('organization');
      expect(page.message).toMatch(/company pages/i);
    });

    it('holds page posts when the variant is a full kill switch', () => {
      process.env.PLATFORM_LINKEDIN_PAGES = 'off';
      expect(getPlatformAvailabilityFor('linkedin', 'organization').canPublish).toBe(false);
      expect(getPlatformAvailabilityFor('linkedin', 'personal').canPublish).toBe(true);
      expect(getPlatformAvailabilityFor('linkedin', 'personal').canConnect).toBe(true);
    });

    it('never widens its parent — PLATFORM_LINKEDIN=off kills pages too', () => {
      process.env.PLATFORM_LINKEDIN = 'off';
      process.env.PLATFORM_LINKEDIN_PAGES = 'on';
      const page = getPlatformAvailabilityFor('linkedin', 'organization');
      expect(page.state).toBe('off');
      expect(page.canPublish).toBe(false);
      // Parent's own wording — the whole platform is down, not just pages.
      expect(page.variant).toBeUndefined();
    });

    it('blocks page connects when App B credentials are missing, without stranding connected pages', () => {
      delete process.env.LINKEDIN_PAGES_CLIENT_ID;
      const page = getPlatformAvailabilityFor('linkedin', 'organization');
      expect(page.state).toBe('connect_off');
      expect(page.reason).toBe('unconfigured');
      expect(page.canConnect).toBe(false);
      expect(page.canPublish).toBe(true);
      // Personal profiles use App A and are unaffected.
      expect(getPlatformAvailabilityFor('linkedin', 'personal').state).toBe('on');
    });

    it('is a no-op for platforms and account types with no variant', () => {
      process.env.PLATFORM_LINKEDIN_PAGES = 'off';
      expect(getPlatformAvailabilityFor('linkedin', null)).toEqual(
        getPlatformAvailability('linkedin'),
      );
      expect(getPlatformAvailabilityFor('facebook', 'page')).toEqual(
        getPlatformAvailability('facebook'),
      );
    });

    it('getAllPlatformVariantAvailability reports every declared variant', () => {
      process.env.PLATFORM_LINKEDIN_PAGES = 'connect_off';
      const all = getAllPlatformVariantAvailability();
      expect(all.linkedin.organization.state).toBe('connect_off');
    });
  });

  /**
   * `admin_only` stages a rollout: site admins (global user.role === 'admin')
   * see the platform as fully on; everyone else can't see or connect it, but
   * publishing stays allowed so admin test channels behave like production.
   */
  describe('admin_only staged rollout', () => {
    beforeEach(() => {
      // Snapchat is credential-gated; give it creds so the flag is the variable.
      process.env.SNAPCHAT_CLIENT_ID = 'id';
      process.env.SNAPCHAT_CLIENT_SECRET = 'secret';
    });
    afterEach(() => {
      delete process.env.SNAPCHAT_CLIENT_ID;
      delete process.env.SNAPCHAT_CLIENT_SECRET;
    });

    it('reports admin_only with connect blocked but publishing allowed', () => {
      process.env.PLATFORM_SNAPCHAT = 'admin_only';
      const a = getPlatformAvailability('snapchat');
      expect(a.state).toBe('admin_only');
      expect(a.reason).toBe('admin_only');
      expect(a.canConnect).toBe(false);
      expect(a.canPublish).toBe(true);
    });

    it('accepts the admin_only aliases', () => {
      for (const value of ['admin-only', 'admins', 'preview', 'ADMIN_ONLY']) {
        process.env.PLATFORM_SNAPCHAT = value;
        expect(getPlatformAvailability('snapchat').state).toBe('admin_only');
      }
    });

    it('resolves to fully on for a site admin, untouched for everyone else', () => {
      process.env.PLATFORM_SNAPCHAT = 'admin_only';
      const raw = getPlatformAvailability('snapchat');

      const admin = resolveAvailabilityForRole(raw, 'admin');
      expect(admin.state).toBe('on');
      expect(admin.canConnect).toBe(true);
      expect(admin.message).toBeNull();

      expect(resolveAvailabilityForRole(raw, 'user')).toEqual(raw);
      expect(resolveAvailabilityForRole(raw, null)).toEqual(raw);
    });

    it('never upgrades other states for admins — off stays off', () => {
      process.env.PLATFORM_SNAPCHAT = 'off';
      const raw = getPlatformAvailability('snapchat');
      expect(resolveAvailabilityForRole(raw, 'admin')).toEqual(raw);
    });

    it('missing credentials still win — admin_only without creds is unconfigured', () => {
      delete process.env.SNAPCHAT_CLIENT_ID;
      process.env.PLATFORM_SNAPCHAT = 'admin_only';
      const a = getPlatformAvailability('snapchat');
      expect(a.reason).toBe('unconfigured');
      // And an admin cannot be upgraded past missing credentials.
      expect(resolveAvailabilityForRole(a, 'admin').canConnect).toBe(false);
    });

    it('hides the platform from regular users but not from site admins', () => {
      process.env.PLATFORM_SNAPCHAT = 'admin_only';
      expect(getHiddenPlatforms()).toContain('snapchat');
      expect(getHiddenPlatforms('user')).toContain('snapchat');
      expect(getHiddenPlatforms('admin')).not.toContain('snapchat');
    });

    it('getAllPlatformAvailability resolves per role', () => {
      process.env.PLATFORM_SNAPCHAT = 'admin_only';
      expect(getAllPlatformAvailability().snapchat.state).toBe('admin_only');
      expect(getAllPlatformAvailability('admin').snapchat.state).toBe('on');
    });
  });

  it('platformFlagEnvVar builds the documented variable name', () => {
    expect(platformFlagEnvVar('linkedin')).toBe('PLATFORM_LINKEDIN');
    expect(platformFlagEnvVar('gmb')).toBe('PLATFORM_GMB');
  });
});
