/**
 * Tests for the post engagement API.
 *
 *   GET /api/posts/[id]/engagement — live-fetch comments/reactions per platform
 *
 * Covers the account label (`accountName`) that the UI shows so the connected
 * Page/account the content was read from is identifiable — required by Meta's
 * `pages_read_user_content` review.
 */
const { state, makeChain, cachedSpy } = vi.hoisted(() => {
  const cachedSpy = vi.fn();
  const state = {
    selectCallIndex: 0,
    selectResults: [] as any[][],
    engagement: null as any,
    engagementError: null as Error | null,
  };

  function makeChain(resolveWith: any[]) {
    const chain: Record<string, any> = {};
    for (const m of ['select', 'from', 'where', 'innerJoin', 'orderBy', 'limit']) {
      chain[m] = (..._args: any[]) => chain;
    }
    chain.then = (resolve: any) => resolve(resolveWith);
    return chain;
  }

  return { state, makeChain, cachedSpy };
});

// Pass-through cache: exercises the route logic, and records the key/TTL so the
// caching contract itself can be asserted.
vi.mock('@/lib/cache', () => ({
  cached: (key: string, ttl: number, compute: () => Promise<unknown>) => {
    cachedSpy(key, ttl);
    return compute();
  },
}));

vi.mock('@/lib/db', () => ({
  db: {
    select: (..._args: any[]) => {
      const idx = state.selectCallIndex++;
      return makeChain(idx < state.selectResults.length ? state.selectResults[idx] : []);
    },
  },
}));

vi.mock('@/lib/db/schema', () => ({
  posts: { id: 'posts.id', organizationId: 'posts.organizationId' },
  postPlatforms: {
    id: 'pp.id',
    postId: 'pp.postId',
    platform: 'pp.platform',
    platformPostId: 'pp.platformPostId',
    platformUrl: 'pp.platformUrl',
    channelId: 'pp.channelId',
  },
  channels: {
    id: 'ch.id',
    accountId: 'ch.accountId',
    accountName: 'ch.accountName',
    accountType: 'ch.accountType',
    accessToken: 'ch.accessToken',
    refreshToken: 'ch.refreshToken',
    metadata: 'ch.metadata',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (..._a: any[]) => ({}),
  and: (..._a: any[]) => ({}),
}));

vi.mock('@/lib/auth/crypto', () => ({ decrypt: (v: string) => `dec:${v}` }));
vi.mock('@/lib/platforms/init', () => ({}));
vi.mock('@/lib/platforms/registry', () => ({
  getPlatformHandler: () => ({
    getPostEngagement: async () => {
      if (state.engagementError) throw state.engagementError;
      return state.engagement;
    },
  }),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/pages/api/posts/[id]/engagement';

function ctx(postId = '1') {
  return {
    locals: { auth: { user: { id: 'u1' }, organizationId: 10 } },
    params: { id: postId },
    url: new URL('http://localhost/api/posts/1/engagement'),
  } as any;
}

const fbRow = {
  ppId: 1,
  platform: 'facebook',
  platformPostId: 'fb_123',
  platformUrl: 'https://facebook.com/p/123',
  channelId: 7,
  accountId: 'page_1',
  accountName: 'Acme Bakery',
  accountType: 'page',
  accessToken: 'enc',
  refreshToken: null,
  metadata: {},
};

const sampleEngagement = {
  comments: [
    { id: 'c1', text: 'Nice!', actor: { id: 'a1', name: 'Jane Doe' } },
  ],
  reactions: [{ id: 'r1', type: 'LIKE', actor: { id: 'a2', name: 'John Roe' } }],
};

beforeEach(() => {
  state.selectCallIndex = 0;
  state.selectResults = [];
  state.engagement = sampleEngagement;
  state.engagementError = null;
  cachedSpy.mockClear();
});

describe('GET /api/posts/[id]/engagement', () => {
  it('returns the connected account name alongside the fetched content', async () => {
    state.selectResults = [[{ id: 1 }], [fbRow]];

    const res = await GET(ctx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.platforms).toHaveLength(1);
    expect(body.platforms[0]).toMatchObject({
      platform: 'facebook',
      accountName: 'Acme Bakery',
      platformUrl: 'https://facebook.com/p/123',
    });
    expect(body.platforms[0].engagement.comments[0].text).toBe('Nice!');
  });

  it('still labels the account when the post was never published to the platform', async () => {
    state.selectResults = [[{ id: 1 }], [{ ...fbRow, platformPostId: null }]];

    const body = await (await GET(ctx())).json();

    expect(body.platforms[0].accountName).toBe('Acme Bakery');
    expect(body.platforms[0].engagement).toBeNull();
  });

  it('still labels the account when the platform fetch fails', async () => {
    state.selectResults = [[{ id: 1 }], [fbRow]];
    state.engagementError = new Error('graph exploded');

    const body = await (await GET(ctx())).json();

    expect(body.platforms[0].accountName).toBe('Acme Bakery');
    expect(body.platforms[0].error).toBe('Could not load engagement for this platform.');
  });

  it('rejects unauthenticated requests', async () => {
    const res = await GET({ ...ctx(), locals: { auth: { user: null, organizationId: 10 } } });
    expect(res.status).toBe(401);
  });

  it('404s when the post is not in the caller organization', async () => {
    state.selectResults = [[]];
    const res = await GET(ctx());
    expect(res.status).toBe(404);
  });

  it('caches the live platform reads for 60s (analytics clicks through many posts)', async () => {
    state.selectResults = [[{ id: 1 }], [fbRow]];

    await GET(ctx());

    expect(cachedSpy).toHaveBeenCalledTimes(1);
    const [key, ttl] = cachedSpy.mock.calls[0];
    expect(key).toContain(':1:');
    expect(ttl).toBe(60);
  });

  it('bypasses the cache when force=1 (the Refresh control)', async () => {
    state.selectResults = [[{ id: 1 }], [fbRow]];
    const c = ctx();
    c.url = new URL('http://localhost/api/posts/1/engagement?force=1');

    const body = await (await GET(c)).json();

    expect(cachedSpy).not.toHaveBeenCalled();
    expect(body.platforms[0].engagement.comments[0].text).toBe('Nice!');
  });
});
