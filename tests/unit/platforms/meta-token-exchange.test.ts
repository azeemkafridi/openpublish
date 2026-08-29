/**
 * Regression tests for the Instagram + Threads OAuth token exchange.
 *
 * Why this file exists: on 2026-07-23 every Instagram connect started failing
 * and nobody noticed for three weeks. Meta moved the short-lived token into a
 * `data[]` wrapper; the handler still read `access_token` off the top level,
 * got `undefined`, and interpolated the literal string "undefined" into the
 * long-lived exchange URL. Meta answered 400 "Unsupported request - method
 * type: get" — an error that names neither the field nor the cause and reads
 * like a wrong HTTP verb. There were no tests over exchangeCodeForToken at all.
 *
 * Covers:
 *   - Instagram: `data[]` wrapper (current shape) and legacy top-level shape
 *   - Instagram/Threads: a mis-read response fails loudly, naming the field,
 *     instead of forwarding `undefined` into the next request
 *   - refreshToken: never returns an undefined token over a working one
 */

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

const { InstagramHandler } = await import('@/lib/platforms/instagram');
const { ThreadsHandler } = await import('@/lib/platforms/threads');

export {};

function jsonOk(data: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data };
}

/** Every URL passed to fetch, in call order. */
function fetchedUrls(): string[] {
  return mockFetch.mock.calls.map((c) => String(c[0]));
}

describe('Instagram exchangeCodeForToken', () => {
  const handler = new InstagramHandler();

  beforeEach(() => {
    mockFetch.mockReset();
    process.env.INSTAGRAM_APP_ID = 'ig-app-id';
    process.env.INSTAGRAM_APP_SECRET = 'ig-app-secret';
  });

  it('reads the token out of the data[] wrapper Meta returns today', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonOk({
          data: [
            {
              access_token: 'short-lived-abc',
              user_id: '17841400000000000',
              permissions: 'instagram_business_basic',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonOk({ access_token: 'long-lived-xyz', token_type: 'bearer', expires_in: 5183944 }),
      );

    const token = await handler.exchangeCodeForToken('the-code', 'https://app.test/cb');

    expect(token.accessToken).toBe('long-lived-xyz');
    expect(token.refreshToken).toBe('long-lived-xyz');
    expect(token.expiresIn).toBe(5183944);
    expect(token.userId).toBe('17841400000000000');
  });

  it('forwards the real short-lived token to the long-lived exchange, never "undefined"', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonOk({ data: [{ access_token: 'short-lived-abc', user_id: 42 }] }))
      .mockResolvedValueOnce(jsonOk({ access_token: 'long-lived-xyz', expires_in: 100 }));

    await handler.exchangeCodeForToken('the-code', 'https://app.test/cb');

    // This is the exact assertion that would have caught the outage.
    const longLivedUrl = fetchedUrls()[1];
    expect(longLivedUrl).toContain('access_token=short-lived-abc');
    expect(longLivedUrl).not.toContain('undefined');
  });

  it('still accepts the legacy top-level shape', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonOk({ access_token: 'short-legacy', user_id: 99 }))
      .mockResolvedValueOnce(jsonOk({ access_token: 'long-legacy', expires_in: 100 }));

    const token = await handler.exchangeCodeForToken('the-code', 'https://app.test/cb');

    expect(token.accessToken).toBe('long-legacy');
    expect(token.userId).toBe('99');
    expect(fetchedUrls()[1]).toContain('access_token=short-legacy');
  });

  it('fails loudly, naming the field, when the short-lived response cannot be parsed', async () => {
    // A shape we do not understand — 200 OK, but no token anywhere.
    mockFetch.mockResolvedValueOnce(jsonOk({ something_new: { access_token: 'hidden' } }));

    await expect(
      handler.exchangeCodeForToken('the-code', 'https://app.test/cb'),
    ).rejects.toThrow(/Instagram OAuth response is missing "access_token"/);

    // It must not have attempted the second call with a bad token.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fails loudly when the long-lived response cannot be parsed', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonOk({ data: [{ access_token: 'short-lived-abc', user_id: 42 }] }))
      .mockResolvedValueOnce(jsonOk({ unexpected: true }));

    await expect(
      handler.exchangeCodeForToken('the-code', 'https://app.test/cb'),
    ).rejects.toThrow(/Instagram OAuth response is missing "access_token"/);
  });
});

describe('Instagram refreshToken', () => {
  const handler = new InstagramHandler();

  beforeEach(() => mockFetch.mockReset());

  it('returns the refreshed token on the documented shape', async () => {
    mockFetch.mockResolvedValueOnce(jsonOk({ access_token: 'refreshed', expires_in: 5183944 }));

    const token = await handler.refreshToken('old-token');

    expect(token?.accessToken).toBe('refreshed');
    expect(token?.refreshToken).toBe('refreshed');
  });

  it('returns null rather than overwriting a working token with undefined', async () => {
    mockFetch.mockResolvedValueOnce(jsonOk({ unexpected: true }));

    // null means "refresh failed, keep what we have" — an object carrying an
    // undefined accessToken would silently kill the channel.
    await expect(handler.refreshToken('old-token')).resolves.toBeNull();
  });
});

describe('Threads exchangeCodeForToken', () => {
  const handler = new ThreadsHandler();

  beforeEach(() => {
    mockFetch.mockReset();
    process.env.THREADS_APP_ID = 'th-app-id';
    process.env.THREADS_APP_SECRET = 'th-app-secret';
  });

  it('reads the top-level shape Threads returns', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonOk({ access_token: 'th-short', user_id: 777 }))
      .mockResolvedValueOnce(jsonOk({ access_token: 'th-long', expires_in: 5183944 }));

    const token = await handler.exchangeCodeForToken('the-code', 'https://app.test/cb');

    expect(token.accessToken).toBe('th-long');
    expect(token.userId).toBe('777');
    expect(fetchedUrls()[1]).toContain('access_token=th-short');
    expect(fetchedUrls()[1]).not.toContain('undefined');
  });

  it('would survive the same data[] migration that broke Instagram', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonOk({ data: [{ access_token: 'th-short', user_id: 777 }] }))
      .mockResolvedValueOnce(jsonOk({ access_token: 'th-long', expires_in: 100 }));

    const token = await handler.exchangeCodeForToken('the-code', 'https://app.test/cb');

    expect(token.accessToken).toBe('th-long');
    expect(token.userId).toBe('777');
  });

  it('fails loudly when the response cannot be parsed', async () => {
    mockFetch.mockResolvedValueOnce(jsonOk({ unexpected: true }));

    await expect(
      handler.exchangeCodeForToken('the-code', 'https://app.test/cb'),
    ).rejects.toThrow(/Threads OAuth response is missing "access_token"/);
  });
});
