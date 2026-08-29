/**
 * Activity log tests.
 *
 * Tests webapp/src/lib/activity/log.ts covering:
 *   - logActivity inserts into the activity_logs table
 *   - Handles different action types
 *   - Includes details in the insert
 *   - Defaults resource from action prefix (before '.')
 *   - Defaults level to 'info'
 *   - Handles missing optional fields (userId, organizationId, resourceId)
 *   - Swallows DB errors gracefully (fire-and-forget)
 */

// ---------------------------------------------------------------------------
// Mocks (hoisted)
// ---------------------------------------------------------------------------

const mockInsertValues = vi.fn();
const mockInsertCatch = vi.fn();

vi.mock('@lib/db', () => {
  const chain = {
    values: mockInsertValues,
    catch: mockInsertCatch,
  };
  mockInsertValues.mockReturnValue(chain);
  mockInsertCatch.mockReturnValue(chain);

  return {
    db: {
      insert: vi.fn(() => chain),
    },
  };
});

vi.mock('@lib/db/schema', () => ({
  activityLogs: { __tableName: 'activity_logs' },
}));

export {};

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------

const { logActivity } = await import('@/lib/activity/log');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('logActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the chain so each test starts fresh
    const chain = {
      values: mockInsertValues,
      catch: mockInsertCatch,
    };
    mockInsertValues.mockReturnValue(chain);
    mockInsertCatch.mockReturnValue(chain);
  });

  it('inserts a record into the activity_logs table', () => {
    logActivity({
      userId: 'user-1',
      organizationId: 10,
      action: 'post.create',
      resource: 'post',
      resourceId: '42',
      details: { title: 'Test Post' },
      level: 'info',
    });

    expect(mockInsertValues).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 10,
      action: 'post.create',
      resource: 'post',
      resourceId: '42',
      details: { title: 'Test Post' },
      level: 'info',
    });
  });

  it('handles different action types', () => {
    const actions = ['post.create', 'post.publish', 'channel.connect', 'schedule.update', 'media.delete'];

    for (const action of actions) {
      vi.clearAllMocks();
      const chain = { values: mockInsertValues, catch: mockInsertCatch };
      mockInsertValues.mockReturnValue(chain);
      mockInsertCatch.mockReturnValue(chain);

      logActivity({ action, userId: 'u1', organizationId: 1 });

      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ action }),
      );
    }
  });

  it('includes details object in the insert', () => {
    const details = { postId: 42, platforms: ['twitter', 'linkedin'], scheduled: true };

    logActivity({
      action: 'post.schedule',
      userId: 'user-1',
      organizationId: 1,
      details,
    });

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ details }),
    );
  });

  it('defaults resource from action prefix when not provided', () => {
    logActivity({
      action: 'channel.disconnect',
      userId: 'user-1',
      organizationId: 1,
    });

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ resource: 'channel' }),
    );
  });

  it('uses explicit resource when provided', () => {
    logActivity({
      action: 'post.create',
      resource: 'custom-resource',
      userId: 'user-1',
      organizationId: 1,
    });

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ resource: 'custom-resource' }),
    );
  });

  it('defaults level to info', () => {
    logActivity({
      action: 'post.create',
      userId: 'user-1',
      organizationId: 1,
    });

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info' }),
    );
  });

  it('accepts warning and error levels', () => {
    logActivity({ action: 'auth.failed', level: 'warning' });
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warning' }),
    );

    vi.clearAllMocks();
    const chain = { values: mockInsertValues, catch: mockInsertCatch };
    mockInsertValues.mockReturnValue(chain);
    mockInsertCatch.mockReturnValue(chain);

    logActivity({ action: 'publish.error', level: 'error' });
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error' }),
    );
  });

  it('handles missing optional fields with null defaults', () => {
    logActivity({ action: 'system.startup' });

    expect(mockInsertValues).toHaveBeenCalledWith({
      userId: null,
      organizationId: null,
      action: 'system.startup',
      resource: 'system',
      resourceId: null,
      details: null,
      level: 'info',
    });
  });

  it('converts numeric resourceId to string', () => {
    logActivity({
      action: 'post.delete',
      resourceId: 123,
      userId: 'user-1',
      organizationId: 1,
    });

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: '123' }),
    );
  });

  it('passes string resourceId as-is', () => {
    logActivity({
      action: 'channel.connect',
      resourceId: 'ch-abc',
      userId: 'user-1',
      organizationId: 1,
    });

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'ch-abc' }),
    );
  });

  it('attaches a .catch handler for fire-and-forget error handling', () => {
    logActivity({ action: 'test.action' });

    expect(mockInsertCatch).toHaveBeenCalled();
    // The catch handler should be a function
    const catchArg = mockInsertCatch.mock.calls[0][0];
    expect(typeof catchArg).toBe('function');
  });

  it('catch handler logs to console.error without throwing', () => {
    logActivity({ action: 'test.action' });

    const catchHandler = mockInsertCatch.mock.calls[0][0];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Should not throw
    expect(() => catchHandler(new Error('DB write failed'))).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('activity-log'),
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });
});
