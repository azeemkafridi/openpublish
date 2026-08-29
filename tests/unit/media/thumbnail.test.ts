/**
 * Thumbnail generation tests.
 *
 * Tests webapp/src/lib/media/thumbnail.ts covering:
 *   - generateThumbnail dispatches to image or video handler based on mimeType
 *   - Image: creates 160x160 square crop (thumbnail)
 *   - Image: creates 400px wide preview
 *   - Image: returns width/height from metadata
 *   - Video: returns placeholder (null paths) for video mimeTypes
 *   - Unknown mimeType returns null paths
 */

// ---------------------------------------------------------------------------
// Mocks (hoisted)
// ---------------------------------------------------------------------------

const mockSharpInstance = {
  resize: vi.fn().mockReturnThis(),
  webp: vi.fn().mockReturnThis(),
  toFile: vi.fn().mockResolvedValue(undefined),
  metadata: vi.fn().mockResolvedValue({ width: 1920, height: 1080, format: 'jpeg' }),
};

const mockSharp = vi.fn(() => mockSharpInstance);

vi.mock('sharp', () => ({
  default: mockSharp,
}));

const { mockProbeVideo, mockExtractVideoFrame } = vi.hoisted(() => ({
  mockProbeVideo: vi.fn(),
  mockExtractVideoFrame: vi.fn(),
}));
vi.mock('@/lib/media/ffmpeg', () => ({
  probeVideo: (...a: any[]) => mockProbeVideo(...a),
  extractVideoFrame: (...a: any[]) => mockExtractVideoFrame(...a),
  pickSeekOffset: () => 1,
}));

vi.mock('@lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

export {};

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------

const { generateThumbnail } = await import('@/lib/media/thumbnail');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateThumbnail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSharpInstance.metadata.mockResolvedValue({ width: 1920, height: 1080, format: 'jpeg' });
    mockSharpInstance.resize.mockReturnThis();
    mockSharpInstance.webp.mockReturnThis();
    mockSharpInstance.toFile.mockResolvedValue(undefined);
  });

  // -----------------------------------------------------------------------
  // Image handling
  // -----------------------------------------------------------------------

  describe('image thumbnails', () => {
    it('creates a 160x160 square crop thumbnail', async () => {
      await generateThumbnail('/uploads/original/photo.jpg', 'image/jpeg', 'photo.jpg');

      // sharp is called at least once for the thumbnail
      expect(mockSharp).toHaveBeenCalledWith('/uploads/original/photo.jpg');

      // Find the resize call for the 160x160 thumbnail
      const resizeCalls = mockSharpInstance.resize.mock.calls;
      const thumbCall = resizeCalls.find(
        (call: any[]) => call[0] === 160 && call[1] === 160,
      );
      expect(thumbCall).toBeDefined();
      expect(thumbCall![2]).toEqual({ fit: 'cover', position: 'centre' });
    });

    it('creates a 400px wide preview', async () => {
      await generateThumbnail('/uploads/original/photo.jpg', 'image/jpeg', 'photo.jpg');

      const resizeCalls = mockSharpInstance.resize.mock.calls;
      const previewCall = resizeCalls.find(
        (call: any[]) => call[0] === 400 && call[1] === undefined,
      );
      expect(previewCall).toBeDefined();
      expect(previewCall![2]).toEqual({ withoutEnlargement: true });
    });

    it('outputs webp format for thumbnail with quality 75', async () => {
      await generateThumbnail('/uploads/original/photo.jpg', 'image/jpeg', 'photo.jpg');

      const webpCalls = mockSharpInstance.webp.mock.calls;
      expect(webpCalls).toContainEqual([{ quality: 75 }]);
    });

    it('outputs webp format for preview with quality 80', async () => {
      await generateThumbnail('/uploads/original/photo.jpg', 'image/jpeg', 'photo.jpg');

      const webpCalls = mockSharpInstance.webp.mock.calls;
      expect(webpCalls).toContainEqual([{ quality: 80 }]);
    });

    it('returns width and height from image metadata', async () => {
      mockSharpInstance.metadata.mockResolvedValue({ width: 3840, height: 2160, format: 'png' });

      const result = await generateThumbnail('/uploads/original/photo.png', 'image/png', 'photo.png');

      expect(result.width).toBe(3840);
      expect(result.height).toBe(2160);
    });

    it('returns thumbnailPath and previewPath as webp files', async () => {
      const result = await generateThumbnail('/uploads/original/photo.jpg', 'image/jpeg', 'photo.jpg');

      expect(result.thumbnailPath).toMatch(/thumb-photo\.webp$/);
      expect(result.previewPath).toMatch(/preview-photo\.webp$/);
    });

    it('strips original extension when building output names', async () => {
      const result = await generateThumbnail('/uploads/original/img.png', 'image/png', 'img.png');

      // Should NOT have double extensions like .png.webp
      expect(result.thumbnailPath).not.toContain('.png.webp');
      expect(result.previewPath).not.toContain('.png.webp');
      expect(result.thumbnailPath).toMatch(/\.webp$/);
      expect(result.previewPath).toMatch(/\.webp$/);
    });

    it('writes files to the thumbnails directory', async () => {
      await generateThumbnail('/uploads/original/photo.jpg', 'image/jpeg', 'photo.jpg');

      const toFileCalls = mockSharpInstance.toFile.mock.calls;
      // thumb (160) + preview (400) + large (1200)
      expect(toFileCalls.length).toBe(3);

      // Both should be in the thumbnails directory
      for (const [outputPath] of toFileCalls) {
        expect(outputPath).toContain('thumbnails');
      }
    });

    it('handles various image mime types', async () => {
      for (const mime of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml']) {
        vi.clearAllMocks();
        mockSharpInstance.metadata.mockResolvedValue({ width: 800, height: 600 });
        mockSharpInstance.resize.mockReturnThis();
        mockSharpInstance.webp.mockReturnThis();
        mockSharpInstance.toFile.mockResolvedValue(undefined);

        const result = await generateThumbnail('/test/img.jpg', mime, 'img.jpg');

        expect(result.thumbnailPath).toBeTruthy();
        expect(result.previewPath).toBeTruthy();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Video handling
  // -----------------------------------------------------------------------

  describe('video posters', () => {
    beforeEach(() => {
      mockProbeVideo.mockResolvedValue({ width: 1080, height: 1920, duration: 30 });
      mockExtractVideoFrame.mockResolvedValue(Buffer.from('jpeg-frame'));
    });

    it('extracts a frame and renders all three derivatives from it', async () => {
      const result = await generateThumbnail('/uploads/original/clip.mp4', 'video/mp4', 'clip.mp4');

      expect(mockExtractVideoFrame).toHaveBeenCalledWith('/uploads/original/clip.mp4', 30);
      expect(result.thumbnailPath).toContain('thumb-clip.webp');
      expect(result.previewPath).toContain('preview-clip.webp');
      expect(result.largePath).toContain('large-clip.webp');
      // sharp reads the frame buffer, never the video file itself.
      expect(mockSharp).toHaveBeenCalledWith(expect.any(Buffer));
    });

    it('reports container dimensions and duration from ffprobe', async () => {
      const result = await generateThumbnail('/uploads/original/clip.mp4', 'video/mp4', 'clip.mp4');

      // Container dimensions win — a rotated video's raw frame disagrees.
      expect(result.width).toBe(1080);
      expect(result.height).toBe(1920);
      expect(result.duration).toBe(30);
    });

    it('still backfills metadata when no frame can be extracted', async () => {
      mockExtractVideoFrame.mockResolvedValue(null);

      const result = await generateThumbnail('/uploads/original/clip.mp4', 'video/mp4', 'clip.mp4');

      expect(result.thumbnailPath).toBeNull();
      expect(result.previewPath).toBeNull();
      expect(result.largePath).toBeNull();
      expect(result.duration).toBe(30);
    });

    it('degrades to null paths when ffmpeg is unavailable', async () => {
      mockProbeVideo.mockResolvedValue(null);
      mockExtractVideoFrame.mockResolvedValue(null);

      const result = await generateThumbnail('/uploads/original/clip.mp4', 'video/mp4', 'clip.mp4');

      expect(result.thumbnailPath).toBeNull();
      expect(result.duration).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Unknown mimeType
  // -----------------------------------------------------------------------

  describe('unsupported mime types', () => {
    it('returns null paths for unknown mimeType', async () => {
      const result = await generateThumbnail('/uploads/doc.pdf', 'application/pdf', 'doc.pdf');

      expect(result.thumbnailPath).toBeNull();
      expect(result.previewPath).toBeNull();
    });

    it('does not invoke sharp for unsupported types', async () => {
      await generateThumbnail('/uploads/doc.pdf', 'application/pdf', 'doc.pdf');

      expect(mockSharp).not.toHaveBeenCalled();
    });
  });
});
