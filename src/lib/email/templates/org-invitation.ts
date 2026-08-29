import { wrapInLayout, ctaButton } from './layout';
import { ROLE_LABELS, type OrgRole } from '../../team/permissions';

export function orgInvitationEmailTemplate(data: {
  organizationName: string;
  inviterName: string;
  role: OrgRole;
  acceptUrl: string;
  baseUrl: string;
}): { subject: string; html: string } {
  const roleLabel = ROLE_LABELS[data.role] ?? 'Member';
  const article = /^[AEIOU]/i.test(roleLabel) ? 'an' : 'a';
  const subject = `You're invited to join ${data.organizationName} on openPublish`;

  const content = `
    <p style="margin:0;font-size:18px;font-weight:600;color:#222222;line-height:1.3;">Join ${escapeHtml(data.organizationName)}</p>
    <p style="margin:12px 0 0;font-size:14px;color:#78716C;line-height:1.6;">
      ${escapeHtml(data.inviterName)} invited you to join <strong>${escapeHtml(data.organizationName)}</strong> on
      openPublish as ${article} <strong>${escapeHtml(roleLabel)}</strong>. Accept the invite to start collaborating.
    </p>

    ${ctaButton('Accept invite', data.acceptUrl)}
  `;

  const html = wrapInLayout(content, {
    baseUrl: data.baseUrl,
    preheader: `${data.inviterName} invited you to ${data.organizationName} on openPublish.`,
    heroImage: 'join-a-team.png',
    finePrint:
      "This invite expires in 7 days. You'll need to sign in (or create an account) with this email address to accept it. If you weren't expecting this, you can ignore this email.",
    footerReason: "You're receiving this email because someone invited you to their openPublish organization.",
  });

  return { subject, html };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
