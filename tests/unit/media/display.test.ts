/**
 * Tests webapp/src/lib/media/display.ts — the size-aware derivative picker.
 *
 * The two rules under test are the ones that caused real bugs:
 *   - a video's originalUrl must NEVER be returned for an <img> (Safari
 *     downloaded whole mp4s into 48px tiles and killed the page for memory)
 *   - large surfaces must not be handed a 160px thumbnail (visible blur)
 */
import { describe, it, expect } from 'vitest';
import {
  mediaImageUrl,
  mediaVideoUrl,
  mediaPosterUrl,
  type MediaLike,
} from '@/lib/media/display';

const IMAGE: MediaLike = {
  mimeType: 'image/jpeg',
  originalUrl: 'https://cdn/original.jpg',
  thumbnailUrl: 'https://cdn/thumb.webp',
  previewUrl: 'https://cdn/preview.webp',
  largeUrl: 'https://cdn/large.webp',
};

const VIDEO: MediaLike = {
  mimeType: 'video/mp4',
  originalUrl: 'https://cdn/clip.mp4',
  thumbnailUrl: 'https://cdn/vthumb.webp',
  previewUrl: 'https://cdn/vpreview.webp',
  largeUrl: 'https://cdn/vlarge.webp',
};

describe('mediaImageUrl', () => {
  it('picks the derivative matching the requested size for images', () => {
    expect(mediaImageUrl(IMAGE, 'thumb')).toBe('https://cdn/thumb.webp');
    expect(mediaImageUrl(IMAGE, 'preview')).toBe('https://cdn/preview.webp');
    expect(mediaImageUrl(IMAGE, 'large')).toBe('https://cdn/large.webp');
  });

  it('opens the original only for `full` — the deliberate single-item view', () => {
    expect(mediaImageUrl(IMAGE, 'full')).toBe('https://cdn/original.jpg');
  });

  it('prefers a derivative over the original for inline large surfaces', () => {
    // Several of these can be on screen at once; the original is too heavy.
    expect(mediaImageUrl({ ...IMAGE, largeUrl: null }, 'large')).toBe('https://cdn/preview.webp');
  });

  it('falls back through the chain when derivatives are missing', () => {
    expect(mediaImageUrl({ ...IMAGE, thumbnailUrl: null }, 'thumb')).toBe('https://cdn/preview.webp');
    expect(
      mediaImageUrl({ ...IMAGE, thumbnailUrl: null, previewUrl: null, largeUrl: null }, 'thumb'),
    ).toBe('https://cdn/original.jpg');
  });

  it('never returns the original for a video, at any size', () => {
    for (const size of ['thumb', 'preview', 'large', 'full'] as const) {
      expect(mediaImageUrl(VIDEO, size)).not.toBe('https://cdn/clip.mp4');
    }
  });

  it('returns null for a video with no poster rather than the media file', () => {
    const noPoster: MediaLike = {
      mimeType: 'video/mp4',
      originalUrl: 'https://cdn/clip.mp4',
      thumbnailUrl: null,
      previewUrl: null,
      largeUrl: null,
    };
    expect(mediaImageUrl(noPoster, 'thumb')).toBeNull();
    expect(mediaImageUrl(noPoster, 'full')).toBeNull();
  });

  it('picks the size-appropriate poster for a video', () => {
    expect(mediaImageUrl(VIDEO, 'thumb')).toBe('https://cdn/vthumb.webp');
    expect(mediaImageUrl(VIDEO, 'preview')).toBe('https://cdn/vpreview.webp');
    expect(mediaImageUrl(VIDEO, 'large')).toBe('https://cdn/vlarge.webp');
  });

  it('ignores the original once it has been swept', () => {
    const swept = { ...IMAGE, isOriginalDeleted: true };
    expect(mediaImageUrl(swept, 'full')).toBe('https://cdn/large.webp');
    expect(
      mediaImageUrl({ ...swept, thumbnailUrl: null, previewUrl: null, largeUrl: null }, 'full'),
    ).toBeNull();
  });

  it('handles null/undefined media', () => {
    expect(mediaImageUrl(null, 'thumb')).toBeNull();
    expect(mediaImageUrl(undefined, 'large')).toBeNull();
  });
});

describe('mediaVideoUrl', () => {
  it('returns the real file for playback', () => {
    expect(mediaVideoUrl(VIDEO)).toBe('https://cdn/clip.mp4');
  });

  it('returns null for images and for swept originals', () => {
    expect(mediaVideoUrl(IMAGE)).toBeNull();
    expect(mediaVideoUrl({ ...VIDEO, isOriginalDeleted: true })).toBeNull();
  });
});

describe('mediaPosterUrl', () => {
  it('gives a video its largest poster, and images nothing', () => {
    expect(mediaPosterUrl(VIDEO)).toBe('https://cdn/vlarge.webp');
    expect(mediaPosterUrl(IMAGE)).toBeUndefined();
  });

  it('is undefined when a video has no poster yet', () => {
    expect(
      mediaPosterUrl({ mimeType: 'video/mp4', originalUrl: 'https://cdn/clip.mp4' }),
    ).toBeUndefined();
  });
});

export {};
