/**
 * Tests for the Post Retry API.
 *
 *   POST /api/posts/[id]/retry — retry failed platforms for a post
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
    status: 'post_platforms.status',
    errorMessage: 'post_platforms.error_message',
    retryCount: 'post_platforms.retry_count',
    maxRetries: 'post_platforms.max_retries',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ type: 'eq', args: a })),
  and: vi.fn((...a: any[]) => ({ type: 'and', args: a })),
  ne: vi.fn((...a: any[]) => ({ type: 'ne', args: a })),
  inArray: vi.fn((...a: any[]) => ({ type: 'inArray', args: a })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: any[]) => ({
    type: 'sql', strings, values,
  })),
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
import { POST } from '@/pages/api/posts/[id]/retry';
import { logActivity } from '@lib/activity/log';
import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A } from '../helpers/fixtures';

const SAMPLE_POST = {
  id: 1,
  organizationId: 1,
  userId: 'user-a',
  content: 'Test post',
  status: 'failed',
};

const FAILED_PLATFORM = {
  id: 10,
  postId: 1,
  channelId: 1,
  platform: 'facebook',
  status: 'failed',
  errorMessage: 'API error',
  retryCount: 0,
  maxRetries: 3,
};

const MAXED_OUT_PLATFORM = {
  id: 11,
  postId: 1,
  channelId: 2,
  platform: 'twitter',
  status: 'failed',
  errorMessage: 'Rate limit',
  retryCount: 3,
  maxRetries: 3,
};

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
// POST /api/posts/[id]/retry
// ---------------------------------------------------------------------------

describe('POST /api/posts/[id]/retry', () => {
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
    queryChain.then = (resolve: any) => resolve([]);
    const ctx = createMockContext({ user: USER_A, params: { id: '999' }, organizationId: 1 });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(404);
    expect(data.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 when no failed platforms exist', async () => {
    // First: post found; second: no failed platforms
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([SAMPLE_POST]);
      if (callCount === 2) return resolve([]); // no failed platforms
      return resolve([]);
    };

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error.message).toContain('No failed platforms');
  });

  it('blocks unconfirmed platforms without republish: true (may already be live)', async () => {
    const UNCONFIRMED_PLATFORM = { ...FAILED_PLATFORM, id: 11, status: 'unconfirmed' };
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([SAMPLE_POST]);
      if (callCount === 2) return resolve([UNCONFIRMED_PLATFORM]);
      return resolve([]);
    };

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error.code).toBe('UNCONFIRMED_REQUIRES_REPUBLISH');
    expect(data.error.message).toContain('republish');
  });

  it('retries unconfirmed platforms when republish: true is passed explicitly', async () => {
    const UNCONFIRMED_PLATFORM = { ...FAILED_PLATFORM, id: 11, status: 'unconfirmed' };
    const updatedPost = { ...SAMPLE_POST, status: 'publishing' };
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([SAMPLE_POST]);
      if (callCount === 2) return resolve([UNCONFIRMED_PLATFORM]);
      return resolve([{ ...UNCONFIRMED_PLATFORM, status: 'pending' }]);
    };
    queryChain.returning = vi.fn().mockResolvedValue([updatedPost]);

    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      organizationId: 1,
      body: { republish: true },
    });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.retriedCount).toBe(1);
  });

  it('returns 400 when all failed platforms have exceeded max retries', async () => {
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([SAMPLE_POST]);
      if (callCount === 2) return resolve([MAXED_OUT_PLATFORM]);
      return resolve([]);
    };

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error.message).toContain('maximum retry count');
  });

  it('retries only failed platforms with remaining retries', async () => {
    const updatedPost = { ...SAMPLE_POST, status: 'publishing' };
    const allPlatforms = [
      { ...FAILED_PLATFORM, status: 'pending' },
      MAXED_OUT_PLATFORM,
    ];

    // post found -> failed platforms -> update -> post update -> all platforms
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([SAMPLE_POST]);
      if (callCount === 2) return resolve([FAILED_PLATFORM, MAXED_OUT_PLATFORM]);
      if (callCount >= 3) return resolve(allPlatforms); // all platforms for response
      return resolve([]);
    };
    queryChain.returning = vi.fn().mockResolvedValue([updatedPost]);

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.retriedCount).toBe(1);
    expect(data.skippedMaxRetries).toBe(1);
    expect(data.status).toBe('publishing');
    expect(mockAddPublishJob).toHaveBeenCalledWith(1);
  });

  it('logs post.retried activity', async () => {
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([SAMPLE_POST]);
      if (callCount === 2) return resolve([FAILED_PLATFORM]);
      return resolve([{ ...FAILED_PLATFORM, status: 'pending' }]);
    };
    queryChain.returning = vi.fn().mockResolvedValue([{ ...SAMPLE_POST, status: 'publishing' }]);

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    await POST(ctx as any);
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'post.retried',
        resourceId: 1,
        details: { retriedCount: 1 },
      }),
    );
  });

  it('queues a publish job after retrying', async () => {
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([SAMPLE_POST]);
      if (callCount === 2) return resolve([FAILED_PLATFORM]);
      return resolve([]);
    };
    queryChain.returning = vi.fn().mockResolvedValue([{ ...SAMPLE_POST, status: 'publishing' }]);

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    await POST(ctx as any);
    expect(mockAddPublishJob).toHaveBeenCalledWith(1);
  });
});
