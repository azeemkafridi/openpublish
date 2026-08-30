/**
 * Shared base email layout for all openPublish transactional emails.
 * All styles are inline for maximum email client compatibility.
 *
 * Design: 480px white card, a
 * compact two-column body (100x100 hero illustration on the left, heading /
 * body / CTA on the right), full-width fine print below, and a cream footer.
 *
 * Below 520px the two columns STACK into a single column (see RESPONSIVE_CSS):
 * side by side there isn't room for a 100px hero plus readable copy, so the
 * card overflowed the viewport horizontally on phones. Stacked, the hero grows
 * to the full content width at its natural 1:1 aspect ratio.
 *
 * Hero illustrations are authored as SVG (source kept in /assets/email-heroes/)
 * but referenced here as rasterized 400x400 PNGs displayed at 100x100 — Gmail
 * and Outlook strip SVG <img>, so PNG is required for them to render at all.
 * The 400px source is what lets the stacked mobile hero scale up cleanly.
 */

/**
 * Mobile stacking rules. Email clients that honour <style> + media queries
 * (Apple Mail, Gmail apps, Outlook mobile, most webmail) collapse the layout;
 * clients that ignore them (legacy desktop Outlook) keep the desktop table
 * layout, which is correct there anyway. `!important` is required to beat the
 * inline styles and the `width` attributes on the cells.
 */
const RESPONSIVE_CSS = `
  <style type="text/css">
    @media only screen and (max-width: 520px) {
      .bp-card { width: 100% !important; }
      .bp-pad { padding-left: 20px !important; padding-right: 20px !important; }
      .bp-stack { display: block !important; width: 100% !important; max-width: 100% !important; }
      .bp-hero-cell { padding: 0 0 20px 0 !important; text-align: center !important; }
      /* Fills the content column. Capped at 400px = the source PNG's native
         resolution, so it never upscales past what the asset actually has. */
      .bp-hero-img { width: 100% !important; max-width: 400px !important; height: auto !important; margin: 0 auto !important; }
      /* Channel card: the icon and the platform name stay on one line
         (.bp-inline), everything below them reads vertically. Dropping all
         three cells out of display:table-cell avoids the anonymous table box
         a lone block cell would otherwise be wrapped in. */
      .bp-inline { display: inline-block !important; vertical-align: top !important; }
      /* 32px left pad = 20px icon + 12px gutter, so the chip lines up under the
         platform name rather than under the icon. */
      .bp-chip-cell { display: block !important; width: 100% !important; padding: 10px 0 0 32px !important; text-align: left !important; }
      /* The status chip is nowrap on desktop; at ~320px that alone overflows. */
      .bp-chip-cell span { white-space: normal !important; }
    }
  </style>`;

export function wrapInLayout(
  content: string,
  options: {
    baseUrl: string;
    preheader?: string;
    /** Filename inside /assets/email-heroes/, e.g. 'verify-your-email.png' */
    heroImage?: string;
    /** Full-width muted line rendered below the two-column body. */
    finePrint?: string;
    /** First line of the footer legal block. Defaults to the account-signup reason. */
    footerReason?: string;
    /**
     * Href of the footer "Unsubscribe" link. Defaults to the in-app settings
     * page. Marketing broadcasts pass Resend's {{{RESEND_UNSUBSCRIBE_URL}}}
     * merge tag here so every recipient gets a working one-click unsubscribe
     * that Resend records against their contact.
     */
    unsubscribeUrl?: string;
  },
): string {
  const { baseUrl, preheader, heroImage, finePrint, footerReason, unsubscribeUrl } = options;

  const preheaderHtml = preheader
    ? `<div style="display:none;font-size:1px;color:#F5F5F4;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}</div>`
    : '';

  // Two-column body: left = square hero, right = caller content. The hero cell
  // is omitted entirely when no heroImage is given (content spans full width).
  const heroCell = heroImage
    ? `<td class="bp-stack bp-hero-cell" width="100" valign="top" style="width:100px;padding:0 16px 0 0;">
                    <img class="bp-hero-img" src="${baseUrl}/assets/email-heroes/${heroImage}" width="100" height="100" alt="" style="display:block;width:100px;height:100px;border-radius:8px;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" />
                  </td>`
    : '';

  const finePrintHtml = finePrint
    ? `<p style="margin:24px 0 0;font-size:12px;font-weight:300;color:#C4BEB6;line-height:1.5;">${finePrint}</p>`
    : '';

  const reason =
    footerReason ?? "You're receiving this email because you signed up for a openPublish account.";

  const year = new Date().getFullYear();
  const linkStyle = 'color:#FA8112;font-weight:500;text-decoration:underline;';
  // Plain spaces, not &nbsp; — non-breaking spaces welded the four footer links
  // into a single unbreakable run, which set a ~470px min-content width on the
  // card and made the whole email scroll sideways on phones.
  const dotSep = `<span style="color:#D6C4A8;padding:0 4px;"> &bull; </span>`;

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>openPublish</title>
${RESPONSIVE_CSS}
</head>
<body style="margin:0;padding:0;background-color:#F5F5F4;font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#222222;line-height:1.6;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  ${preheaderHtml}

  <!-- Outer wrapper -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F5F5F4;">
    <tr>
      <td align="center" style="padding:16px;">

        <!-- Main card -->
        <table class="bp-card" role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;width:100%;background-color:#FFFFFF;border-radius:12px;overflow:hidden;">

          <!-- Header -->
          <tr>
            <td class="bp-pad" style="padding:28px 32px 20px;">
              <img src="${baseUrl}/assets/logo-email.png" width="28" height="17" alt="openPublish" style="display:block;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" />
            </td>
          </tr>

          <!-- Content: compact two-column (hero | body) -->
          <tr>
            <td class="bp-pad" style="padding:0 32px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  ${heroCell}
                  <td class="bp-stack" valign="top">
                    ${content}
                  </td>
                </tr>
              </table>
              ${finePrintHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td class="bp-pad" style="padding:24px 32px 28px;background-color:#FFF8EF;border-top:1px solid #F1E4CE;">
              <p style="margin:0;font-size:14px;font-weight:700;letter-spacing:-0.01em;color:#292524;">
                <img src="${baseUrl}/assets/logo-email.png" width="16" height="10" alt="" style="border:0;outline:none;text-decoration:none;vertical-align:baseline;-ms-interpolation-mode:bicubic;" />&nbsp;&nbsp;openPublish
              </p>
              <p style="margin:8px 0 0;font-size:12.5px;color:#78716C;line-height:1.5;">
                Schedule and publish to every platform from one place.
              </p>
              <p style="margin:14px 0 0;font-size:13px;line-height:1.7;">
                <a href="${unsubscribeUrl ?? `${baseUrl}/settings`}" target="_blank" style="${linkStyle}">Unsubscribe</a>${dotSep}<a href="${baseUrl}/settings" target="_blank" style="${linkStyle}">Manage email preferences</a>
              </p>
              <p style="margin:14px 0 0;font-size:12px;color:#A8A29E;line-height:1.5;">
                ${reason}
              </p>
              <p style="margin:6px 0 0;font-size:12px;color:#A8A29E;line-height:1.5;">
                &copy; ${year} openPublish. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
        <!-- /Main card -->

      </td>
    </tr>
  </table>
  <!-- /Outer wrapper -->
</body>
</html>`;
}

/** Footer reason line for opt-in notification emails. */
export const NOTIFICATION_FOOTER_REASON =
  "You're receiving this email because of your notification settings on openPublish.";

/** Reusable CTA button HTML */
export function ctaButton(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;">
  <tr>
    <td style="background-color:#FA8112;border-radius:50px;">
      <a href="${href}" target="_blank" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:50px;">${label}</a>
    </td>
  </tr>
</table>`;
}
