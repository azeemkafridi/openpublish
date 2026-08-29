import { validateHostname } from '../security/url-guard';

export { validateOwnedChannels } from '../channels/validate';

/** Normalize + SSRF-check a user-supplied feed URL; null when invalid. */
export async function validateFeedUrl(feedUrl: unknown): Promise<string | null> {
  if (typeof feedUrl !== 'string' || feedUrl.length > 2000) return null;
  let parsed: URL;
  try {
    parsed = new URL(feedUrl);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (!(await validateHostname(parsed.hostname))) return null;
  return parsed.href;
}
