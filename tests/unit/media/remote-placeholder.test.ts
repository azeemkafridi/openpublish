/**
 * rehostUrlToMedia must reject IFTTT's "no image" placeholder card.
 *
 * When an applet's {{ImageUrl}} ingredient is empty, IFTTT substitutes
 * https://ifttt.com/images/no_image_card.png instead of sending nothing. The
 * rehost path saw a perfectly valid PNG, stored it, and users published a gray
 * placeholder card as if it were their photo (verified in prod across three
 * orgs, 2026-08-22). Two independent gates:
 *   - the URL itself (any ifttt.com /images/no_image_card* path), pre-fetch
 *   - the file's sha256 after download (same bytes via a proxy/re-upload URL)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mockFetch = vi.fn();
vi.mock('@/lib/security/url-guard', () => ({
  validateHostname: vi.fn(async () => true),
  ssrfSafeFetch: (...args: any[]) => mockFetch(...args),
}));

const mockSave = vi.fn(async () => ({ id: 1, originalPath: 'original/x.png' }));
vi.mock('@/lib/media/upload', () => ({
  saveUploadedFile: (...args: any[]) => mockSave(...(args as [])),
  getMediaPublicUrl: vi.fn((p: string) => p),
}));

import { rehostUrlToMedia, RemoteMediaError } from '@/lib/media/remote';

export {};

// A minimal valid PNG (magic bytes only matter for the type check).
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

// The actual card IFTTT serves (fetched from ifttt.com/images/no_image_card.png,
// sha256 4b16df77…). If IFTTT ever changes the graphic, re-fetch it, update
// this fixture AND the hash constant in src/lib/media/remote.ts together.
const PLACEHOLDER_BYTES = readFileSync(
  join(__dirname, '../../fixtures/ifttt-no-image-card.png'),
);

function pngResponse(buffer: Buffer) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'image/png', 'content-length': String(buffer.length) }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(buffer));
        controller.close();
      },
    }),
  } as unknown as Response;
}

describe('rehostUrlToMedia — IFTTT placeholder rejection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    'https://ifttt.com/images/no_image_card.png',
    'http://ifttt.com/images/no_image_card.png',
    'https://www.ifttt.com/images/no_image_card.png',
    'https://ifttt.com/images/no_image_card.jpg',
  ])('rejects the placeholder URL %s without fetching', async (url) => {
    await expect(rehostUrlToMedia(url, 'user-1', 42)).rejects.toThrow(
      /IFTTT's 'no image' placeholder/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('rejects the placeholder by content hash even from a different URL', async () => {
    mockFetch.mockResolvedValue(pngResponse(PLACEHOLDER_BYTES));
    await expect(
      rehostUrlToMedia('https://cdn.example.com/looks-innocent.png', 'user-1', 42),
    ).rejects.toThrow(/IFTTT's 'no image' placeholder/);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('stores a normal image untouched', async () => {
    const normal = Buffer.concat([PNG_MAGIC, Buffer.from('not-a-placeholder')]);
    mockFetch.mockResolvedValue(pngResponse(normal));
    await expect(rehostUrlToMedia('https://cdn.example.com/photo.png', 'user-1', 42)).resolves.toBeTruthy();
    expect(mockSave).toHaveBeenCalledOnce();
  });

  it('does not reject other ifttt.com URLs', async () => {
    const normal = Buffer.concat([PNG_MAGIC, Buffer.from('real-image-bytes')]);
    mockFetch.mockResolvedValue(pngResponse(normal));
    await expect(
      rehostUrlToMedia('https://ifttt.com/images/some_real_asset.png', 'user-1', 42),
    ).resolves.toBeTruthy();
  });
});
