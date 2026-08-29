/**
 * Tests for GET /api/platforms/public — the advertisable-platform list the
 * marketing site builds its copy from.
 *
 * The contract that matters here is *omission*: anything not fully `on` must be
 * absent, not merely flagged. A visitor reading the homepage has no channel to
 * grandfather, so listing a paused platform with a caveat is still a promise we
 * can't keep. These tests pin that, plus the rule that the endpoint leaks no
 * ops detail (env var names, reasons, pending-approval states).
 */

import { ALL_PLATFORMS, platformFlagEnvVar } from '@/lib/platforms/availability';
import { GET } from '@/pages/api/platforms/public';

export {};

const CRED_KEYS = [
  'X_CLIENT_ID',
  'X_CLIENT_SECRET',
  'LINKEDIN_CLIENT_ID',
  'LINKEDIN_CLIENT_SECRET',
  'FACEBOOK_APP_ID',
  'FACEBOOK_APP_SECRET',
  'INSTAGRAM_APP_ID',
  'INSTAGRAM_APP_SECRET',
  'THREADS_APP_ID',
  'THREADS_APP_SECRET',
  'TIKTOK_CLIENT_KEY',
  'TIKTOK_CLIENT_SECRET',
  'YOUTUBE_CLIENT_ID',
  'YOUTUBE_CLIENT_SECRET',
  'PINTEREST_APP_ID',
  'PINTEREST_APP_SECRET',
  'GMB_CLIENT_ID',
  'GMB_CLIENT_SECRET',
  'REDDIT_CLIENT_ID',
  'REDDIT_CLIENT_SECRET',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_BOT_TOKEN',
  'TUMBLR_CLIENT_ID',
  'TUMBLR_CLIENT_SECRET',
  'SNAPCHAT_CLIENT_ID',
  'SNAPCHAT_CLIENT_SECRET',
];
const KEYS = [...CRED_KEYS, ...ALL_PLATFORMS.map(platformFlagEnvVar)];

/** The route takes no meaningful context — it reads only process.env. */
async function call(): Promise<{ res: Response; body: any }> {
  const res = await (GET as any)({} as any);
  return { res, body: await res.clone().json() };
}

const names = (body: any) => body.platforms.map((p: any) => p.platform);

describe('GET /api/platforms/public', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // Give the credential-gated platforms their keys so each test starts from
    // "everything is on" and only the flag under test moves.
    for (const k of CRED_KEYS) process.env[k] = 'test-value';
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('lists every platform when all are enabled', async () => {
    const { res, body } = await call();
    expect(res.status).toBe(200);
    expect(names(body).sort()).toEqual([...ALL_PLATFORMS].sort());
  });

  it('returns display name and colour for each platform', async () => {
    const { body } = await call();
    const facebook = body.platforms.find((p: any) => p.platform === 'facebook');
    expect(facebook).toEqual({
      platform: 'facebook',
      displayName: 'Facebook',
      color: '#1877F2',
    });
  });

  it('omits a platform killed with PLATFORM_<NAME>=off', async () => {
    process.env.PLATFORM_TIKTOK = 'off';
    const { body } = await call();
    expect(names(body)).not.toContain('tiktok');
    expect(names(body)).toContain('facebook');
  });

  it('omits a platform paused with connect_off rather than listing it as paused', async () => {
    // This is the Reddit case: approved-pending. The app grandfathers existing
    // channels, but the website must not advertise it to new visitors.
    process.env.PLATFORM_REDDIT = 'connect_off';
    const { body } = await call();
    expect(names(body)).not.toContain('reddit');
  });

  it('omits a platform whose app credentials are missing', async () => {
    delete process.env.TUMBLR_CLIENT_ID;
    delete process.env.TUMBLR_CLIENT_SECRET;
    const { body } = await call();
    expect(names(body)).not.toContain('tumblr');
  });

  it('needs only ONE missing credential to drop a platform', async () => {
    delete process.env.REDDIT_CLIENT_SECRET;
    const { body } = await call();
    expect(names(body)).not.toContain('reddit');
  });

  it('leaks no ops detail — no envVar, reason, state, or message', async () => {
    process.env.PLATFORM_REDDIT = 'connect_off';
    const { body } = await call();
    for (const p of body.platforms) {
      expect(Object.keys(p).sort()).toEqual(['color', 'displayName', 'platform']);
    }
    expect(JSON.stringify(body)).not.toContain('PLATFORM_');
  });

  it('is cacheable and cross-origin readable', async () => {
    const { res } = await call();
    expect(res.headers.get('Cache-Control')).toContain('max-age=300');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });

  it('returns an empty list rather than erroring when everything is off', async () => {
    for (const p of ALL_PLATFORMS) process.env[platformFlagEnvVar(p)] = 'off';
    const { res, body } = await call();
    expect(res.status).toBe(200);
    expect(body.platforms).toEqual([]);
  });
});
