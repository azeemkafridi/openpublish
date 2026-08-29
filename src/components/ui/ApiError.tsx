import type { CSSProperties } from 'react';

/**
 * Structured error from API responses.
 * Store this instead of plain error strings to preserve context.
 */
export interface ApiErrorData {
  message: string;
  hint?: string;
  code?: string;
  upgrade?: boolean;
  /** Purchasable add-on that would lift this limit (e.g. 'channel_slot'). */
  addon?: string;
}

/**
 * Parse an API error response body into a structured ApiErrorData.
 * Handles both `{ error: "string" }` and `{ error: { message, hint, code, upgrade } }`.
 */
export function parseApiError(body: unknown, fallback: string): ApiErrorData {
  if (!body || typeof body !== 'object') return { message: fallback };
  const err = (body as Record<string, unknown>).error;
  if (!err) return { message: fallback };
  if (typeof err === 'string') return { message: err };
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    return {
      message: (e.message as string) || fallback,
      hint: (e.hint as string) || undefined,
      code: (e.code as string) || undefined,
      upgrade: (e.upgrade as boolean) || false,
      addon: (e.addon as string) || undefined,
    };
  }
  return { message: fallback };
}

/**
 * Display an API error with proper context, reasoning, and upgrade CTA.
 * Renders as a single red paragraph with an optional upgrade link.
 */
export function ApiError({ error, style }: { error: ApiErrorData | string | null; style?: CSSProperties }) {
  if (!error) return null;

  const data: ApiErrorData = typeof error === 'string' ? { message: error } : error;
  const isUpgrade = data.upgrade || data.code === 'QUOTA_EXCEEDED' || data.code === 'FEATURE_DISABLED';

  return (
    <p
      style={{
        margin: 0,
        fontSize: 'var(--text-sm)',
        color: 'var(--color-error, #DC2626)',
        ...style,
      }}
    >
      {data.message}{data.hint ? ` ${data.hint}` : ''}
      {data.addon === 'channel_slot' && (
        <>
          {' '}
          <a
            href="/settings#channel-slots"
            style={{
              color: 'var(--accent-500)',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Add a slot &rarr;
          </a>
        </>
      )}
      {isUpgrade && (
        <>
          {' '}
          <a
            href="/pricing"
            style={{
              color: 'var(--accent-500)',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            View plans &rarr;
          </a>
        </>
      )}
    </p>
  );
}
