/**
 * Tests for the platform registry.
 *
 * Covers:
 *   - registerPlatform: adds handler to internal map
 *   - getPlatformHandler: returns correct handler, throws for unknown
 *   - getAllPlatforms: returns all registered handlers
 *   - getPlatformConfig: returns config for named platform
 *   - PLATFORM_DISPLAY: display metadata for every platform, and that it agrees
 *     with the canonical name/colour maps AND with each handler's own config —
 *     the registry used to spell Bluesky "BlueSky" and serve a different
 *     Instagram pink than the UI, and the marketing site reads this endpoint.
 */

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

// We need to mock the full init chain so handlers can be instantiated
vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    jpeg: vi.fn().mockReturnThis(),
    resize: vi.fn().mockReturnThis(),
    metadata: vi.fn().mockResolvedValue({ width: 1000, height: 1000 }),
    toBuffer: vi.fn().mockResolvedValue(Buffer.alloc(100)),
  })),
}));

vi.mock('image-to-pdf', () => ({
  default: vi.fn(),
}));

import {
  registerPlatform,
  getPlatformHandler,
  getAllPlatforms,
  getPlatformConfig,
  PLATFORM_DISPLAY,
} from '@/lib/platforms/registry';
import type { PlatformName } from '@/lib/platforms/types';
import {
  ALL_PLATFORMS,
  PLATFORM_DISPLAY_NAMES,
  PLATFORM_BRAND_COLORS,
} from '@/lib/platforms/types';

// Register all platforms (side-effect import)
await import('@/lib/platforms/init');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Platform registry', () => {
  // The shared list, not a local copy — the copy here had gone stale (no tumblr).
  const allPlatformNames: PlatformName[] = ALL_PLATFORMS;

  describe('getPlatformHandler', () => {
    it.each(allPlatformNames)(
      'returns handler for %s',
      (name) => {
        const handler = getPlatformHandler(name);
        expect(handler).toBeDefined();
        expect(handler.name).toBe(name);
      },
    );

    it('throws for unknown platform', () => {
      expect(() => getPlatformHandler('fakeplatform' as PlatformName)).toThrow(
        /not registered/,
      );
    });
  });

  describe('getAllPlatforms', () => {
    it('returns all 14 registered handlers', () => {
      const all = getAllPlatforms();
      expect(all.length).toBeGreaterThanOrEqual(11);
      const names = all.map((h) => h.name);
      for (const name of allPlatformNames) {
        expect(names).toContain(name);
      }
    });
  });

  describe('getPlatformConfig', () => {
    it('returns config with required fields', () => {
      const config = getPlatformConfig('instagram');
      expect(config.name).toBe('instagram');
      expect(config.displayName).toBe('Instagram');
      expect(config.authType).toBe('oauth');
      expect(config.postTypes.length).toBeGreaterThan(0);
      expect(config.mediaRules).toBeDefined();
    });
  });

  describe('PLATFORM_DISPLAY', () => {
    it.each(allPlatformNames)('%s has well-formed display metadata', (name) => {
      expect(PLATFORM_DISPLAY[name]).toBeDefined();
      expect(PLATFORM_DISPLAY[name].displayName).toBeTruthy();
      expect(PLATFORM_DISPLAY[name].color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    });

    it.each(allPlatformNames)('%s matches the canonical name and colour', (name) => {
      expect(PLATFORM_DISPLAY[name].displayName).toBe(PLATFORM_DISPLAY_NAMES[name]);
      expect(PLATFORM_DISPLAY[name].color).toBe(PLATFORM_BRAND_COLORS[name]);
    });

    // base.ts puts config.displayName straight into user-facing error strings
    // ("<X> does not support threads"), so a handler that disagrees with the
    // rest of the UI shows the user two different names for one platform.
    it.each(allPlatformNames)('%s handler config agrees with the canonical name', (name) => {
      expect(getPlatformConfig(name).displayName).toBe(PLATFORM_DISPLAY_NAMES[name]);
    });
  });
});
