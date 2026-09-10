/**
 * URL detection utility for extracting links from post content.
 */

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;

/**
 * Extract the first URL found in the given text.
 * Returns null if no URL is found.
 */
export function extractFirstUrl(text: string): string | null {
  if (!text) return null;
  const match = text.match(URL_REGEX);
  return match ? match[0].replace(/[.,;:!?)]+$/, '') : null;
}

/**
 * Extract all URLs found in the given text.
 */
export function extractAllUrls(text: string): string[] {
  if (!text) return [];
  const matches = text.match(URL_REGEX);
  if (!matches) return [];
  return matches.map((url) => url.replace(/[.,;:!?)]+$/, ''));
}

/**
 * X wraps every URL in t.co and Mastodon flat-counts links: on both platforms
 * a URL always counts as exactly 23 characters, regardless of real length.
 * X: https://docs.x.com/fundamentals/counting-characters
 * Mastodon: https://docs.joinmastodon.org/user/posting/
 */
const URL_WEIGHTED_PLATFORMS = new Set(['x', 'mastodon']);
export const URL_CHAR_WEIGHT = 23;

export function countsUrlsAsFixedLength(platform: string): boolean {
  return URL_WEIGHTED_PLATFORMS.has(platform);
}

/**
 * Character count of `text` as the given platform measures it: every URL
 * counts as URL_CHAR_WEIGHT on url-weighted platforms (trailing punctuation
 * that our regex over-matches is counted at its real length), plain length
 * everywhere else.
 */
export function platformLength(text: string, platform: string): number {
  if (!text) return 0;
  if (!URL_WEIGHTED_PLATFORMS.has(platform)) return text.length;
  const measure = platform === 'x' ? xWeightedLength : (t: string) => t.length;
  let delta = 0;
  for (const match of text.match(URL_REGEX) ?? []) {
    const url = match.replace(/[.,;:!?)]+$/, '');
    delta += URL_CHAR_WEIGHT - measure(url);
  }
  return measure(text) + delta;
}

/**
 * X's weighted count: code points in the Latin, Latin-extended, Greek,
 * Cyrillic, Hebrew, Arabic (up to U+10FF) and general-punctuation ranges
 * count 1, everything else — CJK, emoji, most other scripts — counts 2,
 * measured on the NFC form. `text.length` undercounted a 200-character CJK
 * post as 200 where X sees 400 and rejects it after the media had uploaded.
 * https://docs.x.com/fundamentals/counting-characters
 */
export function xWeightedLength(text: string): number {
  let n = 0;
  for (const ch of text.normalize('NFC')) {
    const cp = ch.codePointAt(0) ?? 0;
    const light =
      cp <= 4351 ||
      (cp >= 8192 && cp <= 8205) ||
      (cp >= 8208 && cp <= 8223) ||
      (cp >= 8242 && cp <= 8247);
    n += light ? 1 : 2;
  }
  return n;
}
