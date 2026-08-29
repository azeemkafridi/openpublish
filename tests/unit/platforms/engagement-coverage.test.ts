/**
 * Every platform must state what it does about per-post engagement, and the UI
 * must be able to render whatever a platform can return.
 *
 * Before this, eight of fifteen handlers simply inherited the base
 * `unsupported: true` default. That is indistinguishable from "nobody has got
 * to it yet" — and four of the eight (Reddit, Tumblr, Discord, X) could in fact
 * read comments the whole time, so the app quietly claimed those networks had
 * no comments while their APIs were sitting there.
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

// X gates engagement on the org's read budget and plan.
vi.mock('@/lib/quotas/check', () => ({ getOrgPlan: async () => 'business' }));
vi.mock('@/lib/platforms/x-usage', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    checkXReadBudget: vi.fn(async () => true),
    trackXApiCall: vi.fn(),
    isXLiveApiDisabled: () => false,
  };
});

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { RedditHandler } = await import('@/lib/platforms/reddit');
const { TumblrHandler } = await import('@/lib/platforms/tumblr');
const { DiscordHandler } = await import('@/lib/platforms/discord');
const { XHandler } = await import('@/lib/platforms/x');
await import('@/lib/platforms/init'); // registers every handler
const { getPlatformHandler } = await import('@/lib/platforms/registry');
const { ALL_PLATFORMS: PLATFORMS } = await import('@/lib/platforms/types');
const { INLINE_COMMENT_PLATFORMS } = await import('@/components/analytics/PreviewComments');
const { METRICS_SUPPORTED_PLATFORMS, METRIC_SUPPORT } = await import('@/lib/platforms/metrics-support');
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
  process.env.DISCORD_BOT_TOKEN = 'bot-token';
});

/* ------------------------------------------------------------------ */
/*  Reddit                                                             */
/* ------------------------------------------------------------------ */

describe('Reddit getPostEngagement', () => {
  it('reads the comment tree and nests replies under their parent', async () => {
    mockJson([
      { data: { children: [] } }, // the link itself
      {
        data: {
          children: [
            {
              kind: 't1',
              data: {
                id: 'c1', body: 'Top level', author: 'alice',
                created_utc: 1_760_000_000, score: 12, parent_id: 't3_abc',
                replies: {
                  data: {
                    children: [
                      { kind: 't1', data: { id: 'c2', body: 'A reply', author: 'bob', parent_id: 't1_c1', replies: '' } },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    ]);

    const result = await new RedditHandler().getPostEngagement(channel('reddit'), 't3_abc');

    // The bare id is what /comments/{article} wants — the t3_ fullname 404s.
    expect(mockFetch.mock.calls[0][0]).toContain('/comments/abc');
    expect(mockFetch.mock.calls[0][0]).toContain('raw_json=1');
    expect(result.comments.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(result.comments[0].parentId).toBeUndefined();   // parent is the link
    expect(result.comments[1].parentId).toBe('c1');
    expect(result.comments[0].actor.name).toBe('u/alice');
    expect(result.comments[0].likeCount).toBe(12);
    // Votes are anonymous on Reddit — never offer a Reactors tab.
    expect(result.reactionsUnsupported).toBe(true);
  });

  it('does not count "load more" placeholders as comments, but flags them', async () => {
    mockJson([
      { data: { children: [] } },
      { data: { children: [{ kind: 'more', data: { id: 'x', count: 40 } }] } },
    ]);

    const result = await new RedditHandler().getPostEngagement(channel('reddit'), 'abc');

    expect(result.comments).toHaveLength(0);
    expect(result.hasMoreComments).toBe(true);
  });

  it('renders a deleted author without dropping the comment', async () => {
    mockJson([
      { data: { children: [] } },
      { data: { children: [{ kind: 't1', data: { id: 'c1', body: 'still here', author: '[deleted]', replies: '' } }] } },
    ]);

    const result = await new RedditHandler().getPostEngagement(channel('reddit'), 'abc');

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].actor.name).toBe('[deleted]');
    expect(result.comments[0].actor.profileUrl).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  Tumblr                                                             */
/* ------------------------------------------------------------------ */

describe('Tumblr getPostEngagement', () => {
  it('splits notes into replies/commentary-reblogs (comments) and likes/bare reblogs (reactions)', async () => {
    mockJson({
      response: {
        total_notes: 4,
        notes: [
          { type: 'reply', blog_name: 'alice', reply_text: 'Love this', timestamp: 1_760_000_000 },
          { type: 'reblog', blog_name: 'bob', added_text: 'so true', timestamp: 1_760_000_100 },
          { type: 'reblog', blog_name: 'carol', timestamp: 1_760_000_200 },
          { type: 'like', blog_name: 'dave', timestamp: 1_760_000_300 },
        ],
      },
    });

    const result = await new TumblrHandler().getPostEngagement(channel('tumblr'), '12345');

    expect(mockFetch.mock.calls[0][0]).toContain('/notes?id=12345');
    expect(mockFetch.mock.calls[0][0]).toContain('mode=all');
    // A reblog that added commentary is a comment; a bare one is a share.
    expect(result.comments.map((c) => c.text)).toEqual(['Love this', 'so true']);
    expect(result.reactions.map((r) => r.type)).toEqual(['REBLOG', 'LIKE']);
    expect(result.comments[0].actor.name).toBe('alice');
  });

  it('reports a missing blog name rather than calling with an empty path', async () => {
    const result = await new TumblrHandler().getPostEngagement(
      channel('tumblr', { accountId: '' }),
      '12345',
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.notice).toMatch(/blog name/i);
  });
});

/* ------------------------------------------------------------------ */
/*  Discord                                                            */
/* ------------------------------------------------------------------ */

describe('Discord getPostEngagement', () => {
  it('recovers the channel id from the permalink and reads reactors + thread replies', async () => {
    mockJson({
      id: 'm1',
      reactions: [{ count: 2, emoji: { name: '🔥' } }],
      thread: { id: 't1' },
    });
    mockJson([{ id: 'u1', username: 'alice' }]);
    mockJson([
      { id: 'r2', content: 'second', timestamp: '2026-08-01T10:01:00Z', author: { id: 'u3', username: 'carol' } },
      { id: 'r1', content: 'first', timestamp: '2026-08-01T10:00:00Z', author: { id: 'u2', username: 'bob' } },
    ]);

    const result = await new DiscordHandler().getPostEngagement(channel('discord'), 'm1', {
      platformUrl: 'https://discord.com/channels/900/901/m1',
    });

    // The channel id is only recorded in the URL — one server has many channels.
    expect(mockFetch.mock.calls[0][0]).toContain('/channels/901/messages/m1');
    expect(result.reactions[0].actor.handle).toBe('alice');
    // Discord returns newest-first; the panel reads oldest-first.
    expect(result.comments.map((c) => c.text)).toEqual(['first', 'second']);
  });

  it('explains itself when the message has no thread instead of claiming zero comments', async () => {
    mockJson({ id: 'm1', reactions: [] });

    const result = await new DiscordHandler().getPostEngagement(channel('discord'), 'm1', {
      platformUrl: 'https://discord.com/channels/900/901/m1',
    });

    expect(result.comments).toHaveLength(0);
    expect(result.notice).toMatch(/no thread/i);
  });
});

/* ------------------------------------------------------------------ */
/*  X — the one that costs money                                       */
/* ------------------------------------------------------------------ */

describe('X getPostEngagement', () => {
  it('reads nothing and says why when the channel has not opted into paid reads', async () => {
    const result = await new XHandler().getPostEngagement(channel('x'), '123');

    // Not a single request: the preview pane fetches on every post selection,
    // and X bills per tweet and per user returned.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.notice).toMatch(/charges for every read/i);
  });

  it('searches the conversation for replies once the channel has opted in', async () => {
    mockJson({
      data: [
        { id: '123', text: 'root', author_id: 'u1' },
        { id: '124', text: 'a reply', author_id: 'u2', created_at: '2026-08-01T10:00:00Z', referenced_tweets: [{ type: 'replied_to', id: '123' }] },
      ],
      includes: { users: [{ id: 'u2', name: 'Bob', username: 'bob' }] },
    });
    mockJson({ data: [{ id: 'u3', name: 'Carol', username: 'carol' }] });

    const result = await new XHandler().getPostEngagement(
      channel('x', { metadata: { metricsSyncEnabled: true } }),
      '123',
    );

    expect(mockFetch.mock.calls[0][0]).toContain('conversation_id%3A123');
    // The root tweet matches its own conversation_id — it is not a reply to itself.
    expect(result.comments.map((c) => c.id)).toEqual(['124']);
    expect(result.comments[0].parentId).toBeUndefined(); // replies to the root are top level
    expect(result.comments[0].actor.name).toBe('Bob');
    expect(result.reactions[0].actor.name).toBe('Carol');
  });
});

/* ------------------------------------------------------------------ */
/*  Coverage guards                                                    */
/* ------------------------------------------------------------------ */

describe('engagement coverage', () => {
  // Snapchat's Public Profile API exposes aggregate stats (REPLIES is a
  // count), never the comment/reply objects themselves — verified 2026-08-19.
  const NO_COMMENT_API = ['tiktok', 'pinterest', 'gmb', 'telegram', 'snapchat'];

  it('every platform declares its engagement behaviour explicitly', async () => {
    // Inheriting the base default is indistinguishable from an oversight — the
    // four networks with no comment API say so in their own handler.
    for (const platform of PLATFORMS) {
      const handler = getPlatformHandler(platform);
      expect(
        Object.getPrototypeOf(handler).hasOwnProperty('getPostEngagement'),
        `${platform} inherits the base getPostEngagement — override it, even if only to state that the API has none`,
      ).toBe(true);
    }
  });

  it('reports unsupported only for the networks whose API genuinely has no comments', async () => {
    for (const platform of PLATFORMS) {
      const handler = getPlatformHandler(platform);
      const result = await handler.getPostEngagement(channel(platform), 'id', {});
      if (NO_COMMENT_API.includes(platform)) {
        expect(result.unsupported, `${platform} should report unsupported`).toBe(true);
        expect(result.notice, `${platform} should say why`).toBeTruthy();
      } else {
        expect(result.unsupported, `${platform} has a comments API — it must not report unsupported`).not.toBe(true);
      }
      mockFetch.mockReset();
    }
  });

  it('the preview can render a thread for every platform that can return one', () => {
    // A platform with engagement data but no skin falls back to the detached
    // card, which is the thing this feature exists to remove.
    const withComments = PLATFORMS.filter((p) => !NO_COMMENT_API.includes(p));
    for (const platform of withComments) {
      expect(
        INLINE_COMMENT_PLATFORMS.has(platform),
        `${platform} can return comments but has no PreviewComments skin`,
      ).toBe(true);
    }
    // ...and nothing claims a skin it can never use.
    for (const platform of NO_COMMENT_API) {
      expect(INLINE_COMMENT_PLATFORMS.has(platform)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Metrics coverage guards — the same discipline for getPostMetrics   */
/* ------------------------------------------------------------------ */

describe('metrics coverage', () => {
  // Verified against current platform docs (2026-08 audit): GMB post insights
  // were removed Feb 2023 with no replacement; the Telegram Bot API cannot
  // read a message on request; Tumblr reports only an unsplittable note_count.
  // Anything else claiming "no metrics" is an oversight, not a platform fact.
  const NO_METRICS_API = ['gmb', 'telegram', 'tumblr'];

  it('every platform is either measured or on the verified no-API list', () => {
    for (const platform of PLATFORMS) {
      const measured = METRICS_SUPPORTED_PLATFORMS.includes(platform);
      const excluded = NO_METRICS_API.includes(platform);
      expect(
        measured || excluded,
        `${platform} is neither measured nor on the verified no-metrics list — decide which from the platform's docs`,
      ).toBe(true);
      expect(measured && excluded, `${platform} cannot be both`).toBe(false);
    }
  });

  it('every measured platform overrides getPostMetrics', () => {
    for (const platform of METRICS_SUPPORTED_PLATFORMS) {
      const handler = getPlatformHandler(platform);
      expect(
        Object.getPrototypeOf(handler).hasOwnProperty('getPostMetrics'),
        `${platform} is listed as measured but inherits the base empty-Map getPostMetrics`,
      ).toBe(true);
    }
    // ...and no handler implements metrics without declaring support — an
    // undeclared implementation never runs (the sync worker filters on the
    // list) and its metrics render as "not measured".
    for (const platform of PLATFORMS) {
      if (METRICS_SUPPORTED_PLATFORMS.includes(platform)) continue;
      const handler = getPlatformHandler(platform);
      expect(
        Object.getPrototypeOf(handler).hasOwnProperty('getPostMetrics'),
        `${platform} implements getPostMetrics but is not in METRICS_SUPPORTED_PLATFORMS — the worker will never call it`,
      ).toBe(false);
    }
  });

  it('declares per-metric support for exactly the measured platforms', () => {
    expect(Object.keys(METRIC_SUPPORT).sort()).toEqual([...METRICS_SUPPORTED_PLATFORMS].sort());
  });
});

/* ------------------------------------------------------------------ */
/*  Reddit getPostMetrics                                              */
/* ------------------------------------------------------------------ */

describe('Reddit getPostMetrics', () => {
  it('reads score/comments/crossposts from /api/info and maps ids back', async () => {
    mockJson({
      data: {
        children: [
          { kind: 't3', data: { name: 't3_abc', score: 41, upvote_ratio: 0.97, num_comments: 7, num_crossposts: 2 } },
          { kind: 't3', data: { name: 't3_def', score: 3, upvote_ratio: 0.5, num_comments: 0, num_crossposts: 0 } },
        ],
      },
    });

    const result = await new RedditHandler().getPostMetrics(channel('reddit'), ['abc', 't3_def']);

    // /api/info wants fullnames regardless of how the id was stored...
    expect(mockFetch.mock.calls[0][0]).toContain('/api/info?id=t3_abc,t3_def');
    // ...but results map back to the STORED form, or the sync worker's lookup
    // by platformPostId silently drops every row.
    const abc = result.get('abc')!;
    expect(abc.likes).toBe(41);
    expect(abc.comments).toBe(7);
    expect(abc.shares).toBe(2);
    expect(abc.extra!.upvoteRatioPct).toBe(97);
    // view_count is null via the data API — impressions must never be claimed.
    expect(abc.impressions).toBeUndefined();
    expect(result.get('t3_def')!.likes).toBe(3);
  });

  it('returns an empty map without a token rather than calling unauthenticated', async () => {
    const result = await new RedditHandler().getPostMetrics(channel('reddit', { accessToken: '' }), ['abc']);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Discord getPostMetrics                                             */
/* ------------------------------------------------------------------ */

describe('Discord getPostMetrics', () => {
  it('sums reaction counts and reads the thread message count', async () => {
    mockJson({
      id: 'm1',
      reactions: [{ count: 2, emoji: { name: '🔥' } }, { count: 3, emoji: { name: '👍' } }],
      thread: { id: 't1', message_count: 6 },
    });

    const result = await new DiscordHandler().getPostMetrics(channel('discord'), ['m1'], {
      urlsById: { m1: 'https://discord.com/channels/900/901/m1' },
    });

    // The channel id comes from the permalink — a message id alone 404s.
    expect(mockFetch.mock.calls[0][0]).toContain('/channels/901/messages/m1');
    const m = result.get('m1')!;
    expect(m.likes).toBe(5);
    expect(m.comments).toBe(6);
  });

  it('reports zero comments for a message with no thread — a true zero on Discord', async () => {
    mockJson({ id: 'm1', reactions: [] });

    const result = await new DiscordHandler().getPostMetrics(channel('discord'), ['m1'], {
      urlsById: { m1: 'https://discord.com/channels/900/901/m1' },
    });

    expect(result.get('m1')).toEqual({ likes: 0, comments: 0 });
  });

  it('skips posts whose channel id is unknowable instead of guessing', async () => {
    const result = await new DiscordHandler().getPostMetrics(channel('discord'), ['m1'], {});
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Mastodon reactors — both endpoints, as the handler's doc promises  */
/* ------------------------------------------------------------------ */

describe('Mastodon getPostEngagement reactors', () => {
  it('lists boosters as well as favouriters', async () => {
    mockJson({ descendants: [] });
    mockJson([{ id: 'a1', username: 'alice', display_name: 'Alice' }]); // favourited_by
    mockJson([{ id: 'b1', username: 'bob', display_name: 'Bob' }]);     // reblogged_by

    const handler = getPlatformHandler('mastodon');
    const result = await handler.getPostEngagement(
      channel('mastodon', { metadata: { instanceUrl: 'mastodon.social' } }),
      '123',
    );

    expect(mockFetch.mock.calls[1][0]).toContain('/statuses/123/favourited_by');
    expect(mockFetch.mock.calls[2][0]).toContain('/statuses/123/reblogged_by');
    expect(result.reactions.map((r) => r.type).sort()).toEqual(['FAVOURITE', 'REBLOG']);
    expect(result.reactions.find((r) => r.type === 'REBLOG')!.actor.name).toBe('Bob');
  });
});
