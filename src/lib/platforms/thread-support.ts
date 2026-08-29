import type { PlatformName } from './types';

/**
 * Platforms that can publish a reply thread (a chain of posts, each replying to
 * the previous one).
 *
 * This list was copy-pasted into four places — the composer's Thread format, the
 * thread editor's limit table, the /tools thread maker, and the IFTTT
 * `thread_platforms` virtual group — and mastodon was missing from two of them
 * even though Mastodon threads fine. It lives here so there is one list to
 * extend when a platform gains threading.
 *
 * Deliberately NOT derived from `PLATFORM_POST_TYPES` having a `thread` entry:
 * threading is a product decision about which composer formats we offer, and a
 * platform can support reply chains long before we expose a thread UI for it.
 */
export const THREAD_PLATFORMS: readonly PlatformName[] = ['x', 'threads', 'bluesky', 'mastodon'];

export function supportsThreads(platform: string): boolean {
  return (THREAD_PLATFORMS as readonly string[]).includes(platform);
}
