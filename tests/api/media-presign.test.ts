/**
 * Tests for POST /api/media/presign — step 1 of the direct-to-R2 browser upload.
 *   - auth, content-type allowlist, size validation
 *   - storage quota gate
 *   - returns an org-namespaced key + presigned URL
 */

const mockGetPresignedUploadUrl = vi.fn();
vi.mock('@/lib/media/r2', () => ({
  getPresignedUploadUrl: (...a: any[]) => mockGetPresignedUploadUrl(...a),
}));

const mockCheckMediaStorageQuota = vi.fn();
const mockGetOrgPlan = vi.fn().mockResolvedValue('pro');
vi.mock('@/lib/quotas/check', () => ({
  checkMediaStorageQuota: (...a: any[]) => mockCheckMediaStorageQuota(...a),
  getOrgPlan: (...a: any[]) => mockGetOrgPlan(...a),
}));

vi.mock('@/lib/quotas/errors', () => ({
  quotaExceededResponse: vi.fn(() => new Response(JSON.stringify({ error: 'Quota exceeded' }), { status: 403 })),
}));

vi.mock('@/lib/errors', () => ({ captureApiError: vi.fn() }));

import { POST } from '@/pages/api/media/presign';
import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A } from '../helpers/fixtures';

function ctxWithBody(body: unknown, opts: { user?: any; organizationId?: number } = {}) {
  const user = 'user' in opts ? opts.user : USER_A;
  const ctx = createMockContext({ user, organizationId: opts.organizationId ?? 1, method: 'POST' });
  (ctx.request as any).json = vi.fn().mockResolvedValue(body);
  return ctx;
}

describe('POST /api/media/presign', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckMediaStorageQuota.mockResolvedValue({ allowed: true });
    mockGetPresignedUploadUrl.mockResolvedValue('https://r2.example.com/signed-put');
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = ctxWithBody({ contentType: 'image/webp', sizeBytes: 1000 }, { user: null });
    const { status } = await parseResponse(await POST(ctx as any));
    expect(status).toBe(401);
  });

  it('returns 400 on invalid JSON body', async () => {
    const ctx = createMockContext({ user: USER_A, method: 'POST' });
    (ctx.request as any).json = vi.fn().mockRejectedValue(new Error('bad json'));
    const { status } = await parseResponse(await POST(ctx as any));
    expect(status).toBe(400);
  });

  it('returns 400 for a disallowed content type', async () => {
    const ctx = ctxWithBody({ contentType: 'application/pdf', sizeBytes: 1000 });
    const { status, data } = await parseResponse(await POST(ctx as any));
    expect(status).toBe(400);
    expect(data.error).toContain('not allowed');
  });

  it('returns 400 for invalid size', async () => {
    for (const sizeBytes of [0, -5, NaN]) {
      const ctx = ctxWithBody({ contentType: 'image/webp', sizeBytes });
      const { status } = await parseResponse(await POST(ctx as any));
      expect(status).toBe(400);
    }
  });

  it('returns 400 when the file exceeds 100MB', async () => {
    const ctx = ctxWithBody({ contentType: 'video/mp4', sizeBytes: 101 * 1024 * 1024 });
    const { status, data } = await parseResponse(await POST(ctx as any));
    expect(status).toBe(400);
    expect(data.error).toContain('too large');
  });

  it('returns 403 when storage quota is exhausted', async () => {
    mockCheckMediaStorageQuota.mockResolvedValue({ allowed: false, current: 100, limit: 100 });
    const ctx = ctxWithBody({ contentType: 'image/webp', sizeBytes: 1000 });
    const { status } = await parseResponse(await POST(ctx as any));
    expect(status).toBe(403);
    expect(mockGetPresignedUploadUrl).not.toHaveBeenCalled();
  });

  it('returns 200 with an org-namespaced key and presigned URL', async () => {
    const ctx = ctxWithBody({ contentType: 'image/webp', sizeBytes: 50_000 }, { organizationId: 7 });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.uploadUrl).toBe('https://r2.example.com/signed-put');
    expect(data.r2Key).toMatch(/^original\/7\/\d+-[0-9a-f]{32}\.webp$/);
    expect(data.expiresIn).toBe(300);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    // signed with the requested content type + the generated key
    const [key, contentType] = mockGetPresignedUploadUrl.mock.calls[0];
    expect(key).toBe(data.r2Key);
    expect(contentType).toBe('image/webp');
  });

  it('maps the content type to the right key extension', async () => {
    const ctx = ctxWithBody({ contentType: 'video/quicktime', sizeBytes: 50_000 });
    const { data } = await parseResponse(await POST(ctx as any));
    expect(data.r2Key).toMatch(/\.mov$/);
  });

  it('returns 500 when signing fails', async () => {
    mockGetPresignedUploadUrl.mockRejectedValue(new Error('R2 down'));
    const ctx = ctxWithBody({ contentType: 'image/webp', sizeBytes: 1000 });
    const { status } = await parseResponse(await POST(ctx as any));
    expect(status).toBe(500);
  });

  // Collect-scoped gate: video R2 backup is a paid feature; must NOT affect
  // composer/library uploads (which send no `purpose`).
});

export {};
