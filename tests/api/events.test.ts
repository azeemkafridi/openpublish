/**
 * Tests for the product-event beacon.
 *
 *   POST /api/events — anonymous-capable client event ingestion (src/lib/track.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    rateLimitAllowed: true,
    authContext: null as null | { userId: string; organizationId: number },
    logged: [] as any[],
  },
}));

vi.mock('@lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () =>
    state.rateLimitAllowed
      ? { allowed: true, remaining: 10 }
      : { allowed: false, remaining: 0, retryAfter: 30 },
  ),
  rateLimitResponse: (retryAfter: number) =>
    new Response(JSON.stringify({ error: { message: 'Too many requests', code: 'RATE_LIMITED' } }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) },
    }),
}));

vi.mock('@lib/http/client-ip', () => ({
  getClientIp: () => '203.0.113.9',
}));

vi.mock('@lib/auth/middleware', () => ({
  getAuthContext: vi.fn(async () => state.authContext),
}));

vi.mock('@lib/activity/log', () => ({
  logActivity: vi.fn((opts: any) => {
    state.logged.push(opts);
  }),
}));

import { POST } from '@/pages/api/events';

function makeContext(body: unknown) {
  const request = new Request('http://localhost/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { request, clientAddress: '203.0.113.9' } as any;
}

describe('POST /api/events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rateLimitAllowed = true;
    state.authContext = null;
    state.logged = [];
  });

  it('records an anonymous event with a ux. action prefix', async () => {
    const res = await POST(makeContext({ name: 'page_view', path: '/login' }));
    expect(res.status).toBe(202);
    expect(state.logged).toHaveLength(1);
    expect(state.logged[0]).toMatchObject({
      userId: undefined,
      organizationId: undefined,
      action: 'ux.page_view',
      resource: 'ux',
      details: { path: '/login' },
    });
  });

  it('attributes the event when a session resolves', async () => {
    state.authContext = { userId: 'user-a', organizationId: 7 };
    const res = await POST(makeContext({ name: 'connect_platform_clicked', props: { platform: 'x' } }));
    expect(res.status).toBe(202);
    expect(state.logged[0]).toMatchObject({
      userId: 'user-a',
      organizationId: 7,
      action: 'ux.connect_platform_clicked',
      details: { platform: 'x' },
    });
  });

  it('merges path and props into details', async () => {
    await POST(makeContext({ name: 'composer_submit_failed', path: '/compose', props: { mode: 'queue' } }));
    expect(state.logged[0].details).toEqual({ path: '/compose', mode: 'queue' });
  });

  it('rejects invalid event names', async () => {
    for (const name of ['', 'UPPER', 'has space', 'x'.repeat(61), '../etc', 42, undefined]) {
      const res = await POST(makeContext({ name }));
      expect(res.status).toBe(400);
    }
    expect(state.logged).toHaveLength(0);
  });

  it('rejects malformed JSON and oversized bodies', async () => {
    expect((await POST(makeContext('not json'))).status).toBe(400);
    expect((await POST(makeContext({ name: 'page_view', props: { pad: 'x'.repeat(5000) } }))).status).toBe(400);
    expect(state.logged).toHaveLength(0);
  });

  it('drops oversized or non-object props but keeps the event', async () => {
    const res = await POST(makeContext({ name: 'page_view', props: { pad: 'x'.repeat(1500) } }));
    expect(res.status).toBe(202);
    expect(state.logged[0].details).toEqual({});

    await POST(makeContext({ name: 'page_view', props: ['not', 'an', 'object'] }));
    expect(state.logged[1].details).toEqual({});
  });

  it('ignores a non-string or non-rooted path', async () => {
    await POST(makeContext({ name: 'page_view', path: 'https://evil.example/x' }));
    expect(state.logged[0].details).toEqual({});
  });

  it('returns 429 when rate limited and logs nothing', async () => {
    state.rateLimitAllowed = false;
    const res = await POST(makeContext({ name: 'page_view' }));
    expect(res.status).toBe(429);
    expect(state.logged).toHaveLength(0);
  });

  it('still records the event when session resolution throws', async () => {
    const { getAuthContext } = await import('@lib/auth/middleware');
    (getAuthContext as any).mockRejectedValueOnce(new Error('db down'));
    const res = await POST(makeContext({ name: 'page_view' }));
    expect(res.status).toBe(202);
    expect(state.logged[0].userId).toBeUndefined();
  });
});

export {};
