/**
 * CRUD tests for the Channel Sets API (saved channel groups).
 *
 *   GET    /api/channel-sets      — list sets for the org
 *   POST   /api/channel-sets      — create (validates channel ownership, dup names)
 *   PUT    /api/channel-sets/[id] — rename / re-target
 *   DELETE /api/channel-sets/[id] — remove
 *
 * Uses a sequenced select mock (one queued result per select call) because the
 * handlers issue several different selects per request.
 */

// ---------------------------------------------------------------------------
// Sequenced Drizzle mock
// ---------------------------------------------------------------------------
const selectResults: any[][] = [];
let insertResult: any[] = [];
let updateResult: any[] = [];

function nextSelect() {
  return selectResults.length > 0 ? selectResults.shift()! : [];
}

function makeSelectChain() {
  const rows = nextSelect();
  const chain: any = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(rows),
    then: (resolve: any) => resolve(rows),
  };
  return chain;
}

vi.mock('@/lib/db', () => ({
  db: {
    select: () => makeSelectChain(),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve(insertResult) }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve(updateResult) }) }) }),
    delete: () => ({ where: () => Promise.resolve() }),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  channelSets: {
    id: 'channel_sets.id', organizationId: 'channel_sets.organization_id',
    userId: 'channel_sets.user_id', name: 'channel_sets.name',
    channelIds: 'channel_sets.channel_ids', createdAt: 'channel_sets.created_at',
    updatedAt: 'channel_sets.updated_at',
  },
  channels: { id: 'channels.id', organizationId: 'channels.organization_id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ type: 'eq', args: a })),
  and: vi.fn((...a: any[]) => ({ type: 'and', args: a })),
  inArray: vi.fn((...a: any[]) => ({ type: 'inArray', args: a })),
}));

vi.mock('@/lib/activity/log', () => ({ logActivity: vi.fn() }));

const mockValidateOwnedChannels = vi.fn();
vi.mock('@/lib/channels/validate', () => ({
  validateOwnedChannels: (...a: any[]) => mockValidateOwnedChannels(...a),
}));

import { GET, POST } from '@/pages/api/channel-sets/index';
import { PUT, DELETE } from '@/pages/api/channel-sets/[id]';
import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A } from '../helpers/fixtures';

const SAMPLE_SET = { id: 1, organizationId: 1, userId: 'user-1', name: 'Launch group', channelIds: [10, 11] };

function reset(...results: any[][]) {
  vi.clearAllMocks();
  selectResults.length = 0;
  selectResults.push(...results);
  insertResult = [SAMPLE_SET];
  updateResult = [SAMPLE_SET];
  mockValidateOwnedChannels.mockImplementation(async (_org: number, ids: unknown) =>
    Array.isArray(ids) && ids.length > 0 && ids.every((id) => Number.isInteger(id) && id > 0 && id < 900)
      ? [...new Set(ids as number[])]
      : null,
  );
}

describe('GET /api/channel-sets', () => {
  it('returns 401 when not authenticated', async () => {
    reset();
    const res = await GET(createMockContext({ user: null }) as any);
    expect((await parseResponse(res)).status).toBe(401);
  });

  it('returns the org sets', async () => {
    reset([SAMPLE_SET]);
    const res = await GET(createMockContext({ user: USER_A, organizationId: 1 }) as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe('Launch group');
  });
});

describe('POST /api/channel-sets', () => {
  const makeCtx = (body: any) =>
    createMockContext({ user: USER_A, organizationId: 1, method: 'POST', body });

  it('creates a set when channels are owned and name is fresh', async () => {
    reset(
      [], // existing sets (under cap, no duplicate)
    );
    const res = await POST(makeCtx({ name: 'Launch group', channelIds: [10, 11] }) as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(201);
    expect(data.name).toBe('Launch group');
    expect(mockValidateOwnedChannels).toHaveBeenCalledWith(1, [10, 11]);
  });

  it('rejects channels not owned by the org', async () => {
    reset();
    const res = await POST(makeCtx({ name: 'Bad', channelIds: [10, 999] }) as any); // 999 fails mock ownership
    expect((await parseResponse(res)).status).toBe(400);
  });

  it('rejects an empty channel list', async () => {
    reset();
    const res = await POST(makeCtx({ name: 'Empty', channelIds: [] }) as any);
    expect((await parseResponse(res)).status).toBe(400);
  });

  it('rejects a missing name', async () => {
    reset();
    const res = await POST(makeCtx({ channelIds: [10] }) as any);
    expect((await parseResponse(res)).status).toBe(400);
  });

  it('409s on a duplicate name', async () => {
    reset(
      [{ id: 7, name: 'Launch group' }], // existing set with the same name
    );
    const res = await POST(makeCtx({ name: 'Launch group', channelIds: [10] }) as any);
    expect((await parseResponse(res)).status).toBe(409);
  });
});

describe('PUT /api/channel-sets/[id]', () => {
  const makeCtx = (id: string, body: any) =>
    createMockContext({ user: USER_A, organizationId: 1, params: { id }, method: 'PUT', body });

  it('renames a set', async () => {
    reset(
      [SAMPLE_SET], // exists
      [],           // no duplicate
    );
    updateResult = [{ ...SAMPLE_SET, name: 'Renamed' }];
    const res = await PUT(makeCtx('1', { name: 'Renamed' }) as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.name).toBe('Renamed');
  });

  it('404s for a set outside the org', async () => {
    reset([]);
    const res = await PUT(makeCtx('99', { name: 'X' }) as any);
    expect((await parseResponse(res)).status).toBe(404);
  });

  it('rejects channelIds not owned by the org', async () => {
    reset(
      [SAMPLE_SET],  // exists
    );
    const res = await PUT(makeCtx('1', { channelIds: [10, 999] }) as any); // 999 fails mock ownership
    expect((await parseResponse(res)).status).toBe(400);
  });
});

describe('DELETE /api/channel-sets/[id]', () => {
  it('deletes an owned set', async () => {
    reset([SAMPLE_SET]);
    const ctx = createMockContext({ user: USER_A, organizationId: 1, params: { id: '1' } });
    const res = await DELETE(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
  });

  it('404s for an unknown set', async () => {
    reset([]);
    const ctx = createMockContext({ user: USER_A, organizationId: 1, params: { id: '5' } });
    const res = await DELETE(ctx as any);
    expect((await parseResponse(res)).status).toBe(404);
  });
});

export {};
