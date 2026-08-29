/**
 * UI ↔ server post-type consistency (drift guard).
 *
 * The compose UI (PostTypeSelector.PLATFORM_POST_TYPES) and the server
 * validator (validateForPlatform) keep SEPARATE copies of each platform's
 * post-type media rules. They must agree on the media-required invariant:
 *   - if the UI marks a post type `mediaRequired`, the server must reject a
 *     zero-media post of that type, and
 *   - the platform's default post type (used for typeless posts — the exact
 *     shape of post #149) must agree on whether media is required.
 *
 * This is the cross-layer check that stops the two copies from drifting the
 * way validation.ts had drifted from reality when the YouTube bug shipped.
 * (A separate guard in validation.test.ts ties the server to the handler
 * configs; together they pin all three sources of truth.)
 */
import { PLATFORM_POST_TYPES, PLATFORM_DEFAULTS } from '@components/compose/PostTypeSelector';
import { validateForPlatform } from '@/lib/platforms/validation';
import type { PlatformName, PostData } from '@/lib/platforms/types';

function textOnlyPost(): PostData {
  return { content: 'text only, no media attached', mediaUrls: [], mediaFiles: [] };
}

describe('UI post types stay consistent with server validation', () => {
  const platforms = Object.keys(PLATFORM_POST_TYPES) as PlatformName[];

  for (const platform of platforms) {
    const types = PLATFORM_POST_TYPES[platform]!;

    for (const pt of types) {
      if (!pt.mediaRequired) continue;
      it(`server rejects a zero-media ${platform}/${pt.value} (UI marks it mediaRequired)`, () => {
        const errors = validateForPlatform(textOnlyPost(), platform, pt.value);
        expect(errors.some((e) => e.field === 'media')).toBe(true);
      });
    }

    // The default post type drives the typeless-post path (postTypeOverrides
    // empty → e.g. post #149). UI and server must agree on whether it needs media.
    it(`${platform} default post type agrees with server on requiring media`, () => {
      const def = PLATFORM_DEFAULTS[platform];
      const uiRequiresMedia = !!types.find((t) => t.value === def)?.mediaRequired;
      const serverRequiresMedia = validateForPlatform(textOnlyPost(), platform, def)
        .some((e) => e.field === 'media');
      expect(serverRequiresMedia).toBe(uiRequiresMedia);
    });
  }
});

export {};
