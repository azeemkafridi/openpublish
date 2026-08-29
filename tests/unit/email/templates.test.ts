/**
 * Email template tests.
 *
 * Tests email templates at webapp/src/lib/email/templates/ covering:
 *   - Verification email template contains the verification URL
 *   - Password reset email template contains the reset URL
 *   - Templates include user name
 *   - Templates include baseUrl for logo/links
 *   - Subject lines are correct
 */

export {};

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

const { verificationEmailTemplate } = await import(
  '@/lib/email/templates/verification-email'
);
const { passwordResetEmailTemplate } = await import(
  '@/lib/email/templates/password-reset'
);
const { tokenExpiryEmailTemplate } = await import(
  '@/lib/email/templates/token-expiry'
);
const { outreachEmailTemplate, OUTREACH_FOOTER_REASON, DEFAULT_OUTREACH_HERO } = await import(
  '@/lib/email/templates/outreach'
);

describe('Verification email template', () => {
  const baseUrl = 'https://app.bulkpublish.com';
  const verificationUrl = `${baseUrl}/verify-email?token=abc123`;

  it('returns correct subject line', () => {
    const { subject } = verificationEmailTemplate({
      name: 'Test User',
      verificationUrl,
      baseUrl,
    });
    expect(subject).toBe('Verify your openPublish email address');
  });

  it('contains the verification URL in HTML', () => {
    const { html } = verificationEmailTemplate({
      name: 'Test User',
      verificationUrl,
      baseUrl,
    });
    expect(html).toContain(verificationUrl);
  });

  it('includes user name', () => {
    const { html } = verificationEmailTemplate({
      name: 'Jane Doe',
      verificationUrl,
      baseUrl,
    });
    expect(html).toContain('Jane Doe');
  });

  it('includes baseUrl for logo/links', () => {
    const { html } = verificationEmailTemplate({
      name: 'Test User',
      verificationUrl,
      baseUrl,
    });
    expect(html).toContain(baseUrl);
  });

  it('wraps content in email layout', () => {
    const { html } = verificationEmailTemplate({
      name: 'Test User',
      verificationUrl,
      baseUrl,
    });
    // Layout wraps in HTML document structure
    expect(html).toContain('<!DOCTYPE html');
  });

  it('escapes HTML characters in name', () => {
    const { html } = verificationEmailTemplate({
      name: '<script>alert("xss")</script>',
      verificationUrl,
      baseUrl,
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('Password reset email template', () => {
  const baseUrl = 'https://app.bulkpublish.com';
  const resetUrl = `${baseUrl}/reset-password?token=reset123`;

  it('returns correct subject line', () => {
    const { subject } = passwordResetEmailTemplate({
      name: 'Test User',
      resetUrl,
      baseUrl,
    });
    expect(subject).toBe('Reset your openPublish password');
  });

  it('contains the reset URL in HTML', () => {
    const { html } = passwordResetEmailTemplate({
      name: 'Test User',
      resetUrl,
      baseUrl,
    });
    expect(html).toContain(resetUrl);
  });

  it('includes user name', () => {
    const { html } = passwordResetEmailTemplate({
      name: 'John Smith',
      resetUrl,
      baseUrl,
    });
    expect(html).toContain('John Smith');
  });

  it('includes baseUrl for logo/links', () => {
    const { html } = passwordResetEmailTemplate({
      name: 'Test User',
      resetUrl,
      baseUrl,
    });
    expect(html).toContain(baseUrl);
  });

  it('wraps content in email layout', () => {
    const { html } = passwordResetEmailTemplate({
      name: 'Test User',
      resetUrl,
      baseUrl,
    });
    expect(html).toContain('<!DOCTYPE html');
  });

  it('mentions password reset in the body', () => {
    const { html } = passwordResetEmailTemplate({
      name: 'Test User',
      resetUrl,
      baseUrl,
    });
    expect(html).toContain('Reset your password');
  });

  it('mentions expiration in the body', () => {
    const { html } = passwordResetEmailTemplate({
      name: 'Test User',
      resetUrl,
      baseUrl,
    });
    expect(html).toContain('expires');
  });
});

describe('Outreach email template', () => {
  const baseUrl = 'https://app.bulkpublish.com';
  const base = { subject: 'Hello there', markdown: 'Hi **friend**', baseUrl };

  it('returns the subject verbatim', () => {
    expect(outreachEmailTemplate(base).subject).toBe('Hello there');
  });

  it('renders the markdown body through the email markdown converter', () => {
    const { html } = outreachEmailTemplate(base);
    expect(html).toContain('<strong');
    expect(html).toContain('friend');
  });

  it('uses the hello hero by default', () => {
    const { html } = outreachEmailTemplate(base);
    expect(html).toContain(`${baseUrl}/assets/email-heroes/${DEFAULT_OUTREACH_HERO}`);
    expect(DEFAULT_OUTREACH_HERO).toBe('hello.png');
  });

  it('renders full width when heroImage is null', () => {
    const { html } = outreachEmailTemplate({ ...base, heroImage: null });
    expect(html).not.toContain('/assets/email-heroes/');
  });

  it('accepts an alternate hero', () => {
    const { html } = outreachEmailTemplate({ ...base, heroImage: 'join-a-team.png' });
    expect(html).toContain('/assets/email-heroes/join-a-team.png');
  });

  it('uses the outreach footer reason, not the account-signup default', () => {
    const { html } = outreachEmailTemplate(base);
    expect(html).toContain(OUTREACH_FOOTER_REASON);
    expect(html).toContain('unsubscribe at any time');
  });

  it('falls back to the subject as the preheader', () => {
    const { html } = outreachEmailTemplate(base);
    // Preheader is the hidden div at the top of the body; the subject sits inside it.
    expect(html).toMatch(/max-height:0;max-width:0;opacity:0;overflow:hidden;">Hello there</);
  });

  it('renders an optional CTA button', () => {
    const { html } = outreachEmailTemplate({
      ...base,
      cta: { label: 'Open openPublish', href: 'https://example.test' },
    });
    expect(html).toContain('Open openPublish');
    expect(html).toContain('border-radius:50px');
  });

  it('omits the CTA when none is given', () => {
    expect(outreachEmailTemplate(base).html).not.toContain('border-radius:50px');
  });

  it('renders fine print when given', () => {
    const { html } = outreachEmailTemplate({ ...base, finePrint: 'Just reply to reach us.' });
    expect(html).toContain('Just reply to reach us.');
  });

  it('escapes HTML in the markdown body', () => {
    const { html } = outreachEmailTemplate({ ...base, markdown: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('wraps content in the standard email layout', () => {
    expect(outreachEmailTemplate(base).html).toContain('<!DOCTYPE html');
  });
});

describe('Token expiry email template', () => {
  const baseUrl = 'https://app.bulkpublish.com';

  it('uses a hosted PNG icon for known platforms, never inline SVG', () => {
    const { html } = tokenExpiryEmailTemplate({
      platform: 'TikTok',
      accountName: '@mybusiness',
      daysUntilExpiry: 2,
      isExpired: false,
      baseUrl,
    });
    // Gmail strips inline SVG — icons must be hosted PNGs referenced by URL.
    expect(html).toContain(`${baseUrl}/assets/email-icons/tiktok.png`);
    expect(html).not.toContain('<svg');
  });

  it('matches platform icons case-insensitively', () => {
    const { html } = tokenExpiryEmailTemplate({
      platform: 'Facebook',
      accountName: 'My Business Page',
      daysUntilExpiry: 0,
      isExpired: true,
      baseUrl,
    });
    expect(html).toContain('/assets/email-icons/facebook.png');
  });

  it('falls back to a CSS letter badge for unmapped platforms, never inline SVG', () => {
    const { html } = tokenExpiryEmailTemplate({
      platform: 'Mastodon',
      accountName: '@me@example.social',
      daysUntilExpiry: 3,
      isExpired: false,
      baseUrl,
    });
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('/assets/email-icons/');
    expect(html).toContain('border-radius:50%');
    expect(html).toContain('>M</div>'); // uppercased first letter
  });

  it('escapes the account name', () => {
    const { html } = tokenExpiryEmailTemplate({
      platform: 'X',
      accountName: '<script>alert("xss")</script>',
      daysUntilExpiry: 1,
      isExpired: false,
      baseUrl,
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
