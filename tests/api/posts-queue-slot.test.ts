/**
 * Tests for the Post Queue Slot API.
 *
 *   GET /api/posts/queue-slot — get next available queue slot
 */

// ---------------------------------------------------------------------------
// vi.mock (hoisted)
// ---------------------------------------------------------------------------
const mockFindNextQueueSlot = vi.fn();
vi.mock('@lib/queue/scheduler', () => ({
  findNextQueueSlot: (...a: any[]) => mockFindNextQueueSlot(...a),
}));

// ---------------------------------------------------------------------------
// Import handlers AFTER mocks
// ---------------------------------------------------------------------------
import { GET } from '@/pages/api/posts/queue-slot';
import { createMockContext, parseResponse } from '../helpers/api-mock';
import { USER_A } from '../helpers/fixtures';

// ---------------------------------------------------------------------------
// GET /api/posts/queue-slot
// ---------------------------------------------------------------------------

describe('GET /api/posts/queue-slot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when not authenticated', async () => {
    const ctx = createMockContext({ user: null });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(401);
    expect(data.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 200 with next queue slot', async () => {
    const slot = { scheduledAt: '2026-03-29T10:00:00Z', label: 'Tomorrow 10:00 AM' };
    mockFindNextQueueSlot.mockResolvedValue(slot);

    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toEqual(slot);
  });

  it('passes timezone from query parameter', async () => {
    mockFindNextQueueSlot.mockResolvedValue({ scheduledAt: '2026-03-29T10:00:00Z' });

    const ctx = createMockContext({
      user: USER_A,
      organizationId: 1,
      searchParams: { timezone: 'America/New_York' },
    });
    await GET(ctx as any);
    expect(mockFindNextQueueSlot).toHaveBeenCalledWith(1, 'America/New_York');
  });

  it('defaults timezone to UTC when not provided', async () => {
    mockFindNextQueueSlot.mockResolvedValue({ scheduledAt: '2026-03-29T10:00:00Z' });

    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    await GET(ctx as any);
    expect(mockFindNextQueueSlot).toHaveBeenCalledWith(1, 'UTC');
  });

  it('returns 422 when queue is full', async () => {
    mockFindNextQueueSlot.mockRejectedValue(new Error('No available slots'));

    const ctx = createMockContext({ user: USER_A, organizationId: 1 });
    const res = await GET(ctx as any);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(422);
    expect(data.error.code).toBe('QUEUE_FULL');
    expect(data.error.message).toContain('No available slots');
  });
});
