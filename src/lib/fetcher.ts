export class FetchError extends Error {
  status: number;
  info: unknown;

  constructor(message: string, status: number, info?: unknown) {
    super(message);
    this.name = 'FetchError';
    this.status = status;
    this.info = info;
  }
}

// Each Astro `client:*` island is a separate React root with its own SWR cache,
// so two islands fetching the same key (e.g. Sidebar + NotificationBell both
// reading /api/notifications?limit=10) bypass SWR's deduping. A window-level
// in-flight Map collapses concurrent identical GETs into a single network call.
type InflightMap = Map<string, Promise<unknown>>;
const inflight: InflightMap =
  typeof window === 'undefined'
    ? new Map()
    : ((window as unknown as { __FETCH_INFLIGHT__?: InflightMap }).__FETCH_INFLIGHT__ ??= new Map());

export async function fetcher<T = unknown>(url: string): Promise<T> {
  const existing = inflight.get(url) as Promise<T> | undefined;
  if (existing) return existing;

  // The cleanup `finally` lives inside the async function (not chained as
  // `.finally()` on the returned promise) so a rejected request doesn't
  // produce an unattended derived promise — that surfaces as an unhandled
  // rejection in tests where the caller never awaits a failed fetch.
  const promise = (async (): Promise<T> => {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new FetchError(
          (body as { error?: { message?: string }; message?: string } | null)?.error?.message
            ?? (body as { message?: string } | null)?.message
            ?? `Request failed with status ${res.status}`,
          res.status,
          body,
        );
      }
      return res.json() as Promise<T>;
    } finally {
      inflight.delete(url);
    }
  })();

  inflight.set(url, promise);
  return promise;
}
