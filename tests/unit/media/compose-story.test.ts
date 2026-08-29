/**
 * Story composite tests.
 *
 * Tests webapp/src/lib/media/upload.ts composeStoryImage() covering:
 *   - Skips non-image mimetypes
 *   - Skips GIF (would lose animation)
 *   - Skips sources that are already ~9:16
 *   - Composes 1:1 source into a 1080x1920 JPEG with blurred background
 *   - Composes landscape source into a 1080x1920 JPEG
 *   - Uploads the composite to R2 and returns url/localPath
 *   - Returns null when sharp throws (graceful fallback)
 */

// ---------------------------------------------------------------------------
// Mocks (hoisted)
// ---------------------------------------------------------------------------

const mockSharpInstance = {
  resize: vi.fn().mockReturnThis(),
  blur: vi.fn().mockReturnThis(),
  modulate: vi.fn().mockReturnThis(),
  composite: vi.fn().mockReturnThis(),
  jpeg: vi.fn().mockReturnThis(),
  toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake-image-bytes')),
  toFile: vi.fn().mockResolvedValue(undefined),
  metadata: vi.fn().mockResolvedValue({ width: 1080, height: 1080, format: 'jpeg' }),
};

const mockSharp = vi.fn(() => mockSharpInstance);

vi.mock('sharp', () => ({ default: mockSharp }));

const mockUploadToR2 = vi.fn().mockResolvedValue(undefined);
const mockDownloadFromR2 = vi.fn().mockResolvedValue(Buffer.from('r2-source-bytes'));
const mockIsR2Key = vi.fn((p: string) => p.startsWith('original/') || p.startsWith('converted/'));
const mockGetR2PublicUrl = vi.fn((key: string) => `https://images.bulkpublish.com/${key}`);

vi.mock('@/lib/media/r2', () => ({
  uploadToR2: (...args: any[]) => mockUploadToR2(...args),
  downloadFromR2: (...args: any[]) => mockDownloadFromR2(...args),
  deleteFromR2: vi.fn(),
  isR2Key: (p: string) => mockIsR2Key(p),
  getR2PublicUrl: (k: string) => mockGetR2PublicUrl(k),
}));

vi.mock('@/lib/media/thumbnail', () => ({
  generateThumbnail: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/db/schema', () => ({ mediaFiles: {} }));

vi.mock('@lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

// Mock fs: pretend files exist and reads return bytes.
// upload.ts uses `import fs from 'node:fs'` (default import) so the default
// export needs to carry the functions, and named exports need them too.
const fakeFs = {
  existsSync: vi.fn(() => true),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => Buffer.from('composite-bytes')),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
};
vi.mock('node:fs', () => ({
  ...fakeFs,
  default: fakeFs,
}));

export {};

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------

const { composeStoryImage } = await import('@/lib/media/upload');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('composeStoryImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-stub chainable Sharp methods after clearAllMocks
    mockSharpInstance.resize.mockReturnThis();
    mockSharpInstance.blur.mockReturnThis();
    mockSharpInstance.modulate.mockReturnThis();
    mockSharpInstance.composite.mockReturnThis();
    mockSharpInstance.jpeg.mockReturnThis();
    mockSharpInstance.toBuffer.mockResolvedValue(Buffer.from('fake-image-bytes'));
    mockSharpInstance.toFile.mockResolvedValue(undefined);
  });

  it('returns null for non-image mimetype', async () => {
    const result = await composeStoryImage('/tmp/video.mp4', 'video/mp4', { width: 1920, height: 1080 });
    expect(result).toBeNull();
    expect(mockSharp).not.toHaveBeenCalled();
  });

  it('returns null for GIF (would lose animation)', async () => {
    const result = await composeStoryImage('/tmp/anim.gif', 'image/gif', { width: 500, height: 500 });
    expect(result).toBeNull();
    expect(mockSharp).not.toHaveBeenCalled();
  });

  it('returns null when source is already ~9:16 (no composite needed)', async () => {
    const result = await composeStoryImage('/tmp/story.jpg', 'image/jpeg', { width: 1080, height: 1920 });
    expect(result).toBeNull();
    expect(mockSharp).not.toHaveBeenCalled();
  });

  it('composites a 1:1 square into 1080x1920 with blurred background', async () => {
    const result = await composeStoryImage('/tmp/square.jpg', 'image/jpeg', { width: 1080, height: 1080 });

    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe('image/jpeg');
    expect(result!.localPath).toMatch(/^converted\/.+\.jpg$/);
    expect(result!.url).toMatch(/^https:\/\/images\.bulkpublish\.com\/converted\//);

    // Three sharp() calls: background cover+blur, foreground contain, final composite
    expect(mockSharp).toHaveBeenCalledTimes(3);

    // Background: cover resize + blur + modulate
    const resizeCalls = mockSharpInstance.resize.mock.calls;
    const coverCall = resizeCalls.find(
      (call: any[]) => call[0] === 1080 && call[1] === 1920 && call[2]?.fit === 'cover',
    );
    expect(coverCall).toBeDefined();
    expect(mockSharpInstance.blur).toHaveBeenCalled();
    expect(mockSharpInstance.modulate).toHaveBeenCalled();

    // Foreground: inside (contain) resize to fit within 1080x1920
    const insideCall = resizeCalls.find(
      (call: any[]) => call[0] === 1080 && call[1] === 1920 && call[2]?.fit === 'inside',
    );
    expect(insideCall).toBeDefined();

    // Composite centered
    expect(mockSharpInstance.composite).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ gravity: 'center' }),
      ]),
    );

    // JPEG output uploaded to R2
    expect(mockSharpInstance.jpeg).toHaveBeenCalledWith(expect.objectContaining({ quality: 92 }));
    expect(mockUploadToR2).toHaveBeenCalledWith(
      expect.stringMatching(/^converted\/.+\.jpg$/),
      expect.any(Buffer),
      'image/jpeg',
    );
  });

  it('composites a landscape image into 1080x1920', async () => {
    const result = await composeStoryImage('/tmp/wide.jpg', 'image/jpeg', { width: 1920, height: 1080 });
    expect(result).not.toBeNull();
    expect(mockSharp).toHaveBeenCalledTimes(3);
  });

  it('downloads from R2 when source is an R2 key', async () => {
    const result = await composeStoryImage('original/12345-abc.png', 'image/png', { width: 800, height: 800 });
    expect(result).not.toBeNull();
    expect(mockDownloadFromR2).toHaveBeenCalledWith('original/12345-abc.png');
  });

  it('returns null when sharp throws', async () => {
    mockSharpInstance.toBuffer.mockRejectedValueOnce(new Error('sharp failed'));
    const result = await composeStoryImage('/tmp/bad.jpg', 'image/jpeg', { width: 1000, height: 1000 });
    expect(result).toBeNull();
  });
});
