/**
 * Tests for the Post Publish API.
 *
 *   POST /api/posts/[id]/publish — publish a draft post immediately
 */

// ---------------------------------------------------------------------------
// Chainable Drizzle mock
// ---------------------------------------------------------------------------
const mockQueryResult: any[] = [];
const queryChain: Record<string, any> = {};
const chainMethods = [
  'select', 'from', 'where', 'orderBy', 'limit', 'offset',
  'insert', 'values', 'returning', 'update', 'set', 'delete',
  'innerJoin', 'leftJoin', 'groupBy', 'having',
];
for (const m of chainMethods) {
  queryChain[m] = vi.fn().mockReturnValue(queryChain);
}
queryChain.returning = vi.fn().mockResolvedValue(mockQueryResult);
queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve(mockQueryResult));
queryChain.then = (resolve: any) => resolve(mockQueryResult);

// ---------------------------------------------------------------------------
// vi.mock (hoisted)
// ---------------------------------------------------------------------------
vi.mock('@lib/db', () => ({
  db: {
    select: () => queryChain,
    update: () => queryChain,
    insert: () => queryChain,
    delete: () => queryChain,
  },
}));

vi.mock('@lib/db/schema', () => ({
  posts: {
    id: 'posts.id',
    organizationId: 'posts.organization_id',
    status: 'posts.status',
    updatedAt: 'posts.updated_at',
  },
  postPlatforms: {
    id: 'post_platforms.id',
    postId: 'post_platforms.post_id',
    channelId: 'post_platforms.channel_id',
    platform: 'post_platforms.platform',
    status: 'post_platforms.status',
  },
  // Looked up to resolve each target channel's accountType — LinkedIn company
  // pages are gated separately from personal profiles.
  channels: {
    id: 'channels.id',
    accountType: 'channels.account_type',
  },
  mediaFiles: {
    id: 'media_files.id',
    organizationId: 'media_files.organization_id',
    mimeType: 'media_files.mime_type',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ type: 'eq', args: a })),
  and: vi.fn((...a: any[]) => ({ type: 'and', args: a })),
  ne: vi.fn((...a: any[]) => ({ type: 'ne', args: a })),
  inArray: vi.fn((...a: any[]) => ({ type: 'inArray', args: a })),
}));

vi.mock('@lib/activity/log', () => ({ logActivity: vi.fn() }));

const mockAddPublishJob = vi.fn().mockResolvedValue(undefined);
vi.mock('@lib/jobs/queue', () => ({
  addPublishJob: (...a: any[]) => mockAddPublishJob(...a),
}));

vi.mock('@lib/errors', () => ({
  captureApiError: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import handlers AFTER mocks
// ---------------------------------------------------------------------------
import { POST } from '@/pages/api/posts/[id]/publish';
import { logActivity } from '@lib/activity/log';
import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A } from '../helpers/fixtures';

const SAMPLE_POST = {
  id: 1,
  organizationId: 1,
  userId: 'user-a',
  content: 'Test post',
  status: 'draft',
};

const SAMPLE_PLATFORMS = [
  { id: 1, postId: 1, channelId: 1, platform: 'facebook', status: 'pending' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resetChain(result: any[] = []) {
  for (const [key, fn] of Object.entries(queryChain)) {
    if (typeof fn === 'function' && key !== 'then') {
      (fn as any).mockReturnValue(queryChain);
    }
  }
  mockQueryResult.length = 0;
  result.forEach((r) => mockQueryResult.push(r));

  queryChain.returning = vi.fn().mockResolvedValue(mockQueryResult);
  queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve(mockQueryResult));
  queryChain.then = (resolve: any) => resolve(mockQueryResult);
}

// ---------------------------------------------------------------------------
// POST /api/posts/[id]/publish
// ---------------------------------------------------------------------------

describe('POST /api/posts/[id]/publish', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([]);
    mockAddPublishJob.mockResolvedValue(undefined);
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null, params: { id: '1' } });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(401);
    expect(data.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 400 for invalid post ID', async () => {
    const ctx = createMockContext({ user: USER_A, params: { id: 'abc' } });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 when post does not belong to org', async () => {
    // First thenable: post query returns empty
    queryChain.then = (resolve: any) => resolve([]);
    const ctx = createMockContext({ user: USER_A, params: { id: '999' }, organizationId: 1 });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(404);
    expect(data.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 when post status is not publishable', async () => {
    // Post with "published" status
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([{ ...SAMPLE_POST, status: 'published' }]);
      return resolve([]);
    };

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error.code).toBe('VALIDATION_ERROR');
    expect(data.error.message).toContain('draft');
  });

  it('returns 400 when post has no platform targets', async () => {
    // First: post found; second: platforms query returns empty
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([SAMPLE_POST]);
      if (callCount === 2) return resolve([]); // no platforms
      return resolve([]);
    };

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error.message).toContain('no target channels');
  });

  it('publishes successfully, queues job, and returns updated post', async () => {
    const updatedPost = { ...SAMPLE_POST, status: 'publishing' };
    // First: post found; second: platforms found
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([SAMPLE_POST]);
      if (callCount === 2) return resolve(SAMPLE_PLATFORMS);
      return resolve([]);
    };
    queryChain.returning = vi.fn().mockResolvedValue([updatedPost]);

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.status).toBe('publishing');
    expect(data).toHaveProperty('postPlatforms');
    expect(mockAddPublishJob).toHaveBeenCalledWith(1);
  });

  it('logs post.publish_queued activity', async () => {
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([SAMPLE_POST]);
      if (callCount === 2) return resolve(SAMPLE_PLATFORMS);
      return resolve([]);
    };
    queryChain.returning = vi.fn().mockResolvedValue([{ ...SAMPLE_POST, status: 'publishing' }]);

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    await POST(ctx as any);
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'post.publish_queued',
        resourceId: 1,
      }),
    );
  });

  it('allows publishing failed posts', async () => {
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([{ ...SAMPLE_POST, status: 'failed' }]);
      if (callCount === 2) return resolve(SAMPLE_PLATFORMS);
      return resolve([]);
    };
    queryChain.returning = vi.fn().mockResolvedValue([{ ...SAMPLE_POST, status: 'publishing' }]);

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await POST(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
  });

  it('allows publishing scheduled posts', async () => {
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([{ ...SAMPLE_POST, status: 'scheduled' }]);
      if (callCount === 2) return resolve(SAMPLE_PLATFORMS);
      return resolve([]);
    };
    queryChain.returning = vi.fn().mockResolvedValue([{ ...SAMPLE_POST, status: 'publishing' }]);

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await POST(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
  });

  it('allows publishing partial posts', async () => {
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([{ ...SAMPLE_POST, status: 'partial' }]);
      if (callCount === 2) return resolve(SAMPLE_PLATFORMS);
      return resolve([]);
    };
    queryChain.returning = vi.fn().mockResolvedValue([{ ...SAMPLE_POST, status: 'publishing' }]);

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await POST(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
  });

  // --- Pre-publish media validation gate (the post #149 regression) ----------

  it('rejects publishing a text-only post to YouTube with a clear error', async () => {
    const ytPost = {
      ...SAMPLE_POST,
      id: 2,
      content: '🍽️ Kung Pao Chicken Fajitas',
      status: 'draft',
      postFormat: 'post',
      postTypeOverrides: {},
      platformContent: {},
      mediaFiles: [], // no video attached
    };
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([ytPost]);
      if (callCount === 2) return resolve([{ id: 5, postId: 2, channelId: 9, platform: 'youtube', status: 'pending' }]);
      return resolve([]); // no media query — mediaFiles is empty
    };

    const ctx = createMockContext({ user: USER_A, params: { id: '2' }, organizationId: 1 });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error.code).toBe('VALIDATION_ERROR');
    expect(data.error.message).toMatch(/requires a video/i);
    expect(mockAddPublishJob).not.toHaveBeenCalled();
  });

  it('allows publishing a YouTube post once a video is attached', async () => {
    const ytPost = {
      ...SAMPLE_POST,
      id: 3,
      content: 'My cooking video',
      status: 'draft',
      postFormat: 'post',
      postTypeOverrides: {},
      platformContent: {},
      mediaFiles: [10],
    };
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([ytPost]);
      if (callCount === 2) return resolve([{ id: 6, postId: 3, channelId: 9, platform: 'youtube', status: 'pending' }]);
      if (callCount === 3) return resolve([{ mimeType: 'video/mp4' }]); // resolved media types
      return resolve([]);
    };
    queryChain.returning = vi.fn().mockResolvedValue([{ ...ytPost, status: 'publishing' }]);

    const ctx = createMockContext({ user: USER_A, params: { id: '3' }, organizationId: 1 });
    const res = await POST(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
    expect(mockAddPublishJob).toHaveBeenCalledWith(3);
  });
});
