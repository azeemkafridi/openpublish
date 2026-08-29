/**
 * R2 storage tests.
 *
 * Tests webapp/src/lib/media/r2.ts covering:
 *   - uploadToR2 sends PutObjectCommand with correct params
 *   - Upload timeout after 60s rejects with error message
 *   - deleteFromR2 sends DeleteObjectCommand
 *   - deleteMultipleFromR2 batches in groups of 1000
 *   - getR2PublicUrl returns correct URL format
 *   - isR2Key returns true for relative paths, false for absolute
 */

// ---------------------------------------------------------------------------
// Mock S3Client BEFORE importing the module
// ---------------------------------------------------------------------------

process.env.STORAGE = 's3';
process.env.R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://media.example';
process.env.R2_ENDPOINT = process.env.R2_ENDPOINT || 'https://r2.example';
process.env.R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || 'test-key';
process.env.R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || 'test-secret';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
  class MockS3Client {
    send = mockSend;
    constructor() {}
  }
  class MockPutObjectCommand {
    _type = 'PutObjectCommand';
    constructor(public params: any) {
      Object.assign(this, params);
    }
  }
  class MockDeleteObjectCommand {
    _type = 'DeleteObjectCommand';
    constructor(public params: any) {
      Object.assign(this, params);
    }
  }
  class MockDeleteObjectsCommand {
    _type = 'DeleteObjectsCommand';
    constructor(public params: any) {
      Object.assign(this, params);
    }
  }
  class MockGetObjectCommand {
    _type = 'GetObjectCommand';
    constructor(public params: any) {
      Object.assign(this, params);
    }
  }
  class MockHeadObjectCommand {
    _type = 'HeadObjectCommand';
    constructor(public params: any) {
      Object.assign(this, params);
    }
  }
  return {
    S3Client: MockS3Client,
    PutObjectCommand: MockPutObjectCommand,
    DeleteObjectCommand: MockDeleteObjectCommand,
    DeleteObjectsCommand: MockDeleteObjectsCommand,
    GetObjectCommand: MockGetObjectCommand,
    HeadObjectCommand: MockHeadObjectCommand,
  };
});

const mockGetSignedUrl = vi.fn();
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: any[]) => mockGetSignedUrl(...args),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

export {};

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------

const {
  uploadToR2,
  deleteFromR2,
  deleteMultipleFromR2,
  downloadFromR2,
  getR2PublicUrl,
  isR2Key,
  getPresignedUploadUrl,
  headR2Object,
  getR2ObjectRange,
} = await import('@/lib/media/r2');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('uploadToR2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends PutObjectCommand with correct params', async () => {
    mockSend.mockResolvedValue({});

    const buffer = Buffer.from('test-data');
    await uploadToR2('original/test.jpg', buffer, 'image/jpeg');

    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd._type).toBe('PutObjectCommand');
    expect(cmd.Key).toBe('original/test.jpg');
    expect(cmd.Body).toEqual(buffer);
    expect(cmd.ContentType).toBe('image/jpeg');
  });

  it('rejects with timeout message after 60s', async () => {
    // Make the send hang indefinitely, then let the timeout fire
    vi.useFakeTimers();
    mockSend.mockImplementation(() => new Promise(() => {})); // never resolves

    const promise = uploadToR2('test/key.jpg', Buffer.from('data'), 'image/jpeg');

    // Advance past the 60s timeout
    vi.advanceTimersByTime(61_000);

    await expect(promise).rejects.toThrow(/timed out/i);

    vi.useRealTimers();
  });
});

describe('deleteFromR2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends DeleteObjectCommand with correct key', async () => {
    mockSend.mockResolvedValue({});

    await deleteFromR2('original/test.jpg');

    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd._type).toBe('DeleteObjectCommand');
    expect(cmd.Key).toBe('original/test.jpg');
  });

  it('does not throw on delete failure', async () => {
    mockSend.mockRejectedValue(new Error('S3 error'));

    await expect(deleteFromR2('nonexistent.jpg')).resolves.toBeUndefined();
  });
});

describe('deleteMultipleFromR2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing for empty array', async () => {
    await deleteMultipleFromR2([]);

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sends single batch for <= 1000 keys', async () => {
    mockSend.mockResolvedValue({});

    const keys = Array.from({ length: 5 }, (_, i) => `file-${i}.jpg`);
    await deleteMultipleFromR2(keys);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd._type).toBe('DeleteObjectsCommand');
    expect(cmd.Delete.Objects).toEqual(keys.map((Key) => ({ Key })));
    expect(cmd.Delete.Quiet).toBe(true);
  });

  it('batches in groups of 1000 for large sets', async () => {
    mockSend.mockResolvedValue({});

    const keys = Array.from({ length: 2500 }, (_, i) => `file-${i}.jpg`);
    await deleteMultipleFromR2(keys);

    // 2500 / 1000 = 3 batches
    expect(mockSend).toHaveBeenCalledTimes(3);
  });
});

describe('downloadFromR2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns buffer from stream', async () => {
    const data = Buffer.from('file-content');
    const mockStream = {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array(data);
      },
    };

    mockSend.mockResolvedValue({ Body: mockStream });

    const result = await downloadFromR2('original/test.jpg');

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.toString()).toBe('file-content');
  });

  it('throws on empty response body', async () => {
    mockSend.mockResolvedValue({ Body: null });

    await expect(downloadFromR2('missing.jpg')).rejects.toThrow(/Empty response/);
  });
});

describe('getR2PublicUrl', () => {
  it('returns correct URL format', () => {
    const url = getR2PublicUrl('original/test.jpg');
    expect(url).toMatch(/^https?:\/\/.+\/original\/test\.jpg$/);
  });

  it('includes the key in the URL', () => {
    const url = getR2PublicUrl('thumbnails/thumb-abc123.webp');
    expect(url).toContain('thumbnails/thumb-abc123.webp');
  });
});

describe('isR2Key', () => {
  it('returns true for relative paths', () => {
    expect(isR2Key('original/test.jpg')).toBe(true);
    expect(isR2Key('thumbnails/thumb.webp')).toBe(true);
    expect(isR2Key('converted/out.jpg')).toBe(true);
  });

  it('returns false for absolute paths', () => {
    expect(isR2Key('/var/uploads/original/test.jpg')).toBe(false);
    expect(isR2Key('/home/user/files/photo.png')).toBe(false);
  });
});

describe('getPresignedUploadUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('signs a PutObjectCommand with the given key + content type', async () => {
    mockGetSignedUrl.mockResolvedValue('https://r2.example.com/signed-put');

    const url = await getPresignedUploadUrl('original/1/123-abc.webp', 'image/webp');

    expect(url).toBe('https://r2.example.com/signed-put');
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
    const [, command, opts] = mockGetSignedUrl.mock.calls[0];
    expect(command._type).toBe('PutObjectCommand');
    expect(command.Key).toBe('original/1/123-abc.webp');
    expect(command.ContentType).toBe('image/webp');
    expect(opts.expiresIn).toBe(300);
  });

  it('honours a custom expiry', async () => {
    mockGetSignedUrl.mockResolvedValue('https://r2.example.com/signed-put');
    await getPresignedUploadUrl('original/1/k.jpg', 'image/jpeg', 600);
    expect(mockGetSignedUrl.mock.calls[0][2].expiresIn).toBe(600);
  });
});

describe('headR2Object', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns content type + length for an existing object', async () => {
    mockSend.mockResolvedValue({ ContentType: 'image/webp', ContentLength: 4096 });
    const res = await headR2Object('original/1/k.webp');
    expect(res).toEqual({ contentType: 'image/webp', contentLength: 4096 });
    expect(mockSend.mock.calls[0][0]._type).toBe('HeadObjectCommand');
  });

  it('returns null when the object does not exist', async () => {
    mockSend.mockRejectedValue(new Error('NotFound'));
    const res = await headR2Object('original/1/missing.webp');
    expect(res).toBeNull();
  });

  it('defaults length to 0 when missing', async () => {
    mockSend.mockResolvedValue({ ContentType: 'image/png' });
    const res = await headR2Object('original/1/k.png');
    expect(res).toEqual({ contentType: 'image/png', contentLength: 0 });
  });
});

describe('getR2ObjectRange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requests a byte range and returns the buffer', async () => {
    const data = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    mockSend.mockResolvedValue({
      Body: {
        async *[Symbol.asyncIterator]() {
          yield new Uint8Array(data);
        },
      },
    });

    const res = await getR2ObjectRange('original/1/k.jpg', 11);
    expect(Buffer.isBuffer(res)).toBe(true);
    expect(res?.[0]).toBe(0xff);
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd._type).toBe('GetObjectCommand');
    expect(cmd.Range).toBe('bytes=0-11');
  });

  it('returns null on error', async () => {
    mockSend.mockRejectedValue(new Error('boom'));
    expect(await getR2ObjectRange('original/1/k.jpg', 11)).toBeNull();
  });

  it('returns null on empty body', async () => {
    mockSend.mockResolvedValue({ Body: null });
    expect(await getR2ObjectRange('original/1/k.jpg', 11)).toBeNull();
  });
});
