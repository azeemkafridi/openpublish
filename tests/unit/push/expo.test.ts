/**
 * Expo push client tests (src/lib/push/expo.ts):
 *   - chunks messages into batches of 100
 *   - DeviceNotRegistered tickets delete the token from push_tokens
 *   - HTTP / network failures are swallowed (never throw)
 *   - sendPushToUser looks up tokens and sends, no-ops with zero tokens
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDeleteWhere = vi.fn().mockResolvedValue([]);
const mockSelectResults: any[][] = [];

vi.mock('@/lib/db', () => ({
  db: {
    delete: vi.fn(() => ({ where: mockDeleteWhere })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(mockSelectResults.shift() ?? [])),
      })),
    })),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  pushTokens: { token: 'push_tokens.token', userId: 'push_tokens.user_id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ type: 'eq', a })),
  inArray: vi.fn((col: any, vals: any[]) => ({ type: 'inArray', col, vals })),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

export {};

const { sendExpoPushMessages, sendPushToUser, sendPushToUsers, EXPO_PUSH_URL } = await import('@/lib/push/expo');

function okResponse(tickets: any[]) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data: tickets }),
  };
}

function msg(i: number) {
  return { to: `ExponentPushToken[tok${i}]`, title: 't', body: 'b' };
}

describe('sendExpoPushMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectResults.length = 0;
    mockDeleteWhere.mockResolvedValue([]);
  });

  it('does nothing for an empty message list', async () => {
    await sendExpoPushMessages([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a single batch to the Expo endpoint', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([{ status: 'ok', id: '1' }]));

    await sendExpoPushMessages([msg(1)]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(EXPO_PUSH_URL);
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toHaveLength(1);
  });

  it('chunks more than 100 messages into batches of 100', async () => {
    fetchMock.mockResolvedValue(okResponse([]));

    const messages = Array.from({ length: 250 }, (_, i) => msg(i));
    await sendExpoPushMessages(messages);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sizes = fetchMock.mock.calls.map(([, o]) => JSON.parse(o.body).length);
    expect(sizes).toEqual([100, 100, 50]);
  });

  it('deletes DeviceNotRegistered tokens from push_tokens', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse([
        { status: 'ok', id: '1' },
        { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
      ]),
    );

    const dead = await sendExpoPushMessages([msg(1), msg(2)]);

    expect(dead).toEqual(['ExponentPushToken[tok2]']);
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
    const { inArray } = await import('drizzle-orm');
    expect(inArray).toHaveBeenCalledWith('push_tokens.token', ['ExponentPushToken[tok2]']);
  });

  it('does not delete tokens for other ticket errors', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse([{ status: 'error', message: 'bad', details: { error: 'MessageTooBig' } }]),
    );

    const dead = await sendExpoPushMessages([msg(1)]);

    expect(dead).toEqual([]);
    expect(mockDeleteWhere).not.toHaveBeenCalled();
  });

  it('swallows non-2xx responses without throwing', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) });
    await expect(sendExpoPushMessages([msg(1)])).resolves.toEqual([]);
  });

  it('swallows network errors without throwing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(sendExpoPushMessages([msg(1)])).resolves.toEqual([]);
  });
});

describe('sendPushToUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectResults.length = 0;
  });

  it('sends one message per registered token', async () => {
    mockSelectResults.push([
      { token: 'ExponentPushToken[a]' },
      { token: 'ExponentPushToken[b]' },
    ]);
    fetchMock.mockResolvedValueOnce(okResponse([{ status: 'ok' }, { status: 'ok' }]));

    await sendPushToUser('user-1', { title: 'Hi', body: 'There', data: { type: 'post_failed' } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual([
      expect.objectContaining({ to: 'ExponentPushToken[a]', title: 'Hi', body: 'There' }),
      expect.objectContaining({ to: 'ExponentPushToken[b]' }),
    ]);
  });

  it('does not call Expo when the user has no tokens', async () => {
    mockSelectResults.push([]);
    await sendPushToUser('user-1', { title: 'Hi', body: 'There' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws even when the token lookup fails', async () => {
    const { db } = await import('@/lib/db');
    (db.select as any).mockImplementationOnce(() => {
      throw new Error('db down');
    });
    await expect(sendPushToUser('user-1', { title: 'x', body: 'y' })).resolves.toBeUndefined();
  });
});

describe('sendPushToUsers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectResults.length = 0;
  });

  it('fans out to every user token with ONE query and one Expo request', async () => {
    const { db } = await import('@/lib/db');
    mockSelectResults.push([
      { token: 'ExponentPushToken[a1]' },
      { token: 'ExponentPushToken[b1]' },
      { token: 'ExponentPushToken[b2]' },
    ]);
    fetchMock.mockResolvedValueOnce(okResponse([{ status: 'ok' }, { status: 'ok' }, { status: 'ok' }]));

    await sendPushToUsers(['user-a', 'user-b'], { title: 'Awaiting approval', body: 'p' });

    expect(db.select).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toHaveLength(3);
    expect(body[0]).toEqual(expect.objectContaining({ to: 'ExponentPushToken[a1]', title: 'Awaiting approval' }));
  });

  it('no-ops on an empty user list without touching the DB', async () => {
    const { db } = await import('@/lib/db');
    await sendPushToUsers([], { title: 'x', body: 'y' });
    expect(db.select).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws even when the token lookup fails', async () => {
    const { db } = await import('@/lib/db');
    (db.select as any).mockImplementationOnce(() => {
      throw new Error('db down');
    });
    await expect(sendPushToUsers(['u1'], { title: 'x', body: 'y' })).resolves.toBeUndefined();
  });
});
