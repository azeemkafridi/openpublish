/**
 * Regression tests for the data-wiring audit (2026-07-28).
 *
 * The recurring bug shape: a platform API's DEFAULT silently filters what it
 * returns (toplevel-only comments, a page limit), so one surface shows fewer
 * items than another surface showing the same concept. These tests pin the
 * request shape and the truncation flags, not just the happy path.
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

vi.mock('@/lib/auth/crypto', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { LinkedInHandler } = await import('@/lib/platforms/linkedin');
const { InstagramHandler } = await import('@/lib/platforms/instagram');
const { postMetricsSupported, METRICS_SUPPORTED_PLATFORMS } = await import(
  '@/lib/platforms/metrics-support'
);
import type { ChannelData } from '@/lib/platforms/types';

function mockJson(body: unknown) {
  mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify(body) });
}

function channel(platform: string, overrides: Partial<ChannelData> = {}): ChannelData {
  return {
    id: 1,
    platform: platform as ChannelData['platform'],
    accountId: 'acct-1',
    accountName: 'Test',
    accessToken: 'token',
    organizationId: 1,
    ...overrides,
  } as ChannelData;
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('LinkedIn getPostEngagement — nested replies', () => {
  it('fetches each comment\'s own replies and nests them via parentId', async () => {
    const handler = new LinkedInHandler();

    // 1) top-level comments
    mockJson({
      elements: [
        {
          $URN: 'urn:li:comment:(urn:li:share:abc,111)',
          actor: 'urn:li:person:p1',
          message: { text: 'Top level' },
          created: { time: 1700000000000 },
        },
      ],
      paging: { total: 1 },
    });
    // 2) resolve p1
    mockJson({ localizedFirstName: 'Jane', localizedLastName: 'Doe', vanityName: 'janedoe' });
    // 3) replies to comment 111
    mockJson({
      elements: [
        {
          $URN: 'urn:li:comment:(urn:li:share:abc,222)',
          actor: 'urn:li:person:p1',
          message: { text: 'A reply' },
          created: { time: 1700000010000 },
        },
      ],
    });
    // 4) reactions
    mockJson({ elements: [], paging: { total: 0 } });

    const result = await handler.getPostEngagement(
      channel('linkedin', { accountType: 'organization' }),
      'urn:li:share:abc',
    );

    expect(result.comments).toHaveLength(2);
    expect(result.comments[0].parentId).toBeUndefined();
    // The reply would have been invisible before: /socialActions/{post}/comments
    // returns top-level comments only.
    expect(result.comments[1].text).toBe('A reply');
    expect(result.comments[1].parentId).toBe('urn:li:comment:(urn:li:share:abc,111)');

    const replyCall = mockFetch.mock.calls[2][0] as string;
    expect(replyCall).toContain('/socialActions/');
    expect(replyCall).toContain(encodeURIComponent('urn:li:comment:(urn:li:share:abc,111)'));
  });

  it('keeps the top-level comment when its replies call fails', async () => {
    const handler = new LinkedInHandler();
    mockJson({
      elements: [
        { $URN: 'urn:li:comment:(x,1)', actor: 'urn:li:person:p1', message: { text: 'Only me' } },
      ],
      paging: { total: 1 },
    });
    mockJson({ localizedFirstName: 'Jane', localizedLastName: 'Doe' });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => '{}' });
    mockJson({ elements: [], paging: { total: 0 } });

    const result = await handler.getPostEngagement(
      channel('linkedin', { accountType: 'organization' }),
      'urn:li:share:abc',
    );
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].text).toBe('Only me');
  });
});

describe('Instagram getPostEngagement — truncation flag', () => {
  it('reports hasMoreComments when replies exhaust the limit, even with no next page', async () => {
    const handler = new InstagramHandler();
    // 2 top-level comments, each with 2 replies = 6 items for a limit of 3.
    mockJson({
      data: [
        {
          id: 'c1', text: 'one', username: 'a',
          replies: { data: [{ id: 'r1', text: 'r1', username: 'b' }, { id: 'r2', text: 'r2', username: 'b' }] },
        },
        {
          id: 'c2', text: 'two', username: 'a',
          replies: { data: [{ id: 'r3', text: 'r3', username: 'b' }] },
        },
      ],
      // No paging.next — this is what used to clobber the flag back to false.
      paging: {},
    });

    const result = await handler.getPostEngagement(channel('instagram'), 'ig_1', {
      commentsLimit: 3,
    });

    expect(result.comments).toHaveLength(3);
    expect(result.hasMoreComments).toBe(true);
  });

  it('still reports hasMoreComments from paging.next when under the limit', async () => {
    const handler = new InstagramHandler();
    mockJson({
      data: [{ id: 'c1', text: 'one', username: 'a' }],
      paging: { next: 'https://next' },
    });
    const result = await handler.getPostEngagement(channel('instagram'), 'ig_1', {
      commentsLimit: 25,
    });
    expect(result.comments).toHaveLength(1);
    expect(result.hasMoreComments).toBe(true);
  });
});

describe('postMetricsSupported', () => {
  it('is false for platforms with no getPostMetrics implementation', () => {
    // Verified against prod 2026-07-28: 76 published gmb rows, 0 post_metrics.
    // (Reddit and Discord left this list in the 2026-08 docs audit — both
    // platforms do report per-post figures and now have handlers.)
    for (const p of ['gmb', 'telegram', 'tumblr']) {
      expect(postMetricsSupported(p)).toBe(false);
    }
    for (const p of ['reddit', 'discord']) {
      expect(postMetricsSupported(p)).toBe(true);
    }
  });

  it('gates LinkedIn on account type — share statistics are org-only', () => {
    expect(postMetricsSupported('linkedin', 'organization')).toBe(true);
    // Prod 2026-07-28: linkedin personal = 2 published rows, 0 metrics rows.
    expect(postMetricsSupported('linkedin', 'personal')).toBe(false);
    expect(postMetricsSupported('linkedin', 'profile')).toBe(false);
    expect(postMetricsSupported('linkedin', null)).toBe(false);
  });

  it('is true for the measured platforms', () => {
    for (const p of METRICS_SUPPORTED_PLATFORMS) {
      if (p === 'linkedin') continue;
      expect(postMetricsSupported(p)).toBe(true);
    }
  });

  it('stays in sync with the metrics-sync worker list', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/lib/jobs/metrics-sync.worker.ts', 'utf8'),
    );
    // The worker must not re-declare its own copy of the list — that drift is
    // how "unsupported" and "not synced yet" became indistinguishable.
    expect(src).toContain('METRICS_SUPPORTED_PLATFORMS');
    expect(src).not.toMatch(/SUPPORTED_PLATFORMS:\s*PlatformName\[\]\s*=\s*\[/);
  });
});
