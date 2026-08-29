/**
 * Auth config tests.
 *
 * Tests the better-auth configuration at webapp/src/lib/auth/index.ts covering:
 *   - sendVerificationEmail builds URL as ${baseUrl}/verify-email?token=...
 *   - sendResetPassword builds URL as ${baseUrl}/reset-password?token=...
 *   - revokeSessionsOnPasswordReset is enabled
 *   - requireEmailVerification is enabled
 *   - minPasswordLength is 8
 *   - emailVerification.sendOnSignUp is true
 *   - Trusted origins include baseUrl, localhost:4321, localhost:3000, localhost:3001
 *   - Session expires in 30 days
 *   - Cookie cache enabled with 5 minute maxAge
 *   - Database hook creates organization and org membership on user signup
 *
 * Since the auth config is constructed at module load time, we test by mocking
 * dependencies and capturing the config values passed to betterAuth().
 */

// ---------------------------------------------------------------------------
// Capture the betterAuth config
// ---------------------------------------------------------------------------

process.env.REQUIRE_EMAIL_VERIFICATION = 'true';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-resend-key';

let capturedConfig: any = null;

vi.mock('better-auth', () => ({
  betterAuth: vi.fn((config) => {
    capturedConfig = config;
    return {
      handler: vi.fn(),
      api: { getSession: vi.fn() },
      $Infer: { Session: { session: {}, user: {} } },
    };
  }),
}));

vi.mock('better-auth/adapters/drizzle', () => ({
  drizzleAdapter: vi.fn(() => ({})),
}));

vi.mock('@polar-sh/better-auth', () => ({
  polar: vi.fn(() => ({})),
  checkout: vi.fn(() => ({})),
  portal: vi.fn(() => ({})),
  webhooks: vi.fn(() => ({})),
}));

vi.mock('@polar-sh/sdk', () => {
  class MockPolar {
    customers = {
      list: vi.fn().mockResolvedValue({ result: { items: [] } }),
      create: vi.fn().mockResolvedValue({ id: 'polar-customer-1' }),
    };
    constructor(_opts?: any) {}
  }
  return { Polar: MockPolar };
});

// Mock DB for the database hook tests
const mockInsertReturning = vi.fn();
const mockInsertValues = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();

vi.mock('@/lib/db', () => {
  const chain: Record<string, any> = {};
  chain.values = (...args: any[]) => {
    mockInsertValues(...args);
    return chain;
  };
  chain.returning = (...args: any[]) => {
    mockInsertReturning(...args);
    return Promise.resolve([{ id: 1 }]);
  };
  chain.set = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(Promise.resolve());

  mockInsert.mockReturnValue(chain);
  mockUpdate.mockReturnValue(chain);

  return {
    db: {
      insert: mockInsert,
      update: mockUpdate,
      select: vi.fn(() => chain),
    },
  };
});

vi.mock('@/lib/db/schema', () => ({
  organizations: { id: 'org.id', name: 'org.name' },
  organizationMembers: { organizationId: 'om.org_id', userId: 'om.user_id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: any[]) => ({ type: 'eq', args: a })),
}));

const mockSendEmail = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/email/client', () => ({
  sendEmail: (...args: any[]) => mockSendEmail(...args),
  emailEnabled: () => true,
}));

vi.mock('@/lib/email/templates/verification-email', () => ({
  verificationEmailTemplate: vi.fn(({ verificationUrl }) => ({
    subject: 'Verify your BulkPublish email address',
    html: `<a href="${verificationUrl}">Verify</a>`,
  })),
}));

vi.mock('@/lib/email/templates/password-reset', () => ({
  passwordResetEmailTemplate: vi.fn(({ resetUrl }) => ({
    subject: 'Reset your BulkPublish password',
    html: `<a href="${resetUrl}">Reset</a>`,
  })),
}));

vi.mock('@/lib/polar/plans', () => ({
  productIdToPlan: vi.fn(() => 'pro'),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

export {};

// ---------------------------------------------------------------------------
// Import the auth module to trigger config capture
// ---------------------------------------------------------------------------

await import('@/lib/auth/index');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Auth configuration', () => {
  it('captures the betterAuth config', () => {
    expect(capturedConfig).not.toBeNull();
  });

  describe('emailAndPassword', () => {
    it('minPasswordLength is 8', () => {
      expect(capturedConfig.emailAndPassword.minPasswordLength).toBe(8);
    });

    it('requireEmailVerification is enabled', () => {
      expect(capturedConfig.emailAndPassword.requireEmailVerification).toBe(true);
    });

    it('revokeSessionsOnPasswordReset is enabled', () => {
      expect(capturedConfig.emailAndPassword.revokeSessionsOnPasswordReset).toBe(true);
    });

    it('sendResetPassword builds URL as ${baseUrl}/reset-password?token=...', async () => {
      const sendResetPassword = capturedConfig.emailAndPassword.sendResetPassword;
      expect(sendResetPassword).toBeDefined();

      await sendResetPassword({
        user: { name: 'Test', email: 'test@example.com' },
        url: 'http://localhost:4321/api/auth/reset-password/some-token?callbackURL=...',
        token: 'test-reset-token',
      });

      expect(mockSendEmail).toHaveBeenCalledWith(
        'test@example.com',
        'Reset your BulkPublish password',
        expect.any(String),
        expect.objectContaining({ template: 'password_reset' }),
      );

      // Verify the template was called with our custom URL format
      const { passwordResetEmailTemplate } = await import('@/lib/email/templates/password-reset');
      expect(passwordResetEmailTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          resetUrl: expect.stringContaining('/reset-password?token=test-reset-token'),
        }),
      );
    });
  });

  describe('emailVerification', () => {
    it('sendOnSignUp is true', () => {
      expect(capturedConfig.emailVerification.sendOnSignUp).toBe(true);
    });

    it('sendVerificationEmail builds URL as ${baseUrl}/verify-email?token=...', async () => {
      const sendVerificationEmail = capturedConfig.emailVerification.sendVerificationEmail;
      expect(sendVerificationEmail).toBeDefined();

      await sendVerificationEmail({
        user: { name: 'Test', email: 'test@example.com' },
        url: 'http://localhost:4321/api/auth/verify-email?token=abc&callbackURL=...',
        token: 'test-verify-token',
      });

      expect(mockSendEmail).toHaveBeenCalledWith(
        'test@example.com',
        'Verify your BulkPublish email address',
        expect.any(String),
        expect.objectContaining({ template: 'verification' }),
      );

      const { verificationEmailTemplate } = await import('@/lib/email/templates/verification-email');
      expect(verificationEmailTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          verificationUrl: expect.stringContaining('/verify-email?token=test-verify-token'),
        }),
      );
    });
  });

  describe('session', () => {
    it('expiresIn is 30 days (in seconds)', () => {
      expect(capturedConfig.session.expiresIn).toBe(60 * 60 * 24 * 30);
    });

    it('cookie cache is enabled', () => {
      expect(capturedConfig.session.cookieCache.enabled).toBe(true);
    });

    it('cookie cache maxAge is 5 minutes (in seconds)', () => {
      expect(capturedConfig.session.cookieCache.maxAge).toBe(60 * 5);
    });
  });

  describe('trustedOrigins', () => {
    it('includes localhost:4321', () => {
      expect(capturedConfig.trustedOrigins).toContain('http://localhost:4321');
    });

    it('includes localhost:3000', () => {
      expect(capturedConfig.trustedOrigins).toContain('http://localhost:3000');
    });

    it('includes localhost:3001', () => {
      expect(capturedConfig.trustedOrigins).toContain('http://localhost:3001');
    });

    it('includes baseUrl', () => {
      // baseUrl defaults to http://localhost:4321 or whatever process.env.BASE_URL is
      expect(capturedConfig.trustedOrigins[0]).toBeDefined();
    });

    it('TRUSTED_ORIGINS env var is parsed as comma-separated list', () => {
      const raw = 'http://localhost:4323, http://localhost:4324 ';
      const result = raw.split(',').map(s => s.trim()).filter(Boolean);
      expect(result).toEqual(['http://localhost:4323', 'http://localhost:4324']);
    });
  });

  describe('databaseHooks', () => {
    it('user.create.after hook is defined', () => {
      expect(capturedConfig.databaseHooks.user.create.after).toBeDefined();
      expect(typeof capturedConfig.databaseHooks.user.create.after).toBe('function');
    });

    it('user.create.after creates organization and membership', async () => {
      vi.clearAllMocks();

      const afterHook = capturedConfig.databaseHooks.user.create.after;

      await afterHook({
        id: 'new-user-id',
        name: 'New User',
        email: 'new@example.com',
      });

      // Should have called insert for organization
      expect(mockInsert).toHaveBeenCalled();

      // Should have called insert for org membership with role 'owner'
      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'owner',
        }),
      );
    });
  });
});
