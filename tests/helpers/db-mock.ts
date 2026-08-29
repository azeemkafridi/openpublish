import { vi } from 'vitest';

/**
 * Create a reusable Drizzle DB mock with chainable query builder.
 * Call setResult() between tests to change what queries return.
 */
export function createDbMock(initialResult: unknown = []) {
  let currentResult = initialResult;

  const makeAwaitable = (chain: Record<string, any>) => {
    chain.then = (resolve: (v: unknown) => void) =>
      resolve(Array.isArray(currentResult) ? currentResult : [currentResult]);
    return chain;
  };

  const queryChain: Record<string, any> = {};
  const methods = [
    'select', 'from', 'where', 'orderBy', 'limit', 'offset',
    'insert', 'values', 'returning', 'update', 'set', 'delete',
    'innerJoin', 'leftJoin', 'groupBy', 'having',
  ];

  for (const m of methods) {
    queryChain[m] = vi.fn().mockReturnValue(queryChain);
  }

  // Make terminal points awaitable
  queryChain.returning = vi.fn().mockImplementation(() => {
    return Promise.resolve(Array.isArray(currentResult) ? currentResult : [currentResult]);
  });

  queryChain.limit = vi.fn().mockImplementation(() => makeAwaitable(queryChain));

  // Also make from() awaitable (for queries without .limit())
  const origFrom = queryChain.from;
  queryChain.from = vi.fn().mockImplementation(() => {
    makeAwaitable(queryChain);
    return queryChain;
  });

  const db = {
    select: vi.fn(() => queryChain),
    insert: vi.fn(() => queryChain),
    update: vi.fn(() => queryChain),
    delete: vi.fn(() => queryChain),
  };

  const setResult = (result: unknown) => {
    currentResult = result;
  };

  const resetChain = () => {
    for (const m of methods) {
      (queryChain[m] as ReturnType<typeof vi.fn>).mockClear().mockReturnValue(queryChain);
    }
    queryChain.returning = vi.fn().mockImplementation(() =>
      Promise.resolve(Array.isArray(currentResult) ? currentResult : [currentResult])
    );
    queryChain.limit = vi.fn().mockImplementation(() => makeAwaitable(queryChain));
    queryChain.from = vi.fn().mockImplementation(() => {
      makeAwaitable(queryChain);
      return queryChain;
    });
  };

  return { db, queryChain, setResult, resetChain };
}

/**
 * Standard drizzle-orm operator mocks for vi.mock('drizzle-orm').
 */
export function createDrizzleOrmMock() {
  const makeSqlResult = (...args: any[]) => ({
    args,
    as: vi.fn().mockReturnValue({ type: 'sql_alias', args }),
    mapWith: vi.fn().mockReturnThis(),
  });

  const sqlFn = (...args: any[]) => makeSqlResult(...args);
  const sqlProxy = new Proxy(sqlFn, {
    apply: (_t, _this, argsList) => makeSqlResult(...argsList),
    get: (_t, prop) => {
      if (prop === 'raw') return vi.fn(() => makeSqlResult());
      return undefined;
    },
  });

  return {
    eq: vi.fn((...args: any[]) => ({ type: 'eq', args })),
    and: vi.fn((...args: any[]) => ({ type: 'and', args })),
    or: vi.fn((...args: any[]) => ({ type: 'or', args })),
    gte: vi.fn((...args: any[]) => ({ type: 'gte', args })),
    lte: vi.fn((...args: any[]) => ({ type: 'lte', args })),
    lt: vi.fn((...args: any[]) => ({ type: 'lt', args })),
    gt: vi.fn((...args: any[]) => ({ type: 'gt', args })),
    isNull: vi.fn((...args: any[]) => ({ type: 'isNull', args })),
    isNotNull: vi.fn((...args: any[]) => ({ type: 'isNotNull', args })),
    desc: vi.fn(),
    asc: vi.fn(),
    inArray: vi.fn((col: any, vals: any[]) => ({ type: 'inArray', col, vals })),
    count: vi.fn(() => makeSqlResult('count')),
    sql: sqlProxy,
  };
}
