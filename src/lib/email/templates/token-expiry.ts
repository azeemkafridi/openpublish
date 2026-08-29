import { wrapInLayout, ctaButton, NOTIFICATION_FOOTER_REASON } from './layout';

// Platform brand icons are pre-rasterized PNGs served from /public/assets/email-icons/.
// (Gmail and several other clients strip inline SVG, so we can't embed the glyphs directly.)
// To add/refresh an icon, drop a square PNG at public/assets/email-icons/<key>.png and list the key here.
const PLATFORM_ICON_KEYS = new Set([
  'facebook',
  'instagram',
  'x',
  'tiktok',
  'youtube',
  'threads',
  'bluesky',
  'pinterest',
  'gmb',
  'linkedin',
]);

function getPlatformIcon(platform: string, baseUrl: string): string {
  const key = platform.toLowerCase();
  if (PLATFORM_ICON_KEYS.has(key)) {
    return `<img src="${baseUrl}/assets/email-icons/${key}.png" width="20" height="20" alt="${escapeHtml(platform)}" style="display:block;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" />`;
  }
  // Fallback for unmapped platforms: a CSS circle badge with the first letter.
  // (border-radius degrades to a square in legacy Outlook — acceptable for this rare case.)
  const letter = escapeHtml(platform.charAt(0).toUpperCase());
  return `<div style="width:20px;height:20px;line-height:20px;text-align:center;border-radius:50%;background-color:#E7E5E4;color:#57534E;font-size:11px;font-weight:600;font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">${letter}</div>`;
}

export function tokenExpiryEmailTemplate(data: {
  platform: string;
  accountName: string;
  daysUntilExpiry: number;
  isExpired: boolean;
  baseUrl: string;
}): { subject: string; html: string } {
  // Defensive: treat negative daysUntilExpiry as expired
  const isExpired = data.isExpired || data.daysUntilExpiry <= 0;
  const daysUntilExpiry = Math.max(0, data.daysUntilExpiry);

  const subject = isExpired
    ? `openPublish: ${data.platform} connection needs attention`
    : `openPublish: ${data.platform} token expiring in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? '' : 's'}`;

  // Expired = red alert chip; expiring soon = soft cream chip with brand orange.
  const statusColor = isExpired ? '#991B1B' : '#FA8112';
  const statusBg = isExpired ? '#FEE2E2' : '#FFF8EF';
  const statusText = isExpired
    ? 'Connection failed'
    : `Expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? '' : 's'}`;

  const description = isExpired
    ? `We were unable to refresh the connection for your ${data.platform} account. Posts to this channel will fail until you reconnect.`
    : `Your ${data.platform} connection is expiring soon. Reconnect now to avoid any interruptions to scheduled posts.`;

  const icon = getPlatformIcon(data.platform, data.baseUrl);

  const content = `
    <p style="margin:0;font-size:18px;font-weight:600;color:#222222;line-height:1.3;">${data.platform} Connection</p>
    <p style="margin:12px 0 0;font-size:14px;color:#78716C;line-height:1.6;">${description}</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;">
      <tr>
        <td style="background-color:#F5F5F4;border-radius:16px;padding:16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td class="bp-inline" style="vertical-align:top;padding-right:12px;width:20px;">
                ${icon}
              </td>
              <td class="bp-inline" style="vertical-align:top;">
                <p style="margin:0;font-size:15px;font-weight:600;color:#222222;line-height:1.2;">${data.platform}</p>
                ${data.accountName ? `<p style="margin:4px 0 0;font-size:13px;color:#78716C;line-height:1.2;">${escapeHtml(data.accountName)}</p>` : ''}
              </td>
              <!-- bp-chip-cell drops the chip onto its own line on narrow screens,
                   where a right-aligned chip alongside the name blows out the width. -->
              <td class="bp-chip-cell" style="vertical-align:top;text-align:right;">
                <span style="display:inline-block;background-color:${statusBg};color:${statusColor};padding:4px 10px;border-radius:4px;font-size:12px;font-weight:500;white-space:nowrap;">${statusText}</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    ${ctaButton('Reconnect Channel', `${data.baseUrl}/channels`)}
  `;

  const html = wrapInLayout(content, {
    baseUrl: data.baseUrl,
    preheader: isExpired
      ? `Your ${data.platform} connection failed. Reconnect to continue publishing.`
      : `Your ${data.platform} token expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? '' : 's'}.`,
    heroImage: 'warning.png',
    finePrint:
      "You'll get at most one reminder per channel every 24 hours. Reminders stop once you reconnect.",
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
