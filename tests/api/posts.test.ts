/**
 * Tests for the Posts API.
 *
 *   GET    /api/posts        - list posts with pagination
 *   POST   /api/posts        - create a new post
 *   GET    /api/posts/[id]   - get single post
 *   DELETE /api/posts/[id]   - delete post
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
queryChain.limit = vi.fn().mockImplementation(() => {
  const p = Promise.resolve(mockQueryResult);
  return p;
});
queryChain.then = (resolve: any) => resolve(mockQueryResult);

// ---------------------------------------------------------------------------
// vi.mock (hoisted)
// ---------------------------------------------------------------------------
vi.mock('@lib/db', () => ({
  db: {
    select: () => queryChain,
    selectDistinctOn: () => queryChain,
    update: () => queryChain,
    insert: () => queryChain,
    delete: () => queryChain,
  },
}));

vi.mock('@lib/db/schema', () => ({
  posts: {
    id: 'posts.id',
    userId: 'posts.user_id',
    organizationId: 'posts.organization_id',
    content: 'posts.content',
    mediaFiles: 'posts.media_files',
    status: 'posts.status',
    scheduledAt: 'posts.scheduled_at',
    publishedAt: 'posts.published_at',
    timezone: 'posts.timezone',
    postFormat: 'posts.post_format',
    postTypeOverrides: 'posts.post_type_overrides',
    platformSpecific: 'posts.platform_specific',
    recurringScheduleId: 'posts.recurring_schedule_id',
    deleteMediaAfterPublish: 'posts.delete_media_after_publish',
    createdAt: 'posts.created_at',
    updatedAt: 'posts.updated_at',
  },
  postPlatforms: {
    id: 'post_platforms.id',
    postId: 'post_platforms.post_id',
    channelId: 'post_platforms.channel_id',
    platform: 'post_platforms.platform',
    status: 'post_platforms.status',
    errorMessage: 'post_platforms.error_message',
    retryCount: 'post_platforms.retry_count',
  },
  postLabels: {
    postId: 'post_labels.post_id',
    labelId: 'post_labels.label_id',
  },
  labels: {
    id: 'labels.id',
    organizationId: 'labels.organization_id',
  },
  channels: {
    id: 'channels.id',
    organizationId: 'channels.organization_id',
  },
  recurringSchedules: {
    id: 'recurring_schedules.id',
    organizationId: 'recurring_schedules.organization_id',
    frequency: 'recurring_schedules.frequency',
    dayOfWeek: 'recurring_schedules.day_of_week',
    dayOfMonth: 'recurring_schedules.day_of_month',
    timeOfDay: 'recurring_schedules.time_of_day',
    timezone: 'recurring_schedules.timezone',
    nextRunAt: 'recurring_schedules.next_run_at',
    isActive: 'recurring_schedules.is_active',
  },
  mediaFiles: {
    id: 'media_files.id',
    organizationId: 'media_files.organization_id',
    originalPath: 'media_files.original_path',
    thumbnailPath: 'media_files.thumbnail_path',
    previewPath: 'media_files.preview_path',
    fileName: 'media_files.file_name',
    mimeType: 'media_files.mime_type',
    sizeBytes: 'media_files.size_bytes',
    width: 'media_files.width',
    height: 'media_files.height',
    duration: 'media_files.duration',
  },
  postMetrics: {
    id: 'post_metrics.id',
    postId: 'post_metrics.post_id',
    postPlatformId: 'post_metrics.post_platform_id',
    impressions: 'post_metrics.impressions',
    likes: 'post_metrics.likes',
    comments: 'post_metrics.comments',
    shares: 'post_metrics.shares',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ type: 'eq', args: a })),
  and: vi.fn((...a: any[]) => ({ type: 'and', args: a })),
  desc: vi.fn((c: any) => ({ type: 'desc', col: c })),
  lte: vi.fn((...a: any[]) => ({ type: 'lte', args: a })),
  gte: vi.fn((...a: any[]) => ({ type: 'gte', args: a })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: any[]) => ({
    type: 'sql',
    strings,
    values,
  })),
  inArray: vi.fn((...a: any[]) => ({ type: 'inArray', args: a })),
  ilike: vi.fn((...a: any[]) => ({ type: 'ilike', args: a })),
}));

vi.mock('@lib/activity/log', () => ({ logActivity: vi.fn() }));

vi.mock('@lib/media/upload', () => ({
  getMediaPublicUrl: vi.fn((path: string) => `https://cdn.example.com/${path}`),
}));

vi.mock('@lib/schedules/next-run', () => ({
  calculateNextRunAt: vi.fn(() => new Date('2026-02-01')),
}));

const mockCheckPostQuotasBatch = vi.fn().mockResolvedValue({
  daily: { allowed: true },
  monthly: { allowed: true },
  scheduled: { allowed: true },
  plan: 'pro',
});
const mockCheckRecurringScheduleQuota = vi.fn().mockResolvedValue({ allowed: true });
const mockCheckScheduledPerDayQuota = vi.fn().mockResolvedValue({ allowed: true, current: 0, limit: 30, resource: 'scheduled_per_day' });
const mockGetOrgPlan = vi.fn().mockResolvedValue('pro');
vi.mock('@lib/quotas/check', () => ({
  checkPostQuotasBatch: (...a: any[]) => mockCheckPostQuotasBatch(...a),
  checkRecurringScheduleQuota: (...a: any[]) => mockCheckRecurringScheduleQuota(...a),
  checkScheduledPerDayQuota: (...a: any[]) => mockCheckScheduledPerDayQuota(...a),
  checkPlatformAllowed: vi.fn().mockResolvedValue({ allowed: true }),
  getOrgPlan: (...a: any[]) => mockGetOrgPlan(...a),
}));

const mockQuotaExceededResponse = vi.fn((..._args: any[]) =>
  new Response(JSON.stringify({ error: 'Quota exceeded' }), { status: 403 }),
);
vi.mock('@lib/quotas/errors', () => ({
  quotaExceededResponse: (...a: any[]) => mockQuotaExceededResponse(...a),
}));

const mockAddPublishJob = vi.fn();
vi.mock('@lib/jobs/queue', () => ({
  addPublishJob: (...a: any[]) => mockAddPublishJob(...a),
}));

// ---------------------------------------------------------------------------
// Import handlers AFTER mocks
// ---------------------------------------------------------------------------
import { GET as ListPosts, POST as CreatePost } from '@/pages/api/posts/index';
import { GET as GetPost, PUT as UpdatePost, DELETE as DeletePost } from '@/pages/api/posts/[id]';
import { logActivity } from '@lib/activity/log';

import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A, SAMPLE_POST } from '../helpers/fixtures';

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
// GET /api/posts (list)
// ---------------------------------------------------------------------------

describe('GET /api/posts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The list endpoint does a count query then a data query.
    // We mock the chain so that the first thenable (count) returns [{count: 1}]
    // and subsequent calls return the post data.
    resetChain([]);
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null });
    const res = await ListPosts(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('expands a bare `to` date to end-of-day (from=to must cover the whole day)', async () => {
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([{ count: 0 }]);
      return resolve([]);
    };
    queryChain.limit = vi.fn().mockReturnValue(queryChain);
    queryChain.offset = vi.fn().mockReturnValue(queryChain);

    const ctx = createMockContext({
      user: USER_A,
      organizationId: 1,
      searchParams: { from: '2026-07-27', to: '2026-07-27' },
    });
    await ListPosts(ctx as any);

    const { lte } = await import('drizzle-orm');
    const call = (lte as any).mock.calls.find((c: any[]) => c[0] === 'posts.created_at');
    expect(call).toBeTruthy();
    const bound = call[1] as Date;
    // End of the named UTC day, not its midnight — midnight made from=to a
    // zero-width window (the Overview "Today" tab was permanently empty).
    expect(bound.toISOString()).toBe('2026-07-27T23:59:59.999Z');
  });

  it('treats the Published filter as published + partial (a partial post is live)', async () => {
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([{ count: 0 }]);
      return resolve([]);
    };
    queryChain.limit = vi.fn().mockReturnValue(queryChain);
    queryChain.offset = vi.fn().mockReturnValue(queryChain);

    const ctx = createMockContext({ user: USER_A, organizationId: 1, searchParams: { status: 'published' } });
    await ListPosts(ctx as any);

    const { inArray } = await import('drizzle-orm');
    const call = (inArray as any).mock.calls.find(
      (c: any[]) => Array.isArray(c[1]) && c[1].includes('published'),
    );
    expect(call).toBeTruthy();
    expect(call[1]).toEqual(['published', 'partial']);
  });

  it('keeps a non-aliased status filter as strict equality', async () => {
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([{ count: 0 }]);
      return resolve([]);
    };
    queryChain.limit = vi.fn().mockReturnValue(queryChain);
    queryChain.offset = vi.fn().mockReturnValue(queryChain);

    const ctx = createMockContext({ user: USER_A, organizationId: 1, searchParams: { status: 'processing' } });
    await ListPosts(ctx as any);

    const { eq, inArray } = await import('drizzle-orm');
    expect(
      (eq as any).mock.calls.some((c: any[]) => c[0] === 'posts.status' && c[1] === 'processing'),
    ).toBe(true);
    expect(
      (inArray as any).mock.calls.some((c: any[]) => Array.isArray(c[1]) && c[1].includes('processing')),
    ).toBe(false);
  });

  it('returns 200 with paginated response', async () => {
    // The GET handler does multiple chained queries:
    // 1) count query -> [{count: 1}]
    // 2) post rows (with .limit().offset()) -> [SAMPLE_POST]
    // 3) postPlatforms -> []
    // 4) postLabels -> []
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([{ count: 1 }]); // count query
      if (callCount === 2) return resolve([SAMPLE_POST]); // posts query
      return resolve([]); // postPlatforms, labels, etc.
    };
    // limit() must return the chain so .offset() can be called on it
    queryChain.limit = vi.fn().mockReturnValue(queryChain);
    queryChain.offset = vi.fn().mockReturnValue(queryChain);

    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await ListPosts(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toHaveProperty('posts');
    expect(data).toHaveProperty('total');
    expect(data).toHaveProperty('page');
    expect(data).toHaveProperty('limit');
    expect(data).toHaveProperty('totalPages');
    // Each post includes a metrics field (null when no metrics exist)
    if (data.posts.length > 0) {
      expect(data.posts[0]).toHaveProperty('metrics');
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/posts/[id] (single)
// ---------------------------------------------------------------------------

describe('GET /api/posts/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([SAMPLE_POST]);
  });

  it('returns 404 when post does not belong to org', async () => {
    resetChain([]);
    queryChain.then = (resolve: any) => resolve([]);
    const ctx = createMockContext({
      user: USER_A,
      params: { id: '999' },
      organizationId: 1,
    });
    const res = await GetPost(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it('returns 200 with post data', async () => {
    // First thenable: post query -> [SAMPLE_POST]
    // Subsequent: postPlatforms, labels, media -> []
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([SAMPLE_POST]);
      return resolve([]);
    };

    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      organizationId: 1,
    });
    const res = await GetPost(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.content).toBe(SAMPLE_POST.content);
    expect(data).toHaveProperty('postPlatforms');
    expect(data).toHaveProperty('labels');
  });
});

// ---------------------------------------------------------------------------
// POST /api/posts (create)
// ---------------------------------------------------------------------------

describe('POST /api/posts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([]);
    mockCheckPostQuotasBatch.mockResolvedValue({
      daily: { allowed: true },
      monthly: { allowed: true },
      scheduled: { allowed: true },
      plan: 'pro',
    });
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({
      user: null,
      body: { content: 'Hello', channels: [{ channelId: 1, platform: 'facebook' }] },
    });
    const res = await CreatePost(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns 201 when creating a draft post', async () => {
    const createdPost = {
      ...SAMPLE_POST,
      id: 10,
      content: 'New draft content',
      status: 'draft',
    };

    // Channel ownership check: select().from().where() -> [{id: 1}]
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([{ id: 1 }]); // channel ownership
      return resolve([]);
    };
    queryChain.returning = vi.fn().mockResolvedValue([createdPost]);

    const ctx = createMockContext({
      user: USER_A,
      organizationId: 1,
      body: {
        content: 'New draft content',
        status: 'draft',
        channels: [{ channelId: 1, platform: 'facebook' }],
      },
    });
    const res = await CreatePost(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(201);
    expect(data.content).toBe('New draft content');
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'post.drafted',
      }),
    );
  });

  it('rejects platformContent whose value is an object, not a string (prod regression: content.split crash)', async () => {
    const ctx = createMockContext({
      user: USER_A,
      organizationId: 1,
      body: {
        content: 'Terracid clip',
        status: 'draft',
        channels: [{ channelId: 1, platform: 'youtube' }],
        platformContent: { youtube: { content: 'Terracid clip #fyp' } },
      },
    });
    const res = await CreatePost(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error.code).toBe('VALIDATION_ERROR');
    expect(data.error.message).toMatch(/platformContent\.youtube must be a string/);
  });

  it('rejects an invalid TikTok privacyLevel with a hint (prod regression: "PUBLIC" → TikTok 400 at publish)', async () => {
    const ctx = createMockContext({
      user: USER_A,
      organizationId: 1,
      body: {
        content: 'Terracid clip',
        status: 'draft',
        channels: [{ channelId: 2, platform: 'tiktok' }],
        platformSpecific: { tiktok: { privacyLevel: 'PUBLIC' } },
      },
    });
    const res = await CreatePost(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error.code).toBe('VALIDATION_ERROR');
    expect(data.error.message).toMatch(/Did you mean "PUBLIC_TO_EVERYONE"/);
  });

  it('rejects non-string content (400, not a stored crash)', async () => {
    const ctx = createMockContext({
      user: USER_A,
      organizationId: 1,
      body: {
        content: ['not', 'a', 'string'],
        status: 'draft',
        channels: [{ channelId: 1, platform: 'facebook' }],
      },
    });
    const res = await CreatePost(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error.message).toMatch(/content must be a string/);
  });

  it('rejects a SCHEDULED text-only YouTube post (media required), but the same DRAFT is allowed', async () => {
    // Channel ownership query resolves the youtube channel; no media attached.
    queryChain.then = (resolve: any) => resolve([{ id: 9, platform: 'youtube' }]);

    const scheduledCtx = createMockContext({
      user: USER_A,
      organizationId: 1,
      body: {
        content: '🍽️ Kung Pao Chicken Fajitas',
        status: 'scheduled',
        scheduledAt: '2026-06-01T09:00:00Z',
        channels: [{ channelId: 9, platform: 'youtube' }],
      },
    });
    const scheduledRes = await CreatePost(scheduledCtx as any);
    const scheduled = await parseResponse(scheduledRes);
    expect(scheduled.status).toBe(400);
    expect(scheduled.data.error.code).toBe('VALIDATION_ERROR');
    expect(scheduled.data.error.message).toMatch(/requires a video/i);
    expect(mockAddPublishJob).not.toHaveBeenCalled();

    // The identical post saved as a DRAFT is allowed (work-in-progress).
    queryChain.then = (resolve: any) => resolve([{ id: 9, platform: 'youtube' }]);
    queryChain.returning = vi.fn().mockResolvedValue([{ id: 12, content: 'draft', status: 'draft' }]);
    const draftCtx = createMockContext({
      user: USER_A,
      organizationId: 1,
      body: {
        content: '🍽️ Kung Pao Chicken Fajitas',
        status: 'draft',
        channels: [{ channelId: 9, platform: 'youtube' }],
      },
    });
    const draftRes = await CreatePost(draftCtx as any);
    const draft = await parseResponse(draftRes);
    expect(draft.status).toBe(201);
  });

  it('defaults to keeping media (deleteMediaAfterPublish=false) when the client does not opt in (regression)', async () => {
    queryChain.then = (resolve: any) => resolve([{ id: 1, platform: 'facebook' }]); // channel ownership
    queryChain.returning = vi.fn().mockResolvedValue([{ ...SAMPLE_POST, id: 31, status: 'scheduled' }]);

    const ctx = createMockContext({
      user: USER_A,
      organizationId: 1,
      body: {
        content: 'One-off, no opt-in',
        status: 'scheduled',
        scheduledAt: '2026-06-01T09:00:00Z',
        channels: [{ channelId: 1, platform: 'facebook' }],
        // neither deleteMediaAfterPublish nor repeatSchedule provided
      },
    });
    const res = await CreatePost(ctx as any);
    expect((await parseResponse(res)).status).toBe(201);

    const postInsert = (queryChain.values as any).mock.calls
      .map((c: any[]) => c[0])
      .find((v: any) => v && typeof v === 'object' && !Array.isArray(v) && 'deleteMediaAfterPublish' in v);
    expect(postInsert?.deleteMediaAfterPublish).toBe(false);
  });

  it('rejects a non-numeric channelId with 400, not a DB 500 (prod regression e04d7d6e: client sent the account handle)', async () => {
    // If the guard is missing, the mocked ownership query "succeeds" and the
    // request proceeds — so asserting 400 here pins the pre-query type check.
    const ctx = createMockContext({
      user: USER_A,
      organizationId: 1,
      body: {
        content: 'Hello',
        status: 'draft',
        channels: [{ channelId: 'sk_evo05', platform: 'x' }],
      },
    });
    const res = await CreatePost(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error.code).toBe('VALIDATION_ERROR');
    expect(data.error.message).toContain('numeric channelId');
  });

  it('rejects a fractional or negative channelId with 400 (same bigint guard)', async () => {
    for (const bad of [1.5, -3, null]) {
      const ctx = createMockContext({
        user: USER_A,
        organizationId: 1,
        body: { content: 'Hello', status: 'draft', channels: [{ channelId: bad, platform: 'x' }] },
      });
      const res = await CreatePost(ctx as any);
      expect((await parseResponse(res)).status).toBe(400);
    }
  });

  it('blocks a scheduled post that exceeds the per-day scheduled limit (M11)', async () => {
    queryChain.then = (resolve: any) => resolve([{ id: 1, platform: 'facebook' }]); // channel ownership
    // The per-day scheduled quota is exhausted for the target day.
    mockCheckScheduledPerDayQuota.mockResolvedValueOnce({ allowed: false, current: 30, limit: 30, resource: 'scheduled_per_day' });

    const ctx = createMockContext({
      user: USER_A,
      organizationId: 1,
      body: {
        content: 'One too many for the day',
        status: 'scheduled',
        scheduledAt: '2026-06-01T09:00:00Z',
        channels: [{ channelId: 1, platform: 'facebook' }],
      },
    });
    const res = await CreatePost(ctx as any);
    expect((await parseResponse(res)).status).toBe(403);
    expect(mockQuotaExceededResponse).toHaveBeenCalledWith(
      expect.objectContaining({ resource: 'scheduled_per_day', allowed: false }),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/posts/[id]
// ---------------------------------------------------------------------------

describe('PUT /api/posts/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([SAMPLE_POST]);
  });

  // The capability an API client reported as missing: promoting an existing draft
  // to scheduled. It works — on PUT, which is the documented update verb. PATCH is
  // a separate, narrow endpoint (see its own describe block below).
  it('promotes a draft to scheduled when given status + a future scheduledAt', async () => {
    const draft = { ...SAMPLE_POST, status: 'draft', scheduledAt: null };
    resetChain([draft]);
    queryChain.then = (resolve: any) => resolve([draft]);

    const future = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      organizationId: 1,
      body: { status: 'scheduled', scheduledAt: future },
    });
    const res = await UpdatePost(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
    expect(queryChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'scheduled', scheduledAt: new Date(future) }),
    );
  });

  it('refuses to schedule a draft into the past', async () => {
    const draft = { ...SAMPLE_POST, status: 'draft', scheduledAt: null };
    resetChain([draft]);
    queryChain.then = (resolve: any) => resolve([draft]);

    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      organizationId: 1,
      body: { status: 'scheduled', scheduledAt: '2020-01-01T00:00:00.000Z' },
    });
    const res = await UpdatePost(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error.message).toMatch(/future date/i);
  });

  it('accepts deleteMediaAfterPublish=true for a non-recurring post', async () => {
    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      organizationId: 1,
      body: { deleteMediaAfterPublish: true },
    });
    const res = await UpdatePost(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
    expect(queryChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ deleteMediaAfterPublish: true }),
    );
  });

  // Status transitions: editing may move a post between draft and scheduled. Previously
  // `status` was silently ignored, so scheduling a draft left it stuck as a draft.
  it('schedules a draft when status:scheduled is sent with a future time', async () => {
    // Extra `platform` field lets the effective-platforms select resolve a real platform.
    resetChain([{ ...SAMPLE_POST, status: 'draft', platform: 'facebook' }]);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      organizationId: 1,
      body: { status: 'scheduled', scheduledAt: future },
    });
    const res = await UpdatePost(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
    expect(queryChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'scheduled' }),
    );
  });

  it('rejects scheduling a draft with no future time (400)', async () => {
    resetChain([{ ...SAMPLE_POST, status: 'draft', scheduledAt: null }]);
    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      organizationId: 1,
      body: { status: 'scheduled' },
    });
    const res = await UpdatePost(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error.message).toMatch(/future date and time/i);
  });

  it('unschedules a scheduled post when status:draft is sent', async () => {
    resetChain([{ ...SAMPLE_POST, status: 'scheduled', scheduledAt: new Date('2099-01-01') }]);
    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      organizationId: 1,
      body: { status: 'draft' },
    });
    const res = await UpdatePost(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
    expect(queryChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'draft' }),
    );
  });

  it('rejects an unsupported status transition (400)', async () => {
    resetChain([{ ...SAMPLE_POST, status: 'draft' }]);
    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      organizationId: 1,
      body: { status: 'published' },
    });
    const res = await UpdatePost(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error.message).toMatch(/draft or scheduled/i);
  });
});

describe('DELETE /api/posts/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([SAMPLE_POST]);
  });

  it('returns 404 when post does not belong to org', async () => {
    resetChain([]);
    queryChain.then = (resolve: any) => resolve([]);
    const ctx = createMockContext({
      user: USER_A,
      params: { id: '999' },
      organizationId: 1,
    });
    const res = await DeletePost(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it('returns 200 when deleting a post', async () => {
    queryChain.then = (resolve: any) => resolve([SAMPLE_POST]);
    const ctx = createMockContext({
      user: USER_A,
      params: { id: '1' },
      organizationId: 1,
    });
    const res = await DeletePost(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'post.deleted',
        resourceId: 1,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Role floor: `viewer` is read-only (audit F5)
// ---------------------------------------------------------------------------
// Every write verb requires `post:create`. Before this gate, a viewer could
// create pending posts and burn the org's postsPerMonth quota — reads stay open.
describe('viewer role is read-only on the posts surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([]);
  });

  const asViewer = (extra: Record<string, unknown> = {}) =>
    createMockContext({
      user: USER_A,
      organizationId: 1,
      organizationRole: 'viewer',
      ...extra,
    });

  it('403s POST /api/posts before any quota is consumed', async () => {
    const res = await CreatePost(
      asViewer({ body: { content: 'Hi', channels: [{ channelId: 1, platform: 'facebook' }] } }) as any,
    );
    const { status, data } = await parseResponse(res);
    expect(status).toBe(403);
    expect(data.error.code).toBe('FORBIDDEN');
    expect(mockCheckPostQuotasBatch).not.toHaveBeenCalled();
  });

  it('403s PUT and DELETE on /api/posts/[id]', async () => {
    for (const handler of [UpdatePost, DeletePost]) {
      const res = await handler(asViewer({ params: { id: '5' }, body: { content: 'x' } }) as any);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(403);
      expect(data.error.code).toBe('FORBIDDEN');
    }
  });

  it('still allows GET (list and single)', async () => {
    resetChain([]);
    const list = await ListPosts(asViewer({ searchParams: {} }) as any);
    expect((await parseResponse(list)).status).not.toBe(403);
  });

  it('contributor (the weakest writing role) can still reach the create path', async () => {
    mockCheckPostQuotasBatch.mockResolvedValue({
      daily: { allowed: false },
      monthly: { allowed: true },
      scheduled: { allowed: true },
      plan: 'free',
    });
    // Reaching the quota check proves the role gate passed — the response here
    // is this file's mocked quotaExceededResponse, not the role 403.
    const res = await CreatePost(
      createMockContext({
        user: USER_A,
        organizationId: 1,
        organizationRole: 'contributor',
        body: { content: 'Hi', channels: [] },
      }) as any,
    );
    expect(mockCheckPostQuotasBatch).toHaveBeenCalled();
    expect(mockQuotaExceededResponse).toHaveBeenCalled();
    expect(res).toBeDefined();
  });
});
