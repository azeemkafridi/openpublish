import { Worker, type Job } from 'bullmq';
import { getRedisConnection, QUEUE_NAMES } from './queue';
import { db } from '../db';
import { notifications, notificationPreferences, user } from '../db/schema';
import { eq } from 'drizzle-orm';
import { sendEmail } from '../email/client';
import { failureEmailTemplate } from '../email/templates/failure';
import { tokenExpiryEmailTemplate } from '../email/templates/token-expiry';
import { createLogger } from '../logger';
import { sendPushToUser } from '../push/expo';

const logger = createLogger('notification-worker');

export function createNotificationWorker() {
  return new Worker(
    QUEUE_NAMES.NOTIFICATION,
    async (job: Job) => {
      // 'daily-digest' repeatable jobs were removed — ignore any stale ones
      // still registered in Redis from a previous deploy.
      if (job.name === 'daily-digest') {
        logger.info('Ignoring stale daily-digest job (feature removed)');
        return;
      }

      const { userId, type, title, message, data, organizationId } = job.data;

      logger.info({ userId, type, title }, 'Processing notification');

      // Get user preferences
      const [prefs] = await db
        .select()
        .from(notificationPreferences)
        .where(eq(notificationPreferences.userId, userId))
        .limit(1);

      // Check if in-app notification should be created
      const shouldNotifyInApp = shouldCreateInAppNotification(type, prefs);
      const shouldNotifyEmail = shouldSendEmail(type, prefs);

      if (shouldNotifyInApp) {
        await db.insert(notifications).values({
          userId,
          organizationId: organizationId ?? null,
          type,
          title,
          message,
          data,
          isRead: false,
        });

        logger.info({ userId, type }, 'In-app notification created');

        // Mirror the in-app notification to the user's mobile devices as an
        // Expo push. Same preference gate as in-app; fire-and-forget — a push
        // failure must never fail the notification job.
        sendPushToUser(userId, {
          title,
          body: message,
          data: {
            type,
            ...(data?.postId != null ? { postId: data.postId } : {}),
          },
        }).catch((err) => {
          logger.error({ err, userId, type }, 'Push notification dispatch failed');
        });
      }

      if (shouldNotifyEmail) {
        await sendEmailNotification(userId, type, message, data);
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 5,
    },
  );
}

function shouldCreateInAppNotification(
  type: string,
  prefs: typeof notificationPreferences.$inferSelect | undefined,
): boolean {
  if (!prefs) return true; // Default: all notifications enabled

  switch (type) {
    case 'post_published':
      return prefs.inAppPublished ?? true;
    case 'post_failed':
      return prefs.inAppFailed ?? true;
    case 'post_scheduled_reminder':
      return prefs.inAppScheduleReminder ?? true;
    case 'token_expiring':
    case 'token_expired':
      return prefs.inAppTokenExpiry ?? true;
    default:
      return true;
  }
}

function shouldSendEmail(
  type: string,
  prefs: typeof notificationPreferences.$inferSelect | undefined,
): boolean {
  // Email notifications are OPT-IN. With no preferences row — or a column left
  // unset — send nothing; a user must explicitly enable an email category in
  // Settings. (In-app notifications, which cost nothing, stay on by default.)
  if (!prefs) return false;

  switch (type) {
    case 'post_failed':
      return prefs.emailOnFailure ?? false;
    case 'token_expiring':
    case 'token_expired':
      return prefs.emailOnTokenExpiry ?? false;
    default:
      return false;
  }
}

async function sendEmailNotification(
  userId: string,
  type: string,
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  // Fetch user email
  const [u] = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (!u?.email) {
    logger.warn({ userId }, 'No email found for user — skipping email notification');
    return;
  }

  const baseUrl = process.env.PUBLIC_APP_URL || 'https://your instance';
  let subject: string;
  let html: string;

  switch (type) {
    case 'post_failed': {
      const result = failureEmailTemplate({
        platform: (data?.platform as string) || 'Unknown',
        errorMessage: message,
        postId: (data?.postId as number) || 0,
        baseUrl,
      });
      subject = result.subject;
      html = result.html;
      break;
    }
    case 'token_expiring':
    case 'token_expired': {
      const result = tokenExpiryEmailTemplate({
        platform: (data?.platform as string) || 'Unknown',
        accountName: (data?.accountName as string) || '',
        daysUntilExpiry: (data?.daysUntilExpiry as number) || 0,
        isExpired: type === 'token_expired',
        baseUrl,
      });
      subject = result.subject;
      html = result.html;
      break;
    }
    default:
      logger.warn({ type }, 'No email template for notification type');
      return;
  }

  const sent = await sendEmail(u.email, subject, html, {
    template: type === 'post_failed' ? 'post_failed' : 'token_expiry',
    userId,
  });
  if (sent) {
    logger.info({ userId, type, email: u.email }, 'Email notification sent');
  }
}
