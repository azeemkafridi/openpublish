/**
 * Shared media-upload validation.
 *
 * Used by every upload path so the rules stay identical:
 *   - POST /api/media          (server-side / programmatic multipart upload)
 *   - POST /api/media/presign  (browser direct-to-R2: pre-flight checks)
 *   - POST /api/media/finalize (browser direct-to-R2: verify the stored object)
 */

/** Max upload size for images (and the cap for remote URL imports). */
export const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

/** Max upload size for videos — uploaded via multipart (chunked, resumable). */
export const MAX_VIDEO_FILE_SIZE = 1024 * 1024 * 1024; // 1GB

/** Size cap for a given MIME type: videos get the 1GB multipart cap. */
export function maxSizeForMime(mime: string): number {
  return mime.startsWith('video/') ? MAX_VIDEO_FILE_SIZE : MAX_FILE_SIZE;
}

/** Human label for the cap, for error messages ("100MB" / "1GB"). */
export function maxSizeLabel(mime: string): string {
  return mime.startsWith('video/') ? '1GB' : '100MB';
}

/** MIME types accepted for upload across all upload paths. */
export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

export function isAllowedMimeType(mime: string): mime is AllowedMimeType {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(mime);
}

/** Map an allowed MIME type to a file extension (used to build R2 keys). */
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

export function extForMime(mime: string): string {
  return MIME_EXT[mime] ?? 'bin';
}

/**
 * Verify the leading bytes of a file match the declared MIME type.
 * Only the first 12 bytes are inspected, so a cheap ranged GET is enough to
 * validate a file already stored in R2 without downloading the whole object.
 *
 * Returns `true` when the type has no known signature (we don't block types we
 * can't fingerprint) or when the signature matches; `false` only on a definite
 * mismatch. Works with both Node `Buffer` and a raw `Uint8Array`.
 */
export function magicBytesMatch(header: Uint8Array, mimeType: string): boolean {
  const checks: Record<string, (h: Uint8Array) => boolean> = {
    'image/jpeg': (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff,
    'image/png': (h) => h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47,
    'image/gif': (h) => h[0] === 0x47 && h[1] === 0x49 && h[2] === 0x46,
    'image/webp': (h) =>
      h.length >= 12 &&
      h[0] === 0x52 &&
      h[1] === 0x49 &&
      h[2] === 0x46 &&
      h[3] === 0x46 &&
      h[8] === 0x57 &&
      h[9] === 0x45 &&
      h[10] === 0x42 &&
      h[11] === 0x50,
    'video/mp4': (h) => h.length >= 8 && h[4] === 0x66 && h[5] === 0x74 && h[6] === 0x79 && h[7] === 0x70,
    'video/quicktime': (h) => h.length >= 8 && h[4] === 0x66 && h[5] === 0x74 && h[6] === 0x79 && h[7] === 0x70,
    'video/webm': (h) => h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3,
  };
  const check = checks[mimeType];
  if (!check) return true; // unknown signature → don't block
  return check(header);
}

/** MIME types the moov checks below apply to (ISO BMFF containers). */
export function isMp4Like(mimeType: string): boolean {
  return mimeType === 'video/mp4' || mimeType === 'video/quicktime';
}

/**
 * Strict top-level ISO-BMFF box walk: true only when a `moov` box exists.
 * A video grabbed mid-encode (or a truncated upload) is `ftyp + mdat` with no
 * `moov` — it passes the ftyp magic-byte check, then fails DAYS later at
 * publish time with an opaque "file is corrupted" from the platform. Catch it
 * at ingest instead. Requires the WHOLE file (moov is usually at the end for
 * non-faststart encodes); for R2-stored objects use `moovFourccInWindows`.
 */
export function hasMp4MoovBox(buf: Uint8Array): boolean {
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const view = new DataView(buf.buffer, buf.byteOffset + offset, Math.min(16, buf.length - offset));
    let size = view.getUint32(0);
    const type = String.fromCharCode(buf[offset + 4], buf[offset + 5], buf[offset + 6], buf[offset + 7]);
    if (type === 'moov') return true;
    if (size === 0) {
      // box extends to end of file
      break;
    } else if (size === 1) {
      // 64-bit largesize — needs the 16-byte extended header
      if (offset + 16 > buf.length) break;
      const hi = view.getUint32(8);
      const lo = view.getUint32(12);
      const large = hi * 2 ** 32 + lo;
      if (large < 16) break; // malformed
      offset += large;
    } else if (size < 8) {
      break; // malformed
    } else {
      offset += size;
    }
  }
  return false;
}

/**
 * Cheap `moov` presence check for files we can only ranged-read (browser
 * direct-to-R2 uploads): scans the head and tail windows for the fourcc.
 * moov lives near the start (faststart) or at the end — an unfinalized
 * `ftyp + mdat` file contains the bytes "moov" nowhere. Substring scan, so a
 * (rare) false positive lets a bad file through to the strict publish-time
 * failure; it can't false-negative a valid one with moov in either window.
 */
export function moovFourccInWindows(...windows: Array<Uint8Array | null | undefined>): boolean {
  const M = [0x6d, 0x6f, 0x6f, 0x76]; // 'moov'
  for (const w of windows) {
    if (!w) continue;
    for (let i = 0; i + 4 <= w.length; i++) {
      if (w[i] === M[0] && w[i + 1] === M[1] && w[i + 2] === M[2] && w[i + 3] === M[3]) return true;
    }
  }
  return false;
}
