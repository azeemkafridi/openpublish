/**
 * Tests for the chunked (multipart) direct-to-R2 upload endpoints:
 *   POST /api/media/multipart/create   — validations + per-part presigned URLs
 *   POST /api/media/multipart/complete — assembly + shared finalize verification
 *   POST /api/media/multipart/abort    — ownership-gated cancel
 */

const mockCreateMultipart = vi.fn();
const mockGetPartUrl = vi.fn();
const mockCompleteMultipart = vi.fn();
const mockAbortMultipart = vi.fn();
vi.mock('@/lib/media/r2', () => ({
  createMultipartUpload: (...a: any[]) => mockCreateMultipart(...a),
  getPresignedPartUrl: (...a: any[]) => mockGetPartUrl(...a),
  completeMultipartUpload: (...a: any[]) => mockCompleteMultipart(...a),
  abortMultipartUpload: (...a: any[]) => mockAbortMultipart(...a),
}));

const mockVerifyAndRecord = vi.fn();
vi.mock('@/lib/media/finalize-object', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    orgFromKey: actual.orgFromKey,
    verifyAndRecordUpload: (...a: any[]) => mockVerifyAndRecord(...a),
  };
});

const mockCheckStorage = vi.fn();
vi.mock('@/lib/quotas/check', () => ({
  checkMediaStorageQuota: (...a: any[]) => mockCheckStorage(...a),
  getOrgPlan: vi.fn().mockResolvedValue('pro'),
}));
vi.mock('@/lib/quotas/errors', () => ({
  quotaExceededResponse: () => new Response(JSON.stringify({ error: 'Quota exceeded' }), { status: 429 }),
}));
vi.mock('@/lib/errors', () => ({ captureApiError: vi.fn() }));
// finalize-object's own imports (pulled in via importOriginal) touch db/queue —
// stub them so importing the module is side-effect free.
vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/db/schema', () => ({ mediaFiles: {} }));
vi.mock('@/lib/media/upload', () => ({ getMediaPublicUrl: (k: string) => `https://cdn/${k}` }));
vi.mock('@/lib/jobs/queue', () => ({ addMediaThumbnailJob: vi.fn() }));
vi.mock('@/lib/activity/log', () => ({ logActivity: vi.fn() }));

import { POST as createUpload } from '@/pages/api/media/multipart/create';
import { POST as completeUpload } from '@/pages/api/media/multipart/complete';
import { POST as abortUpload } from '@/pages/api/media/multipart/abort';
import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A } from '../helpers/fixtures';

const ORG_KEY = `original/1/1752000000000-${'a'.repeat(32)}.mp4`;
const OTHER_ORG_KEY = `original/2/1752000000000-${'a'.repeat(32)}.mp4`;

const ctx = (body: any) => createMockContext({ user: USER_A, organizationId: 1, method: 'POST', body });

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckStorage.mockResolvedValue({ allowed: true });
  mockCreateMultipart.mockResolvedValue('upload-123');
  mockGetPartUrl.mockImplementation(async (_k: string, _u: string, n: number) => `https://r2/part/${n}`);
  mockCompleteMultipart.mockResolvedValue(undefined);
  mockVerifyAndRecord.mockResolvedValue({ ok: true, file: { id: 9 } });
});

describe('POST /api/media/multipart/create', () => {
  it('401s unauthenticated', async () => {
    const res = await createUpload(createMockContext({ user: null }) as any);
    expect((await parseResponse(res)).status).toBe(401);
  });

  it('starts a multipart upload for a large video and signs one URL per 10MB part', async () => {
    const size = 25 * 1024 * 1024; // → 3 parts
    const res = await createUpload(ctx({ contentType: 'video/mp4', sizeBytes: size }) as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.uploadId).toBe('upload-123');
    expect(data.partSize).toBe(10 * 1024 * 1024);
    expect(data.partUrls).toHaveLength(3);
    expect(data.r2Key).toMatch(/^original\/1\//);
  });

  it('accepts a video up to 1GB', async () => {
    const res = await createUpload(ctx({ contentType: 'video/mp4', sizeBytes: 1024 * 1024 * 1024 }) as any);
    expect((await parseResponse(res)).status).toBe(200);
  });

  it('rejects a video over 1GB', async () => {
    const res = await createUpload(ctx({ contentType: 'video/mp4', sizeBytes: 1024 * 1024 * 1024 + 1 }) as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(String(data.error)).toContain('1GB');
  });

  it('rejects an image over 100MB (images keep the smaller cap)', async () => {
    const res = await createUpload(ctx({ contentType: 'image/png', sizeBytes: 200 * 1024 * 1024 }) as any);
    expect((await parseResponse(res)).status).toBe(400);
  });

  it('rejects disallowed MIME types', async () => {
    const res = await createUpload(ctx({ contentType: 'application/zip', sizeBytes: 1000 }) as any);
    expect((await parseResponse(res)).status).toBe(400);
  });

  it('blocks when storage quota is exhausted', async () => {
    mockCheckStorage.mockResolvedValue({ allowed: false });
    const res = await createUpload(ctx({ contentType: 'video/mp4', sizeBytes: 1000 }) as any);
    expect((await parseResponse(res)).status).toBe(429);
  });
});

describe('POST /api/media/multipart/complete', () => {
  const validBody = {
    r2Key: ORG_KEY,
    uploadId: 'upload-123',
    parts: [{ partNumber: 1, etag: '"abc"' }],
    fileName: 'video.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 5000,
  };

  it('assembles the parts and records the file via shared verification', async () => {
    const res = await completeUpload(ctx(validBody) as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(201);
    expect(data.file.id).toBe(9);
    expect(mockCompleteMultipart).toHaveBeenCalledWith(ORG_KEY, 'upload-123', [{ partNumber: 1, etag: '"abc"' }]);
    expect(mockVerifyAndRecord).toHaveBeenCalled();
  });

  it("rejects a key issued for another org before touching R2", async () => {
    const res = await completeUpload(ctx({ ...validBody, r2Key: OTHER_ORG_KEY }) as any);
    expect((await parseResponse(res)).status).toBe(400);
    expect(mockCompleteMultipart).not.toHaveBeenCalled();
  });

  it('rejects a malformed parts list', async () => {
    const res = await completeUpload(ctx({ ...validBody, parts: [{ partNumber: 0, etag: '' }] }) as any);
    expect((await parseResponse(res)).status).toBe(400);
  });

  it('aborts the upload when assembly fails', async () => {
    mockCompleteMultipart.mockRejectedValue(new Error('R2 exploded'));
    const res = await completeUpload(ctx(validBody) as any);
    expect((await parseResponse(res)).status).toBe(400);
    expect(mockAbortMultipart).toHaveBeenCalledWith(ORG_KEY, 'upload-123');
  });

  it('propagates verification failure (e.g. magic-byte mismatch)', async () => {
    mockVerifyAndRecord.mockResolvedValue({ ok: false, status: 400, error: 'File content does not match declared type' });
    const res = await completeUpload(ctx(validBody) as any);
    expect((await parseResponse(res)).status).toBe(400);
  });
});

describe('POST /api/media/multipart/abort', () => {
  it('aborts an owned upload', async () => {
    const res = await abortUpload(ctx({ r2Key: ORG_KEY, uploadId: 'upload-123' }) as any);
    expect((await parseResponse(res)).status).toBe(200);
    expect(mockAbortMultipart).toHaveBeenCalledWith(ORG_KEY, 'upload-123');
  });

  it("refuses another org's key", async () => {
    const res = await abortUpload(ctx({ r2Key: OTHER_ORG_KEY, uploadId: 'upload-123' }) as any);
    expect((await parseResponse(res)).status).toBe(400);
    expect(mockAbortMultipart).not.toHaveBeenCalled();
  });
});

export {};
