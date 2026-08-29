import { Worker, type Job } from 'bullmq';
import { getRedisConnection, QUEUE_NAMES, addNotificationJob } from './queue';
import { db } from '../db';
import { channels } from '../db/schema';
import { eq, and, lte, gte, isNotNull, isNull } from 'drizzle-orm';
import { encrypt, decrypt } from '../auth/crypto';
import { getPlatformHandler } from '../platforms/registry';
import { platformDisplayName } from '../platforms/types';
import type { PlatformName } from '../platforms/types';
import { createLogger } from '../logger';
import { acquireRefreshLock, releaseRefreshLock } from '../oauth/refresh-lock';
import { isReconnectError } from '../platforms/auth-errors';

const logger = createLogger('token-refresh-worker');

export function createTokenRefreshWorker() {
  return new Worker(
    QUEUE_NAMES.TOKEN_REFRESH,
    async (job: Job) => {
      logger.info('Starting token refresh check');
      await refreshExpiringTokens();
      await validateStaticTokens();
    },
    {
      connection: getRedisConnection(),
      concurrency: 1,
    },
  );
}

function shouldSendExpiryNotification(channel: { metadata: Record<string, unknown> | null }): boolean {
  const meta = (channel.metadata ?? {}) as Record<string, unknown>;
  const lastNotified = meta.lastTokenExpiryNotifiedAt as string | undefined;
  if (!lastNotified) return true;
  const hoursSince = (Date.now() - new Date(lastNotified).getTime()) / (1000 * 60 * 60);
  return hoursSince >= 24;
}

async function markExpiryNotified(channelId: number, existingMetadata: Record<string, unknown> | null | undefined): Promise<void> {
  const merged = { ...(existingMetadata ?? {}), lastTokenExpiryNotifiedAt: new Date().toISOString() };
  await db.update(channels).set({ metadata: merged }).where(eq(channels.id, channelId));
}

async function refreshExpiringTokens() {
  // Find channels with tokens expiring within the next 7 days
  // but not already expired more than 7 days ago (no point refreshing or notifying)
  const expiryThreshold = new Date();
  expiryThreshold.setDate(expiryThreshold.getDate() + 7);
  const expiryCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const expiringChannels = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.isActive, true),
        isNotNull(channels.refreshToken),
        isNotNull(channels.tokenExpiresAt),
        lte(channels.tokenExpiresAt, expiryThreshold),
        gte(channels.tokenExpiresAt, expiryCutoff),
      ),
    );

  if (expiringChannels.length === 0) {
    logger.info('No tokens need refreshing');
    return;
  }

  // Cap work per tick and spread provider calls: a cohort of channels connected the
  // same day expires in the same window, and firing all their OAuth refreshes back-to-back
  // can trip provider rate limits (Meta/Google/X rate-limit token endpoints per app).
  // Process at most MAX_PER_TICK per run — the remainder are still inside the 7-day window
  // and get picked up on the next 40-min tick — with jitter between each call (below).
  const MAX_PER_TICK = 75;
  const batch = expiringChannels.slice(0, MAX_PER_TICK);
  logger.info(
    { found: expiringChannels.length, processing: batch.length },
    'Found channels with expiring tokens',
  );

  for (const channel of batch) {
    // Single-flight: skip if another path (publish-time retry, metrics) is already
    // refreshing this channel — refreshing the same rotating token twice can invalidate it.
    if (!(await acquireRefreshLock(channel.id))) {
      logger.info({ channelId: channel.id }, 'Channel refresh already in progress — skipping this cycle');
      continue;
    }
    try {
      const handler = getPlatformHandler(channel.platform as PlatformName);
      const refreshToken = channel.refreshToken ? decrypt(channel.refreshToken) : null;

      if (!refreshToken) {
        logger.warn({ channelId: channel.id, platform: channel.platform }, 'No refresh token');
        continue;
      }

      const result = await handler.refreshToken(refreshToken, channel.accountType ?? undefined);

      if (result) {
        const updates: Record<string, unknown> = {
          accessToken: encrypt(result.accessToken),
          updatedAt: new Date(),
          // A successful refresh means the token is healthy again — clear any
          // stale reconnect flag set by a previous publish failure.
          needsReconnect: false,
        };

        if (result.refreshToken) {
          updates.refreshToken = encrypt(result.refreshToken);
        }

        if (result.expiresIn) {
          const expiresAt = new Date();
          expiresAt.setSeconds(expiresAt.getSeconds() + result.expiresIn);
          updates.tokenExpiresAt = expiresAt;
        }

        await db
          .update(channels)
          .set(updates)
          .where(eq(channels.id, channel.id));

        logger.info(
          { channelId: channel.id, platform: channel.platform },
          'Token refreshed successfully',
        );
      } else {
        logger.warn(
          { channelId: channel.id, platform: channel.platform },
          'Token refresh returned null - platform may not support refresh',
        );

        // Notify user if token is about to expire and can't be refreshed
        const daysUntilExpiry = channel.tokenExpiresAt
          ? Math.ceil(
              (channel.tokenExpiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
            )
          : 0;

        // Already past expiry and we can't refresh it → the user must reconnect.
        if (daysUntilExpiry <= 0) {
          await db.update(channels).set({ needsReconnect: true }).where(eq(channels.id, channel.id));
        }

        if (daysUntilExpiry <= 3 && shouldSendExpiryNotification(channel)) {
          const isExpired = daysUntilExpiry <= 0;
          const notificationType = isExpired ? 'token_expired' : 'token_expiring';
          const expiryMessage = isExpired
            ? `Your ${channel.accountName} connection has expired. Please reconnect.`
            : `Your ${channel.accountName} connection will expire in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? '' : 's'}. Please reconnect.`;
          await addNotificationJob(
            channel.userId,
            notificationType,
            `${platformDisplayName(channel.platform)} token ${isExpired ? 'expired' : 'expiring soon'}`,
            expiryMessage,
            {
              channelId: channel.id,
              platform: channel.platform,
              daysUntilExpiry,
              accountName: channel.accountName,
            },
            channel.organizationId,
          );
          await markExpiryNotified(channel.id, channel.metadata as Record<string, unknown>);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        { channelId: channel.id, platform: channel.platform, error: message },
        'Token refresh failed',
      );

      // The refresh call itself failed (e.g. the refresh token was revoked) —
      // flag for reconnection so the UI shows it and publishing fails fast.
      await db.update(channels).set({ needsReconnect: true }).where(eq(channels.id, channel.id));

      // Notify user about refresh failure (at most once per 24h)
      if (shouldSendExpiryNotification(channel)) {
        await addNotificationJob(
          channel.userId,
          'token_expired',
          `${platformDisplayName(channel.platform)} connection needs attention`,
          `Failed to refresh token for ${channel.accountName}. Please reconnect your account.`,
          { channelId: channel.id, platform: channel.platform, accountName: channel.accountName },
          channel.organizationId,
        );
        await markExpiryNotified(channel.id, channel.metadata as Record<string, unknown>);
      }
    } finally {
      await releaseRefreshLock(channel.id);
      // Jitter (120–600ms) between serialized refreshes so a same-window cohort doesn't
      // arrive at one provider's token endpoint as a single burst.
      await new Promise((r) => setTimeout(r, 120 + Math.floor(Math.random() * 480)));
    }
  }
}

// How often each static-token channel is re-validated against the platform.
const VALIDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Proactive liveness check for channels the expiry sweep can never see: tokens
 * with no refresh token AND no stored expiry (Facebook page tokens, Telegram bot
 * tokens, Mastodon tokens, ...). These are "long-lived" but the platform can
 * revoke or expire them server-side at any time — e.g. Meta invalidates page
 * tokens on password change, security checkpoint, or app deauthorization —
 * so without this sweep /api/channels keeps reporting them healthy until a
 * publish fails (live incident: Facebook channel 41, 2026-06-29).
 *
 * One lightweight read (`getAccountInfo`, e.g. Graph GET /me) per channel per
 * 24h. Only errors the shared reconnect classifier recognises flag the channel;
 * network blips / rate limits / permission errors are ignored.
 */
async function validateStaticTokens() {
  const staticChannels = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.isActive, true),
        eq(channels.needsReconnect, false),
        isNull(channels.refreshToken),
        isNull(channels.tokenExpiresAt),
        isNotNull(channels.accessToken),
      ),
    );

  for (const channel of staticChannels) {
    // X reads are paid — never spend credits on background validation. (X channels
    // carry a refresh token so the WHERE excludes them; this is a belt-and-braces
    // guard in case one is ever stored without.)
    if (channel.platform === 'x') continue;

    const meta = (channel.metadata ?? {}) as Record<string, unknown>;
    const lastValidated = meta.lastTokenValidatedAt as string | undefined;
    if (lastValidated && Date.now() - new Date(lastValidated).getTime() < VALIDATE_INTERVAL_MS) {
      continue;
    }

    try {
      const handler = getPlatformHandler(channel.platform as PlatformName);
      await handler.getAccountInfo(decrypt(channel.accessToken!));
      await db
        .update(channels)
        .set({ metadata: { ...meta, lastTokenValidatedAt: new Date().toISOString() } })
        .where(eq(channels.id, channel.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (!isReconnectError(message)) {
        // Transient (network, 5xx, rate limit) — leave the channel alone and let
        // the next cycle retry (lastTokenValidatedAt was not advanced).
        logger.warn(
          { channelId: channel.id, platform: channel.platform, error: message },
          'Static token validation failed with a non-auth error — skipping',
        );
        continue;
      }

      logger.warn(
        { channelId: channel.id, platform: channel.platform, error: message },
        'Static token rejected by platform — flagging channel for reconnection',
      );
      await db
        .update(channels)
        .set({ needsReconnect: true, updatedAt: new Date() })
        .where(eq(channels.id, channel.id));

      if (shouldSendExpiryNotification(channel)) {
        await addNotificationJob(
          channel.userId,
          'token_expired',
          `${platformDisplayName(channel.platform)} connection needs attention`,
          `Your ${channel.accountName} connection is no longer valid — its access was revoked or expired. Please reconnect your account.`,
          { channelId: channel.id, platform: channel.platform, accountName: channel.accountName },
          channel.organizationId,
        );
        await markExpiryNotified(channel.id, channel.metadata as Record<string, unknown>);
      }
    }
  }
}
