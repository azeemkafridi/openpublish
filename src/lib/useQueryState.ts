import { useState, useEffect, useCallback } from 'react';

const isBrowser = typeof window !== 'undefined';

/**
 * Like useState, but syncs the value to a URL query parameter.
 * Supports browser back/forward navigation.
 *
 * @param key   - The query parameter name (e.g. "view")
 * @param defaultValue - Fallback when the param is absent
 */
export function useQueryState<T extends string>(
  key: string,
  defaultValue: T,
): [T, (value: T) => void] {
  function readParam(): T {
    if (!isBrowser) return defaultValue;
    const params = new URLSearchParams(window.location.search);
    return (params.get(key) as T) || defaultValue;
  }

  // Initialise to the default on BOTH server and client so the first render is identical
  // and hydration succeeds. Reading the URL here instead would make the server (no
  // `window` -> default) and client (URL value) disagree, throwing React hydration error
  // #418 and leaving the island with stale markup and dead event handlers. The effect
  // below adopts the real URL value immediately after mount.
  const [value, setValueInternal] = useState<T>(defaultValue);

  // Adopt the URL value once mounted on the client (post-hydration, so no mismatch).
  useEffect(() => {
    setValueInternal(readParam());
  }, []);

  const setValue = useCallback(
    (next: T) => {
      setValueInternal(next);

      const url = new URL(window.location.href);
      if (next === defaultValue) {
        url.searchParams.delete(key);
      } else {
        url.searchParams.set(key, next);
      }
      window.history.pushState({}, '', url.toString());
    },
    [key, defaultValue],
  );

  // Listen for back/forward
  useEffect(() => {
    function onPopState() {
      setValueInternal(readParam());
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [key, defaultValue]);

  return [value, setValue];
}
