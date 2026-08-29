/**
 * Platform coverage across the compose UI's per-platform tables (drift guard).
 *
 * Every table below is keyed by platform, and every one of them had stopped at
 * `mastodon` — the four platforms that shipped afterwards (reddit, discord,
 * telegram, tumblr) were absent from all of them. None failed loudly:
 *
 *   - POST_FORMATS.supportedPlatforms  → dropped from the format bar's platform
 *                                        row and from `disabledPlatforms`
 *   - PLATFORM_MAX_MEDIA               → fell back to the generic cap, letting a
 *                                        user attach more files than the platform takes
 *   - ComposeSidebar's reference panel → the platform simply never appeared
 *   - PLATFORM_BADGE_COLORS            → notification chips render nothing at all
 *
 * The tests assert coverage, and — for the format bar — that we never claim a
 * format the SERVER would reject, which is the direction that actually hurts.
 */
import { POST_FORMATS } from '@components/compose/PostFormatBar';
import { PLATFORM_MAX_MEDIA, CHAR_LIMITS } from '@components/compose/Composer';
import { PLATFORM_SPECS } from '@components/layout/ComposeSidebar';
import { PLATFORM_BADGE_COLORS } from '@components/channels/PlatformBadge';
import { PLATFORM_POST_TYPES } from '@components/compose/PostTypeSelector';
import { THREAD_PLATFORMS } from '@/lib/platforms/thread-support';
import { ALL_PLATFORMS, platformDisplayName } from '@/lib/platforms/types';
import { validateForPlatform } from '@/lib/platforms/validation';
import type { PlatformName, PostData } from '@/lib/platforms/types';

describe('every platform is represented in the compose UI tables', () => {
  it.each(ALL_PLATFORMS)('%s has a character limit', (platform) => {
    expect(typeof CHAR_LIMITS[platform]).toBe('number');
  });

  it.each(ALL_PLATFORMS)('%s has a media cap', (platform) => {
    expect(typeof PLATFORM_MAX_MEDIA[platform]).toBe('number');
  });

  it.each(ALL_PLATFORMS)('%s appears in the compose reference panel', (platform) => {
    const spec = PLATFORM_SPECS.find((s) => s.platform === platform);
    expect(spec, `ComposeSidebar has no row for "${platform}"`).toBeDefined();
    expect(spec!.label).toBe(platformDisplayName(platform));
    expect(spec!.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it.each(ALL_PLATFORMS)('%s has notification badge colours', (platform) => {
    expect(PLATFORM_BADGE_COLORS[platform]).toBeDefined();
  });

  it.each(ALL_PLATFORMS)('%s is offered by at least one post format', (platform) => {
    const formats = POST_FORMATS.filter((f) => f.supportedPlatforms.includes(platform));
    expect(formats.length, `no post format offers "${platform}"`).toBeGreaterThan(0);
  });
});

describe('post formats never promise more than the server accepts', () => {
  const cases = POST_FORMATS.flatMap((format) =>
    format.supportedPlatforms.map((platform) => ({ format, platform })),
  );

  it.each(cases)('$format.value on $platform resolves to a real post type', ({ format, platform }) => {
    const postType = format.platformPostTypes[platform];
    expect(postType, `${format.value} lists ${platform} but maps it to no post type`).toBeDefined();
    const offered = PLATFORM_POST_TYPES[platform]?.map((o) => o.value) ?? [];
    expect(offered, `${platform} does not offer post type "${postType}"`).toContain(postType);
  });

  it.each(cases)('$format.value on $platform accepts a text post with one image', ({ format, platform }) => {
    // A format that lists a platform must not be rejected outright by the server
    // for the media shape that format produces. One image is the shape every
    // non-thread format can produce; formats that REQUIRE more (carousel) are
    // checked by minMedia in the composer, not here.
    const post: PostData = {
      content: 'coverage probe',
      mediaUrls: ['https://example.com/a.jpg'],
      mediaFiles: [{ mimeType: 'image/jpeg' } as never],
    };
    const errors = validateForPlatform(post, platform as PlatformName, format.platformPostTypes[platform]);
    const fatal = errors.filter((e) => e.field === 'postType' || e.field === 'platform');
    expect(fatal, JSON.stringify(errors)).toHaveLength(0);
  });
});

describe('threading platforms', () => {
  it('match the Thread format exactly', () => {
    const thread = POST_FORMATS.find((f) => f.value === 'thread')!;
    expect([...thread.supportedPlatforms].sort()).toEqual([...THREAD_PLATFORMS].sort());
  });

  it('each offer a thread post type', () => {
    for (const platform of THREAD_PLATFORMS) {
      const offered = PLATFORM_POST_TYPES[platform]?.map((o) => o.value) ?? [];
      expect(offered, `${platform} is listed as threading but offers no thread type`).toContain('thread');
    }
  });

  it('exclude platforms with no thread support', () => {
    for (const platform of ['reddit', 'discord', 'telegram', 'tumblr', 'youtube'] as const) {
      expect(THREAD_PLATFORMS).not.toContain(platform);
    }
  });
});
