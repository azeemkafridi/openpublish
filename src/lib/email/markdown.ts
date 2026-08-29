/**
 * Minimal Markdown → email-safe HTML for the admin email composer.
 *
 * Deliberately dependency-free and email-oriented: it emits inline-styled block
 * elements (paragraphs, headings, lists, blockquotes, rules) and inline marks
 * (bold, italic, links, code) that render consistently across mail clients. It is a
 * pure function shared by the live preview (browser) and the send route (server), so
 * what the admin previews is byte-for-byte what gets sent.
 *
 * Supported: # / ## / ### headings, **bold** / __bold__, *italic* / _italic_,
 * `code`, [text](url), - / * / + bullet lists, 1. ordered lists, > blockquotes,
 * --- horizontal rules, blank-line paragraphs (single newlines become <br>).
 * Anything else is treated as literal text. All input is HTML-escaped first.
 */

const S = {
  p: 'margin:0 0 16px;font-size:14px;line-height:1.7;color:#44403C;',
  h1: 'margin:0 0 12px;font-size:20px;font-weight:600;color:#222222;line-height:1.3;',
  h2: 'margin:24px 0 10px;font-size:17px;font-weight:600;color:#222222;line-height:1.3;',
  h3: 'margin:20px 0 8px;font-size:15px;font-weight:600;color:#222222;line-height:1.3;',
  list: 'margin:0 0 16px;padding-left:22px;font-size:14px;line-height:1.7;color:#44403C;',
  li: 'margin:0 0 6px;',
  quote: 'margin:0 0 16px;padding:8px 16px;border-left:3px solid #E7E5E4;color:#57534E;font-size:14px;line-height:1.7;',
  hr: 'border:none;border-top:1px solid #E7E5E4;margin:24px 0;',
  a: 'color:#FA8112;text-decoration:underline;',
  strong: 'font-weight:600;color:#222222;',
  code: 'font-family:monospace;background:#F5F5F4;padding:1px 4px;border-radius:3px;font-size:13px;',
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Apply inline marks to an already-HTML-escaped string. */
function inline(escaped: string): string {
  return escaped
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) => `<a href="${url}" style="${S.a}">${text}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, `<strong style="${S.strong}">$1</strong>`)
    .replace(/__([^_]+)__/g, `<strong style="${S.strong}">$1</strong>`)
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/(^|[^\w])_([^_\n]+)_(?=$|[^\w])/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, `<code style="${S.code}">$1</code>`);
}

const fmt = (line: string): string => inline(escapeHtml(line));

export function markdownToEmailHtml(md: string): string {
  const lines = (md ?? '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let i = 0;

  const flush = () => {
    if (para.length) {
      out.push(`<p style="${S.p}">${para.map(fmt).join('<br>')}</p>`);
      para = [];
    }
  };

  const collect = (test: RegExp, strip: RegExp): string[] => {
    const items: string[] = [];
    while (i < lines.length && test.test(lines[i].trim())) {
      items.push(lines[i].trim().replace(strip, ''));
      i++;
    }
    return items;
  };

  while (i < lines.length) {
    const t = lines[i].trim();

    if (t === '') { flush(); i++; continue; }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); out.push(`<hr style="${S.hr}" />`); i++; continue; }

    const h = /^(#{1,3})\s+(.*)$/.exec(t);
    if (h) {
      flush();
      const tag = h[1].length === 1 ? 'h1' : h[1].length === 2 ? 'h2' : 'h3';
      const style = h[1].length === 1 ? S.h1 : h[1].length === 2 ? S.h2 : S.h3;
      out.push(`<${tag} style="${style}">${fmt(h[2])}</${tag}>`);
      i++; continue;
    }

    if (/^>\s?/.test(t)) {
      flush();
      const items = collect(/^>\s?/, /^>\s?/);
      out.push(`<blockquote style="${S.quote}">${items.map(fmt).join('<br>')}</blockquote>`);
      continue;
    }

    if (/^[-*+]\s+/.test(t)) {
      flush();
      const items = collect(/^[-*+]\s+/, /^[-*+]\s+/);
      out.push(`<ul style="${S.list}">${items.map((x) => `<li style="${S.li}">${fmt(x)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(t)) {
      flush();
      const items = collect(/^\d+\.\s+/, /^\d+\.\s+/);
      out.push(`<ol style="${S.list}">${items.map((x) => `<li style="${S.li}">${fmt(x)}</li>`).join('')}</ol>`);
      continue;
    }

    para.push(t);
    i++;
  }
  flush();

  return out.join('\n');
}
