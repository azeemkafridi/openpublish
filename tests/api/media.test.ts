/**
 * Tests for the Media API (index).
 *
 *   GET  /api/media — list media files with pagination, search, label filters
 *   POST /api/media — upload file with quota check and MIME validation
 */

// ---------------------------------------------------------------------------
// Chainable Drizzle mock
// ---------------------------------------------------------------------------
const mockQueryResult: any[] = [];
const queryChain: Record<string, any> = {};
const chainMethods = [
  'select', 'selectDistinct', 'from', 'where', 'orderBy', 'limit', 'offset',
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
vi.mock('@/lib/db', () => ({
  db: {
    select: () => queryChain,
    selectDistinct: () => queryChain,
    update: () => queryChain,
    insert: () => queryChain,
    delete: () => queryChain,
  },
}));

vi.mock('@/lib/db/schema', () => ({
  mediaFiles: {
    id: 'media_files.id',
    organizationId: 'media_files.organization_id',
    userId: 'media_files.user_id',
    fileName: 'media_files.file_name',
    mimeType: 'media_files.mime_type',
    sizeBytes: 'media_files.size_bytes',
    width: 'media_files.width',
    height: 'media_files.height',
    duration: 'media_files.duration',
    originalPath: 'media_files.original_path',
    thumbnailPath: 'media_files.thumbnail_path',
    previewPath: 'media_files.preview_path',
    isOriginalDeleted: 'media_files.is_original_deleted',
    createdAt: 'media_files.created_at',
  },
  mediaLabels: {
    mediaFileId: 'media_labels.media_file_id',
    labelId: 'media_labels.label_id',
  },
  labels: {
    id: 'labels.id',
    name: 'labels.name',
    color: 'labels.color',
    organizationId: 'labels.organization_id',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ type: 'eq', args: a })),
  and: vi.fn((...a: any[]) => ({ type: 'and', args: a })),
  desc: vi.fn((c: any) => ({ type: 'desc', col: c })),
  ilike: vi.fn((...a: any[]) => ({ type: 'ilike', args: a })),
  inArray: vi.fn((...a: any[]) => ({ type: 'inArray', args: a })),
  sql: vi.fn(),
}));

vi.mock('@/lib/activity/log', () => ({ logActivity: vi.fn() }));

vi.mock('@/lib/media/upload', () => ({
  getMediaPublicUrl: vi.fn((path: string) => `https://cdn.example.com/${path}`),
  saveUploadedFile: vi.fn(),
}));

const mockCheckMediaStorageQuota = vi.fn().mockResolvedValue({ allowed: true });
const mockGetOrgPlan = vi.fn().mockResolvedValue('pro');
vi.mock('@/lib/quotas/check', () => ({
  checkMediaStorageQuota: (...a: any[]) => mockCheckMediaStorageQuota(...a),
  getOrgPlan: (...a: any[]) => mockGetOrgPlan(...a),
}));

const mockQuotaExceededResponse = vi.fn((..._args: any[]) =>
  new Response(JSON.stringify({ error: 'Quota exceeded' }), { status: 403 }),
);
vi.mock('@/lib/quotas/errors', () => ({
  quotaExceededResponse: (...a: any[]) => mockQuotaExceededResponse(...a),
}));

vi.mock('@/lib/errors', () => ({
  captureApiError: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import handlers AFTER mocks
// ---------------------------------------------------------------------------
import { GET, POST } from '@/pages/api/media/index';
import { saveUploadedFile } from '@/lib/media/upload';
import { logActivity } from '@/lib/activity/log';
import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A } from '../helpers/fixtures';

// Magic byte helpers for mock files that pass server-side validation
const JPEG_MAGIC = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, ...Array(8).fill(0)]);
// Minimal COMPLETE mp4: 12-byte ftyp box + 8-byte moov box (the moov-atom
// ingest check walks the real box sizes, so the fixture must contain one).
const MP4_MAGIC = new Uint8Array([
  0x00, 0x00, 0x00, 0x0c, 0x66, 0x74, 0x79, 0x70, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x08, 0x6d, 0x6f, 0x6f, 0x76,
]);

function makeTestFile(name: string, type: string): File {
  const magic = type.startsWith('video/') ? MP4_MAGIC : JPEG_MAGIC;
  return new File([magic], name, { type });
}

const SAMPLE_MEDIA = {
  id: 1,
  organizationId: 1,
  userId: 'user-a',
  fileName: 'photo.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 1024000,
  width: 1920,
  height: 1080,
  duration: null,
  originalPath: 'org-1/photo.jpg',
  thumbnailPath: 'org-1/thumb-photo.jpg',
  previewPath: null,
  isOriginalDeleted: false,
  createdAt: new Date('2026-01-15'),
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
  queryChain.limit = vi.fn().mockImplementation(() => {
    return queryChain;
  });
  queryChain.offset = vi.fn().mockReturnValue(queryChain);
  queryChain.then = (resolve: any) => resolve(mockQueryResult);
}

// ---------------------------------------------------------------------------
// GET /api/media
// ---------------------------------------------------------------------------

describe('GET /api/media', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([]);
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns 200 with files list and pagination', async () => {
    // The GET handler queries media, then labels.
    // First call: media rows; second: media labels
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([SAMPLE_MEDIA]);
      return resolve([]); // no labels
    };

    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toHaveProperty('files');
    expect(data).toHaveProperty('page');
    expect(data).toHaveProperty('limit');
    expect(Array.isArray(data.files)).toBe(true);
  });

  it('returns empty files array when no media exists', async () => {
    queryChain.then = (resolve: any) => resolve([]);
    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.files).toEqual([]);
  });

  it('sets Cache-Control: private, no-store header', async () => {
    queryChain.then = (resolve: any) => resolve([]);
    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('returns files with resolved URLs', async () => {
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([SAMPLE_MEDIA]);
      return resolve([]);
    };

    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.files[0].originalUrl).toBe('https://cdn.example.com/org-1/photo.jpg');
    expect(data.files[0].thumbnailUrl).toBe('https://cdn.example.com/org-1/thumb-photo.jpg');
  });

  it('defaults page to 1 and limit to 20', async () => {
    queryChain.then = (resolve: any) => resolve([]);
    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.page).toBe(1);
    expect(data.limit).toBe(20);
  });

  it('clamps limit to max 100', async () => {
    queryChain.then = (resolve: any) => resolve([]);
    const ctx = createMockContext({
      user: USER_A,
      organizationId: 1,
      searchParams: { limit: '500' },
    });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.limit).toBe(100);
  });

  it('returns empty files when label filter matches no media', async () => {
    // selectDistinct for label filter returns empty
    let callCount = 0;
    queryChain.then = (resolve: any) => {
      callCount++;
      if (callCount === 1) return resolve([]); // no media with those labels
      return resolve([]);
    };

    const ctx = createMockContext({
      user: USER_A,
      organizationId: 1,
      searchParams: { labelIds: '99' },
    });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/media
// ---------------------------------------------------------------------------

describe('POST /api/media', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([]);
    mockCheckMediaStorageQuota.mockResolvedValue({ allowed: true });
    (saveUploadedFile as any).mockResolvedValue({
      id: 10,
      fileName: 'upload.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 5000,
      width: 800,
      height: 600,
      duration: null,
      originalPath: 'org-1/upload.jpg',
      thumbnailPath: 'org-1/thumb-upload.jpg',
      previewPath: null,
    });
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null });
    const res = await POST(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns 400 when content-type is not multipart/form-data', async () => {
    const ctx = createMockContext({ user: USER_A });
    // Override request headers to not include multipart
    (ctx.request as any).headers = new Headers({ 'Content-Type': 'application/json' });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('multipart/form-data');
  });

  it('returns 400 when file field is missing', async () => {
    const formData = new FormData();
    const ctx = createMockContext({ user: USER_A });
    (ctx.request as any).headers = new Headers({ 'Content-Type': 'multipart/form-data' });
    (ctx.request as any).formData = vi.fn().mockResolvedValue(formData);
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('Missing');
  });

  it('returns 400 when file is empty', async () => {
    const file = new File([], 'empty.jpg', { type: 'image/jpeg' });
    const formData = new FormData();
    formData.append('file', file);
    const ctx = createMockContext({ user: USER_A });
    (ctx.request as any).headers = new Headers({ 'Content-Type': 'multipart/form-data' });
    (ctx.request as any).formData = vi.fn().mockResolvedValue(formData);
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('empty');
  });

  it('returns 400 when file exceeds 100MB limit', async () => {
    const largeBuffer = new ArrayBuffer(101 * 1024 * 1024);
    const file = new File([largeBuffer], 'huge.jpg', { type: 'image/jpeg' });
    const formData = new FormData();
    formData.append('file', file);
    const ctx = createMockContext({ user: USER_A });
    (ctx.request as any).headers = new Headers({ 'Content-Type': 'multipart/form-data' });
    (ctx.request as any).formData = vi.fn().mockResolvedValue(formData);
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('too large');
  });

  it('returns 400 for disallowed MIME type', async () => {
    const file = new File(['data'], 'doc.pdf', { type: 'application/pdf' });
    const formData = new FormData();
    formData.append('file', file);
    const ctx = createMockContext({ user: USER_A });
    (ctx.request as any).headers = new Headers({ 'Content-Type': 'multipart/form-data' });
    (ctx.request as any).formData = vi.fn().mockResolvedValue(formData);
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('not allowed');
  });

  it('returns quota exceeded when media storage quota is exhausted', async () => {
    mockCheckMediaStorageQuota.mockResolvedValue({ allowed: false, limit: 100, current: 100 });
    const file = makeTestFile('photo.jpg', 'image/jpeg');
    const formData = new FormData();
    formData.append('file', file);
    const ctx = createMockContext({ user: USER_A });
    (ctx.request as any).headers = new Headers({ 'Content-Type': 'multipart/form-data' });
    (ctx.request as any).formData = vi.fn().mockResolvedValue(formData);
    const res = await POST(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it('returns 201 with file data on successful upload', async () => {
    const file = makeTestFile('photo.jpg', 'image/jpeg');
    const formData = new FormData();
    formData.append('file', file);
    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    (ctx.request as any).headers = new Headers({ 'Content-Type': 'multipart/form-data' });
    (ctx.request as any).formData = vi.fn().mockResolvedValue(formData);
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(201);
    expect(data).toHaveProperty('file');
    expect(data.file.id).toBe(10);
    expect(data.file.fileName).toBe('upload.jpg');
    expect(data.file.originalUrl).toContain('cdn.example.com');
  });

  it('logs media.uploaded activity on success', async () => {
    const file = makeTestFile('photo.jpg', 'image/jpeg');
    const formData = new FormData();
    formData.append('file', file);
    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    (ctx.request as any).headers = new Headers({ 'Content-Type': 'multipart/form-data' });
    (ctx.request as any).formData = vi.fn().mockResolvedValue(formData);
    await POST(ctx as any);
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'media.uploaded',
        resource: 'media',
        resourceId: 10,
      }),
    );
  });

  it('returns 500 when saveUploadedFile throws', async () => {
    (saveUploadedFile as any).mockRejectedValue(new Error('R2 upload failed'));
    const file = makeTestFile('photo.jpg', 'image/jpeg');
    const formData = new FormData();
    formData.append('file', file);
    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    (ctx.request as any).headers = new Headers({ 'Content-Type': 'multipart/form-data' });
    (ctx.request as any).formData = vi.fn().mockResolvedValue(formData);
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(500);
    expect(data.error).toContain('Failed to upload file');
  });

  it('accepts video/mp4 MIME type', async () => {
    const file = makeTestFile('clip.mp4', 'video/mp4');
    const formData = new FormData();
    formData.append('file', file);
    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    (ctx.request as any).headers = new Headers({ 'Content-Type': 'multipart/form-data' });
    (ctx.request as any).formData = vi.fn().mockResolvedValue(formData);
    const res = await POST(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(201);
  });
});
