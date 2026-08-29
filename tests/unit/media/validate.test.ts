/**
 * Tests for shared media-upload validation (webapp/src/lib/media/validate.ts):
 *   - isAllowedMimeType allowlist
 *   - extForMime mapping
 *   - magicBytesMatch signature checks (match, mismatch, unknown)
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_FILE_SIZE,
  ALLOWED_MIME_TYPES,
  isAllowedMimeType,
  extForMime,
  magicBytesMatch,
  isMp4Like,
  hasMp4MoovBox,
  moovFourccInWindows,
} from '@/lib/media/validate';

export {};

describe('isAllowedMimeType', () => {
  it('accepts every allowed type', () => {
    for (const t of ALLOWED_MIME_TYPES) {
      expect(isAllowedMimeType(t)).toBe(true);
    }
  });

  it('rejects disallowed types', () => {
    expect(isAllowedMimeType('application/pdf')).toBe(false);
    expect(isAllowedMimeType('image/svg+xml')).toBe(false);
    expect(isAllowedMimeType('text/html')).toBe(false);
    expect(isAllowedMimeType('')).toBe(false);
  });
});

describe('MAX_FILE_SIZE', () => {
  it('is 100MB', () => {
    expect(MAX_FILE_SIZE).toBe(100 * 1024 * 1024);
  });
});

describe('extForMime', () => {
  it('maps known types to extensions', () => {
    expect(extForMime('image/jpeg')).toBe('jpg');
    expect(extForMime('image/png')).toBe('png');
    expect(extForMime('image/webp')).toBe('webp');
    expect(extForMime('image/gif')).toBe('gif');
    expect(extForMime('video/mp4')).toBe('mp4');
    expect(extForMime('video/quicktime')).toBe('mov');
    expect(extForMime('video/webm')).toBe('webm');
  });

  it('falls back to bin for unknown types', () => {
    expect(extForMime('application/octet-stream')).toBe('bin');
  });
});

describe('magicBytesMatch', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
  const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0, 0, 0, 0, 0, 0, 0, 0]);
  const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]);
  const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);

  it('matches correct signatures', () => {
    expect(magicBytesMatch(JPEG, 'image/jpeg')).toBe(true);
    expect(magicBytesMatch(PNG, 'image/png')).toBe(true);
    expect(magicBytesMatch(GIF, 'image/gif')).toBe(true);
    expect(magicBytesMatch(WEBP, 'image/webp')).toBe(true);
    expect(magicBytesMatch(MP4, 'video/mp4')).toBe(true);
    expect(magicBytesMatch(MP4, 'video/quicktime')).toBe(true);
    expect(magicBytesMatch(WEBM, 'video/webm')).toBe(true);
  });

  it('rejects a mismatched signature (PNG bytes claiming JPEG)', () => {
    expect(magicBytesMatch(PNG, 'image/jpeg')).toBe(false);
    expect(magicBytesMatch(JPEG, 'image/png')).toBe(false);
    expect(magicBytesMatch(JPEG, 'image/webp')).toBe(false);
  });

  it('accepts a type with no known signature (does not block)', () => {
    expect(magicBytesMatch(new Uint8Array(12), 'application/zip')).toBe(true);
  });

  it('works with a Node Buffer (Buffer is a Uint8Array)', () => {
    expect(magicBytesMatch(Buffer.from(JPEG), 'image/jpeg')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// moov-atom checks (unfinalized mp4s pass the ftyp check but have no moov)
// ---------------------------------------------------------------------------

function box(type: string, payload = 0): Uint8Array {
  const size = 8 + payload;
  const b = new Uint8Array(size);
  new DataView(b.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  return b;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

describe('hasMp4MoovBox', () => {
  it('finds moov after ftyp + mdat (end-of-file moov)', () => {
    expect(hasMp4MoovBox(concat(box('ftyp', 8), box('mdat', 100), box('moov', 16)))).toBe(true);
  });

  it('finds a faststart moov before mdat', () => {
    expect(hasMp4MoovBox(concat(box('ftyp', 8), box('moov', 16), box('mdat', 100)))).toBe(true);
  });

  it('rejects an unfinalized ftyp + mdat file (the mid-encode grab)', () => {
    expect(hasMp4MoovBox(concat(box('ftyp', 8), box('mdat', 100)))).toBe(false);
  });

  it('rejects a truncated file whose last box size runs past EOF', () => {
    const truncated = concat(box('ftyp', 8), box('mdat', 1000)).subarray(0, 40);
    expect(hasMp4MoovBox(truncated)).toBe(false);
  });

  it('handles a largesize (64-bit) box header without walking past it incorrectly', () => {
    // size=1 marker + 16-byte extended header declaring a 24-byte box, then moov
    const large = new Uint8Array(24);
    const dv = new DataView(large.buffer);
    dv.setUint32(0, 1); // size == 1 -> largesize
    for (let i = 0; i < 4; i++) large[4 + i] = 'mdat'.charCodeAt(i);
    dv.setUint32(8, 0);  // hi
    dv.setUint32(12, 24); // lo = full box length
    expect(hasMp4MoovBox(concat(box('ftyp', 8), large, box('moov', 16)))).toBe(true);
  });

  it('stops on a malformed size instead of looping', () => {
    const bad = box('ftyp', 8);
    new DataView(bad.buffer).setUint32(0, 3); // size < 8, malformed
    expect(hasMp4MoovBox(bad)).toBe(false);
  });
});

describe('moovFourccInWindows', () => {
  it('finds moov bytes in either window', () => {
    const tail = concat(box('mdat', 4), box('moov', 8));
    expect(moovFourccInWindows(null, tail)).toBe(true);
    expect(moovFourccInWindows(tail, undefined)).toBe(true);
  });

  it('returns false when no window contains the fourcc', () => {
    expect(moovFourccInWindows(box('ftyp', 8), box('mdat', 64))).toBe(false);
    expect(moovFourccInWindows(null, undefined)).toBe(false);
  });
});

describe('isMp4Like', () => {
  it('covers mp4 and quicktime only', () => {
    expect(isMp4Like('video/mp4')).toBe(true);
    expect(isMp4Like('video/quicktime')).toBe(true);
    expect(isMp4Like('video/webm')).toBe(false);
    expect(isMp4Like('image/gif')).toBe(false);
  });
});
