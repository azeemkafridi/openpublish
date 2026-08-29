/**
 * Platform-list drift guard.
 *
 * Adding a platform means touching many parallel lists. Most are
 * `Record<Platform, X>` maps, and those are safe: `tsc` fails the build the
 * moment a key is missing. But a few are **arrays**, and an array has no
 * exhaustiveness check — omit an entry and it compiles, type-checks, and passes
 * every test, while the platform is simply invisible in the UI.
 *
 * That is exactly how Tumblr shipped without appearing in the connect grid:
 * `ChannelList.PLATFORMS` is a `PlatformOption[]`, so nothing forced it to be
 * listed. Availability resolved correctly, the API returned it, the icon
 * existed — the grid just never rendered a card for it.
 *
 * This test ties the array-shaped lists back to ALL_PLATFORMS.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_PLATFORMS } from '@/lib/platforms/availability';
import { PLATFORMS as CONNECT_GRID } from '@components/channels/ChannelList';

export {};

describe('every platform is reachable in the UI', () => {
  it('the connect grid lists every known platform', () => {
    const listed = CONNECT_GRID.map((p) => p.key).sort();
    // Compare as sorted lists so the failure message names the missing platform.
    expect(listed).toEqual([...ALL_PLATFORMS].sort());
  });

  it('the connect grid has no duplicate or unknown entries', () => {
    const keys = CONNECT_GRID.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(ALL_PLATFORMS).toContain(k);
  });

  it('every platform card carries the fields the grid renders', () => {
    for (const p of CONNECT_GRID) {
      expect(p.name, `${p.key} name`).toBeTruthy();
      expect(p.description, `${p.key} description`).toBeTruthy();
      expect(p.accent, `${p.key} accent`).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(p.bg, `${p.key} bg`).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('every platform has a brand icon asset', () => {
    // PlatformIcon renders /assets/platforms/<key>.svg — a missing file is a
    // broken image in the grid, which nothing else in the suite would catch.
    for (const platform of ALL_PLATFORMS) {
      const icon = join(process.cwd(), 'public/assets/platforms', `${platform}.svg`);
      expect(existsSync(icon), `missing icon: public/assets/platforms/${platform}.svg`).toBe(true);
    }
  });

  it('every platform is accepted by the connect route', () => {
    // VALID_PLATFORMS in the connect route is another array-shaped list: a
    // platform missing there gets a 400 from the Connect button.
    const source = readFileSync(
      join(process.cwd(), 'src/pages/api/channels/connect/[platform].ts'),
      'utf8',
    );
    const match = source.match(/const VALID_PLATFORMS = new Set<string>\(\[([^\]]*)\]\)/);
    expect(match, 'could not find VALID_PLATFORMS in the connect route').toBeTruthy();
    const valid = new Set([...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
    for (const platform of ALL_PLATFORMS) {
      expect(valid.has(platform), `connect route rejects: ${platform}`).toBe(true);
    }
  });
});
