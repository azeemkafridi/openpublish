import { wrapInLayout, ctaButton } from './layout';

export function passwordResetEmailTemplate(data: {
  name: string;
  resetUrl: string;
  baseUrl: string;
}): { subject: string; html: string } {
  const subject = 'Reset your openPublish password';

  const content = `
    <p style="margin:0;font-size:18px;font-weight:600;color:#222222;line-height:1.3;">Reset your password</p>
    <p style="margin:12px 0 0;font-size:14px;color:#78716C;line-height:1.6;">
      Hi ${escapeHtml(data.name)}, we received a request to reset your password. Click the button below to choose a new one.
    </p>

    ${ctaButton('Reset Password', data.resetUrl)}
  `;

  const html = wrapInLayout(content, {
    baseUrl: data.baseUrl,
    preheader: 'You requested a password reset for your openPublish account.',
    heroImage: 'reset-your-password.png',
    finePrint:
      "This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email — your password will remain unchanged.",
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
