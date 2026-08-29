import { wrapInLayout, ctaButton } from './layout';

export function verificationEmailTemplate(data: {
  name: string;
  verificationUrl: string;
  baseUrl: string;
}): { subject: string; html: string } {
  const subject = 'Verify your openPublish email address';

  const content = `
    <p style="margin:0;font-size:18px;font-weight:600;color:#222222;line-height:1.3;">Verify your email</p>
    <p style="margin:12px 0 0;font-size:14px;color:#78716C;line-height:1.6;">
      Hi ${escapeHtml(data.name)}, thanks for signing up for openPublish. Please verify your email address to get started.
    </p>

    ${ctaButton('Verify Email', data.verificationUrl)}
  `;

  const html = wrapInLayout(content, {
    baseUrl: data.baseUrl,
    preheader: 'Confirm your email to start publishing with openPublish.',
    heroImage: 'verify-your-email.png',
    finePrint:
      "This link expires in 24 hours. If you didn't create an account, you can safely ignore this email.",
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
