/**
 * Tests for the admin email composer's Markdown → email-HTML converter.
 * Pure, dependency-free; shared by the live preview and the send route.
 */
import { markdownToEmailHtml } from '@/lib/email/markdown';

describe('markdownToEmailHtml', () => {
  it('wraps plain text in a styled paragraph', () => {
    const html = markdownToEmailHtml('Hello there');
    expect(html).toContain('<p style=');
    expect(html).toContain('Hello there');
  });

  it('HTML-escapes input (no raw tags survive)', () => {
    expect(markdownToEmailHtml('a < b & c')).toContain('a &lt; b &amp; c');
    expect(markdownToEmailHtml('<script>alert(1)</script>')).not.toContain('<script>');
  });

  it('renders bold and italic', () => {
    expect(markdownToEmailHtml('**bold**')).toContain('<strong');
    expect(markdownToEmailHtml('*italic*')).toContain('<em>italic</em>');
  });

  it('renders links', () => {
    const html = markdownToEmailHtml('[BulkPublish](https://bulkpublish.com)');
    expect(html).toContain('<a href="https://bulkpublish.com"');
    expect(html).toContain('BulkPublish</a>');
  });

  it('renders headings h1–h3', () => {
    expect(markdownToEmailHtml('# Title')).toContain('<h1');
    expect(markdownToEmailHtml('## Sub')).toContain('<h2');
    expect(markdownToEmailHtml('### Small')).toContain('<h3');
  });

  it('renders bullet and numbered lists', () => {
    const ul = markdownToEmailHtml('- one\n- two');
    expect(ul).toContain('<ul');
    expect((ul.match(/<li/g) || []).length).toBe(2);
    expect(markdownToEmailHtml('1. a\n2. b')).toContain('<ol');
  });

  it('renders blockquotes and horizontal rules', () => {
    expect(markdownToEmailHtml('> quoted')).toContain('<blockquote');
    expect(markdownToEmailHtml('---')).toContain('<hr');
  });

  it('joins single newlines with <br> but splits on blank lines', () => {
    expect(markdownToEmailHtml('line one\nline two')).toContain('line one<br>line two');
    expect((markdownToEmailHtml('para one\n\npara two').match(/<p /g) || []).length).toBe(2);
  });

  it('returns empty string for empty input', () => {
    expect(markdownToEmailHtml('')).toBe('');
  });

  it('does not italicize snake_case', () => {
    const html = markdownToEmailHtml('some_var_name');
    expect(html).toContain('some_var_name');
    expect(html).not.toContain('<em>');
  });
});

export {};
