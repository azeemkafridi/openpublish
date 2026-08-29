import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from '../db';
import { organizations, organizationMembers } from '../db/schema';
import { sendEmail, emailEnabled } from '../email/client';
import { verificationEmailTemplate } from '../email/templates/verification-email';
import { passwordResetEmailTemplate } from '../email/templates/password-reset';
import { createLogger } from '../logger';

const logger = createLogger('auth');

const baseUrl = process.env.BASE_URL || 'http://localhost:4321';

// Email verification only makes sense when an email provider is configured;
// most self-hosts run without one. Opt in with REQUIRE_EMAIL_VERIFICATION=true.
const requireEmailVerification =
  process.env.REQUIRE_EMAIL_VERIFICATION === 'true' && emailEnabled();

// Google sign-in is optional: enabled only when both env vars are present.
const googleEnabled = !!(process.env.GOOGLE_AUTH_CLIENT_ID && process.env.GOOGLE_AUTH_CLIENT_SECRET);

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  baseURL: baseUrl,
  secret: process.env.BETTER_AUTH_SECRET,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    requireEmailVerification,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url: _url, token }) => {
      // Use our own /reset-password page instead of better-auth's callback URL.
      const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
      const { subject, html } = passwordResetEmailTemplate({
        name: user.name,
        resetUrl,
        baseUrl,
      });
      await sendEmail(user.email, subject, html, { template: 'password_reset', userId: user.id });
    },
  },
  emailVerification: {
    sendOnSignUp: requireEmailVerification,
    sendVerificationEmail: async ({ user, url: _url, token }) => {
      if (!emailEnabled()) return;
      const verificationUrl = `${baseUrl}/verify-email?token=${encodeURIComponent(token)}`;
      const { subject, html } = verificationEmailTemplate({
        name: user.name,
        verificationUrl,
        baseUrl,
      });
      await sendEmail(user.email, subject, html, { template: 'verification', userId: user.id });
    },
  },
  ...(googleEnabled
    ? {
        socialProviders: {
          google: {
            clientId: process.env.GOOGLE_AUTH_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_AUTH_CLIENT_SECRET!,
          },
        },
        accountLinking: {
          enabled: true,
          trustedProviders: ['google'],
        },
      }
    : {}),
  databaseHooks: {
    user: {
      create: {
        after: async (newUser) => {
          const slug = (newUser.name || 'workspace')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 80)
            + '-' + Date.now().toString(36);
          const [org] = await db
            .insert(organizations)
            .values({
              name: `${newUser.name || 'My'}'s Workspace`,
              slug,
              ownerId: newUser.id,
              plan: 'free',
            })
            .returning();
          await db.insert(organizationMembers).values({
            organizationId: org.id,
            userId: newUser.id,
            role: 'owner',
          });
          logger.info({ userId: newUser.id, orgId: org.id }, 'Workspace created');
        },
      },
    },
  },
  user: {
    deleteUser: {
      enabled: true,
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh session every 24 hours
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // 5 minute cookie cache
    },
  },
  trustedOrigins: [
    baseUrl,
    'http://localhost:4321',
    'http://localhost:3000',
    'http://localhost:3001',
    ...(process.env.TRUSTED_ORIGINS
      ? process.env.TRUSTED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
      : []),
  ],
});

export type Session = typeof auth.$Infer.Session.session;
export type User = typeof auth.$Infer.Session.user;
