import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock drizzle-orm with importOriginal to include relations
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn(),
    desc: vi.fn(),
    ilike: vi.fn(),
    and: vi.fn((...args: unknown[]) => args),
  };
});

vi.mock('@/lib/db', () => ({ db: { select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ offset: vi.fn().mockResolvedValue([]) }) }) }) }) }) } }));
vi.mock('@/lib/media/upload', () => ({
  saveUploadedFile: vi.fn().mockResolvedValue({
    id: 1, fileName: 'test.jpg', mimeType: 'image/jpeg', sizeBytes: 1024,
    originalPath: '/test.jpg', thumbnailPath: null, previewPath: null,
    width: null, height: null, duration: null,
  }),
  getMediaPublicUrl: vi.fn((p: string) => `https://cdn.test/${p}`),
}));
vi.mock('@/lib/activity/log', () => ({ logActivity: vi.fn() }));
vi.mock('@/lib/quotas/check', () => ({
  checkMediaStorageQuota: vi.fn().mockResolvedValue({ allowed: true }),
  getOrgPlan: vi.fn().mockResolvedValue('pro'),
}));
vi.mock('@/lib/quotas/errors', () => ({
  quotaExceededResponse: vi.fn(),
}));

import { POST } from '@/pages/api/media/index';

function createCtx(file: File | null) {
  const formData = new FormData();
  if (file) formData.append('file', file);

  return {
    locals: {
      auth: {
        user: { id: 'user-1', name: 'Test', email: 'test@test.com', role: 'user' },
        organizationId: 1,
      },
    },
    request: {
      headers: new Headers({ 'content-type': 'multipart/form-data; boundary=---' }),
      formData: vi.fn().mockResolvedValue(formData),
    },
  };
}

describe('Upload Validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects files over 100MB', async () => {
    const file = new File([new Uint8Array(1)], 'big.jpg', { type: 'image/jpeg' });
    Object.defineProperty(file, 'size', { value: 101 * 1024 * 1024 });

    const response = await POST(createCtx(file) as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain('too large');
  });

  it('rejects disallowed MIME types', async () => {
    const file = new File(['test'], 'malware.exe', { type: 'application/x-msdownload' });
    Object.defineProperty(file, 'size', { value: 1024 });

    const response = await POST(createCtx(file) as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain('not allowed');
  });

  it('rejects empty files', async () => {
    const file = new File([], 'empty.jpg', { type: 'image/jpeg' });

    const response = await POST(createCtx(file) as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain('empty');
  });

  it('accepts valid image uploads', async () => {
    const jpegMagic = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, ...Array(8).fill(0)]);
    const file = new File([jpegMagic], 'photo.jpg', { type: 'image/jpeg' });
    Object.defineProperty(file, 'size', { value: 5000 });

    const response = await POST(createCtx(file) as any);
    expect(response.status).toBe(201);
  });
});
