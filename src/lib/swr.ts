import useSWR, { type SWRConfiguration } from 'swr';
export { mutate } from 'swr';
import { fetcher, type FetchError } from './fetcher';

const defaults: SWRConfiguration = {
  fetcher,
  revalidateOnFocus: false,      // Don't refetch on every tab switch
  revalidateOnReconnect: true,   // Refetch after network reconnect
  dedupingInterval: 10_000,      // 10s — dedup identical requests within this window
  errorRetryCount: 3,            // Retry failed requests 3 times max
  focusThrottleInterval: 60_000, // If revalidateOnFocus is enabled per-hook, throttle to 1/min
};

export function useApi<T = unknown>(
  key: string | null,
  options?: SWRConfiguration<T, FetchError>,
) {
  return useSWR<T, FetchError>(key, { ...defaults, ...options });
}
