import { wrapInLayout, ctaButton } from './layout';
import { markdownToEmailHtml } from '../markdown';

/**
 * Outreach / one-off conversation email.
 *
 * Unlike the transactional templates (verification, password reset, failure…)
 * this one carries no fixed copy: the body is Markdown written by an admin at
 * send time and converted through the same `markdownToEmailHtml` the composer
 * previews with, so preview and delivery are byte-for-byte identical.
 *
 * It renders in the standard two-column shell — the "hello" hero on the left,
 * copy on the right, stacking below 520px like every other template (see
 * layout.ts). The hero defaults to `hello.png`; pass `heroImage: null` for a
 * full-width single-column body when the message is long enough that a hero
 * would just squeeze the copy.
 *
 * The footer reason is NOT the default account-signup line: these emails are
 * people-to-people messages rather than account notifications, so the reason
 * says so, and the footer's unsubscribe/preferences links still apply.
 */

export const OUTREACH_FOOTER_REASON =
  "You're receiving this email because you have a openPublish account. You can unsubscribe at any time.";

export const DEFAULT_OUTREACH_HERO = 'hello.png';

export function outreachEmailTemplate(data: {
  /** Subject line, used verbatim. */
  subject: string;
  /** Message body, Markdown (see lib/email/markdown.ts for the supported subset). */
  markdown: string;
  baseUrl: string;
  /** Inbox preview line. Defaults to the subject. */
  preheader?: string;
  /** Hero filename in /assets/email-heroes/. `null` renders full width. */
  heroImage?: string | null;
  /** Optional call-to-action button rendered below the body. */
  cta?: { label: string; href: string };
  /** Muted line below the body — e.g. a reply-to nudge. */
  finePrint?: string;
  footerReason?: string;
  /** Passed through to the layout — see wrapInLayout. */
  unsubscribeUrl?: string;
}): { subject: string; html: string } {
  const hero = data.heroImage === undefined ? DEFAULT_OUTREACH_HERO : data.heroImage;

  // markdownToEmailHtml escapes its input, so the body can never inject markup.
  const content = `
    ${markdownToEmailHtml(data.markdown)}
    ${data.cta ? ctaButton(data.cta.label, data.cta.href) : ''}
  `;

  const html = wrapInLayout(content, {
    baseUrl: data.baseUrl,
    preheader: data.preheader ?? data.subject,
    heroImage: hero ?? undefined,
    finePrint: data.finePrint,
    footerReason: data.footerReason ?? OUTREACH_FOOTER_REASON,
    unsubscribeUrl: data.unsubscribeUrl,
  });

  return { subject: data.subject, html };
}
