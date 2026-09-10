/**
 * Tests for pre-publish validation (validateForPlatform).
 *
 * Covers:
 *   - Character limits per platform
 *   - Media count limits (maxImages, maxVideos)
 *   - Mixed media disallowed
 *   - minMedia and maxMedia constraints
 *   - Required content check
 *   - Valid post returns no errors
 */

import {
  validateForPlatform,
  validatePlatformContentShape,
  validatePlatformSpecificShape,
  validatePostTypeOverridesShape,
  validateThreadPartsShape,
  validatePostMediaForPlatforms,
  PLATFORM_CHAR_LIMITS,
} from '@/lib/platforms/validation';
import type { PlatformName, PostData, MediaFileData } from '@/lib/platforms/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePost(overrides: Partial<PostData> = {}): PostData {
  return {
    content: overrides.content ?? 'Hello world',
    mediaUrls: overrides.mediaUrls ?? [],
    mediaFiles: overrides.mediaFiles ?? [],
    ...overrides,
  };
}

function makeImage(url = 'https://cdn.test/img.jpg'): MediaFileData {
  return {
    url,
    localPath: '/tmp/img.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1000,
  };
}

function makeVideo(url = 'https://cdn.test/vid.mp4'): MediaFileData {
  return {
    url,
    localPath: '/tmp/vid.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 50000,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateForPlatform', () => {
  describe('character limits', () => {
    it.each<[PlatformName, number]>([
      ['x', 280],
      ['threads', 500],
      ['bluesky', 300],
      ['mastodon', 500],
      ['pinterest', 500],
      ['linkedin', 3000],
      ['instagram', 2200],
      ['tiktok', 2200],
      ['youtube', 5000],
      ['facebook', 63206],
      ['gmb', 1500],
      ['reddit', 40000],
      ['discord', 2000],
      ['telegram', 4096],
    ])('%s has limit of %d characters', (platform, limit) => {
      expect(PLATFORM_CHAR_LIMITS[platform]).toBe(limit);
    });

    it('returns error when content exceeds limit', () => {
      const post = makePost({ content: 'a'.repeat(281) });
      const errors = validateForPlatform(post, 'x');
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('content');
      expect(errors[0].message).toContain('280');
    });

    it('returns no error when content is at limit', () => {
      const post = makePost({ content: 'a'.repeat(280) });
      const errors = validateForPlatform(post, 'x');
      expect(errors).toHaveLength(0);
    });

    it('returns no error when content is under limit', () => {
      const post = makePost({ content: 'hello' });
      const errors = validateForPlatform(post, 'x');
      expect(errors).toHaveLength(0);
    });
  });

  describe('media constraints', () => {
    it('rejects mixed images and videos on X', () => {
      const post = makePost({
        mediaFiles: [makeImage(), makeVideo()],
      });
      const errors = validateForPlatform(post, 'x', 'tweet');
      const mixedError = errors.find((e) => e.message.includes('mixing'));
      expect(mixedError).toBeDefined();
    });

    it('rejects more than 4 images on X tweet', () => {
      const post = makePost({
        mediaFiles: Array.from({ length: 5 }, () => makeImage()),
      });
      const errors = validateForPlatform(post, 'x', 'tweet');
      expect(errors.some((e) => e.message.includes('max 4 images'))).toBe(true);
    });

    it('rejects more than 1 video on X tweet', () => {
      const post = makePost({
        mediaFiles: [makeVideo(), makeVideo()],
      });
      const errors = validateForPlatform(post, 'x', 'tweet');
      expect(errors.some((e) => e.message.includes('max 1 videos'))).toBe(true);
    });

    it('allows carousel mixed media on Instagram', () => {
      const post = makePost({
        mediaFiles: [makeImage(), makeImage(), makeVideo()],
      });
      const errors = validateForPlatform(post, 'instagram', 'carousel');
      const mixedError = errors.find((e) => e.message.includes('mixing'));
      expect(mixedError).toBeUndefined();
    });

    it('enforces minMedia on Instagram carousel', () => {
      const post = makePost({
        mediaFiles: [makeImage()],
      });
      const errors = validateForPlatform(post, 'instagram', 'carousel');
      expect(errors.some((e) => e.message.includes('at least 2'))).toBe(true);
    });

    it('enforces maxMedia on Instagram carousel', () => {
      const post = makePost({
        mediaFiles: Array.from({ length: 11 }, () => makeImage()),
      });
      const errors = validateForPlatform(post, 'instagram', 'carousel');
      expect(errors.some((e) => e.message.includes('max 10'))).toBe(true);
    });

    it('allows up to 20 images in Threads carousel', () => {
      const post = makePost({
        mediaFiles: Array.from({ length: 20 }, () => makeImage()),
      });
      const errors = validateForPlatform(post, 'threads', 'carousel');
      expect(errors.some((e) => e.field === 'media')).toBe(false);
    });

    it('rejects more than 20 in Threads carousel', () => {
      const post = makePost({
        mediaFiles: Array.from({ length: 21 }, () => makeImage()),
      });
      const errors = validateForPlatform(post, 'threads', 'carousel');
      expect(errors.some((e) => e.message.includes('max 20'))).toBe(true);
    });

    it('enforces video-only for TikTok video post type', () => {
      const post = makePost({
        mediaFiles: [makeImage()],
      });
      const errors = validateForPlatform(post, 'tiktok', 'video');
      expect(errors.some((e) => e.message.includes('max 0 images'))).toBe(true);
    });

    it('allows up to 35 images for TikTok photo slideshow', () => {
      const post = makePost({
        mediaFiles: Array.from({ length: 35 }, () => makeImage()),
      });
      const errors = validateForPlatform(post, 'tiktok', 'photo_slideshow');
      expect(errors.filter((e) => e.field === 'media')).toHaveLength(0);
    });

    it('rejects a YouTube video post with no media (required media)', () => {
      const post = makePost({
        content: 'A YouTube video',
        mediaFiles: [],
      });
      const errors = validateForPlatform(post, 'youtube', 'video');
      const mediaErr = errors.find((e) => e.field === 'media');
      expect(mediaErr).toBeDefined();
      expect(mediaErr!.message).toContain('requires a video');
    });

    it('enforces maxImages for Pinterest carousel', () => {
      const post = makePost({
        mediaFiles: Array.from({ length: 6 }, () => makeImage()),
      });
      const errors = validateForPlatform(post, 'pinterest', 'carousel');
      expect(errors.some((e) => e.message.includes('max 5'))).toBe(true);
    });

    it('allows up to 20 images for LinkedIn multi_image', () => {
      const post = makePost({
        mediaFiles: Array.from({ length: 20 }, () => makeImage()),
      });
      const errors = validateForPlatform(post, 'linkedin', 'multi_image');
      expect(errors.filter((e) => e.field === 'media')).toHaveLength(0);
    });

    it('enforces max 1 image for GMB post', () => {
      const post = makePost({
        mediaFiles: [makeImage(), makeImage()],
      });
      const errors = validateForPlatform(post, 'gmb', 'post');
      expect(errors.some((e) => e.message.includes('max 1 images'))).toBe(true);
    });

    it('allows 4 images on Mastodon post', () => {
      const post = makePost({
        mediaFiles: Array.from({ length: 4 }, () => makeImage()),
      });
      const errors = validateForPlatform(post, 'mastodon', 'post');
      expect(errors.filter((e) => e.field === 'media')).toHaveLength(0);
    });

    it('rejects 5 images on Mastodon post', () => {
      const post = makePost({
        mediaFiles: Array.from({ length: 5 }, () => makeImage()),
      });
      const errors = validateForPlatform(post, 'mastodon', 'post');
      expect(errors.some((e) => e.message.includes('max 4 images'))).toBe(true);
    });
  });

  // Google's v4 localPosts API rejects images under 250×250 with a bare
  // "500 Internal error encountered", which the publish worker retried as
  // transient forever (post #1352, a 1075×210 banner via IFTTT). The
  // documented minimum is enforced here instead.
  describe('minimum image dimensions (gmb)', () => {
    it('rejects a GMB image below 250x250', () => {
      const post = makePost({
        mediaFiles: [{ ...makeImage(), width: 1075, height: 210 }],
      });
      const errors = validateForPlatform(post, 'gmb', 'standard');
      expect(errors.some((e) => e.message.includes('at least 250x250'))).toBe(true);
      expect(errors.some((e) => e.message.includes('1075x210'))).toBe(true);
    });

    it('accepts a GMB image at exactly 250x250', () => {
      const post = makePost({
        mediaFiles: [{ ...makeImage(), width: 250, height: 250 }],
      });
      expect(validateForPlatform(post, 'gmb', 'standard')).toEqual([]);
    });

    it('applies the minimum to the typeless (default) GMB post', () => {
      const post = makePost({
        mediaFiles: [{ ...makeImage(), width: 200, height: 200 }],
      });
      expect(validateForPlatform(post, 'gmb').length).toBeGreaterThan(0);
    });

    it('skips images with unknown dimensions', () => {
      const post = makePost({ mediaFiles: [makeImage()] });
      expect(validateForPlatform(post, 'gmb', 'standard')).toEqual([]);
    });

    it('does not apply GMB minimums to other platforms', () => {
      const post = makePost({
        mediaFiles: [{ ...makeImage(), width: 100, height: 100 }],
      });
      expect(validateForPlatform(post, 'facebook', 'post')).toEqual([]);
    });
  });

  describe('required content', () => {
    it('returns error when post has no content and no media', () => {
      const post = makePost({ content: '', mediaFiles: [] });
      const errors = validateForPlatform(post, 'x');
      expect(errors.some((e) => e.message.includes('must have content or media'))).toBe(true);
    });

    it('allows empty content with media', () => {
      const post = makePost({ content: '', mediaFiles: [makeImage()] });
      const errors = validateForPlatform(post, 'x', 'tweet');
      expect(errors.filter((e) => e.field === 'content')).toHaveLength(0);
    });

    it('GMB is exempt from required content check (allows empty)', () => {
      const post = makePost({ content: '', mediaFiles: [] });
      const errors = validateForPlatform(post, 'gmb');
      expect(errors.some((e) => e.message.includes('must have content or media'))).toBe(false);
    });
  });

  describe('falls back to the platform default type for unknown/missing post type', () => {
    it('uses X tweet limits (max 4 images) for an unknown X post type', () => {
      const post = makePost({
        mediaFiles: Array.from({ length: 11 }, () => makeImage()),
      });
      // "mystery_type" isn't an X type → resolves to X's default ('tweet'), not a
      // permissive generic default. This is the fix for the typeless-post gap.
      const errors = validateForPlatform(post, 'x', 'mystery_type');
      expect(errors.some((e) => e.message.includes('max 4 images'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Required media — the regression suite for the YouTube "No video file
  // provided" failure (post #149). A media-required platform must reject a
  // post with no media BEFORE it reaches the platform handler.
  // ---------------------------------------------------------------------------
  describe('required media on media-required platforms', () => {
    const REQUIRED: Array<[PlatformName, string | undefined]> = [
      ['youtube', 'video'],
      ['youtube', 'short'],
      ['youtube', undefined], // typeless — the exact post #149 shape
      ['tiktok', 'video'],
      ['tiktok', undefined],
      ['instagram', 'feed_photo'],
      ['instagram', 'feed_video'],
      ['instagram', 'reel'],
      ['instagram', undefined],
      ['pinterest', 'pin'],
      ['pinterest', 'video_pin'],
      ['pinterest', undefined],
      ['facebook', 'reel'],
      ['facebook', 'story'],
    ];

    it.each(REQUIRED)('rejects %s/%s with no media', (platform, postType) => {
      const post = makePost({ content: 'Has text but no media', mediaFiles: [] });
      const errors = validateForPlatform(post, platform, postType);
      expect(errors.some((e) => e.field === 'media')).toBe(true);
    });

    it('produces a clear "requires a video" message for a typeless YouTube post (post #149)', () => {
      const post = makePost({ content: '🍽️ Kung Pao Chicken Fajitas', mediaFiles: [] });
      const errors = validateForPlatform(post, 'youtube');
      const mediaErr = errors.find((e) => e.field === 'media');
      expect(mediaErr?.message).toMatch(/requires a video/i);
    });

    it('accepts a YouTube post once a video is attached', () => {
      const post = makePost({ content: 'A real video', mediaFiles: [makeVideo()] });
      const errors = validateForPlatform(post, 'youtube', 'video');
      expect(errors.filter((e) => e.field === 'media')).toHaveLength(0);
    });

    it('rejects an image attached to a YouTube video post', () => {
      const post = makePost({ content: 'wrong media type', mediaFiles: [makeImage()] });
      const errors = validateForPlatform(post, 'youtube', 'video');
      expect(errors.some((e) => e.message.includes('max 0 images'))).toBe(true);
    });
  });

  describe('text-friendly platforms still allow text-only posts', () => {
    it.each<PlatformName>(['x', 'facebook', 'threads', 'bluesky', 'linkedin', 'mastodon', 'gmb'])(
      '%s allows a text-only post (no media error)',
      (platform) => {
        const post = makePost({ content: 'Just text, no media', mediaFiles: [] });
        const errors = validateForPlatform(post, platform);
        expect(errors.filter((e) => e.field === 'media')).toHaveLength(0);
      },
    );
  });

  describe('base post types accept native video (handlers branch on mime type)', () => {
    it.each<[PlatformName, string]>([
      ['x', 'tweet'],
      ['facebook', 'post'],
      ['bluesky', 'post'],
      ['linkedin', 'post'],
      ['mastodon', 'post'],
    ])('%s/%s accepts a single video', (platform, postType) => {
      const post = makePost({ content: 'video post', mediaFiles: [makeVideo()] });
      const errors = validateForPlatform(post, platform, postType);
      expect(errors.filter((e) => e.field === 'media')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Drift guard — ties server validation to each handler's own declared
// `mediaRequired`. If a handler config gains a media-required post type, this
// fails until validation enforces it too, preventing the class of drift that
// let post #149 through.
// ---------------------------------------------------------------------------
import '@/lib/platforms/init';
import { getPlatformConfig } from '@/lib/platforms/registry';

describe('validation stays consistent with handler configs (drift guard)', () => {
  const PLATFORMS: PlatformName[] = [
    'facebook', 'instagram', 'x', 'tiktok', 'youtube',
    'threads', 'bluesky', 'pinterest', 'gmb', 'linkedin', 'mastodon',
    'reddit', 'discord', 'telegram',
  ];

  it.each(PLATFORMS)('every media-required post type in the %s handler is enforced by validation', (platform) => {
    const config = getPlatformConfig(platform);
    for (const pt of config.postTypes) {
      if (!pt.mediaRequired) continue;
      const errors = validateForPlatform(
        { content: 'text only', mediaUrls: [], mediaFiles: [] },
        platform,
        pt.value,
      );
      expect(
        errors.some((e) => e.field === 'media'),
        `${platform}/${pt.value} is mediaRequired in the handler config but validation accepts zero media`,
      ).toBe(true);
    }
  });
});

describe('validatePlatformContentShape', () => {
  it('accepts undefined, null, an empty object, and a flat string map', () => {
    expect(validatePlatformContentShape(undefined)).toBeNull();
    expect(validatePlatformContentShape(null)).toBeNull();
    expect(validatePlatformContentShape({})).toBeNull();
    expect(validatePlatformContentShape({ youtube: 'A caption', tiktok: '' })).toBeNull();
  });

  it('rejects a nested-object value (prod regression: {"youtube": {"content": ...}})', () => {
    const err = validatePlatformContentShape({ youtube: { content: 'clip #fyp' } });
    expect(err).toMatch(/platformContent\.youtube must be a string, got object/);
  });

  it('rejects array, number, and null values, naming the offending platform', () => {
    expect(validatePlatformContentShape({ tiktok: ['a'] })).toMatch(/platformContent\.tiktok must be a string, got array/);
    expect(validatePlatformContentShape({ x: 42 })).toMatch(/platformContent\.x must be a string, got number/);
    expect(validatePlatformContentShape({ facebook: null })).toMatch(/platformContent\.facebook must be a string/);
  });

  it('rejects a non-object platformContent outright', () => {
    expect(validatePlatformContentShape('caption')).toMatch(/must be an object/);
    expect(validatePlatformContentShape(['caption'])).toMatch(/must be an object/);
  });
});

describe('validateThreadPartsShape', () => {
  it('accepts absent inputs and well-formed parts', () => {
    expect(validateThreadPartsShape(undefined, undefined)).toBeNull();
    expect(validateThreadPartsShape(null, null)).toBeNull();
    expect(validateThreadPartsShape(
      [{ content: 'part 1' }, { content: 'part 2', mediaFileIds: [1] }],
      { x: [{ content: 'x part 1' }, { content: 'x part 2' }] },
    )).toBeNull();
  });

  it('rejects a non-string part content, naming the index', () => {
    expect(validateThreadPartsShape([{ content: { text: 'nested' } }], undefined))
      .toMatch(/threadParts\[0\]\.content must be a string, got object/);
    expect(validateThreadPartsShape([{ content: 'ok' }, { content: 42 }], undefined))
      .toMatch(/threadParts\[1\]\.content must be a string, got number/);
  });

  it('rejects malformed per-platform parts, naming the platform', () => {
    expect(validateThreadPartsShape(undefined, { x: [{ content: ['a'] }] }))
      .toMatch(/platformThreadParts\.x\[0\]\.content must be a string, got array/);
    expect(validateThreadPartsShape(undefined, { x: 'not-an-array' }))
      .toMatch(/platformThreadParts\.x must be an array/);
    expect(validateThreadPartsShape(undefined, ['not-a-map']))
      .toMatch(/platformThreadParts must be an object/);
  });

  it('rejects non-object entries and non-array threadParts', () => {
    expect(validateThreadPartsShape(['just a string'], undefined))
      .toMatch(/threadParts\[0\] must be an object/);
    expect(validateThreadPartsShape('not-an-array', undefined))
      .toMatch(/threadParts must be an array/);
  });
});

describe('validatePlatformSpecificShape', () => {
  it('accepts absent input, empty objects, and every documented TikTok privacy level', () => {
    expect(validatePlatformSpecificShape(undefined)).toBeNull();
    expect(validatePlatformSpecificShape(null)).toBeNull();
    expect(validatePlatformSpecificShape({})).toBeNull();
    expect(validatePlatformSpecificShape({ youtube: { title: 'T' } })).toBeNull();
    for (const level of ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY']) {
      expect(validatePlatformSpecificShape({ tiktok: { privacyLevel: level } })).toBeNull();
    }
  });

  it('requires Tumblr tags to be strings, in an array or comma-separated', () => {
    expect(validatePlatformSpecificShape({ tumblr: { tags: ['a', 'b'] } })).toBeNull();
    expect(validatePlatformSpecificShape({ tumblr: { tags: 'a,b' } })).toBeNull();
    expect(validatePlatformSpecificShape({ tumblr: { 7: { tags: ['a'] } } })).toBeNull();
    expect(validatePlatformSpecificShape({ tumblr: { tags: 42 } })).toMatch(/tumblr\.tags must be an array of strings/);
    expect(validatePlatformSpecificShape({ tumblr: { tags: [1] } })).toMatch(/tumblr\.tags/);
    expect(validatePlatformSpecificShape({ tumblr: { 7: { tags: { a: 1 } } } })).toMatch(/tumblr\.7\.tags/);
  });

  it('rejects SEND_TO_USER_INBOX: a TikTok publish status, not a privacy level', () => {
    expect(validatePlatformSpecificShape({ tiktok: { privacyLevel: 'SEND_TO_USER_INBOX' } })).toMatch(/privacyLevel/);
  });

  it('rejects an unknown TikTok privacy level with a did-you-mean hint (prod regression: "PUBLIC")', () => {
    const err = validatePlatformSpecificShape({ tiktok: { privacyLevel: 'PUBLIC' } });
    expect(err).toMatch(/privacyLevel must be one of/);
    expect(err).toMatch(/Did you mean "PUBLIC_TO_EVERYONE"\?/);
    expect(validatePlatformSpecificShape({ tiktok: { privacyLevel: 'private' } }))
      .toMatch(/Did you mean "SELF_ONLY"\?/);
  });

  it('rejects a non-string privacyLevel and a non-object platformSpecific', () => {
    expect(validatePlatformSpecificShape({ tiktok: { privacyLevel: 42 } }))
      .toMatch(/privacyLevel must be one of/);
    expect(validatePlatformSpecificShape(['nope'])).toMatch(/must be an object/);
  });

  it('leaves unknown keys and other platforms untouched', () => {
    expect(validatePlatformSpecificShape({ tiktok: { somethingNew: true }, x: { replySettings: 'everyone' } })).toBeNull();
  });

  it('rejects invalid YouTube privacyStatus, X replySettings, GMB ctaType, IG graduationStrategy', () => {
    expect(validatePlatformSpecificShape({ youtube: { privacyStatus: 'Public' } }))
      .toMatch(/youtube\.privacyStatus must be one of: public, unlisted, private\. Did you mean "public"\?/);
    expect(validatePlatformSpecificShape({ x: { replySettings: 'nobody' } }))
      .toMatch(/x\.replySettings must be one of: everyone, following, verified, subscribers, mentionedUsers/);
    expect(validatePlatformSpecificShape({ gmb: { ctaType: 'LEARNMORE' } }))
      .toMatch(/Did you mean "LEARN_MORE"\?/);
    expect(validatePlatformSpecificShape({ instagram: { graduationStrategy: 'AUTO' } }))
      .toMatch(/Did you mean "auto"\?/);
  });

  it('accepts every valid value of the newly gated enums', () => {
    for (const v of ['public', 'unlisted', 'private']) {
      expect(validatePlatformSpecificShape({ youtube: { privacyStatus: v } })).toBeNull();
    }
    for (const v of ['everyone', 'following', 'verified', 'subscribers', 'mentionedUsers']) {
      expect(validatePlatformSpecificShape({ x: { replySettings: v } })).toBeNull();
    }
    for (const v of ['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL']) {
      expect(validatePlatformSpecificShape({ gmb: { ctaType: v } })).toBeNull();
    }
    expect(validatePlatformSpecificShape({ instagram: { graduationStrategy: 'manual' } })).toBeNull();
    expect(validatePlatformSpecificShape({ instagram: { graduationStrategy: 'auto' } })).toBeNull();
  });

  describe('URL-typed fields (SSRF front door)', () => {
    it('accepts public https URLs on every gated field', () => {
      expect(validatePlatformSpecificShape({ youtube: { thumbnailUrl: 'https://cdn.example.com/t.jpg' } })).toBeNull();
      expect(validatePlatformSpecificShape({ reddit: { thumbnailUrl: 'https://cdn.example.com/t.png' } })).toBeNull();
      expect(validatePlatformSpecificShape({ pinterest: { coverImageUrl: 'https://cdn.example.com/c.jpg' } })).toBeNull();
      expect(validatePlatformSpecificShape({ gmb: { ctaUrl: 'https://example.com/book', redeemOnlineUrl: 'https://example.com/deal' } })).toBeNull();
      // Empty string means "unset" in the composer — allowed
      expect(validatePlatformSpecificShape({ youtube: { thumbnailUrl: '' } })).toBeNull();
    });

    it('rejects junk, non-http schemes, and non-string values', () => {
      expect(validatePlatformSpecificShape({ youtube: { thumbnailUrl: 'not a url' } }))
        .toMatch(/youtube\.thumbnailUrl is not a valid URL/);
      expect(validatePlatformSpecificShape({ reddit: { thumbnailUrl: 'file:///etc/passwd' } }))
        .toMatch(/must be an http\(s\) URL/);
      expect(validatePlatformSpecificShape({ pinterest: { coverImageUrl: 42 } }))
        .toMatch(/must be a URL string/);
    });

    it('rejects localhost and private-range literals (internal hosts never valid here)', () => {
      for (const bad of [
        'http://localhost/x.jpg',
        'http://127.0.0.1/x.jpg',
        'http://10.0.0.5/x.jpg',
        'http://172.16.0.1/x.jpg',
        'http://192.168.1.1/x.jpg',
        'http://169.254.169.254/latest/meta-data',
        'http://100.64.0.1/x.jpg',
        'http://redis.internal/x.jpg',
        'http://[::1]/x.jpg',
      ]) {
        expect(validatePlatformSpecificShape({ youtube: { thumbnailUrl: bad } }))
          .toMatch(/publicly reachable host/);
      }
    });
  });
});

describe('validatePostTypeOverridesShape', () => {
  it('accepts absent input and every real post type', () => {
    expect(validatePostTypeOverridesShape(undefined)).toBeNull();
    expect(validatePostTypeOverridesShape(null)).toBeNull();
    expect(validatePostTypeOverridesShape({})).toBeNull();
    expect(validatePostTypeOverridesShape({ instagram: 'story', youtube: 'short', tiktok: 'photo_slideshow', linkedin: 'pdf_carousel' })).toBeNull();
  });

  it('accepts what the composer actually sends for the Thread format (regression guard)', () => {
    // Thread is a cross-platform pseudo-type — threads/bluesky/mastodon have no
    // MEDIA_CONSTRAINTS entry for it, and rejecting it would 400 every
    // composer thread post targeting them.
    expect(validatePostTypeOverridesShape({ x: 'thread', threads: 'thread', bluesky: 'thread', mastodon: 'thread' })).toBeNull();
    expect(validatePostTypeOverridesShape({ reddit: 'default' })).toBeNull();
    expect(validatePostTypeOverridesShape({ facebook: '' })).toBeNull();
  });

  it('rejects a type the platform does not offer, with a case hint', () => {
    expect(validatePostTypeOverridesShape({ instagram: 'Story' }))
      .toMatch(/postTypeOverrides\.instagram must be one of: .*story.*\. Did you mean "story"\?/);
    expect(validatePostTypeOverridesShape({ youtube: 'reel' }))
      .toMatch(/postTypeOverrides\.youtube must be one of: video, short/);
    expect(validatePostTypeOverridesShape({ x: 42 }))
      .toMatch(/postTypeOverrides\.x must be one of/);
  });

  it('ignores unknown platform keys and rejects a non-object input', () => {
    expect(validatePostTypeOverridesShape({ snapchat: 'story' })).toBeNull();
    expect(validatePostTypeOverridesShape(['story'])).toMatch(/must be an object/);
  });
});

describe('validatePostMediaForPlatforms — image dimensions', () => {
  it('passes width/height through to the per-platform gate (gmb undersized)', () => {
    const errors = validatePostMediaForPlatforms({
      content: 'hello',
      media: [{ mimeType: 'image/jpeg', width: 1075, height: 210 }],
      platforms: ['gmb'],
    });
    expect(errors.some((e) => e.message.includes('at least 250x250'))).toBe(true);
  });

  it('does not flag media without dimensions', () => {
    const errors = validatePostMediaForPlatforms({
      content: 'hello',
      media: [{ mimeType: 'image/jpeg', width: null, height: null }],
      platforms: ['gmb'],
    });
    expect(errors).toEqual([]);
  });
});

export {};
