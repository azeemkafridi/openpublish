import { createLogger } from '../logger';

const logger = createLogger('email');

interface ResendResponse {
  id?: string;
  message?: string;
  data?: Array<{ id?: string }>;
}

/** Template keys — kept for call-site compatibility. */
export type EmailTemplate =
  | 'verification'
  | 'password_reset'
  | 'post_failed'
  | 'token_expiry'
  | 'org_invitation'
  | 'batch';

export interface EmailContext {
  template: EmailTemplate;
  userId?: string;
  organizationId?: number;
}

function senderConfig() {
  return {
    resendApiKey: process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM || 'openPublish <no-reply@localhost>',
    replyTo: process.env.EMAIL_REPLY_TO,
  };
}

/**
 * Transactional email is optional in a self-hosted install. Configure
 * RESEND_API_KEY + EMAIL_FROM to enable it; without it, verification and
 * notification emails are skipped with a log line.
 */
export function emailEnabled(): boolean {
  return !!process.env.RESEND_API_KEY;
}

/** Explicit kill switch, e.g. for staging copies of a production database. */
export function sendingDisabled(): boolean {
  return process.env.EMAIL_DISABLED === 'true';
}

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  ctx?: EmailContext,
): Promise<boolean> {
  const cfg = senderConfig();

  if (!cfg.resendApiKey) {
    logger.warn({ to, subject }, 'Email provider not configured — email not sent');
    return false;
  }
  if (sendingDisabled()) {
    logger.info({ to, subject }, 'Email skipped (EMAIL_DISABLED=true)');
    return true;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: cfg.from,
        to,
        subject,
        html,
        ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
      }),
    });
    const data: ResendResponse = await res.json();
    if (!res.ok) {
      logger.error({ to, subject, status: res.status, error: data.message }, 'Email API error');
      return false;
    }
    logger.info({ to, subject, id: data.id, template: ctx?.template }, 'Email sent');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ to, subject, error: message }, 'Failed to send email');
    return false;
  }
}

/** Resend's /emails/batch accepts at most 100 messages per call. */
export const BATCH_CHUNK_SIZE = 100;

export interface BatchResult {
  sent: string[];
  failed: string[];
}

/**
 * Send ONE identical message to many recipients, each as its own email (no
 * shared To/BCC — recipients never see each other).
 */
export async function sendEmailBatch(
  recipients: string[],
  subject: string,
  html: string,
  _ctx?: EmailContext,
): Promise<BatchResult> {
  const cfg = senderConfig();
  const unique = [...new Set(recipients.map((r) => r.trim().toLowerCase()).filter(Boolean))];

  if (!unique.length) return { sent: [], failed: [] };
  if (!cfg.resendApiKey) {
    logger.warn({ count: unique.length, subject }, 'Email provider not configured — batch not sent');
    return { sent: [], failed: unique };
  }
  if (sendingDisabled()) {
    logger.info({ count: unique.length, subject }, 'Email batch skipped (EMAIL_DISABLED=true)');
    return { sent: unique, failed: [] };
  }

  const result: BatchResult = { sent: [], failed: [] };
  for (let i = 0; i < unique.length; i += BATCH_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + BATCH_CHUNK_SIZE);
    try {
      const res = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(
          chunk.map((to) => ({
            from: cfg.from,
            to,
            subject,
            html,
            ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
          })),
        ),
      });
      const data = (await res.json().catch(() => ({}))) as ResendResponse;
      if (!res.ok) {
        logger.error({ count: chunk.length, subject, status: res.status, error: data.message }, 'Resend batch API error');
        result.failed.push(...chunk);
        continue;
      }
      result.sent.push(...chunk);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ count: chunk.length, subject, error: message }, 'Failed to send email batch');
      result.failed.push(...chunk);
    }
  }
  return result;
}
