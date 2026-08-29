import { describe, it, expect } from 'vitest';
import { tiktokVideoUrl } from '@lib/platforms/tiktok';
import { bareHandle, channelProfileUrl } from '@lib/platforms/profile-urls';

export {};

const VIDEO_ID = '7667872114598333716';

describe('tiktokVideoUrl', () => {
  it('does not double the @ when accountName already carries one', () => {
    // 32 of 36 production TikTok channels store the handle as '@name', which
    // produced https://www.tiktok.com/@@surah.pk/video/... — a 404.
    expect(tiktokVideoUrl('@surah.pk', VIDEO_ID)).toBe(
      `https://www.tiktok.com/@surah.pk/video/${VIDEO_ID}`,
    );
  });

  it('adds the @ when accountName has none', () => {
    expect(tiktokVideoUrl('surah.pk', VIDEO_ID)).toBe(
      `https://www.tiktok.com/@surah.pk/video/${VIDEO_ID}`,
    );
  });

  it('collapses repeated @ prefixes', () => {
    expect(tiktokVideoUrl('@@surah.pk', VIDEO_ID)).toBe(
      `https://www.tiktok.com/@surah.pk/video/${VIDEO_ID}`,
    );
  });

  it('preserves the full 19-digit id without rounding', () => {
    const url = tiktokVideoUrl('@surah.pk', VIDEO_ID);
    expect(url.endsWith(VIDEO_ID)).toBe(true);
    expect(url).not.toContain('7667872114598333000');
  });
});

describe('bareHandle', () => {
  it.each([
    ['@surah.pk', 'surah.pk'],
    ['surah.pk', 'surah.pk'],
    ['@@surah.pk', 'surah.pk'],
    ['  @surah.pk  ', 'surah.pk'],
    ['', ''],
    [null, ''],
    [undefined, ''],
  ])('normalises %p to %p', (input, expected) => {
    expect(bareHandle(input as string | null | undefined)).toBe(expected);
  });
});

describe('channelProfileUrl still strips the @', () => {
  it('builds a single-@ tiktok profile url', () => {
    expect(channelProfileUrl('tiktok', '@surah.pk', null)).toBe('https://www.tiktok.com/@surah.pk');
  });

  it('builds an x profile url with no @', () => {
    expect(channelProfileUrl('x', '@someone', null)).toBe('https://x.com/someone');
  });
});
