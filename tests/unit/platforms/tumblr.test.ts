/**
 * Tests for the Tumblr platform handler.
 *
 * Covers:
 *   - config (name / displayName / authType / media rules)
 *   - getOAuthUrl: authorize URL carries offline_access (required for a refresh
 *     token) and throws when credentials are missing
 *   - exchangeCodeForToken / refreshToken: token parsing, refresh-token carry-over
 *   - getBlogs + getAccountInfo: primary-blog selection
 *   - publishPost: JSON body for text-only, multipart for media, NPF block
 *     construction (heading/title, paragraph splitting, 4096-char chunking,
 *     alt text, video dimensions), tag normalization, media combination limits,
 *     post URL construction, and error mapping (auth-expired, rate limit, 8023)
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

vi.mock('node:fs/promises', () => ({
  default: { readFile: vi.fn().mockResolvedValue(Buffer.from('fake-bytes')) },
  readFile: vi.fn().mockResolvedValue(Buffer.from('fake-bytes')),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { TumblrHandler } = await import('@/lib/platforms/tumblr');
import type { PostData, ChannelData, MediaFileData } from '@/lib/platforms/types';

export {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(overrides: Partial<ChannelData> = {}): ChannelData {
  return {
    id: 1,
    platform: 'tumblr',
    accountId: 'myblog',
    accountName: 'My Blog',
    accessToken: 'tumblr-access-token',
    metadata: {},
    ...overrides,
  };
}

function makePost(overrides: Partial<PostData> = {}): PostData {
  return {
    content: 'Hello Tumblr!',
    mediaUrls: [],
    mediaFiles: [],
    ...overrides,
  };
}

function makeMedia(overrides: Partial<MediaFileData> = {}): MediaFileData {
  return {
    url: 'https://cdn.example.com/a.jpg',
    localPath: '/tmp/a.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1234,
    width: 800,
    height: 600,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

/** The parsed `json` part of the multipart body from the most recent publish. */
async function parseMultipartPayload(): Promise<any> {
  const form: FormData = mockFetch.mock.calls.at(-1)![1].body;
  return JSON.parse(await (form.get('json') as Blob).text());
}

const OK_CREATE = { response: { id_string: '987654321' } };

beforeEach(() => {
  mockFetch.mockReset();
  process.env.TUMBLR_CLIENT_ID = 'client-id';
  process.env.TUMBLR_CLIENT_SECRET = 'client-secret';
});

// ---------------------------------------------------------------------------

describe('TumblrHandler config', () => {
  it('declares the platform identity', () => {
    const { config } = new TumblrHandler();
    expect(config.name).toBe('tumblr');
    expect(config.displayName).toBe('Tumblr');
    expect(config.authType).toBe('oauth');
  });

  it('allows 30 images but only one video', () => {
    const { config } = new TumblrHandler();
    expect(config.mediaRules.image.maxCount).toBe(30);
    expect(config.mediaRules.video.maxCount).toBe(1);
  });
});

describe('TumblrHandler OAuth', () => {
  it('requests offline_access so Tumblr issues a refresh token', async () => {
    const url = await new TumblrHandler().getOAuthUrl('https://app.test/cb', 'state123');
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://www.tumblr.com/oauth2/authorize');
    expect(parsed.searchParams.get('scope')).toContain('offline_access');
    expect(parsed.searchParams.get('scope')).toContain('write');
    expect(parsed.searchParams.get('state')).toBe('state123');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://app.test/cb');
  });

  it('throws a clear error when the app credentials are missing', async () => {
    delete process.env.TUMBLR_CLIENT_ID;
    await expect(new TumblrHandler().getOAuthUrl('https://app.test/cb', 's')).rejects.toThrow(
      'TUMBLR_CLIENT_ID not configured',
    );
  });

  it('exchanges the code for tokens', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 2520 }),
    );

    const token = await new TumblrHandler().exchangeCodeForToken('code', 'https://app.test/cb');
    expect(token).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresIn: 2520 });
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.tumblr.com/v2/oauth2/token');
  });

  it('keeps the existing refresh token when Tumblr omits it on refresh', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ access_token: 'at2', expires_in: 2520 }));

    const token = await new TumblrHandler().refreshToken('original-rt');
    expect(token).toMatchObject({ accessToken: 'at2', refreshToken: 'original-rt' });
  });

  it('returns null rather than throwing when refresh fails', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, 400));
    expect(await new TumblrHandler().refreshToken('dead-rt')).toBeNull();
  });
});

describe('TumblrHandler account + blogs', () => {
  const userInfo = {
    response: {
      user: {
        name: 'someone',
        blogs: [
          { name: 'sideblog', title: 'Side Blog', primary: false, followers: 3 },
          { name: 'mainblog', title: 'Main Blog', primary: true, followers: 42 },
        ],
      },
    },
  };

  it('lists every blog on the account', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(userInfo));
    const blogs = await new TumblrHandler().getBlogs('at');
    expect(blogs.map((b) => b.name)).toEqual(['sideblog', 'mainblog']);
    expect(blogs[1]).toMatchObject({ primary: true, followers: 42, title: 'Main Blog' });
  });

  it('picks the primary blog for the connected account, not merely the first', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(userInfo));
    const info = await new TumblrHandler().getAccountInfo('at');
    expect(info.id).toBe('mainblog');
    expect(info.name).toBe('Main Blog');
  });

  it('fails clearly when the account has no blogs', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ response: { user: { blogs: [] } } }));
    await expect(new TumblrHandler().getAccountInfo('at')).rejects.toThrow(/no blogs/i);
  });
});

describe('TumblrHandler publishPost', () => {
  it('posts text-only content as JSON with a single text block', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(OK_CREATE));

    const result = await new TumblrHandler().publishPost(makePost(), makeChannel());

    expect(result.success).toBe(true);
    expect(result.postId).toBe('987654321');
    expect(result.url).toBe('https://www.tumblr.com/myblog/987654321');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.tumblr.com/v2/blog/myblog/posts');
    const body = JSON.parse(init.body);
    expect(body.state).toBe('published');
    expect(body.content).toEqual([{ type: 'text', text: 'Hello Tumblr!' }]);
  });

  it('splits paragraphs into separate NPF text blocks', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(OK_CREATE));

    await new TumblrHandler().publishPost(
      makePost({ content: 'First para.\n\nSecond para.' }),
      makeChannel(),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.content).toEqual([
      { type: 'text', text: 'First para.' },
      { type: 'text', text: 'Second para.' },
    ]);
  });

  it('chunks a paragraph longer than the 4096-char block limit', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(OK_CREATE));

    await new TumblrHandler().publishPost(
      makePost({ content: 'a'.repeat(9000) }),
      makeChannel(),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.content).toHaveLength(3); // 4096 + 4096 + 808
    expect(body.content.every((b: any) => b.text.length <= 4096)).toBe(true);
    expect(body.content.map((b: any) => b.text).join('')).toHaveLength(9000);
  });

  it('adds a heading block for the title and a link block for the link', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(OK_CREATE));

    await new TumblrHandler().publishPost(
      makePost({ platformSpecific: { 1: { title: 'My Title', link: 'example.com/a' } } }),
      makeChannel(),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.content[0]).toEqual({ type: 'text', subtype: 'heading1', text: 'My Title' });
    // Bare hostnames are normalized to https so Tumblr doesn't reject the block.
    expect(body.content.at(-1)).toEqual({ type: 'link', url: 'https://example.com/a' });
  });

  it('normalizes tags to a comma-separated string and strips leading #', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(OK_CREATE));

    await new TumblrHandler().publishPost(
      makePost({ platformSpecific: { 1: { tags: ['#art', ' design '] } } }),
      makeChannel(),
    );

    expect(JSON.parse(mockFetch.mock.calls[0][1].body).tags).toBe('art,design');
  });

  it('publishes to the blog chosen per post, overriding the channel default', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(OK_CREATE));

    const result = await new TumblrHandler().publishPost(
      makePost({ platformSpecific: { 1: { blogName: 'otherblog' } } }),
      makeChannel(),
    );

    expect(mockFetch.mock.calls[0][0]).toBe('https://api.tumblr.com/v2/blog/otherblog/posts');
    expect(result.url).toBe('https://www.tumblr.com/otherblog/987654321');
  });

  it('uploads images as multipart with matching identifiers and alt text', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(OK_CREATE));

    const result = await new TumblrHandler().publishPost(
      makePost({ mediaFiles: [makeMedia({ altText: 'A cat' })] }),
      makeChannel(),
    );

    expect(result.success).toBe(true);
    const payload = await parseMultipartPayload();
    const imageBlock = payload.content.find((b: any) => b.type === 'image');
    expect(imageBlock.media[0]).toMatchObject({ identifier: 'media-0', width: 800, height: 600 });
    expect(imageBlock.alt_text).toBe('A cat');

    // The file part name must match the identifier the block references.
    const form: FormData = mockFetch.mock.calls[0][1].body;
    expect(form.get('media-0')).toBeInstanceOf(Blob);
  });

  it('falls back to default dimensions for a video with none', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(OK_CREATE));

    await new TumblrHandler().publishPost(
      makePost({
        mediaFiles: [
          makeMedia({ mimeType: 'video/mp4', localPath: '/tmp/v.mp4', width: undefined, height: undefined }),
        ],
      }),
      makeChannel(),
    );

    const payload = await parseMultipartPayload();
    const videoBlock = payload.content.find((b: any) => b.type === 'video');
    expect(videoBlock).toMatchObject({ provider: 'tumblr' });
    expect(videoBlock.media).toMatchObject({ identifier: 'media-0', width: 540, height: 405 });
  });

  it('sends an empty text block for a media-only post', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(OK_CREATE));

    await new TumblrHandler().publishPost(
      makePost({ content: '', mediaFiles: [makeMedia()] }),
      makeChannel(),
    );

    const payload = await parseMultipartPayload();
    expect(payload.content.filter((b: any) => b.type === 'image')).toHaveLength(1);
    expect(payload.content.some((b: any) => b.type === 'text')).toBe(false);
  });

  describe('media combination limits', () => {
    it('rejects more than one video before calling the API', async () => {
      const video = makeMedia({ mimeType: 'video/mp4', localPath: '/tmp/v.mp4' });
      const result = await new TumblrHandler().publishPost(
        makePost({ mediaFiles: [video, { ...video, localPath: '/tmp/v2.mp4' }] }),
        makeChannel(),
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/only one video/i);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects mixing a video with images', async () => {
      const result = await new TumblrHandler().publishPost(
        makePost({
          mediaFiles: [makeMedia(), makeMedia({ mimeType: 'video/mp4', localPath: '/tmp/v.mp4' })],
        }),
        makeChannel(),
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/cannot mix/i);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects more than 30 images', async () => {
      const result = await new TumblrHandler().publishPost(
        makePost({ mediaFiles: Array.from({ length: 31 }, () => makeMedia()) }),
        makeChannel(),
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/up to 30 images/i);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('error mapping', () => {
    it('flags a 401 as auth-expired so the channel is marked for reconnect', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ detail: 'Unauthorized' }] }, 401));

      const result = await new TumblrHandler().publishPost(makePost(), makeChannel());
      expect(result.success).toBe(false);
      expect(result.authExpired).toBe(true);
      expect(result.error).toMatch(/reconnect/i);
    });

    it('translates the daily-posting-limit code into actionable copy', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ code: 8023 }] }, 400));

      const result = await new TumblrHandler().publishPost(makePost(), makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/daily posting limit/i);
      expect(result.authExpired).toBe(false);
    });

    // base.ts retries a 429 twice with real 2s/4s backoff before giving up, so
    // this exercises ~6s of wall clock — the mapping is only reachable once the
    // in-band retries are exhausted.
    it('describes a rate limit as retryable once retries are exhausted', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ errors: [] }, 429));

      const result = await new TumblrHandler().publishPost(makePost(), makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/rate limit/i);
    }, 20000);

    it('reports a missing post id rather than claiming success', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ response: {} }));

      const result = await new TumblrHandler().publishPost(makePost(), makeChannel());
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no post id/i);
    });
  });
});
