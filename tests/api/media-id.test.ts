/**
 * Tests for the Media [id] API.
 *
 *   GET    /api/media/[id] — get single media file
 *   DELETE /api/media/[id] — delete media file with R2 cleanup
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
vi.mock('@/lib/db', () => ({
  db: {
    select: () => queryChain,
    update: () => queryChain,
    insert: () => queryChain,
    delete: () => queryChain,
  },
}));

vi.mock('@/lib/db/schema', () => ({
  mediaFiles: {
    id: 'media_files.id',
    organizationId: 'media_files.organization_id',
    fileName: 'media_files.file_name',
    mimeType: 'media_files.mime_type',
    sizeBytes: 'media_files.size_bytes',
    width: 'media_files.width',
    height: 'media_files.height',
    duration: 'media_files.duration',
    originalPath: 'media_files.original_path',
    thumbnailPath: 'media_files.thumbnail_path',
    isOriginalDeleted: 'media_files.is_original_deleted',
    createdAt: 'media_files.created_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ type: 'eq', args: a })),
  and: vi.fn((...a: any[]) => ({ type: 'and', args: a })),
}));

vi.mock('@/lib/activity/log', () => ({ logActivity: vi.fn() }));

vi.mock('@/lib/media/upload', () => ({
  getMediaPublicUrl: vi.fn((path: string) => `https://cdn.example.com/${path}`),
}));

const mockAddMediaDeleteJob = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/jobs/queue', () => ({
  addMediaDeleteJob: (...a: any[]) => mockAddMediaDeleteJob(...a),
}));

// ---------------------------------------------------------------------------
// Import handlers AFTER mocks
// ---------------------------------------------------------------------------
import { GET, DELETE } from '@/pages/api/media/[id]';
import { logActivity } from '@/lib/activity/log';
import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A } from '../helpers/fixtures';

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
  queryChain.limit = vi.fn().mockImplementation(() => Promise.resolve(mockQueryResult));
  queryChain.then = (resolve: any) => resolve(mockQueryResult);
}

// ---------------------------------------------------------------------------
// GET /api/media/[id]
// ---------------------------------------------------------------------------

describe('GET /api/media/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([SAMPLE_MEDIA]);
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null, params: { id: '1' } });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns 400 for invalid (non-numeric) media ID', async () => {
    const ctx = createMockContext({ user: USER_A, params: { id: 'abc' } });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it('returns 404 when media file does not belong to org', async () => {
    resetChain([]);
    queryChain.then = (resolve: any) => resolve([]);
    const ctx = createMockContext({ user: USER_A, params: { id: '999' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it('returns 200 with file data and resolved URLs', async () => {
    queryChain.then = (resolve: any) => resolve([SAMPLE_MEDIA]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toHaveProperty('file');
    expect(data.file.id).toBe(1);
    expect(data.file.fileName).toBe('photo.jpg');
    expect(data.file.originalUrl).toContain('cdn.example.com');
    expect(data.file.thumbnailUrl).toContain('cdn.example.com');
  });

  it('sets Cache-Control: private, no-store header', async () => {
    queryChain.then = (resolve: any) => resolve([SAMPLE_MEDIA]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('returns null thumbnailUrl when no thumbnail path exists', async () => {
    queryChain.then = (resolve: any) => resolve([{ ...SAMPLE_MEDIA, thumbnailPath: null }]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { data } = await parseResponse(res);
    expect(data.file.thumbnailUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/media/[id]
// ---------------------------------------------------------------------------

describe('DELETE /api/media/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([SAMPLE_MEDIA]);
    mockAddMediaDeleteJob.mockResolvedValue(undefined);
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null, params: { id: '1' } });
    const res = await DELETE(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns 400 for invalid media ID', async () => {
    const ctx = createMockContext({ user: USER_A, params: { id: 'abc' } });
    const res = await DELETE(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it('returns 404 when media file does not belong to org', async () => {
    resetChain([]);
    queryChain.then = (resolve: any) => resolve([]);
    const ctx = createMockContext({ user: USER_A, params: { id: '999' }, organizationId: 1 });
    const res = await DELETE(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it('deletes R2 files and DB record, returns success', async () => {
    queryChain.then = (resolve: any) => resolve([SAMPLE_MEDIA]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await DELETE(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.deletedId).toBe(1);
  });

  it('queues async R2 deletion for original and thumbnail', async () => {
    queryChain.then = (resolve: any) => resolve([SAMPLE_MEDIA]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    await DELETE(ctx as any);
    expect(mockAddMediaDeleteJob).toHaveBeenCalledWith(
      expect.arrayContaining(['org-1/photo.jpg', 'org-1/thumb-photo.jpg']),
    );
  });

  it('queues only original path when no thumbnail exists', async () => {
    queryChain.then = (resolve: any) => resolve([{ ...SAMPLE_MEDIA, thumbnailPath: null }]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    await DELETE(ctx as any);
    expect(mockAddMediaDeleteJob).toHaveBeenCalledWith(
      expect.arrayContaining(['org-1/photo.jpg']),
    );
    // Should not include null paths
    const paths = mockAddMediaDeleteJob.mock.calls[0][0];
    expect(paths.every((p: string) => typeof p === 'string')).toBe(true);
  });

  it('logs media.deleted activity', async () => {
    queryChain.then = (resolve: any) => resolve([SAMPLE_MEDIA]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    await DELETE(ctx as any);
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'media.deleted',
        resource: 'media',
        resourceId: 1,
        details: { fileName: 'photo.jpg' },
      }),
    );
  });
});
