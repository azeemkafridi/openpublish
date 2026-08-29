/**
 * Media cleanup worker tests.
 *
 * Tests webapp/src/lib/jobs/media-cleanup.worker.ts covering:
 *   - cleanup-media job calls cleanupPostMedia with correct postId
 *   - generate-thumbnails job calls generateThumbnailsForMedia with mediaId
 *   - delete-files job deletes each path
 *   - check-cleanup job runs without error (periodic check)
 *   - Unknown job names are silently ignored
 *   - Worker propagates errors from cleanupPostMedia
 */

// ---------------------------------------------------------------------------
// Mocks BEFORE importing the module
// ---------------------------------------------------------------------------

const mockCleanupPostMedia = vi.fn().mockResolvedValue(undefined);
const mockGenerateThumbnailsForMedia = vi.fn().mockResolvedValue(undefined);
const mockDeleteMediaFile = vi.fn().mockResolvedValue(undefined);
let capturedProcessor: ((job: any) => Promise<void>) | null = null;

vi.mock('bullmq', () => {
  class MockWorker {
    constructor(_name: string, processor: any, _opts: any) {
      capturedProcessor = processor;
    }
  }
  return { Worker: MockWorker };
});

vi.mock('@/lib/jobs/queue', () => ({
  getRedisConnection: () => ({}),
  QUEUE_NAMES: { MEDIA_CLEANUP: 'media-cleanup' },
}));

vi.mock('@/lib/media/storage', () => ({
  cleanupPostMedia: (...args: any[]) => mockCleanupPostMedia(...args),
}));

vi.mock('@/lib/media/upload', () => ({
  generateThumbnailsForMedia: (...args: any[]) => mockGenerateThumbnailsForMedia(...args),
  deleteMediaFile: (...args: any[]) => mockDeleteMediaFile(...args),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

export {};

const { createMediaCleanupWorker } = await import('@/lib/jobs/media-cleanup.worker');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('media-cleanup worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedProcessor = null;
    createMediaCleanupWorker();
  });

  it('calls cleanupPostMedia for cleanup-media job', async () => {
    await capturedProcessor!({ name: 'cleanup-media', data: { postId: 42 } });

    expect(mockCleanupPostMedia).toHaveBeenCalledTimes(1);
    expect(mockCleanupPostMedia).toHaveBeenCalledWith(42);
  });

  it('calls generateThumbnailsForMedia for generate-thumbnails job', async () => {
    await capturedProcessor!({ name: 'generate-thumbnails', data: { mediaId: 7 } });

    expect(mockGenerateThumbnailsForMedia).toHaveBeenCalledTimes(1);
    expect(mockGenerateThumbnailsForMedia).toHaveBeenCalledWith(7);
    expect(mockCleanupPostMedia).not.toHaveBeenCalled();
  });

  it('deletes each path for delete-files job', async () => {
    await capturedProcessor!({ name: 'delete-files', data: { paths: ['converted/a.jpg', 'converted/b.jpg'] } });

    expect(mockDeleteMediaFile).toHaveBeenCalledTimes(2);
    expect(mockDeleteMediaFile).toHaveBeenNthCalledWith(1, 'converted/a.jpg');
    expect(mockDeleteMediaFile).toHaveBeenNthCalledWith(2, 'converted/b.jpg');
  });

  it('handles check-cleanup job without calling cleanupPostMedia', async () => {
    await capturedProcessor!({ name: 'check-cleanup', data: {} });

    expect(mockCleanupPostMedia).not.toHaveBeenCalled();
  });

  it('silently ignores unknown job names', async () => {
    await expect(
      capturedProcessor!({ name: 'unknown-job', data: {} }),
    ).resolves.toBeUndefined();
    expect(mockCleanupPostMedia).not.toHaveBeenCalled();
  });

  it('propagates errors from cleanupPostMedia', async () => {
    mockCleanupPostMedia.mockRejectedValueOnce(new Error('Post not found'));

    await expect(
      capturedProcessor!({ name: 'cleanup-media', data: { postId: 999 } }),
    ).rejects.toThrow('Post not found');
  });

  it('passes different post IDs correctly', async () => {
    await capturedProcessor!({ name: 'cleanup-media', data: { postId: 1 } });
    await capturedProcessor!({ name: 'cleanup-media', data: { postId: 999 } });

    expect(mockCleanupPostMedia).toHaveBeenCalledTimes(2);
    expect(mockCleanupPostMedia).toHaveBeenNthCalledWith(1, 1);
    expect(mockCleanupPostMedia).toHaveBeenNthCalledWith(2, 999);
  });
});
