import { createHash } from 'node:crypto';
import { validateHostname, ssrfSafeFetch } from '../security/url-guard';
import { MAX_FILE_SIZE, isAllowedMimeType, magicBytesMatch, extForMime, isMp4Like, hasMp4MoovBox } from './validate';
import { saveUploadedFile, type UploadResult } from './upload';

/**
 * Fetch a user-supplied remote media URL and re-host it as an org media file.
 * Used by Bulk Compose CSV import (`media_urls`). SSRF-guarded: HTTP(S) only,
 * private/internal hosts blocked (with per-redirect re-validation), hard size
 * cap, content-type allowlist + magic-byte check before anything is stored.
 */

const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

// IFTTT substitutes this card graphic for an empty {{ImageUrl}} ingredient
// instead of sending nothing, so applets silently attach a gray "no image"
// placeholder as if it were the user's photo (verified in prod across three
// orgs, 2026-08-22). Rejecting it turns a wrong post into an actionable error.
// Checked twice: by URL before fetching, and by content hash after (the same
// bytes can arrive via a proxy or re-upload URL).
const IFTTT_PLACEHOLDER_MESSAGE =
  "is IFTTT's 'no image' placeholder card — the item that triggered your applet " +
  'has no image. Check the Image URL ingredient in your applet';

const IFTTT_PLACEHOLDER_SHA256 = '4b16df77fb385162a48b5d4c86fe4d1a73d6ef360b10ec5eb888b08fe2725447';

function isIftttPlaceholderUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    (host === 'ifttt.com' || host.endsWith('.ifttt.com')) &&
    /^\/images\/no_image_card(\.|$)/.test(url.pathname)
  );
}

/** Thrown for any unsafe/invalid/unfetchable remote media URL. Message is user-safe. */
export class RemoteMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteMediaError';
  }
}

async function fetchRemoteBytes(rawUrl: string, maxBytes: number = MAX_FILE_SIZE): Promise<{ buffer: Buffer; contentType: string; fileName: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new RemoteMediaError('not a valid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new RemoteMediaError('only HTTP/HTTPS URLs are allowed');
  if (isIftttPlaceholderUrl(parsed)) throw new RemoteMediaError(IFTTT_PLACEHOLDER_MESSAGE);
  if (!(await validateHostname(parsed.hostname))) throw new RemoteMediaError('host is not allowed');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let currentUrl = parsed.href;
    let response!: Response;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      response = await ssrfSafeFetch(currentUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'openPublish/1.0 MediaImport' },
        redirect: 'manual',
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (!location) break;
      const redirectUrl = new URL(location, currentUrl);
      if (!['http:', 'https:'].includes(redirectUrl.protocol)) throw new RemoteMediaError('redirect to a disallowed protocol');
      if (!(await validateHostname(redirectUrl.hostname))) throw new RemoteMediaError('redirect to a disallowed host');
      currentUrl = redirectUrl.href;
      if (i === MAX_REDIRECTS) throw new RemoteMediaError('too many redirects');
    }

    if (!response.ok) throw new RemoteMediaError(`fetch failed (HTTP ${response.status})`);

    const maxMb = Math.round(maxBytes / (1024 * 1024));
    const declaredLen = Number(response.headers.get('content-length') || '0');
    if (declaredLen && declaredLen > maxBytes) throw new RemoteMediaError(`file too large (max ${maxMb}MB)`);

    const reader = response.body?.getReader();
    if (!reader) throw new RemoteMediaError('empty response body');
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RemoteMediaError(`file too large (max ${maxMb}MB)`);
      }
      chunks.push(Buffer.from(value));
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) throw new RemoteMediaError('downloaded file is empty');

    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const base = (parsed.pathname.split('/').pop() || 'media').trim() || 'media';
    const ext = extForMime(contentType).replace(/^\./, '');
    const fileName = base.includes('.') ? base : `${base}.${ext || 'bin'}`;
    return { buffer, contentType, fileName };
  } catch (err) {
    if (err instanceof RemoteMediaError) throw err;
    if (err instanceof Error && err.name === 'AbortError') throw new RemoteMediaError('request timed out');
    throw new RemoteMediaError('could not be fetched');
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch a remote URL and store it as an org media file. Returns the stored
 * media record. `maxBytes` lets automated importers (RSS autopost) use a lower
 * cap than user-driven imports.
 */
export async function rehostUrlToMedia(
  rawUrl: string,
  userId: string,
  organizationId: number,
  opts?: { maxBytes?: number },
): Promise<UploadResult> {
  const { buffer, contentType, fileName } = await fetchRemoteBytes(rawUrl, opts?.maxBytes ?? MAX_FILE_SIZE);
  if (createHash('sha256').update(buffer).digest('hex') === IFTTT_PLACEHOLDER_SHA256) {
    throw new RemoteMediaError(IFTTT_PLACEHOLDER_MESSAGE);
  }
  if (!isAllowedMimeType(contentType)) throw new RemoteMediaError(`unsupported media type${contentType ? ` (${contentType})` : ''}`);
  if (!magicBytesMatch(new Uint8Array(buffer).subarray(0, 12), contentType)) {
    throw new RemoteMediaError('file contents do not match the declared type');
  }
  if (isMp4Like(contentType) && !hasMp4MoovBox(new Uint8Array(buffer))) {
    throw new RemoteMediaError('the video file is incomplete (no moov atom) — it may still be encoding at the source');
  }
  const file = new File([buffer], fileName, { type: contentType });
  return saveUploadedFile(userId, file, organizationId);
}
