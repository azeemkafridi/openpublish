import { wrapInLayout, ctaButton, NOTIFICATION_FOOTER_REASON } from './layout';

export function failureEmailTemplate(data: {
  platform: string;
  errorMessage: string;
  postId: number;
  baseUrl: string;
}): { subject: string; html: string } {
  const subject = `openPublish: Failed to publish to ${data.platform}`;

  const content = `
    <p style="margin:0;font-size:18px;font-weight:600;color:#222222;line-height:1.3;">Post Failed to Publish</p>
    <p style="margin:12px 0 0;font-size:14px;color:#78716C;line-height:1.6;">Something went wrong while publishing to ${data.platform}.</p>

    <p style="margin:12px 0 0;font-size:13px;color:#DC2626;line-height:1.5;">${escapeHtml(data.errorMessage)}</p>

    ${ctaButton('Retry Post', `${data.baseUrl}/compose?repost=${data.postId}`)}
  `;

  const html = wrapInLayout(content, {
    baseUrl: data.baseUrl,
    preheader: `Failed to publish to ${data.platform}: ${data.errorMessage.slice(0, 80)}`,
    heroImage: 'post-failed.png',
    finePrint:
      'You can retry this post anytime from your calendar. If it keeps failing, reconnect the channel from your Channels page.',
    footerReason: NOTIFICATION_FOOTER_REASON,
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
