/**
 * Minimal Expo push client — plain fetch against the Expo push API, no SDK.
 *
 * Sends messages in chunks of up to 100 (the Expo API limit) and cleans up
 * tokens the API reports as DeviceNotRegistered so we stop pushing to
 * uninstalled/logged-out devices. Errors are logged, never thrown: push is
 * strictly best-effort.
 */
import { db } from '../db';
import { pushTokens } from '../db/schema';
import { eq, inArray } from 'drizzle-orm';
import { createLogger } from '../logger';

const logger = createLogger('expo-push');

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_PUSH_CHUNK_SIZE = 100;

export interface ExpoPushMessage {
  to: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
}

interface ExpoPushTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Send push messages to Expo. Returns the tokens that came back
 * DeviceNotRegistered (already deleted from push_tokens by the time this
 * resolves). Never throws.
 */
export async function sendExpoPushMessages(messages: ExpoPushMessage[]): Promise<string[]> {
  if (messages.length === 0) return [];

  const deadTokens: string[] = [];

  for (const batch of chunk(messages, EXPO_PUSH_CHUNK_SIZE)) {
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
        body: JSON.stringify(batch),
      });

      if (!res.ok) {
        logger.error({ status: res.status }, 'Expo push request failed');
        continue;
      }

      const payload = (await res.json()) as { data?: ExpoPushTicket[] };
      const tickets = payload.data ?? [];

      // Tickets come back in the same order as the messages in the batch.
      tickets.forEach((ticket, i) => {
        if (ticket.status === 'error') {
          const token = batch[i]?.to;
          if (ticket.details?.error === 'DeviceNotRegistered' && token) {
            deadTokens.push(token);
          } else {
            logger.warn(
              { error: ticket.details?.error, message: ticket.message },
              'Expo push ticket error',
            );
          }
        }
      });
    } catch (err) {
      logger.error({ err }, 'Expo push send failed');
    }
  }

  if (deadTokens.length > 0) {
    try {
      await db.delete(pushTokens).where(inArray(pushTokens.token, deadTokens));
      logger.info({ count: deadTokens.length }, 'Removed unregistered push tokens');
    } catch (err) {
      logger.error({ err }, 'Failed to delete unregistered push tokens');
    }
  }

  return deadTokens;
}

/**
 * Push one notification to every registered device of MANY users — one token
 * query and one chunked Expo send, for fan-out paths (approver notifications,
 * broadcasts). Per-user sends in a loop would do N queries and N HTTP posts
 * of 1–3 messages each. Best-effort like sendPushToUser.
 */
export async function sendPushToUsers(
  userIds: string[],
  notification: { title: string; body: string; data?: Record<string, unknown> },
): Promise<void> {
  if (userIds.length === 0) return;
  try {
    const tokens = await db
      .select({ token: pushTokens.token })
      .from(pushTokens)
      .where(inArray(pushTokens.userId, userIds));

    if (tokens.length === 0) return;

    await sendExpoPushMessages(
      tokens.map((t) => ({
        to: t.token,
        title: notification.title,
        body: notification.body,
        data: notification.data,
        sound: 'default' as const,
      })),
    );
  } catch (err) {
    logger.error({ err, users: userIds.length }, 'Batch push notification failed');
  }
}

/**
 * Push a notification to every registered device of one user. Best-effort:
 * logs and swallows every failure so callers can fire-and-forget.
 */
export async function sendPushToUser(
  userId: string,
  notification: { title: string; body: string; data?: Record<string, unknown> },
): Promise<void> {
  try {
    const tokens = await db
      .select({ token: pushTokens.token })
      .from(pushTokens)
      .where(eq(pushTokens.userId, userId));

    if (tokens.length === 0) return;

    await sendExpoPushMessages(
      tokens.map((t) => ({
        to: t.token,
        title: notification.title,
        body: notification.body,
        data: notification.data,
        sound: 'default' as const,
      })),
    );
  } catch (err) {
    logger.error({ err, userId }, 'Push notification failed');
  }
}
