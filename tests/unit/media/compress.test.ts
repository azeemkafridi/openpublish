/**
 * Tests webapp/src/lib/media/compress.ts:
 *   - fitWithin scaling (caps the longest edge, never upsizes)
 *   - prepareForUpload passthrough decisions (video, GIF, non-image)
 *   - prepareForUpload falls back to the original when re-encoding isn't possible
 *
 * The real WebP re-encode needs canvas/createImageBitmap, which jsdom doesn't
 * provide, so the image path here exercises the graceful fallback to the
 * original bytes (the server backfills dimensions when it makes the thumbnail).
 */
import { fitWithin, prepareForUpload } from '@/lib/media/compress';

export {};

describe('fitWithin', () => {
  it('leaves images already within the cap untouched', () => {
    expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(2048, 2048, 2048)).toEqual({ width: 2048, height: 2048 });
  });

  it('scales the longest edge down to the cap, preserving aspect ratio', () => {
    expect(fitWithin(4096, 2048, 2048)).toEqual({ width: 2048, height: 1024 });
    expect(fitWithin(3000, 6000, 2048)).toEqual({ width: 1024, height: 2048 });
  });

  it('never produces a zero dimension', () => {
    const { width, height } = fitWithin(10000, 1, 2048);
    expect(width).toBe(2048);
    expect(height).toBeGreaterThanOrEqual(1);
  });
});

describe('prepareForUpload', () => {
  it('passes a GIF through untouched (would lose animation if re-encoded)', async () => {
    const file = new File([new Uint8Array([0x47, 0x49, 0x46])], 'anim.gif', { type: 'image/gif' });
    const out = await prepareForUpload(file);
    expect(out.blob).toBe(file);
    expect(out.mimeType).toBe('image/gif');
    expect(out.fileName).toBe('anim.gif');
  });

  it('passes a non-image (PDF) through untouched', async () => {
    const file = new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' });
    const out = await prepareForUpload(file);
    expect(out.blob).toBe(file);
    expect(out.mimeType).toBe('application/pdf');
  });

  it('passes a video through untouched', async () => {
    const file = new File([new Uint8Array(16)], 'clip.mp4', { type: 'video/mp4' });
    const out = await prepareForUpload(file);
    expect(out.blob).toBe(file);
    expect(out.mimeType).toBe('video/mp4');
    expect(out.width).toBe(0);
  });

  it('falls back to the original image when re-encoding fails', async () => {
    // Stub decode to fail fast (jsdom has no real canvas) → upload the original.
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('unsupported')));
    try {
      const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'photo.jpg', { type: 'image/jpeg' });
      const out = await prepareForUpload(file);
      expect(out.blob).toBe(file);
      expect(out.mimeType).toBe('image/jpeg');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
