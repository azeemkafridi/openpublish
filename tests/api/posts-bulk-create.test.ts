/**
 * Tests for the Bulk Create API.
 *
 *   POST /api/posts/bulk-create — create many posts in one request
 *
 * Focus: batch validation, quota blocking (block-with-remaining), the
 * "Add to queue" slot assignment, and per-post "Repeat" recurring schedules.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mutable state shared with the hoisted db mock + the vi.fn dependency mocks
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  ownedChannels: [] as { id: number; platform: string }[],
  ownedMedia: [] as { id: number }[],
  insertedPosts: [] as { id: number }[],
  txInserts: {} as Record<string, unknown[]>,
}));

const m = vi.hoisted(() => ({
  checkPostQuotasBatch: vi.fn(),
  checkPlatformAllowed: vi.fn(),
  checkRecurringScheduleQuota: vi.fn(),
  checkScheduledPerDayQuota: vi.fn(),
  checkMediaStorageQuota: vi.fn(),
  findNextQueueSlots: vi.fn(),
  calculateNextRunAt: vi.fn(),
  addPublishJob: vi.fn(),
  logActivity: vi.fn(),
  captureApiError: vi.fn(),
  rehostUrlToMedia: vi.fn(),
  validatePostMediaForPlatforms: vi.fn((..._a: any[]): any[] => []),
}));

// ---------------------------------------------------------------------------
// vi.mock (hoisted)
// ---------------------------------------------------------------------------
vi.mock('@lib/db', () => {
  const makeSelect = () => {
    const chain: any = {};
    chain.from = (t: any) => { chain._t = t?.__table; return chain; };
    chain.where = () => chain;
    chain.then = (resolve: any) =>
      resolve(chain._t === 'channels' ? h.ownedChannels : chain._t === 'media_files' ? h.ownedMedia : []);
    return chain;
  };
  const values = (t: any) => ({
    returning: () =>
      Promise.resolve(t?.__table === 'posts' ? h.insertedPosts : t?.__table === 'recurring_schedules' ? [{ id: 900 }] : []),
    then: (resolve: any) => resolve(undefined),
  });
  const tx = {
    insert: (t: any) => ({ values: (v: any) => { (h.txInserts[t?.__table] ||= []).push(v); return values(t); } }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  };
  return {
    db: {
      select: () => makeSelect(),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      transaction: (cb: any) => cb(tx),
    },
  };
});

vi.mock('@lib/db/schema', () => ({
  posts: { __table: 'posts', id: 'p.id', organizationId: 'p.org', status: 'p.status', scheduledAt: 'p.sched' },
  postPlatforms: { __table: 'post_platforms' },
  channels: { __table: 'channels', id: 'c.id', organizationId: 'c.org', platform: 'c.platform' },
  mediaFiles: { __table: 'media_files', id: 'mf.id', organizationId: 'mf.org' },
  recurringSchedules: { __table: 'recurring_schedules', id: 'rs.id', organizationId: 'rs.org', isActive: 'rs.active' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: any[]) => ({ eq: a }),
  and: (...a: any[]) => ({ and: a }),
  inArray: (...a: any[]) => ({ inArray: a }),
  gte: (...a: any[]) => ({ gte: a }),
  lte: (...a: any[]) => ({ lte: a }),
  sql: (s: any, ...v: any[]) => ({ sql: s, v }),
}));

vi.mock('@lib/jobs/queue', () => ({ addPublishJob: (...a: any[]) => m.addPublishJob(...a) }));
vi.mock('@lib/queue/scheduler', () => ({ findNextQueueSlots: (...a: any[]) => m.findNextQueueSlots(...a) }));
vi.mock('@lib/schedules/next-run', () => ({ calculateNextRunAt: (...a: any[]) => m.calculateNextRunAt(...a) }));
vi.mock('@lib/quotas/check', () => ({
  checkPostQuotasBatch: (...a: any[]) => m.checkPostQuotasBatch(...a),
  checkPlatformAllowed: (...a: any[]) => m.checkPlatformAllowed(...a),
  checkRecurringScheduleQuota: (...a: any[]) => m.checkRecurringScheduleQuota(...a),
  checkScheduledPerDayQuota: (...a: any[]) => m.checkScheduledPerDayQuota(...a),
  checkMediaStorageQuota: (...a: any[]) => m.checkMediaStorageQuota(...a),
}));
vi.mock('@lib/activity/log', () => ({ logActivity: (...a: any[]) => m.logActivity(...a) }));
vi.mock('@lib/errors', () => ({ captureApiError: (...a: any[]) => m.captureApiError(...a) }));
vi.mock('@lib/platforms/validation', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  PLATFORM_CHAR_LIMITS: { facebook: 63206, twitter: 280, youtube: 5000 },
  validatePostMediaForPlatforms: (...a: any[]) => m.validatePostMediaForPlatforms(...a),
}));
vi.mock('@lib/media/remote', () => ({
  rehostUrlToMedia: (...a: any[]) => m.rehostUrlToMedia(...a),
  RemoteMediaError: class RemoteMediaError extends Error {},
}));

// ---------------------------------------------------------------------------
// Import handler AFTER mocks
// ---------------------------------------------------------------------------
import { POST } from '@/pages/api/posts/bulk-create';
import { RemoteMediaError } from '@lib/media/remote';
import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A } from '../helpers/fixtures';

const unlimited = (resource: string) => ({ allowed: true, current: 0, limit: -1, resource });

function ctxWith(body: unknown, user: any = USER_A) {
  return createMockContext({ user, organizationId: 1, method: 'POST', body }) as any;
}

describe('POST /api/posts/bulk-create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.ownedChannels = [{ id: 10, platform: 'facebook' }];
    h.ownedMedia = [];
    h.insertedPosts = [];
    h.txInserts = {};
    m.checkPostQuotasBatch.mockResolvedValue({
      plan: 'pro',
      daily: unlimited('posts_per_day'),
      monthly: unlimited('posts_per_month'),
      scheduled: unlimited('pending_scheduled'),
    });
    m.checkPlatformAllowed.mockResolvedValue({ allowed: true });
    m.checkRecurringScheduleQuota.mockResolvedValue({ allowed: true, current: 0, limit: -1, resource: 'recurring_schedules' });
    m.checkScheduledPerDayQuota.mockResolvedValue({ allowed: true, current: 0, limit: -1, resource: 'scheduled_per_day' });
    m.calculateNextRunAt.mockReturnValue(new Date('2026-06-01T09:00:00Z'));
    m.addPublishJob.mockResolvedValue(undefined);
    m.checkMediaStorageQuota.mockResolvedValue({ allowed: true, current: 10, limit: 2048, resource: 'media_storage' });
    m.rehostUrlToMedia.mockResolvedValue({ id: 777, originalPath: 'original/x.jpg', fileName: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: 100, thumbnailPath: null, previewPath: null });
    m.validatePostMediaForPlatforms.mockReturnValue([]);
  });

  it('returns 401 when not authenticated', async () => {
    const res = await POST(ctxWith({ posts: [] }, null));
    const { status, data } = await parseResponse(res);
    expect(status).toBe(401);
    expect(data.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 400 when no posts are provided', async () => {
    const res = await POST(ctxWith({ defaults: { channels: [{ channelId: 10 }] }, posts: [] }));
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error.code).toBe('VALIDATION_ERROR');
  });

  it('creates scheduled posts and reports the count', async () => {
    h.insertedPosts = [{ id: 101 }, { id: 102 }];
    const res = await POST(ctxWith({
      defaults: { channels: [{ channelId: 10 }], timezone: 'UTC', status: 'scheduled' },
      posts: [
        { content: 'first', scheduledAt: '2026-06-01T09:00:00Z' },
        { content: 'second', scheduledAt: '2026-06-02T09:00:00Z' },
      ],
    }));
    const { status, data } = await parseResponse(res);
    expect(status).toBe(201);
    expect(data.count).toBe(2);
    expect(data.created).toHaveLength(2);
    // Two posts inserted in one batch; no queue or recurring work.
    expect((h.txInserts.posts?.[0] as unknown[]).length).toBe(2);
    expect(m.findNextQueueSlots).not.toHaveBeenCalled();
    expect(h.txInserts.recurring_schedules).toBeUndefined();
  });

  it('"Add to queue" assigns each post a slot from findNextQueueSlots', async () => {
    h.insertedPosts = [{ id: 201 }, { id: 202 }];
    m.findNextQueueSlots.mockResolvedValue([
      { scheduledAt: '2026-06-01T10:00:00Z', dayLabel: 'Mon' },
      { scheduledAt: '2026-06-02T13:00:00Z', dayLabel: 'Tue' },
    ]);
    const res = await POST(ctxWith({
      defaults: { channels: [{ channelId: 10 }], timezone: 'America/New_York', status: 'scheduled', useQueue: true },
      posts: [{ content: 'a' }, { content: 'b' }], // no scheduledAt — queue assigns it
    }));
    const { status, data } = await parseResponse(res);
    expect(status).toBe(201);
    expect(data.count).toBe(2);
    expect(m.findNextQueueSlots).toHaveBeenCalledWith(1, 'America/New_York', 2);
    // The inserted rows carry the assigned slot times.
    const rows = h.txInserts.posts?.[0] as { scheduledAt: Date | null }[];
    expect(rows[0].scheduledAt?.toISOString()).toBe('2026-06-01T10:00:00.000Z');
    expect(rows[1].scheduledAt?.toISOString()).toBe('2026-06-02T13:00:00.000Z');
  });

  it('returns 409 when the queue has no open slots', async () => {
    m.findNextQueueSlots.mockRejectedValue(new Error('Only 0 open queue slot(s) in the next 7 days — not enough for 2 posts.'));
    const res = await POST(ctxWith({
      defaults: { channels: [{ channelId: 10 }], timezone: 'UTC', status: 'scheduled', useQueue: true },
      posts: [{ content: 'a' }, { content: 'b' }],
    }));
    const { status, data } = await parseResponse(res);
    expect(status).toBe(409);
    expect(data.error.code).toBe('NO_QUEUE_SLOTS');
    expect(data.error.message).toContain('Only 0 open queue');
  });

  it('"Repeat" creates one recurring schedule per scheduled post', async () => {
    h.insertedPosts = [{ id: 301 }, { id: 302 }];
    const res = await POST(ctxWith({
      defaults: { channels: [{ channelId: 10 }], timezone: 'UTC', status: 'scheduled', repeatSchedule: { frequency: 'daily' } },
      posts: [
        { content: 'a', scheduledAt: '2026-06-01T09:00:00Z' },
        { content: 'b', scheduledAt: '2026-06-02T09:00:00Z' },
      ],
    }));
    const { status } = await parseResponse(res);
    expect(status).toBe(201);
    expect(m.checkRecurringScheduleQuota).toHaveBeenCalledWith(1);
    expect(h.txInserts.recurring_schedules).toHaveLength(2);
    expect(m.calculateNextRunAt).toHaveBeenCalledTimes(2);
    // Daily frequency carries through with no weekday/day-of-month.
    const sched = h.txInserts.recurring_schedules?.[0] as { frequency: string; dayOfWeek: number | null };
    expect(sched.frequency).toBe('daily');
    expect(sched.dayOfWeek).toBeNull();
  });

  it('keeps media for every bulk post — one-off and repeating (regression)', async () => {
    // Media is reclaimed by the 3-month retention sweep, not deleted right after
    // publishing, so bulk posts never set delete-after-publish (repeats especially
    // need it — the recurring schedule re-uses the same media every run).
    h.insertedPosts = [{ id: 311 }, { id: 312 }];
    await POST(ctxWith({
      defaults: { channels: [{ channelId: 10 }], timezone: 'UTC', status: 'scheduled', repeatSchedule: { frequency: 'daily' } },
      posts: [
        { content: 'a', scheduledAt: '2026-06-01T09:00:00Z' },
        { content: 'b', scheduledAt: '2026-06-02T09:00:00Z' },
      ],
    }));
    const repeatRows = h.txInserts.posts?.[0] as { deleteMediaAfterPublish: boolean }[];
    expect(repeatRows.every((r) => r.deleteMediaAfterPublish === false)).toBe(true);

    h.txInserts = {};
    h.insertedPosts = [{ id: 321 }];
    await POST(ctxWith({
      defaults: { channels: [{ channelId: 10 }], timezone: 'UTC', status: 'scheduled' },
      posts: [{ content: 'c', scheduledAt: '2026-06-03T09:00:00Z' }],
    }));
    const oneOffRows = h.txInserts.posts?.[0] as { deleteMediaAfterPublish: boolean }[];
    expect(oneOffRows[0].deleteMediaAfterPublish).toBe(false);
  });

  it('blocks the batch when recurring-schedule quota would be exceeded', async () => {
    m.checkRecurringScheduleQuota.mockResolvedValue({ allowed: false, current: 5, limit: 5, resource: 'recurring_schedules' });
    const res = await POST(ctxWith({
      defaults: { channels: [{ channelId: 10 }], timezone: 'UTC', status: 'scheduled', repeatSchedule: { frequency: 'weekly' } },
      posts: [
        { content: 'a', scheduledAt: '2026-06-01T09:00:00Z' },
        { content: 'b', scheduledAt: '2026-06-02T09:00:00Z' },
      ],
    }));
    const { status, data } = await parseResponse(res);
    expect(status).toBe(409);
    expect(data.error.code).toBe('QUOTA_EXCEEDED');
    expect(data.quota.resource).toBe('recurring_schedules');
    expect(data.quota.requested).toBe(2);
    expect(data.quota.remaining).toBe(0);
    // Nothing should have been inserted.
    expect(h.txInserts.recurring_schedules).toBeUndefined();
  });

  it('blocks the batch and reports remaining when the daily post quota is exceeded', async () => {
    m.checkPostQuotasBatch.mockResolvedValue({
      plan: 'free',
      daily: { allowed: false, current: 3, limit: 3, resource: 'posts_per_day' },
      monthly: unlimited('posts_per_month'),
      scheduled: unlimited('pending_scheduled'),
    });
    const res = await POST(ctxWith({
      defaults: { channels: [{ channelId: 10 }], timezone: 'UTC', status: 'scheduled' },
      posts: [
        { content: 'a', scheduledAt: '2026-06-01T09:00:00Z' },
        { content: 'b', scheduledAt: '2026-06-02T09:00:00Z' },
      ],
    }));
    const { status, data } = await parseResponse(res);
    expect(status).toBe(409);
    expect(data.error.code).toBe('QUOTA_EXCEEDED');
    expect(data.quota.resource).toBe('posts_per_day');
    expect(data.quota.remaining).toBe(0);
  });

  it('re-hosts CSV media URLs and attaches them to the post', async () => {
    h.insertedPosts = [{ id: 401 }];
    m.rehostUrlToMedia.mockResolvedValue({ id: 777, originalPath: 'original/x.jpg', fileName: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: 100, thumbnailPath: null, previewPath: null });
    const res = await POST(ctxWith({
      defaults: { channels: [{ channelId: 10 }], timezone: 'UTC', status: 'scheduled' },
      posts: [{ content: 'with media', scheduledAt: '2026-06-01T09:00:00Z', mediaUrls: ['https://cdn.example.com/a.jpg'] }],
    }));
    const { status } = await parseResponse(res);
    expect(status).toBe(201);
    expect(m.rehostUrlToMedia).toHaveBeenCalledWith('https://cdn.example.com/a.jpg', 'user-a', 1);
    const rows = h.txInserts.posts?.[0] as { mediaFiles: number[] }[];
    expect(rows[0].mediaFiles).toContain(777);
  });

  it('returns 403 when media storage is over quota before re-hosting any URL', async () => {
    m.checkMediaStorageQuota.mockResolvedValue({ allowed: false, current: 2048, limit: 2048, resource: 'media_storage' });
    const res = await POST(ctxWith({
      defaults: { channels: [{ channelId: 10 }], timezone: 'UTC', status: 'scheduled' },
      posts: [{ content: 'with media', scheduledAt: '2026-06-01T09:00:00Z', mediaUrls: ['https://cdn.example.com/a.jpg'] }],
    }));
    const { status, data } = await parseResponse(res);
    expect(status).toBe(403);
    expect(data.error.code).toBe('QUOTA_EXCEEDED');
    expect(data.error.resource).toBe('media_storage');
    expect(m.rehostUrlToMedia).not.toHaveBeenCalled();
  });

  it('returns 400 when a CSV media URL cannot be re-hosted', async () => {
    m.rehostUrlToMedia.mockRejectedValue(new RemoteMediaError('host is not allowed'));
    const res = await POST(ctxWith({
      defaults: { channels: [{ channelId: 10 }], timezone: 'UTC', status: 'scheduled' },
      posts: [{ content: 'bad media', scheduledAt: '2026-06-01T09:00:00Z', mediaUrls: ['http://169.254.169.254/x'] }],
    }));
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error.code).toBe('MEDIA_URL_ERROR');
    expect(data.error.message).toContain('host is not allowed');
  });

  it('rejects a scheduled media-required post (e.g. text-only YouTube) with a per-post error', async () => {
    h.ownedChannels = [{ id: 20, platform: 'youtube' }];
    m.validatePostMediaForPlatforms.mockReturnValue([
      { platform: 'youtube', field: 'media', message: 'youtube video requires a video (no media attached)' },
    ]);
    const res = await POST(ctxWith({
      defaults: { channels: [{ channelId: 20 }], timezone: 'UTC', status: 'scheduled' },
      posts: [{ content: '🍽️ Kung Pao Chicken Fajitas', scheduledAt: '2026-06-01T09:00:00Z' }],
    }));
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error.code).toBe('VALIDATION_ERROR');
    expect(data.error.message).toMatch(/^Post 1:/);
    expect(data.error.message).toMatch(/requires a video/i);
    // Nothing should have been inserted.
    expect(h.txInserts.posts).toBeUndefined();
  });

  it('does not media-validate draft posts (drafts may be incomplete)', async () => {
    h.ownedChannels = [{ id: 20, platform: 'youtube' }];
    h.insertedPosts = [{ id: 501 }];
    const res = await POST(ctxWith({
      defaults: { channels: [{ channelId: 20 }], timezone: 'UTC', status: 'draft' },
      posts: [{ content: 'Draft YouTube idea, video coming later' }],
    }));
    const { status } = await parseResponse(res);
    expect(status).toBe(201);
    expect(m.validatePostMediaForPlatforms).not.toHaveBeenCalled();
  });
});

export {};
