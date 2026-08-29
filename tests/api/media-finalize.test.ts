/**
 * Tests for POST /api/media/finalize — step 2 of the direct-to-R2 browser upload.
 * The client is not trusted: key ownership, object existence/size, magic bytes,
 * and quota are all verified server-side; bad uploads are deleted.
 */

import { createDbMock, createDrizzleOrmMock } from '../helpers/db-mock';

const { db: mockDb, setResult, resetChain } = createDbMock();
vi.mock('@/lib/db', () => ({ db: mockDb }));
vi.mock('@/lib/db/schema', () => ({ mediaFiles: { id: 'mf.id' } }));
vi.mock('drizzle-orm', () => createDrizzleOrmMock());

vi.mock('@/lib/media/upload', () => ({
  getMediaPublicUrl: (k: string) => `https://images.bulkpublish.com/${k}`,
}));

const mockHeadR2Object = vi.fn();
const mockGetR2ObjectTail = vi.fn().mockResolvedValue(null);
const mockGetR2ObjectRange = vi.fn();
const mockDeleteFromR2 = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/media/r2', () => ({
  headR2Object: (...a: any[]) => mockHeadR2Object(...a),
  getR2ObjectRange: (...a: any[]) => mockGetR2ObjectRange(...a),
  getR2ObjectTail: (...a: any[]) => mockGetR2ObjectTail(...a),
  deleteFromR2: (...a: any[]) => mockDeleteFromR2(...a),
}));

const mockAddMediaThumbnailJob = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/jobs/queue', () => ({
  addMediaThumbnailJob: (...a: any[]) => mockAddMediaThumbnailJob(...a),
}));

vi.mock('@/lib/activity/log', () => ({ logActivity: vi.fn() }));

const mockCheckMediaStorageQuota = vi.fn();
vi.mock('@/lib/quotas/check', () => ({
  checkMediaStorageQuota: (...a: any[]) => mockCheckMediaStorageQuota(...a),
  getOrgPlan: vi.fn().mockResolvedValue('pro'),
}));

vi.mock('@/lib/quotas/errors', () => ({
  quotaExceededResponse: vi.fn(() => new Response(JSON.stringify({ error: 'Quota exceeded' }), { status: 403 })),
}));

vi.mock('@/lib/errors', () => ({ captureApiError: vi.fn() }));

import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A } from '../helpers/fixtures';

// Dynamic imports AFTER mocks: the @/lib/db factory returns `mockDb` eagerly, so
// the route (which imports @/lib/db) must load only once mockDb is initialised.
const { POST } = await import('@/pages/api/media/finalize');
const { logActivity } = await import('@/lib/activity/log');

// A key shaped exactly like presign issues, for org 1.
const VALID_KEY = `original/1/1716240000000-${'a'.repeat(32)}.webp`;
const WEBP_MAGIC = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0]);

function ctxWithBody(body: unknown, opts: { user?: any; organizationId?: number } = {}) {
  const user = 'user' in opts ? opts.user : USER_A;
  const ctx = createMockContext({ user, organizationId: opts.organizationId ?? 1, method: 'POST' });
  (ctx.request as any).json = vi.fn().mockResolvedValue(body);
  return ctx;
}

function validBody(overrides: Record<string, unknown> = {}) {
  return { r2Key: VALID_KEY, fileName: 'photo.png', mimeType: 'image/webp', sizeBytes: 4096, width: 800, height: 600, ...overrides };
}

describe('POST /api/media/finalize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain();
    setResult([{ id: 99, width: 800, height: 600, duration: null }]);
    mockCheckMediaStorageQuota.mockResolvedValue({ allowed: true });
    mockHeadR2Object.mockResolvedValue({ contentType: 'image/webp', contentLength: 4096 });
    mockGetR2ObjectRange.mockResolvedValue(WEBP_MAGIC);
  });

  it('returns 401 when not authenticated', async () => {
    const { status } = await parseResponse(await POST(ctxWithBody(validBody(), { user: null }) as any));
    expect(status).toBe(401);
  });

  it('returns 400 on invalid JSON body', async () => {
    const ctx = createMockContext({ user: USER_A, method: 'POST' });
    (ctx.request as any).json = vi.fn().mockRejectedValue(new Error('bad'));
    const { status } = await parseResponse(await POST(ctx as any));
    expect(status).toBe(400);
  });

  it('returns 400 when fileName is missing', async () => {
    const { status } = await parseResponse(await POST(ctxWithBody(validBody({ fileName: '' })) as any));
    expect(status).toBe(400);
  });

  it('returns 400 for a disallowed mime type', async () => {
    const { status, data } = await parseResponse(await POST(ctxWithBody(validBody({ mimeType: 'application/pdf' })) as any));
    expect(status).toBe(400);
    expect(data.error).toContain('not allowed');
  });

  it('returns 400 for invalid size', async () => {
    const { status } = await parseResponse(await POST(ctxWithBody(validBody({ sizeBytes: 0 })) as any));
    expect(status).toBe(400);
  });

  it('rejects a key belonging to another org', async () => {
    const otherOrgKey = `original/2/1716240000000-${'b'.repeat(32)}.webp`;
    const { status, data } = await parseResponse(await POST(ctxWithBody(validBody({ r2Key: otherOrgKey }), { organizationId: 1 }) as any));
    expect(status).toBe(400);
    expect(data.error).toContain('Invalid upload key');
    expect(mockHeadR2Object).not.toHaveBeenCalled();
  });

  it('rejects a malformed key (path traversal / wrong shape)', async () => {
    for (const bad of ['original/1/../secret.webp', 'thumbnails/1/x.webp', 'original/1/notrandom.webp', '/etc/passwd']) {
      const { status } = await parseResponse(await POST(ctxWithBody(validBody({ r2Key: bad })) as any));
      expect(status).toBe(400);
    }
  });

  it('returns 400 when the object does not exist in R2', async () => {
    mockHeadR2Object.mockResolvedValue(null);
    const { status, data } = await parseResponse(await POST(ctxWithBody(validBody()) as any));
    expect(status).toBe(400);
    expect(data.error).toContain('not found');
  });

  it('deletes and rejects an oversized object', async () => {
    mockHeadR2Object.mockResolvedValue({ contentType: 'image/webp', contentLength: 200 * 1024 * 1024 });
    const { status } = await parseResponse(await POST(ctxWithBody(validBody()) as any));
    expect(status).toBe(400);
    expect(mockDeleteFromR2).toHaveBeenCalledWith(VALID_KEY);
  });

  it('deletes and rejects when the stored bytes do not match the declared type', async () => {
    mockGetR2ObjectRange.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])); // PNG, not WebP
    const { status, data } = await parseResponse(await POST(ctxWithBody(validBody()) as any));
    expect(status).toBe(400);
    expect(data.error).toContain('does not match');
    expect(mockDeleteFromR2).toHaveBeenCalledWith(VALID_KEY);
  });

  it('deletes and rejects when quota is exceeded at finalize', async () => {
    mockCheckMediaStorageQuota.mockResolvedValue({ allowed: false, current: 100, limit: 100 });
    const { status } = await parseResponse(await POST(ctxWithBody(validBody()) as any));
    expect(status).toBe(403);
    expect(mockDeleteFromR2).toHaveBeenCalledWith(VALID_KEY);
  });

  it('creates the row, queues thumbnails, logs activity, and returns the file (image)', async () => {
    const res = await POST(ctxWithBody(validBody()) as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(201);
    expect(data.file.id).toBe(99);
    expect(data.file.originalUrl).toContain(VALID_KEY);
    expect(data.file.thumbnailUrl).toBeNull();
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(mockAddMediaThumbnailJob).toHaveBeenCalledWith(99);
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'media.uploaded', resourceId: 99 }));
  });

  it('uses the real R2 size, not the client-claimed size', async () => {
    mockHeadR2Object.mockResolvedValue({ contentType: 'image/webp', contentLength: 7777 });
    const { data } = await parseResponse(await POST(ctxWithBody(validBody({ sizeBytes: 4096 })) as any));
    expect(data.file.sizeBytes).toBe(7777);
  });

  it('does NOT reject a video when the moov ranged reads fail (fail open, keep the upload)', async () => {
    // Both range helpers return null on a transient R2 error; treating that as
    // "no moov" deleted valid uploads. The magic-byte header read succeeds,
    // then the moov head-window read fails.
    const videoKey = `original/1/1716240000000-${'d'.repeat(32)}.mp4`;
    mockHeadR2Object.mockResolvedValue({ contentType: 'video/mp4', contentLength: 4096 });
    mockGetR2ObjectRange
      .mockResolvedValueOnce(Buffer.from([0, 0, 0, 0x0c, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0])) // 16-byte header check
      .mockResolvedValueOnce(null); // moov head-window read fails
    const { status } = await parseResponse(
      await POST(ctxWithBody(validBody({ r2Key: videoKey, mimeType: 'video/mp4', fileName: 'clip.mp4' })) as any),
    );
    expect(status).toBe(201);
    expect(mockDeleteFromR2).not.toHaveBeenCalled();
  });

  it('rejects a large video whose head has no moov only when the tail read also succeeded', async () => {
    const videoKey = `original/1/1716240000000-${'e'.repeat(32)}.mp4`;
    // Larger than the 256KB window, so the tail read is required.
    mockHeadR2Object.mockResolvedValue({ contentType: 'video/mp4', contentLength: 10 * 1024 * 1024 });
    mockGetR2ObjectRange.mockResolvedValue(Buffer.from([0, 0, 0, 0x0c, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0])); // no moov in head
    // Tail read fails → must NOT reject
    mockGetR2ObjectTail.mockResolvedValueOnce(null);
    let res = await parseResponse(
      await POST(ctxWithBody(validBody({ r2Key: videoKey, mimeType: 'video/mp4', fileName: 'clip.mp4' })) as any),
    );
    expect(res.status).toBe(201);
    expect(mockDeleteFromR2).not.toHaveBeenCalled();

    // Tail read succeeds and has no moov either → reject + delete
    mockGetR2ObjectTail.mockResolvedValueOnce(Buffer.from([0, 0, 0, 0x08, 0x6d, 0x64, 0x61, 0x74])); // mdat only
    res = await parseResponse(
      await POST(ctxWithBody(validBody({ r2Key: videoKey, mimeType: 'video/mp4', fileName: 'clip.mp4' })) as any),
    );
    expect(res.status).toBe(400);
    expect(String(res.data.error)).toContain('moov');
    expect(mockDeleteFromR2).toHaveBeenCalledWith(videoKey);
  });

  it('queues derivative generation for a video upload (poster frame)', async () => {
    const videoKey = `original/1/1716240000000-${'c'.repeat(32)}.mp4`;
    mockHeadR2Object.mockResolvedValue({ contentType: 'video/mp4', contentLength: 4096 });
    // A complete faststart-style fixture: ftyp then a moov box — the finalize
    // moov check ranged-reads the head window and must find the fourcc.
    mockGetR2ObjectRange.mockResolvedValue(
      Buffer.from([0, 0, 0, 0x0c, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0, 0, 0, 0, 0x08, 0x6d, 0x6f, 0x6f, 0x76]),
    );
    const { status } = await parseResponse(
      await POST(ctxWithBody(validBody({ r2Key: videoKey, mimeType: 'video/mp4', fileName: 'clip.mp4' })) as any),
    );
    expect(status).toBe(201);
    // ffmpeg extracts a poster frame in the worker, so videos enqueue too.
    expect(mockAddMediaThumbnailJob).toHaveBeenCalled();
  });
});

export {};
