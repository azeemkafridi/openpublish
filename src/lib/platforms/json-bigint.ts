/**
 * JSON parsing that survives 64-bit integer IDs.
 *
 * Several platforms return object IDs as bare JSON *numbers* rather than
 * strings. TikTok's `publicaly_available_post_id` is one: a video id like
 * 7667872114598333716 exceeds Number.MAX_SAFE_INTEGER (9007199254740991), so
 * `JSON.parse` silently rounds it to the nearest double —
 * 7667872114598333000 — and the real id is gone before any of our code sees
 * it. We stored that rounded value as `platform_post_id`, which made
 * /video/query/ return nothing (every TikTok post read 0 impressions / 0
 * likes) and produced a 404 public URL.
 *
 * `parseJsonPreservingBigInts` rewrites out-of-range integer literals into
 * strings before handing the text to JSON.parse, so the caller receives the
 * exact digits. Values that fit in a double are left as numbers, so ordinary
 * counts (`like_count`, `follower_count`) keep their existing type and no
 * caller arithmetic changes behaviour.
 *
 * The scan is string-aware: a number-looking run inside a JSON string (say a
 * caption that happens to contain a long digit sequence) is never touched.
 * Regex-only approaches get this wrong, which is why this walks the text.
 */

/** Digits at which an integer may exceed 2^53-1 (which is 16 digits long). */
const UNSAFE_DIGIT_COUNT = 16;

/**
 * Returns the source text with every unsafe bare integer literal quoted.
 * Exported for testing; prefer `parseJsonPreservingBigInts`.
 */
export function quoteUnsafeIntegers(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;

  while (i < text.length) {
    const ch = text[i];

    if (inString) {
      // Copy escapes as a unit so a \" doesn't look like the closing quote.
      if (ch === '\\' && i + 1 < text.length) {
        out += ch + text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      out += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    // A number literal can only start where a value is expected. Requiring the
    // previous non-whitespace character to be a structural one keeps us from
    // mangling, say, the exponent tail of a number we already copied.
    const isDigit = ch >= '0' && ch <= '9';
    const isNegative = ch === '-' && i + 1 < text.length && text[i + 1] >= '0' && text[i + 1] <= '9';
    if (isDigit || isNegative) {
      let j = i + (isNegative ? 1 : 0);
      const digitStart = j;
      while (j < text.length && text[j] >= '0' && text[j] <= '9') j++;
      const digits = text.slice(digitStart, j);
      // Only plain integers qualify: a following '.', 'e' or 'E' means it is a
      // float/exponent, where quoting would change the parsed value's meaning.
      const next = text[j];
      const isPlainInteger = next !== '.' && next !== 'e' && next !== 'E';

      if (isPlainInteger && digits.length >= UNSAFE_DIGIT_COUNT) {
        const literal = text.slice(i, j);
        // Length is a cheap prefilter; this is the authoritative check.
        if (!Number.isSafeInteger(Number(literal))) {
          out += `"${literal}"`;
          i = j;
          continue;
        }
      }

      out += text.slice(i, j);
      i = j;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Drop-in `JSON.parse` that yields oversized integers as strings.
 * Throws the same SyntaxError as JSON.parse on malformed input.
 */
export function parseJsonPreservingBigInts(text: string): unknown {
  // Fast path: nothing long enough to be at risk, so don't walk the text.
  if (!/\d{16}/.test(text)) return JSON.parse(text);
  return JSON.parse(quoteUnsafeIntegers(text));
}

/**
 * Normalises an id that may arrive as a string or a (possibly already-rounded)
 * number into a string. Use at every site that reads a platform object id.
 */
export function idToString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}
