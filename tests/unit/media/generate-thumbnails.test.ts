/**
 * Tests webapp/src/lib/media/upload.ts generateThumbnailsForMedia() — the worker
 * path that derives the 160px thumb, 400px preview and 1200px large for a
 * browser upload that went straight to R2 (presign/finalize), so the SSR never
 * saw the bytes. Videos go through the same path, with ffmpeg extracting a
 * poster frame first.
 *
 * Covers:
 *   - Happy path: pulls original from R2, uploads all three, backfills DB
 *   - Skips only when every derivative already exists
 *   - Regenerates when `large` is missing (the backfill case)
 *   - Videos: reads via a presigned URL rather than buffering the object
 *   - Skips a missing row
 *   - Skips when the original was already deleted
 */

import { createDbMock, createDrizzleOrmMock } from '../../helpers/db-mock';

// ---------------------------------------------------------------------------
// Mocks (hoisted)
// ---------------------------------------------------------------------------

vi.mock('sharp', () => ({ default: vi.fn(() => ({ metadata: vi.fn().mockResolvedValue({}) })) }));

const mockDownloadFromR2 = vi.fn().mockResolvedValue(Buffer.from('webp-original-bytes'));
const mockUploadToR2 = vi.fn().mockResolvedValue(undefined);
const mockGetPresignedDownloadUrl = vi.fn().mockResolvedValue('https://r2.example/signed-video');
const mockDeleteMultipleFromR2 = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/media/r2', () => ({
  uploadToR2: (...args: any[]) => mockUploadToR2(...args),
  downloadFromR2: (...args: any[]) => mockDownloadFromR2(...args),
  getPresignedDownloadUrl: (...args: any[]) => mockGetPresignedDownloadUrl(...args),
  deleteMultipleFromR2: (...args: any[]) => mockDeleteMultipleFromR2(...args),
  deleteFromR2: vi.fn(),
  isR2Key: (p: string) => !p.startsWith('/'),
  getR2PublicUrl: (k: string) => `https://images.bulkpublish.com/${k}`,
}));

const mockGenerateThumbnail = vi.fn();
vi.mock('@/lib/media/thumbnail', () => ({
  generateThumbnail: (...args: any[]) => mockGenerateThumbnail(...args),
}));

const { db: mockDb, setResult, resetChain } = createDbMock();
vi.mock('@/lib/db', () => ({ db: mockDb }));
vi.mock('@/lib/db/schema', () => ({ mediaFiles: { id: 'mf.id' } }));
vi.mock('drizzle-orm', () => createDrizzleOrmMock());

vi.mock('@lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() }),
}));

const fakeFs = {
  existsSync: vi.fn(() => true),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => Buffer.from('thumb-bytes')),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
};
vi.mock('node:fs', () => ({ ...fakeFs, default: fakeFs }));

export {};

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------
const { generateThumbnailsForMedia } = await import('@/lib/media/upload');

const IMAGE_ROW = {
  id: 5,
  originalPath: 'original/1/123-abc.webp',
  thumbnailPath: null,
  previewPath: null,
  largePath: null,
  mimeType: 'image/webp',
  width: null,
  height: null,
  duration: null,
  isOriginalDeleted: false,
};

describe('generateThumbnailsForMedia', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain();
    mockGenerateThumbnail.mockResolvedValue({
      thumbnailPath: '/tmp/thumb-123-abc.webp',
      previewPath: '/tmp/preview-123-abc.webp',
      largePath: '/tmp/large-123-abc.webp',
      width: 800,
      height: 600,
    });
  });

  it('downloads the original, uploads all three derivatives, and backfills the row', async () => {
    setResult([IMAGE_ROW]);

    await generateThumbnailsForMedia(5);

    expect(mockDownloadFromR2).toHaveBeenCalledWith('original/1/123-abc.webp');
    expect(mockUploadToR2).toHaveBeenCalledTimes(3);
    const keys = mockUploadToR2.mock.calls.map((c) => c[0]);
    expect(keys).toEqual([
      'thumbnails/thumb-123-abc.webp',
      'thumbnails/preview-123-abc.webp',
      'thumbnails/large-123-abc.webp',
    ]);
    expect(mockUploadToR2.mock.calls[0][2]).toBe('image/webp');
    // DB row updated with the new keys + backfilled dimensions
    expect(mockDb.update).toHaveBeenCalledTimes(1);
    const setArg = (mockDb.update() as any).set.mock.calls.at(-1)[0];
    expect(setArg.thumbnailPath).toBe('thumbnails/thumb-123-abc.webp');
    expect(setArg.previewPath).toBe('thumbnails/preview-123-abc.webp');
    expect(setArg.largePath).toBe('thumbnails/large-123-abc.webp');
    expect(setArg.width).toBe(800);
    expect(setArg.height).toBe(600);
  });

  it('keeps client-supplied dimensions over the derived ones', async () => {
    setResult([{ ...IMAGE_ROW, width: 1920, height: 1080 }]);

    await generateThumbnailsForMedia(5);

    const setArg = (mockDb.update() as any).set.mock.calls.at(-1)[0];
    expect(setArg.width).toBe(1920);
    expect(setArg.height).toBe(1080);
  });

  it('skips only when every derivative already exists', async () => {
    setResult([{
      ...IMAGE_ROW,
      thumbnailPath: 'thumbnails/existing.webp',
      previewPath: 'thumbnails/existing-preview.webp',
      largePath: 'thumbnails/existing-large.webp',
    }]);

    await generateThumbnailsForMedia(5);

    expect(mockDownloadFromR2).not.toHaveBeenCalled();
    expect(mockUploadToR2).not.toHaveBeenCalled();
  });

  it('regenerates when only `large` is missing — the backfill case', async () => {
    setResult([{
      ...IMAGE_ROW,
      thumbnailPath: 'thumbnails/existing.webp',
      previewPath: 'thumbnails/existing-preview.webp',
      largePath: null,
    }]);

    await generateThumbnailsForMedia(5);

    expect(mockDownloadFromR2).toHaveBeenCalled();
    const setArg = (mockDb.update() as any).set.mock.calls.at(-1)[0];
    expect(setArg.largePath).toBe('thumbnails/large-123-abc.webp');

    // Regeneration writes new randomised keys, so the ones it replaced must be
    // swept or they become R2 orphans no DB row will ever reference.
    expect(mockDeleteMultipleFromR2).toHaveBeenCalledWith([
      'thumbnails/existing.webp',
      'thumbnails/existing-preview.webp',
    ]);
  });

  it('reads video through a presigned URL instead of buffering the object', async () => {
    setResult([{ ...IMAGE_ROW, mimeType: 'video/mp4', originalPath: 'original/1/123-abc.mp4' }]);
    mockGenerateThumbnail.mockResolvedValue({
      thumbnailPath: '/tmp/thumb-123-abc.webp',
      previewPath: '/tmp/preview-123-abc.webp',
      largePath: '/tmp/large-123-abc.webp',
      width: 1080,
      height: 1920,
      duration: 30,
    });

    await generateThumbnailsForMedia(5);

    // A 1GB upload must not be pulled into the worker heap.
    expect(mockDownloadFromR2).not.toHaveBeenCalled();
    expect(mockGetPresignedDownloadUrl).toHaveBeenCalledWith('original/1/123-abc.mp4');
    expect(mockGenerateThumbnail).toHaveBeenCalledWith(
      'https://r2.example/signed-video',
      'video/mp4',
      expect.any(String),
    );
    const setArg = (mockDb.update() as any).set.mock.calls.at(-1)[0];
    expect(setArg.duration).toBe(30);
  });

  it('keeps existing derivatives when a video frame could not be extracted', async () => {
    setResult([{ ...IMAGE_ROW, mimeType: 'video/mp4', thumbnailPath: 'thumbnails/old.webp' }]);
    mockGenerateThumbnail.mockResolvedValue({
      thumbnailPath: null,
      previewPath: null,
      largePath: null,
      width: 1080,
      height: 1920,
      duration: 12,
    });

    await generateThumbnailsForMedia(5);

    const setArg = (mockDb.update() as any).set.mock.calls.at(-1)[0];
    expect(setArg.thumbnailPath).toBe('thumbnails/old.webp');
    expect(setArg.duration).toBe(12);
  });

  it('skips when the row is missing', async () => {
    setResult([]);

    await generateThumbnailsForMedia(999);

    expect(mockDownloadFromR2).not.toHaveBeenCalled();
  });

  it('skips when the original was already deleted', async () => {
    setResult([{ ...IMAGE_ROW, isOriginalDeleted: true }]);

    await generateThumbnailsForMedia(5);

    expect(mockDownloadFromR2).not.toHaveBeenCalled();
  });
});
