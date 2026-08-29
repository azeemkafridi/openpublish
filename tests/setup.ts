import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Mock @lib/swr to isolate SWR between tests.
// SWR uses a module-level map to deduplicate concurrent fetches for the same key.
// This leaks between tests. We work around it by appending a unique test ID to
// each SWR key (for dedup/caching) while still fetching with the original URL.
let _swrTestId = 0;
beforeEach(() => { _swrTestId++; });

vi.mock('@lib/swr', async () => {
  const actual = await vi.importActual<typeof import('@lib/swr')>('@lib/swr');
  const { fetcher } = await vi.importActual<typeof import('@lib/fetcher')>('@lib/fetcher');
  const useSWR = (await vi.importActual<typeof import('swr')>('swr')).default;

  return {
    ...actual,
    useApi: (key: string | null, options?: any) => {
      const cacheKey = key ? `${key}#_t=${_swrTestId}` : null;
      return useSWR(cacheKey, {
        fetcher: () => fetcher(key!),
        revalidateOnFocus: false,
        dedupingInterval: 0,
        errorRetryCount: 0,
        ...options,
      });
    },
  };
});

// Auto-cleanup after each test.
// The setTimeout flush lets SWR's internal async operations settle before cleanup
// to prevent stale in-flight requests from leaking into subsequent tests.
afterEach(() => {
  cleanup();
  // Clear the cross-island fetch dedupe map (set in src/lib/fetcher.ts) so
  // unresolved requests from one test don't satisfy a fetch in the next.
  (window as unknown as { __FETCH_INFLIGHT__?: Map<string, unknown> }).__FETCH_INFLIGHT__?.clear();
});

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
  };
})();

Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// Mock fetch globally
globalThis.fetch = vi.fn();

// Mock window.dispatchEvent
window.dispatchEvent = vi.fn();

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
