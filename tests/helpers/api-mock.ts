import { vi } from 'vitest';

/**
 * Mock factory for Astro API route context.
 * Includes full auth context with organizationId, matching the middleware's locals.auth shape.
 */
export function createMockContext(options: {
  user?: { id: string; name: string; email?: string; role?: string } | null;
  organizationId?: number;
  organizationPlan?: 'free' | 'pro' | 'business';
  organizationName?: string;
  organizationRole?: 'owner' | 'admin' | 'approver' | 'contributor' | 'viewer';
  params?: Record<string, string>;
  body?: unknown;
  searchParams?: Record<string, string>;
  method?: string;
} = {}) {
  const {
    user = { id: 'user-1', name: 'Test User', email: 'test@example.com', role: 'user' },
    organizationId = 1,
    organizationPlan = 'pro',
    organizationName = 'Test Org',
    organizationRole = 'owner',
    params = {},
    body,
    searchParams = {},
    method = 'GET',
  } = options;

  const url = new URL('http://localhost:4321/api/test');
  for (const [k, v] of Object.entries(searchParams)) {
    url.searchParams.set(k, v);
  }

  return {
    locals: {
      auth: {
        user,
        organizationId,
        organizationPlan,
        organizationName,
        organizationRole,
      },
    },
    params,
    url,
    request: {
      method,
      json: vi.fn().mockResolvedValue(body ?? {}),
      headers: new Headers({ 'Content-Type': 'application/json' }),
    } as unknown as Request,
  };
}

/**
 * Parse JSON response from API route handler.
 */
export async function parseResponse(response: Response) {
  const text = await response.text();
  try {
    return { status: response.status, data: JSON.parse(text) };
  } catch {
    return { status: response.status, data: text };
  }
}

/**
 * Create a chainable Drizzle query mock.
 */
export function createQueryChain(result: unknown = []) {
  const chain: Record<string, any> = {};
  const methods = [
    'select', 'from', 'where', 'orderBy', 'limit', 'offset',
    'insert', 'values', 'returning', 'update', 'set', 'delete',
    'innerJoin', 'leftJoin', 'groupBy', 'having',
  ];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  // Terminal methods return the result
  chain.returning = vi.fn().mockResolvedValue(Array.isArray(result) ? result : [result]);
  chain.limit = vi.fn().mockImplementation(() => {
    // Make the chain thenable for await
    chain.then = (resolve: (v: unknown) => void) => resolve(Array.isArray(result) ? result : [result]);
    return chain;
  });
  // Make select().from() return a thenable by default
  (chain as any)[Symbol.iterator] = function* () {
    const arr = Array.isArray(result) ? result : [result];
    yield* arr;
  };
  return chain;
}
