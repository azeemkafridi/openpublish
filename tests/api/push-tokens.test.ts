/**
 * /api/push/tokens route tests: auth, Expo token validation, upsert on
 * register, ownership-scoped delete.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInsertValues = vi.fn();
const mockOnConflict = vi.fn().mockResolvedValue([]);
const mockDeleteWhere = vi.fn().mockResolvedValue([]);

vi.mock('@/lib/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: mockInsertValues.mockReturnValue({ onConflictDoUpdate: mockOnConflict }),
    })),
    delete: vi.fn(() => ({ where: mockDeleteWhere })),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  pushTokens: { token: 'push_tokens.token', userId: 'push_tokens.user_id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ type: 'eq', a })),
  and: vi.fn((...a: any[]) => ({ type: 'and', a })),
}));

import { POST, DELETE, isValidExpoPushToken } from '@/pages/api/push/tokens';

const VALID_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

function ctx(body: unknown, user: any = { id: 'user-1' }) {
  return {
    locals: { auth: { user, organizationId: 7 } },
    request: new Request('http://localhost:4321/api/push/tokens', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOnConflict.mockResolvedValue([]);
  mockDeleteWhere.mockResolvedValue([]);
});

describe('isValidExpoPushToken', () => {
  it('accepts ExponentPushToken[...] and ExpoPushToken[...]', () => {
    expect(isValidExpoPushToken(VALID_TOKEN)).toBe(true);
    expect(isValidExpoPushToken('ExpoPushToken[abc-DEF_123]')).toBe(true);
  });

  it('rejects malformed values', () => {
    expect(isValidExpoPushToken('abc')).toBe(false);
    expect(isValidExpoPushToken('ExponentPushToken[]')).toBe(false);
    expect(isValidExpoPushToken('ExponentPushToken[a b]')).toBe(false);
    expect(isValidExpoPushToken(123)).toBe(false);
    expect(isValidExpoPushToken(null)).toBe(false);
    expect(isValidExpoPushToken(`ExponentPushToken[${'a'.repeat(300)}]`)).toBe(false);
  });
});

describe('POST /api/push/tokens', () => {
  it('returns 401 without an authenticated user', async () => {
    const res = await POST(ctx({ token: VALID_TOKEN, platform: 'ios' }, null));
    expect(res.status).toBe(401);
  });

  it('rejects an invalid token with 400', async () => {
    const res = await POST(ctx({ token: 'not-a-token', platform: 'ios' }));
    expect(res.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects an invalid platform with 400', async () => {
    const res = await POST(ctx({ token: VALID_TOKEN, platform: 'windows' }));
    expect(res.status).toBe(400);
  });

  it('rejects a malformed JSON body with 400', async () => {
    const res = await POST(ctx('{nope'));
    expect(res.status).toBe(400);
  });

  it('upserts the token for the authenticated user', async () => {
    const res = await POST(
      ctx({ token: VALID_TOKEN, platform: 'ios', deviceName: 'My iPhone' }),
    );
    expect(res.status).toBe(200);

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        organizationId: 7,
        token: VALID_TOKEN,
        platform: 'ios',
        deviceName: 'My iPhone',
      }),
    );
    // Upsert keyed on the unique token — re-registering moves it to this user.
    expect(mockOnConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'push_tokens.token',
        set: expect.objectContaining({ userId: 'user-1', platform: 'ios' }),
      }),
    );
  });

  it('stores null deviceName when absent', async () => {
    const res = await POST(ctx({ token: VALID_TOKEN, platform: 'android' }));
    expect(res.status).toBe(200);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ deviceName: null, platform: 'android' }),
    );
  });
});

describe('DELETE /api/push/tokens', () => {
  it('returns 401 without an authenticated user', async () => {
    const res = await DELETE(ctx({ token: VALID_TOKEN }, null));
    expect(res.status).toBe(401);
  });

  it('rejects an invalid token with 400', async () => {
    const res = await DELETE(ctx({ token: 'nope' }));
    expect(res.status).toBe(400);
    expect(mockDeleteWhere).not.toHaveBeenCalled();
  });

  it('deletes only the authenticated user\'s row for that token', async () => {
    const res = await DELETE(ctx({ token: VALID_TOKEN }));
    expect(res.status).toBe(200);

    const { and, eq } = await import('drizzle-orm');
    expect(eq).toHaveBeenCalledWith('push_tokens.token', VALID_TOKEN);
    expect(eq).toHaveBeenCalledWith('push_tokens.user_id', 'user-1');
    expect(and).toHaveBeenCalled();
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
  });
});

export {};
