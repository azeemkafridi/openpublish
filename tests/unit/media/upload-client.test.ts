/**
 * Tests the browser upload flow in webapp/src/lib/media/upload-client.ts:
 *   compress → presign → PUT (with progress) → finalize.
 *
 * compress is mocked (no real canvas); fetch + XMLHttpRequest are faked so we
 * can drive presign/finalize responses and the upload progress/error paths.
 */

const mockPrepareForUpload = vi.fn();
vi.mock('@/lib/media/compress', () => ({
  prepareForUpload: (...a: any[]) => mockPrepareForUpload(...a),
}));

export {};

const { uploadMediaFile } = await import('@/lib/media/upload-client');

// ---- fake XMLHttpRequest --------------------------------------------------
let xhrBehavior: { status?: number; networkError?: boolean } = {};
let lastXhr: FakeXHR | null = null;

class FakeXHR {
  upload: { onprogress?: (e: any) => void } = {};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 200;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: any = null;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  abort() {
    this.onabort?.();
  }
  send(body: any) {
    this.body = body;
    lastXhr = this;
    queueMicrotask(() => {
      if (xhrBehavior.networkError) {
        this.onerror?.();
        return;
      }
      this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
      this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
      this.status = xhrBehavior.status ?? 200;
      this.onload?.();
    });
  }
}

// ---- fake fetch -----------------------------------------------------------
function jsonResponse(body: unknown, ok = true, status = 200): any {
  return { ok, status, json: async () => body };
}

let presignResponse: any;
let finalizeResponse: any;
let fetchCalls: Array<{ url: string; body: any }> = [];

const fetchMock = vi.fn(async (url: string, init: any) => {
  const body = init?.body ? JSON.parse(init.body) : undefined;
  fetchCalls.push({ url, body });
  if (url.includes('/presign')) return presignResponse;
  if (url.includes('/finalize')) return finalizeResponse;
  throw new Error(`unexpected fetch ${url}`);
});

const PREPARED = { blob: new Blob(['x'.repeat(100)], { type: 'image/webp' }), mimeType: 'image/webp', fileName: 'photo.png', width: 800, height: 600 };
const FINALIZED_FILE = { id: 42, fileName: 'photo.png', mimeType: 'image/webp', sizeBytes: 100, originalUrl: 'https://cdn/x.webp', thumbnailUrl: null, previewUrl: null };

describe('uploadMediaFile', () => {
  beforeEach(() => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR as any);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockClear();
    fetchCalls = [];
    xhrBehavior = {};
    lastXhr = null;
    mockPrepareForUpload.mockResolvedValue(PREPARED);
    presignResponse = jsonResponse({ uploadUrl: 'https://r2/put?sig', r2Key: 'original/1/123-abc.webp' });
    finalizeResponse = jsonResponse({ file: FINALIZED_FILE }, true, 201);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('compresses, presigns, PUTs, finalizes, and returns the file', async () => {
    const file = new File(['original'], 'photo.png', { type: 'image/png' });
    const result = await uploadMediaFile(file);

    expect(mockPrepareForUpload).toHaveBeenCalledWith(file);
    expect(result).toEqual(FINALIZED_FILE);

    // presign sent the prepared content type + compressed size
    const presign = fetchCalls.find((c) => c.url.includes('/presign'))!;
    expect(presign.body).toEqual({ contentType: 'image/webp', sizeBytes: PREPARED.blob.size });

    // PUT went to the signed URL with a matching Content-Type
    expect(lastXhr?.method).toBe('PUT');
    expect(lastXhr?.url).toBe('https://r2/put?sig');
    expect(lastXhr?.headers['Content-Type']).toBe('image/webp');

    // finalize carried the key + dimensions
    const finalize = fetchCalls.find((c) => c.url.includes('/finalize'))!;
    expect(finalize.body).toMatchObject({ r2Key: 'original/1/123-abc.webp', fileName: 'photo.png', mimeType: 'image/webp', width: 800, height: 600 });
  });

  it('reports monotonic progress ending at 100', async () => {
    const seen: number[] = [];
    await uploadMediaFile(new File(['x'], 'p.png', { type: 'image/png' }), { onProgress: (p) => seen.push(p) });
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(100);
    // upload progress is capped at 95 until finalize
    expect(Math.max(...seen.slice(0, -1))).toBeLessThanOrEqual(95);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it('throws the server error and never PUTs when presign fails', async () => {
    presignResponse = jsonResponse({ error: 'Storage quota exceeded' }, false, 403);
    await expect(uploadMediaFile(new File(['x'], 'p.png', { type: 'image/png' }))).rejects.toThrow('Storage quota exceeded');
    expect(lastXhr).toBeNull();
    expect(fetchCalls.some((c) => c.url.includes('/finalize'))).toBe(false);
  });

  it('appends the server hint to the error when the quota response includes one', async () => {
    presignResponse = jsonResponse(
      { error: { message: "You've reached the media storage limit (100/100).", hint: 'Free space by removing unused media from your Media Library.' } },
      false,
      403,
    );
    await expect(uploadMediaFile(new File(['x'], 'p.png', { type: 'image/png' }))).rejects.toThrow('media storage limit (100/100). Free space by removing unused media');
  });

  it('throws and does not finalize when the PUT fails', async () => {
    xhrBehavior = { status: 403 };
    await expect(uploadMediaFile(new File(['x'], 'p.png', { type: 'image/png' }))).rejects.toThrow(/Upload failed \(403\)/);
    expect(fetchCalls.some((c) => c.url.includes('/finalize'))).toBe(false);
  });

  it('throws on a network error during PUT', async () => {
    xhrBehavior = { networkError: true };
    await expect(uploadMediaFile(new File(['x'], 'p.png', { type: 'image/png' }))).rejects.toThrow(/network error/);
  });

  it('throws when finalize fails', async () => {
    finalizeResponse = jsonResponse({ error: 'File content does not match declared type' }, false, 400);
    await expect(uploadMediaFile(new File(['x'], 'p.png', { type: 'image/png' }))).rejects.toThrow(/does not match/);
  });

  it('omits zero dimensions from the finalize payload', async () => {
    mockPrepareForUpload.mockResolvedValue({ blob: new Blob(['v']), mimeType: 'video/mp4', fileName: 'clip.mp4', width: 0, height: 0 });
    await uploadMediaFile(new File(['v'], 'clip.mp4', { type: 'video/mp4' }));
    const finalize = fetchCalls.find((c) => c.url.includes('/finalize'))!;
    expect(finalize.body.width).toBeUndefined();
    expect(finalize.body.height).toBeUndefined();
  });
});
