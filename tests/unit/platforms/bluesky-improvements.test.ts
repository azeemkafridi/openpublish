/**
 * Bluesky improvements tests.
 *
 * Tests:
 *   - @mention facet detection alongside link facets
 *   - Mention handle→DID resolution
 *   - Auto image resize for images >976KB
 *   - Image size limit config update
 */

import { readFileSync } from 'node:fs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockFetchJsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
    json: async () => data,
  };
}

function mockFetchErrorResponse(status: number, data: unknown) {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify(data),
  };
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const { BlueskyHandler } = await import('@/lib/platforms/bluesky');

import type { ChannelData, PostData } from '@/lib/platforms/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(): ChannelData {
  // Create a mock JWT token with a DID in the sub claim
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'did:plc:testuser123', iat: Date.now() })).toString('base64url');
  const sig = Buffer.from('fake-sig').toString('base64url');
  const jwt = `${header}.${payload}.${sig}`;

  return {
    id: 1,
    platform: 'bluesky',
    accountId: 'did:plc:testuser123',
    accountName: 'test.bsky.social',
    accessToken: jwt,
    metadata: { did: 'did:plc:testuser123' },
  };
}

// ---------------------------------------------------------------------------
// Tests: Facet Detection
// ---------------------------------------------------------------------------

describe('Bluesky facet detection', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new BlueskyHandler();

  it('config allows images up to 10MB (auto-resize handles limit)', () => {
    expect(handler.config.mediaRules.image?.maxSizeMB).toBe(10);
  });

  it('detects @mention facets in post text', async () => {
    const channel = makeChannel();

    // Mock the handle resolution API call
    mockFetch
      // resolveHandle for alice.bsky.social
      .mockResolvedValueOnce(
        mockFetchJsonResponse({ did: 'did:plc:alice123' }),
      )
      // createRecord
      .mockResolvedValueOnce(
        mockFetchJsonResponse({
          uri: 'at://did:plc:testuser123/app.bsky.feed.post/abc123',
          cid: 'bafyxyz',
        }),
      );

    const post: PostData = {
      content: 'Hello @alice.bsky.social check this out!',
      mediaUrls: [],
      mediaFiles: [],
    };

    await handler.publishPost(post, channel);

    // The first fetch should be the handle resolution
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const resolveCall = mockFetch.mock.calls[0][0];
    expect(resolveCall).toContain('resolveHandle');
    expect(resolveCall).toContain('alice.bsky.social');

    // The second fetch should be the createRecord with facets
    const createOpts = mockFetch.mock.calls[1][1];
    const recordPayload = JSON.parse(createOpts.body);
    const record = recordPayload.record;

    expect(record.facets).toBeDefined();
    expect(record.facets.length).toBeGreaterThanOrEqual(1);

    // Find the mention facet
    const mentionFacet = record.facets.find((f: any) =>
      f.features.some((feat: any) => feat.$type === 'app.bsky.richtext.facet#mention'),
    );
    expect(mentionFacet).toBeDefined();
    expect(mentionFacet.features[0].did).toBe('did:plc:alice123');
  });

  it('detects both links and mentions in the same text', async () => {
    const channel = makeChannel();

    mockFetch
      // resolveHandle
      .mockResolvedValueOnce(
        mockFetchJsonResponse({ did: 'did:plc:bob456' }),
      )
      // createRecord
      .mockResolvedValueOnce(
        mockFetchJsonResponse({
          uri: 'at://did:plc:testuser123/app.bsky.feed.post/def456',
          cid: 'bafyabc',
        }),
      );

    const post: PostData = {
      content: 'Check https://example.com by @bob.bsky.social',
      mediaUrls: [],
      mediaFiles: [],
    };

    await handler.publishPost(post, channel);

    const createOpts = mockFetch.mock.calls[1][1];
    const record = JSON.parse(createOpts.body).record;

    expect(record.facets.length).toBe(2);

    const linkFacet = record.facets.find((f: any) =>
      f.features.some((feat: any) => feat.$type === 'app.bsky.richtext.facet#link'),
    );
    const mentionFacet = record.facets.find((f: any) =>
      f.features.some((feat: any) => feat.$type === 'app.bsky.richtext.facet#mention'),
    );

    expect(linkFacet).toBeDefined();
    expect(linkFacet.features[0].uri).toBe('https://example.com');

    expect(mentionFacet).toBeDefined();
    expect(mentionFacet.features[0].did).toBe('did:plc:bob456');
  });

  it('removes unresolvable mentions gracefully', async () => {
    const channel = makeChannel();

    mockFetch
      // resolveHandle fails
      .mockResolvedValueOnce(
        mockFetchErrorResponse(404, { error: 'Handle not found' }),
      )
      // createRecord
      .mockResolvedValueOnce(
        mockFetchJsonResponse({
          uri: 'at://did:plc:testuser123/app.bsky.feed.post/ghi789',
          cid: 'bafydef',
        }),
      );

    const post: PostData = {
      content: 'Hey @nonexistent.bsky.social!',
      mediaUrls: [],
      mediaFiles: [],
    };

    await handler.publishPost(post, channel);

    const createOpts = mockFetch.mock.calls[1][1];
    const record = JSON.parse(createOpts.body).record;

    // Facets should be empty or undefined (unresolvable mention removed)
    expect(record.facets).toBeUndefined();
  });

  it('handles text with no mentions or links (no facets)', async () => {
    const channel = makeChannel();

    mockFetch.mockResolvedValueOnce(
      mockFetchJsonResponse({
        uri: 'at://did:plc:testuser123/app.bsky.feed.post/nofacet',
        cid: 'bafynofacet',
      }),
    );

    const post: PostData = {
      content: 'Just a simple text post',
      mediaUrls: [],
      mediaFiles: [],
    };

    await handler.publishPost(post, channel);

    const createOpts = mockFetch.mock.calls[0][1];
    const record = JSON.parse(createOpts.body).record;

    expect(record.facets).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: Image Auto-Resize
// ---------------------------------------------------------------------------

describe('Bluesky auto image resize', () => {
  afterEach(() => mockFetch.mockReset());

  const handler = new BlueskyHandler();

  it('uploads small images without resizing', async () => {
    const channel = makeChannel();

    // Create a small test image file (under 976KB)
    const testDir = join(tmpdir(), 'bluesky-test-' + Date.now());
    mkdirSync(testDir, { recursive: true });
    const smallImagePath = join(testDir, 'small.jpg');
    // 100 bytes — way under 976KB
    writeFileSync(smallImagePath, Buffer.alloc(100, 0xff));

    // Mock blob upload response
    mockFetch
      // uploadBlob
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          blob: {
            $type: 'blob',
            ref: { $link: 'blobref123' },
            mimeType: 'image/jpeg',
            size: 100,
          },
        }),
      })
      // createRecord
      .mockResolvedValueOnce(
        mockFetchJsonResponse({
          uri: 'at://did:plc:testuser123/app.bsky.feed.post/smallimg',
          cid: 'bafysmall',
        }),
      );

    const post: PostData = {
      content: 'Small image',
      mediaUrls: [],
      mediaFiles: [
        {
          url: 'https://example.com/small.jpg',
          localPath: smallImagePath,
          mimeType: 'image/jpeg',
          sizeBytes: 100,
        },
      ],
    };

    const result = await handler.publishPost(post, channel);
    expect(result.success).toBe(true);

    // Verify the upload was called with original content type
    const uploadCall = mockFetch.mock.calls[0];
    const uploadHeaders = uploadCall[1].headers;
    expect(uploadHeaders['Content-Type']).toBe('image/jpeg');
  });
});

// ---------------------------------------------------------------------------
// Tests: Threads scope
// ---------------------------------------------------------------------------

describe('Threads OAuth scope includes insights', () => {
  it('includes threads_manage_insights in OAuth scopes', async () => {
    const { ThreadsHandler } = await import('@/lib/platforms/threads');
    process.env.THREADS_APP_ID = 'test-threads-app';

    const handler = new ThreadsHandler();
    const url = await handler.getOAuthUrl('http://localhost/callback', 'state');

    expect(url).toContain('threads_manage_insights');
    expect(url).toContain('threads_basic');
    expect(url).toContain('threads_content_publish');
    expect(url).toContain('threads_read_replies');
    expect(url).toContain('threads_manage_replies');
  });
});
