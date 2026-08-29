/**
 * PUSH_PLATFORMS drift guard.
 *
 * The publish worker only downloads R2 media to local temp files for platforms
 * listed in `PUSH_PLATFORMS`. Every other platform gets `localPath` still set to
 * an **R2 key**, not a filesystem path.
 *
 * So a handler that reads bytes off disk (readFileSync / readFile /
 * createReadStream on `media.localPath`) and is NOT in that set fails at publish
 * time with ENOENT — for every post with media, in production only. Unit tests
 * can't catch it: they mock `node:fs`, so the read always "succeeds".
 *
 * That is exactly how the Tumblr handler shipped broken. This test ties the two
 * sources together statically — no module loading, no mocks — so the next
 * push-based platform can't repeat it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export {};

const PLATFORMS_DIR = join(process.cwd(), 'src/lib/platforms');
const WORKER_PATH = join(process.cwd(), 'src/lib/jobs/publish.worker.ts');

/** Non-handler modules that live alongside the platform handlers. */
const NOT_HANDLERS = new Set([
  'base.ts', 'types.ts', 'registry.ts', 'init.ts', 'validation.ts',
  'availability.ts', 'auth-errors.ts', 'profile-urls.ts', 'x-usage.ts',
]);

/** Parse the `PUSH_PLATFORMS = new Set<PlatformName>([...])` literal from the worker source. */
function readPushPlatforms(): Set<string> {
  const source = readFileSync(WORKER_PATH, 'utf8');
  const match = source.match(/const PUSH_PLATFORMS = new Set<PlatformName>\(\[([^\]]*)\]\)/);
  if (!match) throw new Error('Could not find the PUSH_PLATFORMS literal in publish.worker.ts');
  return new Set([...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

/** Handlers that read media bytes off the local filesystem. */
function handlersReadingFromDisk(): string[] {
  const found: string[] = [];
  for (const file of readdirSync(PLATFORMS_DIR)) {
    if (!file.endsWith('.ts') || NOT_HANDLERS.has(file)) continue;
    const source = readFileSync(join(PLATFORMS_DIR, file), 'utf8');
    // A disk read whose argument mentions localPath — the exact combination that
    // requires the worker to have materialized the file first.
    const readsLocalPath = /(readFileSync|readFile|createReadStream)\s*\(\s*[^)]*localPath/.test(source);
    if (readsLocalPath) found.push(file.replace(/\.ts$/, ''));
  }
  return found;
}

describe('PUSH_PLATFORMS covers every handler that reads media from disk', () => {
  const pushPlatforms = readPushPlatforms();
  const diskReaders = handlersReadingFromDisk();

  it('finds the known push-based handlers (guards the detector itself)', () => {
    // If this fails, the detector regex broke — fix it before trusting the test below.
    expect(diskReaders).toEqual(
      expect.arrayContaining(['x', 'linkedin', 'bluesky', 'mastodon', 'youtube', 'tumblr']),
    );
  });

  for (const platform of handlersReadingFromDisk()) {
    it(`${platform} reads media from disk, so it must be in PUSH_PLATFORMS`, () => {
      expect(pushPlatforms.has(platform)).toBe(true);
    });
  }

  it('lists only real platform handlers', () => {
    const handlerNames = readdirSync(PLATFORMS_DIR)
      .filter((f) => f.endsWith('.ts') && !NOT_HANDLERS.has(f))
      .map((f) => f.replace(/\.ts$/, ''));
    for (const p of pushPlatforms) {
      expect(handlerNames).toContain(p);
    }
  });
});
