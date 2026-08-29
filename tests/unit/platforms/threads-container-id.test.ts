/**
 * Threads: a PUBLISHED container must not be stored as the post ID.
 *
 * When checkPublishStatus finds a container already in PUBLISHED state we never
 * saw the publish response, so we never learned the real media ID. The code
 * stored the CONTAINER id instead — but a container is not addressable once
 * published. Verified against the live API: the one production row written this
 * way holds 18125312440780701, and both /{id}?fields=id and /{id}/insights
 * return 400 "Object with ID ... does not exist", so that post had no metrics
 * and no permalink, permanently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { resolveRecentThreadId } = await import('@/lib/platforms/threads');

export {};

function listResponse(items: Array<{ id: string; permalink?: string; timestamp?: string }>) {
  return { ok: true, status: 200, json: async () => ({ data: items }) };
}

const NOW = new Date('2026-07-29T12:00:00Z').getTime();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe('resolveRecentThreadId', () => {
  beforeEach(() => mockFetch.mockReset());

  it('returns the newest thread when it was just published', async () => {
    mockFetch.mockResolvedValue(
      listResponse([
        { id: '18126519427728454', permalink: 'https://www.threads.com/@a/post/X', timestamp: iso(60_000) },
        { id: '17991561370898273', timestamp: iso(90 * 24 * 3600_000) },
      ]),
    );

    const got = await resolveRecentThreadId('user1', 'tok', NOW);
    expect(got).toEqual({
      id: '18126519427728454',
      permalink: 'https://www.threads.com/@a/post/X',
    });
  });

  it('refuses a stale thread — the real post was deleted, do not adopt an old one', async () => {
    // Exactly the production shape: the account's newest real thread is weeks
    // old while our container claims PUBLISHED. Adopting it would report an
    // unrelated post's metrics as this post's.
    mockFetch.mockResolvedValue(
      listResponse([{ id: '18126519427728454', timestamp: iso(24 * 24 * 3600_000) }]),
    );

    expect(await resolveRecentThreadId('user1', 'tok', NOW)).toBeUndefined();
  });

  it('accepts a thread right at the edge of the window but not past it', async () => {
    mockFetch.mockResolvedValue(listResponse([{ id: 'a', timestamp: iso(2 * 3600_000 - 1000) }]));
    expect(await resolveRecentThreadId('u', 't', NOW)).toMatchObject({ id: 'a' });

    mockFetch.mockResolvedValue(listResponse([{ id: 'b', timestamp: iso(2 * 3600_000 + 1000) }]));
    expect(await resolveRecentThreadId('u', 't', NOW)).toBeUndefined();
  });

  it('returns undefined for an empty account', async () => {
    mockFetch.mockResolvedValue(listResponse([]));
    expect(await resolveRecentThreadId('u', 't', NOW)).toBeUndefined();
  });

  it('returns undefined without a token, and makes no request', async () => {
    expect(await resolveRecentThreadId('u', undefined, NOW)).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('swallows a non-OK response rather than failing the publish', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });
    expect(await resolveRecentThreadId('u', 't', NOW)).toBeUndefined();
  });

  it('swallows a transport failure rather than failing the publish', async () => {
    // Throws synchronously inside the try block, exercising the same catch as a
    // network rejection. A mock that REJECTS trips vitest's unhandled-rejection
    // detector regardless of the caller's try/catch, which would fail this test
    // for the very behaviour it asserts.
    mockFetch.mockResolvedValue({
      get ok(): boolean {
        throw new Error('socket hang up');
      },
    });
    expect(await resolveRecentThreadId('u', 't', NOW)).toBeUndefined();
  });

  it('accepts a thread with no timestamp rather than discarding it', async () => {
    mockFetch.mockResolvedValue(listResponse([{ id: 'no-ts' }]));
    expect(await resolveRecentThreadId('u', 't', NOW)).toMatchObject({ id: 'no-ts' });
  });
});
