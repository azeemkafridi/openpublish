/**
 * Client-side product-event tracker.
 *
 * Fire-and-forget beacon to POST /api/events, which writes the event into
 * activity_logs with a `ux.` action prefix — so UI behavior (page views,
 * connect clicks, failed submits) lands in the same stream the admin
 * dashboard already reads, interleaved with the server-side mutation log.
 *
 * Telemetry must never break the UI: every path here swallows its errors,
 * and sendBeacon/keepalive let events survive an immediate navigation
 * (login redirect, OAuth hand-off).
 */

const EVENT_ENDPOINT = '/api/events';

export function track(name: string, props?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return; // SSR no-op
  try {
    const payload = JSON.stringify({
      name,
      props,
      path: window.location.pathname,
    });
    // sendBeacon survives page unload; Blob carries the content type.
    if (navigator.sendBeacon?.(EVENT_ENDPOINT, new Blob([payload], { type: 'application/json' }))) {
      return;
    }
    fetch(EVENT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
      credentials: 'same-origin',
    }).catch(() => {});
  } catch {
    /* never break the UI over telemetry */
  }
}

export function trackPageView(): void {
  track('page_view');
}
