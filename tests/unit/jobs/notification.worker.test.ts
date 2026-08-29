/**
 * Notification worker tests.
 *
 * Tests webapp/src/lib/jobs/notification.worker.ts covering:
 *   - Creates in-app notification in DB for standard types
 *   - Email is OPT-IN: no email without an explicit preference (off by default)
 *   - Respects user notification preferences
 *   - Does not send email for non-failure types by default
 *   - Handles missing user email gracefully
 *   - Stale daily-digest jobs are ignored (feature removed)
 *   - Token expiry email uses correct template
 */

// ---------------------------------------------------------------------------
// Mocks BEFORE importing the module
// ---------------------------------------------------------------------------

const mockDbSelectResults: any[][] = [];
const mockDbInsertValues: any[] = [];
let selectCallIdx = 0;

const mockSendEmail = vi.fn().mockResolvedValue(true);
const mockSendPushToUser = vi.fn().mockResolvedValue(undefined);
let capturedProcessor: ((job: any) => Promise<void>) | null = null;

function buildSelectChain() {
  const getResult = () => {
    const rows = mockDbSelectResults[selectCallIdx] || [];
    selectCallIdx++;
    return rows;
  };
  const makeThenable = (resolver: () => any[]) => ({
    limit: vi.fn().mockImplementation(() => Promise.resolve(resolver())),
    then: (resolve: any, reject?: any) => Promise.resolve(resolver()).then(resolve, reject),
  });
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(() => makeThenable(getResult)),
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => makeThenable(getResult)),
      }),
    }),
  };
}

function buildInsertChain() {
  return {
    values: vi.fn().mockImplementation((data: any) => {
      mockDbInsertValues.push(data);
      return Promise.resolve([]);
    }),
  };
}

vi.mock('bullmq', () => {
  class MockWorker {
    constructor(_name: string, processor: any, _opts: any) {
      capturedProcessor = processor;
    }
  }
  return { Worker: MockWorker };
});

vi.mock('@/lib/jobs/queue', () => ({
  getRedisConnection: () => ({}),
  QUEUE_NAMES: { NOTIFICATION: 'notification' },
}));

vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn().mockImplementation(() => buildSelectChain()),
    insert: vi.fn().mockImplementation(() => buildInsertChain()),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  notifications: {},
  notificationPreferences: { userId: 'userId' },
  user: { id: 'id', email: 'email' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ _type: 'eq', a })),
  and: vi.fn((...a: any[]) => ({ _type: 'and', a })),
  gte: vi.fn((...a: any[]) => ({ _type: 'gte', a })),
  lt: vi.fn((...a: any[]) => ({ _type: 'lt', a })),
  sql: vi.fn(),
}));

vi.mock('@/lib/email/client', () => ({
  sendEmail: (...args: any[]) => mockSendEmail(...args),
}));

vi.mock('@/lib/email/templates/failure', () => ({
  failureEmailTemplate: (data: any) => ({
    subject: `Publish failed on ${data.platform}`,
    html: `<p>Error: ${data.errorMessage}</p>`,
  }),
}));

vi.mock('@/lib/email/templates/token-expiry', () => ({
  tokenExpiryEmailTemplate: (data: any) => ({
    subject: `Token ${data.isExpired ? 'expired' : 'expiring'} for ${data.platform}`,
    html: `<p>Account: ${data.accountName}</p>`,
  }),
}));

vi.mock('@/lib/push/expo', () => ({
  sendPushToUser: (...args: any[]) => mockSendPushToUser(...args),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

export {};

const { createNotificationWorker } = await import('@/lib/jobs/notification.worker');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetState() {
  selectCallIdx = 0;
  mockDbSelectResults.length = 0;
  mockDbInsertValues.length = 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('notification worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
    capturedProcessor = null;
    createNotificationWorker();
  });

  describe('standard notification', () => {
    it('creates in-app notification when no preferences exist (defaults to enabled)', async () => {
      // No prefs found -> defaults: in-app enabled for all types
      mockDbSelectResults.push([]); // no prefs

      await capturedProcessor!({
        name: 'send-notification',
        data: {
          userId: 'user-1',
          type: 'post_published',
          title: 'Published!',
          message: 'Your post is live',
          data: { postId: 5 },
          organizationId: 1,
        },
      });

      expect(mockDbInsertValues).toHaveLength(1);
      expect(mockDbInsertValues[0]).toEqual(
        expect.objectContaining({
          userId: 'user-1',
          type: 'post_published',
          title: 'Published!',
          message: 'Your post is live',
          isRead: false,
        }),
      );
    });

    it('does NOT email for post_failed when no prefs exist (email is opt-in)', async () => {
      mockDbSelectResults.push([]); // no prefs

      await capturedProcessor!({
        name: 'send-notification',
        data: {
          userId: 'user-1',
          type: 'post_failed',
          title: 'Failed!',
          message: 'API error',
          data: { postId: 5, platform: 'x', contentSnippet: 'Hello world' },
          organizationId: 1,
        },
      });

      // In-app notification is still created (in-app stays on by default)...
      expect(mockDbInsertValues).toHaveLength(1);
      // ...but no email without an explicit opt-in — this is what was burning quota.
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('emails for post_failed only when the user has opted in', async () => {
      mockDbSelectResults.push(
        [{ emailOnFailure: true }],            // prefs: failure email enabled
        [{ email: 'test@example.com' }],       // user email
      );

      await capturedProcessor!({
        name: 'send-notification',
        data: {
          userId: 'user-1',
          type: 'post_failed',
          title: 'Failed!',
          message: 'API error',
          data: { postId: 5, platform: 'x', contentSnippet: 'Hello world' },
          organizationId: 1,
        },
      });

      expect(mockSendEmail).toHaveBeenCalledWith(
        'test@example.com',
        expect.stringContaining('Publish failed'),
        expect.any(String),
        expect.objectContaining({ template: 'post_failed', userId: 'user-1' }),
      );
    });

    it('does not email for post_failed when the user has it disabled', async () => {
      mockDbSelectResults.push(
        [{ emailOnFailure: false }],           // prefs: failure email disabled
        [{ email: 'test@example.com' }],
      );

      await capturedProcessor!({
        name: 'send-notification',
        data: {
          userId: 'user-1',
          type: 'post_failed',
          title: 'Failed!',
          message: 'Error',
        },
      });

      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('does not send email for post_published by default', async () => {
      mockDbSelectResults.push([]); // no prefs

      await capturedProcessor!({
        name: 'send-notification',
        data: {
          userId: 'user-1',
          type: 'post_published',
          title: 'Published!',
          message: 'Live now',
        },
      });

      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('respects inApp disabled preference', async () => {
      // prefs with inAppPublished: false
      mockDbSelectResults.push([{ inAppPublished: false }]);

      await capturedProcessor!({
        name: 'send-notification',
        data: {
          userId: 'user-1',
          type: 'post_published',
          title: 'Published!',
          message: 'Live now',
        },
      });

      // Should NOT create in-app notification
      expect(mockDbInsertValues).toHaveLength(0);
    });

    it('skips email when user has no email address', async () => {
      mockDbSelectResults.push(
        [{ emailOnFailure: true }],  // prefs: failure email enabled
        [{ email: null }],           // user has no email
      );

      await capturedProcessor!({
        name: 'send-notification',
        data: {
          userId: 'user-1',
          type: 'post_failed',
          title: 'Failed!',
          message: 'Error',
        },
      });

      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('skips email when user not found', async () => {
      mockDbSelectResults.push(
        [{ emailOnFailure: true }],  // prefs: failure email enabled
        [],                          // user not found
      );

      await capturedProcessor!({
        name: 'send-notification',
        data: {
          userId: 'user-1',
          type: 'post_failed',
          title: 'Failed!',
          message: 'Error',
        },
      });

      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('sends email for token_expiring type when prefs enable it', async () => {
      mockDbSelectResults.push(
        [{ emailOnTokenExpiry: true, inAppTokenExpiry: true }],  // prefs
        [{ email: 'user@test.com' }],                           // user
      );

      await capturedProcessor!({
        name: 'send-notification',
        data: {
          userId: 'user-1',
          type: 'token_expiring',
          title: 'Token expiring',
          message: 'Reconnect soon',
          data: { platform: 'x', accountName: 'TestAcc', daysUntilExpiry: 2 },
        },
      });

      expect(mockSendEmail).toHaveBeenCalledWith(
        'user@test.com',
        expect.stringContaining('expiring'),
        expect.any(String),
        expect.objectContaining({ template: 'token_expiry' }),
      );
    });

    it('sends email for token_expired type when prefs enable it', async () => {
      mockDbSelectResults.push(
        [{ emailOnTokenExpiry: true, inAppTokenExpiry: true }],
        [{ email: 'user@test.com' }],
      );

      await capturedProcessor!({
        name: 'send-notification',
        data: {
          userId: 'user-1',
          type: 'token_expired',
          title: 'Token expired',
          message: 'Please reconnect',
          data: { platform: 'facebook', accountName: 'FBAcct', daysUntilExpiry: 0 },
        },
      });

      expect(mockSendEmail).toHaveBeenCalledWith(
        'user@test.com',
        expect.stringContaining('expired'),
        expect.any(String),
        expect.objectContaining({ template: 'token_expiry' }),
      );
    });
  });

  describe('push notifications', () => {
    it('sends an Expo push alongside the in-app notification', async () => {
      mockDbSelectResults.push([]); // no prefs → in-app enabled

      await capturedProcessor!({
        name: 'send-notification',
        data: {
          userId: 'user-1',
          type: 'post_failed',
          title: 'Failed!',
          message: 'API error',
          data: { postId: 42, platform: 'x' },
          organizationId: 1,
        },
      });

      expect(mockSendPushToUser).toHaveBeenCalledWith('user-1', {
        title: 'Failed!',
        body: 'API error',
        data: { type: 'post_failed', postId: 42 },
      });
    });

    it('omits postId from push data when not present', async () => {
      mockDbSelectResults.push([]);

      await capturedProcessor!({
        name: 'send-notification',
        data: {
          userId: 'user-1',
          type: 'token_expiring',
          title: 'Token expiring',
          message: 'Reconnect soon',
          data: { platform: 'x' },
        },
      });

      expect(mockSendPushToUser).toHaveBeenCalledWith('user-1', {
        title: 'Token expiring',
        body: 'Reconnect soon',
        data: { type: 'token_expiring' },
      });
    });

    it('does not push when the in-app preference is disabled', async () => {
      mockDbSelectResults.push([{ inAppPublished: false }]);

      await capturedProcessor!({
        name: 'send-notification',
        data: {
          userId: 'user-1',
          type: 'post_published',
          title: 'Published!',
          message: 'Live now',
        },
      });

      expect(mockSendPushToUser).not.toHaveBeenCalled();
    });

    it('a rejected push never fails the job', async () => {
      mockDbSelectResults.push([]);
      mockSendPushToUser.mockRejectedValueOnce(new Error('expo down'));

      await expect(
        capturedProcessor!({
          name: 'send-notification',
          data: {
            userId: 'user-1',
            type: 'post_published',
            title: 'Published!',
            message: 'Live now',
          },
        }),
      ).resolves.toBeUndefined();

      expect(mockDbInsertValues).toHaveLength(1);
    });
  });

  describe('stale daily-digest job', () => {
    it('ignores stale daily-digest jobs without touching the DB or sending email', async () => {
      // Daily digest was removed; stale repeatable jobs from a previous
      // deploy must be a silent no-op.
      await capturedProcessor!({ name: 'daily-digest', data: {} });

      expect(selectCallIdx).toBe(0);
      expect(mockSendEmail).not.toHaveBeenCalled();
    });
  });
});
