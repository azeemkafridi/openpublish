/**
 * Stubs for Astro virtual modules that are not available in vitest.
 * Used as alias targets in vitest.config.ts.
 */

// astro:middleware
export function defineMiddleware(fn: any) {
  return fn;
}

export function sequence(...handlers: any[]) {
  return handlers;
}
