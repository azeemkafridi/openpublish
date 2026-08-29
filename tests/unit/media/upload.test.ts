/**
 * Media upload tests.
 *
 * Tests upload validation at webapp/src/pages/api/media/index.ts (POST)
 * and saveUploadedFile at webapp/src/lib/media/upload.ts covering:
 *   - MIME type validation
 *   - File size validation (>100MB rejected)
 *   - Empty file rejection
 *   - Quota check blocks upload when over limit
 *   - Allowed MIME types pass validation
 */

import { createDbMock, createDrizzleOrmMock } from '../../helpers/db-mock';

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------
const { db: mockDb, setResult, resetChain } = createDbMock();
const drizzleOrmMock = createDrizzleOrmMock();

vi.mock('@/lib/db', () => ({ db: mockDb }));

vi.mock('@/lib/db/schema', () => ({
  mediaFiles: {
    id: 'mf.id',
    userId: 'mf.user_id',
    organizationId: 'mf.org_id',
    originalPath: 'mf.original_path',
    thumbnailPath: 'mf.thumbnail_path',
    previewPath: 'mf.preview_path',
    fileName: 'mf.file_name',
    mimeType: 'mf.mime_type',
    sizeBytes: 'mf.size_bytes',
    width: 'mf.width',
    height: 'mf.height',
    duration: 'mf.duration',
    createdAt: 'mf.created_at',
    isOriginalDeleted: 'mf.is_original_deleted',
  },
  mediaLabels: {
    mediaFileId: 'ml.media_file_id',
    labelId: 'ml.label_id',
  },
  labels: {
    id: 'l.id',
    name: 'l.name',
    color: 'l.color',
  },
  organizations: {
    id: 'org.id',
    plan: 'org.plan',
  },
}));

vi.mock('drizzle-orm', () => drizzleOrmMock);

// ---------------------------------------------------------------------------
// Other mocks
// ---------------------------------------------------------------------------

const mockCheckMediaStorageQuota = vi.fn();
const mockGetOrgPlan = vi.fn();

vi.mock('@/lib/quotas/check', () => ({
  checkMediaStorageQuota: (...args: any[]) => mockCheckMediaStorageQuota(...args),
  getOrgPlan: (...args: any[]) => mockGetOrgPlan(...args),
}));

vi.mock('@/lib/quotas/errors', () => ({
  quotaExceededResponse: vi.fn(() =>
    new Response(JSON.stringify({ error: { code: 'QUOTA_EXCEEDED' } }), { status: 403 }),
  ),
}));

const mockSaveUploadedFile = vi.fn();
vi.mock('@/lib/media/upload', () => ({
  saveUploadedFile: (...args: any[]) => mockSaveUploadedFile(...args),
  getMediaPublicUrl: vi.fn((path: string) => `https://images.bulkpublish.com/${path}`),
}));

vi.mock('@/lib/activity/log', () => ({
  logActivity: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import handlers AFTER mocks
// ---------------------------------------------------------------------------

const { POST } = await import('@/pages/api/media/index');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a File-like object with a custom size.
 * jsdom's File has a read-only `size` that reflects actual content length,
 * so we use Object.create to build something that passes `instanceof File`.
 */
// Magic bytes for each supported type so server-side validation passes
const MAGIC_BYTES: Record<string, Uint8Array> = {
  'image/jpeg': new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, ...Array(8).fill(0)]),
  'image/png': new Uint8Array([0x89, 0x50, 0x4E, 0x47, ...Array(8).fill(0)]),
  'image/gif': new Uint8Array([0x47, 0x49, 0x46, 0x38, ...Array(8).fill(0)]),
  'image/webp': new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
  // A minimal COMPLETE ISO-BMFF file: a 12-byte ftyp box followed by an
  // 8-byte moov box — the moov-atom ingest check walks the real box sizes.
  'video/mp4': new Uint8Array([0x00, 0x00, 0x00, 0x0C, 0x66, 0x74, 0x79, 0x70, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x6D, 0x6F, 0x6F, 0x76]),
  'video/quicktime': new Uint8Array([0x00, 0x00, 0x00, 0x0C, 0x66, 0x74, 0x79, 0x70, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x6D, 0x6F, 0x6F, 0x76]),
  'video/webm': new Uint8Array([0x1A, 0x45, 0xDF, 0xA3, ...Array(8).fill(0)]),
};

function createMockFile(name: string, type: string, size: number) {
  const content = MAGIC_BYTES[type] || new Uint8Array([0x78]);
  // Cast Uint8Array → BlobPart explicitly: TS 5.x narrowed Uint8Array<ArrayBufferLike>
  // which no longer auto-assigns to BlobPart's stricter ArrayBufferView<ArrayBuffer>.
  const file = new File([content as BlobPart], name, { type });
  // Override the read-only size with a getter
  Object.defineProperty(file, 'size', { value: size, writable: false });
  return file;
}

function createCtx(options: {
  user?: { id: string; name: string } | null;
  organizationId?: number;
  file?: { name: string; type: string; size: number } | null;
  hasFile?: boolean;
}) {
  const {
    user = { id: 'user-1', name: 'Test User' },
    organizationId = 1,
    file,
    hasFile = true,
  } = options;

  const mockFile = file ? createMockFile(file.name, file.type, file.size) : null;

  const formDataMap = new Map<string, any>();
  if (hasFile && mockFile) {
    formDataMap.set('file', mockFile);
  }

  const formData = {
    get: (key: string) => formDataMap.get(key) ?? null,
    has: (key: string) => formDataMap.has(key),
  };

  return {
    locals: {
      auth: {
        user,
        organizationId,
        organizationPlan: 'pro' as const,
        organizationName: 'Test Org',
      },
    },
    request: {
      headers: new Headers({
        'content-type': 'multipart/form-data; boundary=----WebKitFormBoundary',
      }),
      formData: vi.fn().mockResolvedValue(formData),
    } as unknown as Request,
    url: new URL('http://localhost:4321/api/media'),
  };
}

async function parseResponse(res: Response) {
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/media', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain();
    mockCheckMediaStorageQuota.mockResolvedValue({ allowed: true, current: 50, limit: 2048, resource: 'media_storage' });
    mockGetOrgPlan.mockResolvedValue('pro');
  });

  it('returns 401 when user is null', async () => {
    const ctx = createCtx({ user: null });
    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 400 when content-type is not multipart/form-data', async () => {
    const ctx = createCtx({
      file: { name: 'test.jpg', type: 'image/jpeg', size: 100 },
    });
    // Override content-type to something wrong
    (ctx.request.headers as Headers).set('content-type', 'application/json');

    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('multipart/form-data');
  });

  it('returns 400 when file field is missing', async () => {
    const ctx = createCtx({ hasFile: false });

    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('Missing');
  });

  it('returns 400 for empty file (size = 0)', async () => {
    const ctx = createCtx({
      file: { name: 'empty.jpg', type: 'image/jpeg', size: 0 },
    });

    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('empty');
  });

  it('returns 400 for file over 100MB', async () => {
    const ctx = createCtx({
      file: { name: 'huge.mp4', type: 'video/mp4', size: 101 * 1024 * 1024 },
    });

    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('100MB');
  });

  it('returns 400 for disallowed MIME type', async () => {
    const ctx = createCtx({
      file: { name: 'document.pdf', type: 'application/pdf', size: 1024 },
    });

    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('not allowed');
  });

  it('returns 400 for text file', async () => {
    const ctx = createCtx({
      file: { name: 'readme.txt', type: 'text/plain', size: 1024 },
    });

    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('not allowed');
  });

  it.each([
    ['image/jpeg', 'photo.jpg'],
    ['image/png', 'photo.png'],
    ['image/webp', 'photo.webp'],
    ['image/gif', 'animation.gif'],
    ['video/mp4', 'video.mp4'],
    ['video/quicktime', 'video.mov'],
    ['video/webm', 'video.webm'],
  ])('allows MIME type %s', async (mimeType, fileName) => {
    const ctx = createCtx({
      file: { name: fileName, type: mimeType, size: 1024 },
    });

    mockSaveUploadedFile.mockResolvedValue({
      id: 1,
      originalPath: 'original/test.jpg',
      thumbnailPath: 'thumbnails/test-thumb.webp',
      previewPath: 'thumbnails/test-preview.webp',
      fileName,
      mimeType,
      sizeBytes: 1024,
    });

    const res = await POST(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(201);
  });

  it('blocks upload when storage quota exceeded', async () => {
    mockCheckMediaStorageQuota.mockResolvedValue({
      allowed: false,
      current: 2048,
      limit: 2048,
      resource: 'media_storage',
    });

    const ctx = createCtx({
      file: { name: 'photo.jpg', type: 'image/jpeg', size: 1024 },
    });

    const res = await POST(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it('returns 201 with file data on successful upload', async () => {
    mockSaveUploadedFile.mockResolvedValue({
      id: 123,
      originalPath: 'original/test.jpg',
      thumbnailPath: 'thumbnails/test-thumb.webp',
      previewPath: 'thumbnails/test-preview.webp',
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 5000,
      width: 1920,
      height: 1080,
    });

    const ctx = createCtx({
      file: { name: 'photo.jpg', type: 'image/jpeg', size: 5000 },
    });

    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);

    expect(status).toBe(201);
    expect(data.file.id).toBe(123);
    expect(data.file.fileName).toBe('photo.jpg');
    expect(data.file.mimeType).toBe('image/jpeg');
    expect(data.file.originalUrl).toContain('original/test.jpg');
  });
});

describe('mp4 moov-atom ingest check', () => {
  it('rejects an unfinalized mp4 (ftyp + mdat, no moov)', async () => {
    // Valid ftyp magic, then an mdat box that runs to the declared end — the
    // classic "grabbed mid-encode" render that used to fail days later at
    // publish time.
    const incomplete = new Uint8Array([
      0x00, 0x00, 0x00, 0x0c, 0x66, 0x74, 0x79, 0x70, 0x00, 0x00, 0x00, 0x00, // ftyp (12)
      0x00, 0x00, 0x00, 0x08, 0x6d, 0x64, 0x61, 0x74,                         // mdat (8)
    ]);
    const file = new File([incomplete as unknown as BlobPart], 'cut.mp4', { type: 'video/mp4' });
    Object.defineProperty(file, 'size', { value: incomplete.length, writable: false });

    const formDataMap = new Map<string, any>([['file', file]]);
    const ctx = {
      locals: { auth: { user: { id: 'user-1', name: 'Test User' }, organizationId: 1, organizationPlan: 'pro' as const } },
      request: {
        headers: new Headers({ 'content-type': 'multipart/form-data; boundary=----WebKitFormBoundary' }),
        formData: async () => ({ get: (k: string) => formDataMap.get(k) ?? null, has: (k: string) => formDataMap.has(k) }),
      },
    };

    const res = await POST(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(String(data.error)).toContain('moov');
  });
});
