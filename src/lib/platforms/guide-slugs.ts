import type { PlatformName } from './types';

/**
 * URL slug for a platform's marketing guide at
 * openpublish.example/integrations/<slug>.
 *
 * Defined HERE, in the app, rather than on the marketing site, even though the
 * pages are marketing's — because both halves need it and only one of them can
 * own it. The tool pages link out to a guide and the guides link back to the
 * tools; a second copy of this map on the marketing side would be a silent
 * 404 generator the first time a slug changed. It reaches marketing inside
 * platform-capabilities.json, which is generated from this file and drift-
 * tested, so there is exactly one place to edit.
 *
 * The default is the platform key, which is already the word people search.
 * Overrides exist only where the key is an internal abbreviation or too short
 * to rank on its own.
 */
const OVERRIDES: Partial<Record<PlatformName, string>> = {
  gmb: 'google-business',
  x: 'x-twitter',
};

export function platformGuideSlug(platform: string): string {
  return OVERRIDES[platform as PlatformName] ?? platform;
}

/** Path to a platform's guide, localized. Prefix with MARKETING_URL to link. */
export function platformGuidePath(platform: string, localize: (path: string) => string): string {
  return localize(`/integrations/${platformGuideSlug(platform)}/`);
}
