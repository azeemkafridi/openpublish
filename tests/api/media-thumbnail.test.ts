/**
 * Tests for the Media Thumbnail API.
 *
 *   GET /api/media/[id]/thumbnail — serve or redirect to thumbnail
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
    thumbnailPath: 'media_files.thumbnail_path',
    originalPath: 'media_files.original_path',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ type: 'eq', args: a })),
  and: vi.fn((...a: any[]) => ({ type: 'and', args: a })),
}));

vi.mock('@/lib/media/upload', () => ({
  getMediaPublicUrl: vi.fn((path: string) => `https://cdn.example.com/${path}`),
}));

const mockIsR2Key = vi.fn().mockReturnValue(true);
vi.mock('@/lib/media/r2', () => ({
  isR2Key: (...a: any[]) => mockIsR2Key(...a),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(Buffer.from('fake-image')),
  },
}));

vi.mock('node:path', () => ({
  default: {
    extname: vi.fn().mockReturnValue('.jpg'),
  },
}));

// ---------------------------------------------------------------------------
// Import handlers AFTER mocks
// ---------------------------------------------------------------------------
import { GET } from '@/pages/api/media/[id]/thumbnail';
import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A } from '../helpers/fixtures';

const SAMPLE_MEDIA = {
  id: 1,
  organizationId: 1,
  thumbnailPath: 'r2/org-1/thumb-photo.jpg',
  originalPath: 'r2/org-1/photo.jpg',
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
// GET /api/media/[id]/thumbnail
// ---------------------------------------------------------------------------

describe('GET /api/media/[id]/thumbnail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain([SAMPLE_MEDIA]);
    mockIsR2Key.mockReturnValue(true);
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null, params: { id: '1' } });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it('returns 400 for invalid media ID', async () => {
    const ctx = createMockContext({ user: USER_A, params: { id: 'abc' } });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it('returns 404 when media file does not exist', async () => {
    resetChain([]);
    queryChain.then = (resolve: any) => resolve([]);
    const ctx = createMockContext({ user: USER_A, params: { id: '999' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it('returns 404 when no thumbnail path exists', async () => {
    queryChain.then = (resolve: any) => resolve([{ ...SAMPLE_MEDIA, thumbnailPath: null }]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(404);
    expect(data.error).toContain('No thumbnail');
  });

  it('redirects to CDN URL for R2-stored thumbnails', async () => {
    queryChain.then = (resolve: any) => resolve([SAMPLE_MEDIA]);
    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('cdn.example.com');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
  });

  it('returns 404 for legacy local disk when file does not exist', async () => {
    mockIsR2Key.mockReturnValue(false);
    queryChain.then = (resolve: any) => resolve([{ ...SAMPLE_MEDIA, thumbnailPath: '/local/thumb.jpg' }]);

    const ctx = createMockContext({ user: USER_A, params: { id: '1' }, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(404);
    expect(data.error).toContain('not found on disk');
  });
});
