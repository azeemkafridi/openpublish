import { useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useApi } from '@lib/swr';
import { Spinner } from '@components/ui/Spinner';
import { Badge } from '@components/ui/Badge';
import { EmptyState } from '@components/ui/EmptyState';
import { ApiError, parseApiError, type ApiErrorData } from '@components/ui/ApiError';
import { PlatformIcon } from '@components/channels/PlatformIcon';
import type { Platform } from '@components/compose/ChannelSelector';
import PostPreview from '@components/compose/PostPreview';
import { platformDisplayName } from '@lib/platforms/types';

interface Channel {
  id: number;
  platform: string;
  accountName: string;
}

interface MappingOverride {
  template?: string;
  hashtags?: string;
  stripHtml?: boolean;
  truncate?: 'smart' | 'hard' | 'skip';
}

interface FieldMapping {
  template: string;
  mediaField: 'none' | 'image' | 'video' | 'auto';
  stripHtml: boolean;
  truncate: 'smart' | 'hard' | 'skip';
  hashtags: string;
  channelOverrides?: Record<string, MappingOverride>;
}

const DEFAULT_MAPPING: FieldMapping = {
  template: '{title}\n\n{link}',
  mediaField: 'none',
  stripHtml: true,
  truncate: 'smart',
  hashtags: '',
};

interface RssFeed {
  id: number;
  name: string;
  feedUrl: string;
  channelIds: number[];
  mode: 'draft' | 'publish';
  requireApproval?: boolean;
  fieldMapping: FieldMapping | null;
  enabled: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
}

interface ChannelPreview {
  channelId: number;
  platform: string;
  accountName: string;
  text: string;
  charCount: number;
  charLimit: number;
  truncated: boolean;
  overridden: boolean;
  skipped: boolean;
  skipReason: string | null;
}

interface PreviewLinkCard {
  url: string;
  title: string;
  description: string;
  image: string;
  siteName: string;
  domain: string;
}

interface TokenChip {
  token: string;
  label: string;
}

interface PreviewResult {
  feedTitle: string;
  availableFields?: TokenChip[];
  linkPreview: PreviewLinkCard | null;
  item: { title: string; link: string; publishedAt: string | null; description?: string; image: { url: string } | null; video: { url: string } | null };
  media: { url: string; kind: 'image' | 'video' } | null;
  previews: ChannelPreview[];
}

/** URL detector mirroring the server's extractFirstUrl, to decide if a channel's
 *  text actually contains the item link (so the link card only shows then). */
const URL_IN_TEXT = /https?:\/\/[^\s]+/i;

const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="7" y1="2" x2="7" y2="12" />
    <line x1="2" y1="7" x2="12" y2="7" />
  </svg>
);

const RssIcon = () => (
  <svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="10" cy="30" r="2.6" fill="currentColor" stroke="none" />
    <path d="M9 20a11 11 0 0111 11" />
    <path d="M9 11a20 20 0 0120 20" />
  </svg>
);

const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform var(--transition-fast)' }}
  >
    <polyline points="4 6 8 10 12 6" />
  </svg>
);

const PencilIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11.5 1.5l3 3L5 14H2v-3z" />
    <line x1="9" y1="4" x2="12" y2="7" />
  </svg>
);

const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="2 4 12 4" />
    <path d="M4.5 4V2.5a1 1 0 011-1h3a1 1 0 011 1V4" />
    <path d="M3.5 4l.5 8a1 1 0 001 1h4a1 1 0 001-1l.5-8" />
  </svg>
);

/* Toggle switch — same look as the Settings page toggles. */
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      style={{
        width: '44px',
        height: '24px',
        borderRadius: 'var(--radius-pill)',
        background: checked ? 'var(--accent-500)' : 'var(--stone-300)',
        position: 'relative',
        cursor: 'pointer',
        transition: 'background var(--transition-base)',
        border: 'none',
        flexShrink: 0,
        padding: 0,
      }}
    >
      <span
        style={{
          width: '20px',
          height: '20px',
          borderRadius: '50%',
          background: '#FFFFFF',
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
          position: 'absolute',
          top: '2px',
          left: checked ? '22px' : '2px',
          transition: 'left var(--transition-base)',
        }}
      />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Content mapping editor — template, media, per-channel overrides    */
/* ------------------------------------------------------------------ */

/** Fallback pills shown before a preview reveals the feed's actual fields. */
const DEFAULT_TOKEN_CHIPS: TokenChip[] = [
  { token: '{title}', label: 'Title' },
  { token: '{link}', label: 'Link' },
  { token: '{description}', label: 'Summary' },
  { token: '{content}', label: 'Full text' },
  { token: '{author}', label: 'Author' },
  { token: '{categories}', label: 'Categories' },
  { token: '{feedName}', label: 'Feed name' },
];

const TRUNCATE_OPTIONS = [
  { value: 'smart', label: 'Trim to fit (keep the link)' },
  { value: 'hard', label: 'Cut at the limit' },
  { value: 'skip', label: 'Skip the channel' },
] as const;

const MEDIA_OPTIONS = [
  { value: 'none', label: 'No media' },
  { value: 'image', label: 'Item image' },
  { value: 'video', label: 'Item video' },
  { value: 'auto', label: 'Video, or image if none' },
] as const;

function TokenChips({ onInsert, tokens }: { onInsert: (token: string) => void; tokens: TokenChip[] }) {
  return (
    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
      {tokens.map((t) => (
        <button
          key={t.token}
          type="button"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('text/plain', t.token);
            e.dataTransfer.effectAllowed = 'copy';
          }}
          onClick={() => onInsert(t.token)}
          title={`Click or drag to insert ${t.token}`}
          style={{
            border: '1px solid var(--stone-200)',
            background: 'transparent',
            color: 'var(--stone-600)',
            borderRadius: 'var(--radius-pill)',
            padding: '3px 10px',
            fontSize: 'var(--text-xs)',
            fontWeight: 600,
            cursor: 'grab',
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function TemplateArea({
  value,
  onChange,
  tokens,
  rows = 5,
}: {
  value: string;
  onChange: (v: string) => void;
  tokens: TokenChip[];
  rows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (token: string) => {
    const el = ref.current;
    if (!el) {
      onChange(value + token);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + token.length;
    });
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <textarea
        ref={ref}
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // preventDefault on dragOver marks the textarea a valid drop target so
        // the browser moves the text caret to follow the cursor — that's what
        // makes selectionStart the actual drop point on drop.
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('text/plain')) e.preventDefault();
        }}
        onDrop={(e) => {
          const token = e.dataTransfer.getData('text/plain');
          if (!token.startsWith('{') || !token.endsWith('}')) return;
          e.preventDefault();
          const el = e.currentTarget;
          // Resolve the caret at the drop coordinates directly (more reliable
          // than selectionStart, which some browsers leave at the old caret).
          let pos = el.selectionStart ?? value.length;
          const doc = el.ownerDocument as Document & {
            caretPositionFromPoint?: (x: number, y: number) => { offset: number; offsetNode: Node } | null;
          };
          if (typeof doc.caretPositionFromPoint === 'function') {
            const caret = doc.caretPositionFromPoint(e.clientX, e.clientY);
            if (caret && el.contains(caret.offsetNode)) pos = caret.offset;
          } else if (typeof (doc as any).caretRangeFromPoint === 'function') {
            const range = (doc as any).caretRangeFromPoint(e.clientX, e.clientY);
            if (range && el.contains(range.startContainer)) pos = range.startOffset;
          }
          onChange(value.slice(0, pos) + token + value.slice(pos));
          requestAnimationFrame(() => {
            el.focus();
            el.selectionStart = el.selectionEnd = pos + token.length;
          });
        }}
        rows={rows}
        style={{ ...grayInput, resize: 'vertical', fontFamily: 'inherit', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}
        aria-label="Caption template"
      />
      <TokenChips onInsert={insert} tokens={tokens} />
    </div>
  );
}

/* Select styled like the Composer's dropdowns: .input base, no native arrow,
   custom chevron overlay. */
function MappingSelect({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  ariaLabel?: string;
}) {
  return (
    <div style={{ position: 'relative' }}>
      <select
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        style={{
          ...grayInput,
          appearance: 'none',
          paddingRight: '36px',
          cursor: 'pointer',
          fontSize: 'var(--text-sm)',
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="var(--stone-400)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}
      >
        <polyline points="4 6 8 10 12 6" />
      </svg>
    </div>
  );
}

function MappingEditor({
  mapping,
  onChange,
  selectedChannels,
  tokens,
}: {
  mapping: FieldMapping;
  onChange: (next: FieldMapping) => void;
  selectedChannels: Channel[];
  tokens: TokenChip[];
}) {
  const [openOverrideId, setOpenOverrideId] = useState<number | null>(null);

  const setOverride = (channelId: number, patch: MappingOverride | null) => {
    const overrides = { ...(mapping.channelOverrides ?? {}) };
    if (patch === null) {
      delete overrides[String(channelId)];
    } else {
      overrides[String(channelId)] = patch;
    }
    onChange({ ...mapping, channelOverrides: Object.keys(overrides).length > 0 ? overrides : undefined });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 0', minWidth: '150px' }}>
          <span style={editor.sectionTitle}>Attach media</span>
          <MappingSelect
            value={mapping.mediaField}
            onChange={(v) => onChange({ ...mapping, mediaField: v as FieldMapping['mediaField'] })}
            options={MEDIA_OPTIONS}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 0', minWidth: '150px' }}>
          <span style={editor.sectionTitle}>If text is too long</span>
          <MappingSelect
            value={mapping.truncate}
            onChange={(v) => onChange({ ...mapping, truncate: v as FieldMapping['truncate'] })}
            options={TRUNCATE_OPTIONS}
          />
        </label>
      </div>

      <div>
        <div style={editor.sectionTitle}>Caption template</div>
        <div style={editor.sectionHint}>Build the post text from the item's fields. Click or drag a field to insert it; empty fields drop their line.</div>
        <TemplateArea value={mapping.template} onChange={(template) => onChange({ ...mapping, template })} tokens={tokens} />
      </div>

      {selectedChannels.length > 0 && (
        <div>
          <div style={editor.sectionTitle}>Per-channel overrides</div>
          <div style={editor.sectionHint}>
            Give a channel its own template. Channels on the same platform share one text.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {selectedChannels.map((ch) => {
              const override = mapping.channelOverrides?.[String(ch.id)];
              const open = openOverrideId === ch.id;
              return (
                <div key={ch.id} style={{ padding: '8px 0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <PlatformIcon platform={ch.platform as Platform} size="xs" square />
                    <span style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--stone-700)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {ch.accountName}
                      {override && (
                        <span style={{ marginLeft: '8px', fontSize: 'var(--text-xs)', color: 'var(--accent-600)', fontWeight: 600 }}>customized</span>
                      )}
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setOpenOverrideId(open ? null : ch.id)}
                    >
                      {open ? 'Close' : override ? 'Edit' : 'Customize'}
                    </button>
                    {override && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setOverride(ch.id, null); if (open) setOpenOverrideId(null); }}>
                        Reset
                      </button>
                    )}
                  </div>
                  {open && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', margin: '8px 0 4px', padding: '12px', background: 'var(--surface-main)', border: '1px solid var(--stone-200)', borderRadius: '28px' }}>
                      <TemplateArea
                        value={override?.template ?? mapping.template}
                        onChange={(template) => setOverride(ch.id, { ...override, template })}
                        tokens={tokens}
                        rows={3}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Live preview — renders the feed's newest item per channel          */
/* ------------------------------------------------------------------ */

function MappingPreview({
  feedUrl,
  feedName,
  mapping,
  channelIds,
  onFields,
}: {
  feedUrl: string;
  feedName: string;
  mapping: FieldMapping;
  channelIds: number[];
  /** Report the feed's real field list up so the editor's pills can use it. */
  onFields: (fields: TokenChip[]) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PreviewResult | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/rss-feeds/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedUrl, feedName, channelIds, fieldMapping: mapping }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error || 'Could not build the preview.');
        setResult(null);
        return;
      }
      setResult(body);
      if (Array.isArray(body?.availableFields) && body.availableFields.length > 0) {
        onFields(body.availableFields as TokenChip[]);
      }
    } catch {
      setError('Could not build the preview.');
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  // Feed the rendered per-channel result into the SAME PostPreview the Composer
  // uses. Same-platform channels share one text (mirrors platformContent), so we
  // key by platform. Skipped channels drop out of the preview platforms.
  const usable = (result?.previews ?? []).filter((p) => !p.skipped);
  const platforms = Array.from(new Set(usable.map((p) => p.platform))) as Platform[];
  const platformContent: Record<string, string> = {};
  for (const p of usable) platformContent[p.platform] = p.text;
  const baseContent = usable.find((p) => !p.overridden)?.text ?? usable[0]?.text ?? '';
  const skippedNames = (result?.previews ?? []).filter((p) => p.skipped).map((p) => p.accountName);

  // Render the item's link as a real link card matching what platforms publish.
  // The server unfurls the article's Open Graph data (title/description/image);
  // only shown when the caption contains the link and no media is attached.
  const anyTextHasUrl = usable.some((p) => URL_IN_TEXT.test(p.text));
  const linkPreview = result?.linkPreview && anyTextHasUrl && !result.media ? result.linkPreview : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* Before the first fetch: just the trigger button. */}
      {!result && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary btn-sm" disabled={loading || channelIds.length === 0} onClick={run}>
            {loading ? 'Fetching…' : 'Preview latest item'}
          </button>
        </div>
      )}

      {channelIds.length === 0 && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>Turn on at least one channel to preview.</div>
      )}
      {error && <Badge variant="error">{error}</Badge>}

      {result && (
        <>
          {platforms.length > 0 ? (
            <PostPreview
              content={baseContent}
              platforms={platforms}
              platformContent={platformContent}
              mediaUrl={result.media?.url ?? null}
              mediaType={result.media?.kind ?? null}
              linkPreview={linkPreview}
            />
          ) : (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-500)' }}>
              No channel can publish this item with the current mapping.
            </div>
          )}
          {skippedNames.length > 0 && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-error-text)' }}>
              Skipped: {skippedNames.join(', ')}
            </div>
          )}
          {/* Instagram/TikTok captions never linkify URLs — a {link} in the
              template is dead text there. Surface that instead of letting the
              user find out from a published post. */}
          {usable.some((p) => (p.platform === 'instagram' || p.platform === 'tiktok') && URL_IN_TEXT.test(p.text)) && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-500)' }}>
              Note: links in Instagram and TikTok captions are not clickable, so consider removing {'{link}'} for those channels via a per-channel override.
            </div>
          )}
          {/* "Latest item" caption + refresh — below the preview. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-500)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {result.item && (
                <>Latest item: <strong style={{ color: 'var(--stone-700)' }}>{result.item.title || result.item.link}</strong></>
              )}
            </div>
            <button type="button" className="btn btn-secondary btn-sm" disabled={loading || channelIds.length === 0} onClick={run} style={{ flexShrink: 0 }}>
              {loading ? 'Fetching…' : 'Refresh'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Feed editor — channels toggles + mode radios (used by new + edit)  */
/* ------------------------------------------------------------------ */

interface EditorState {
  name: string;
  channelIds: number[];
  mode: 'draft' | 'publish';
  requireApproval: boolean;
  fieldMapping: FieldMapping;
}

/** A readable default feed name from the URL's host, e.g. business.financialpost.com. */
function deriveFeedName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function FeedEditor({
  channels,
  value,
  onChange,
  availableFields,
}: {
  channels: Channel[];
  value: EditorState;
  onChange: (next: EditorState) => void;
  /** Feed-driven pills from the last preview; falls back to the standard set. */
  availableFields?: TokenChip[] | null;
}) {
  const toggleChannel = (id: number, on: boolean) => {
    const next = on ? [...value.channelIds, id] : value.channelIds.filter((c) => c !== id);
    onChange({ ...value, channelIds: next });
  };
  const selectedChannels = channels.filter((c) => value.channelIds.includes(c.id));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div>
        <div style={editor.sectionTitle}>Feed name</div>
        <div style={editor.sectionHint}>Shown in your feed list. Defaults to the site's domain.</div>
        <input
          className="input"
          style={{ ...grayInput, marginTop: '4px' }}
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          placeholder="Feed name"
          maxLength={100}
          aria-label="Feed name"
        />
      </div>

      <div>
        <div style={editor.sectionTitle}>Channels</div>
        <div style={editor.sectionHint}>Choose the channels new items from this feed are posted to.</div>
        {channels.length === 0 && (
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-500)', padding: '12px 0' }}>
            No channels connected yet. <a href="/channels" style={{ color: 'var(--accent-600)', fontWeight: 600 }}>Connect channels</a>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {channels.map((ch, i) => (
            <div
              key={ch.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '12px 0',
                borderTop: i > 0 ? '1px solid var(--stone-150)' : 'none',
              }}
            >
              <PlatformIcon platform={ch.platform as Platform} size="sm" square />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--stone-800)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {ch.accountName}
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>
                  {platformDisplayName(ch.platform)}
                </div>
              </div>
              <Toggle
                checked={value.channelIds.includes(ch.id)}
                onChange={(on) => toggleChannel(ch.id, on)}
                label={`Post to ${ch.accountName}`}
              />
            </div>
          ))}
        </div>
      </div>

      <MappingEditor
        mapping={value.fieldMapping}
        onChange={(fieldMapping) => onChange({ ...value, fieldMapping })}
        selectedChannels={selectedChannels}
        tokens={availableFields && availableFields.length > 0 ? availableFields : DEFAULT_TOKEN_CHIPS}
      />

      <div>
        <div style={editor.sectionTitle}>New items become</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
          {(
            [
              { value: 'draft', label: 'Draft', hint: 'Review each post before it goes out.' },
              { value: 'publish', label: 'Publish immediately', hint: 'New articles are posted automatically.' },
            ] as const
          ).map((opt) => (
            <label key={opt.value} style={editor.radioRow}>
              <input
                type="radio"
                name="rss-mode"
                value={opt.value}
                checked={value.mode === opt.value}
                onChange={() => onChange({ ...value, mode: opt.value })}
                style={{ accentColor: 'var(--accent-600)', width: '16px', height: '16px', margin: 0, flexShrink: 0 }}
              />
              <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--stone-800)' }}>{opt.label}</span>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>{opt.hint}</span>
            </label>
          ))}
        </div>
        {value.mode === 'publish' && (
          <label style={{ ...editor.radioRow, marginTop: '10px' }}>
            <input
              type="checkbox"
              checked={value.requireApproval}
              onChange={(e) => onChange({ ...value, requireApproval: e.target.checked })}
              style={{ accentColor: 'var(--accent-600)', width: '16px', height: '16px', margin: 0, flexShrink: 0 }}
            />
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--stone-800)' }}>Require approval</span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>
              Each new item waits for an approver before it publishes.
            </span>
          </label>
        )}
      </div>
    </div>
  );
}

const editor: Record<string, CSSProperties> = {
  sectionTitle: {
    fontSize: 'var(--text-sm)',
    fontWeight: 600,
    color: 'var(--stone-900)',
  },
  sectionHint: {
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-400)',
    marginTop: '2px',
    marginBottom: '4px',
  },
  radioRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    cursor: 'pointer',
  },
};

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export function RssFeedsPage() {
  const { data: feedsData, isLoading, mutate } = useApi<RssFeed[]>('/api/rss-feeds');
  const { data: channelsData } = useApi<Channel[] | { channels?: Channel[] }>('/api/channels');
  const feeds = Array.isArray(feedsData) ? feedsData : [];
  const channels = Array.isArray(channelsData) ? channelsData : channelsData?.channels ?? [];

  /* Add-feed bar — just a URL; name is set (from the domain) in the editor. */
  const [feedUrl, setFeedUrl] = useState('');
  const [addError, setAddError] = useState<ApiErrorData | null>(null);
  /* A feed being created: url captured, name/channels/mode picked in an expanded editor row. */
  const [pendingNew, setPendingNew] = useState<{ feedUrl: string } | null>(null);
  const [newEditor, setNewEditor] = useState<EditorState>({ name: '', channelIds: [], mode: 'draft', requireApproval: false, fieldMapping: DEFAULT_MAPPING });
  const [saving, setSaving] = useState(false);

  /* Per-feed expanded editor */
  const [openFeedId, setOpenFeedId] = useState<number | null>(null);
  const [feedEditor, setFeedEditor] = useState<EditorState>({ name: '', channelIds: [], mode: 'draft', requireApproval: false, fieldMapping: DEFAULT_MAPPING });
  const [editError, setEditError] = useState<ApiErrorData | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  /* Feed-driven caption pills — set from the preview's availableFields, reset
     whenever a different feed's editor opens (its fields differ). */
  const [previewFields, setPreviewFields] = useState<TokenChip[] | null>(null);

  const startAdd = () => {
    setAddError(null);
    const url = feedUrl.trim();
    if (!url) {
      setAddError({ message: 'Enter a feed URL first.' });
      return;
    }
    setPendingNew({ feedUrl: url });
    setNewEditor({ name: deriveFeedName(url), channelIds: [], mode: 'draft', requireApproval: false, fieldMapping: DEFAULT_MAPPING });
    setOpenFeedId(null);
    setPreviewFields(null);
  };

  const saveNew = async () => {
    if (!pendingNew) return;
    setAddError(null);
    if (newEditor.channelIds.length === 0) {
      setAddError({ message: 'Turn on at least one channel for this feed.' });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/rss-feeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newEditor.name.trim() || deriveFeedName(pendingNew.feedUrl) || pendingNew.feedUrl,
          feedUrl: pendingNew.feedUrl,
          channelIds: newEditor.channelIds,
          mode: newEditor.mode,
          requireApproval: newEditor.requireApproval,
          fieldMapping: newEditor.fieldMapping,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setAddError(parseApiError(body, 'Could not add the feed.'));
        return;
      }
      await mutate();
      setPendingNew(null);
      setFeedUrl('');
    } catch (err: any) {
      setAddError({ message: err?.message || 'Something went wrong. Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  const openFeed = (feed: RssFeed) => {
    setEditError(null);
    setConfirmDeleteId(null);
    setPreviewFields(null);
    if (openFeedId === feed.id) {
      setOpenFeedId(null);
      return;
    }
    setOpenFeedId(feed.id);
    setFeedEditor({ name: feed.name, channelIds: feed.channelIds ?? [], mode: feed.mode, requireApproval: feed.requireApproval === true, fieldMapping: feed.fieldMapping ?? DEFAULT_MAPPING });
  };

  const saveFeed = async (feed: RssFeed) => {
    setEditError(null);
    if (feedEditor.channelIds.length === 0) {
      setEditError({ message: 'Turn on at least one channel for this feed.' });
      return;
    }
    setSavingEdit(true);
    try {
      const res = await fetch(`/api/rss-feeds/${feed.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: feedEditor.name.trim() || feed.name, channelIds: feedEditor.channelIds, mode: feedEditor.mode, requireApproval: feedEditor.requireApproval, fieldMapping: feedEditor.fieldMapping }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setEditError(parseApiError(body, 'Could not save the feed.'));
        return;
      }
      await mutate();
      setOpenFeedId(null);
    } catch (err: any) {
      setEditError({ message: err?.message || 'Something went wrong. Please try again.' });
    } finally {
      setSavingEdit(false);
    }
  };

  const toggleFeed = async (feed: RssFeed) => {
    await fetch(`/api/rss-feeds/${feed.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !feed.enabled }),
    });
    await mutate();
  };

  const deleteFeed = async (feed: RssFeed) => {
    await fetch(`/api/rss-feeds/${feed.id}`, { method: 'DELETE' });
    setConfirmDeleteId(null);
    if (openFeedId === feed.id) setOpenFeedId(null);
    await mutate();
  };

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '80px 0' }}>
        <Spinner size="lg" />
      </div>
    );
  }

  /* The editor currently open (add or edit) — drives the right-hand preview
     column and switches the page to full width, like the Composer. */
  const openFeedForEdit = openFeedId != null ? feeds.find((f) => f.id === openFeedId) : undefined;
  const editingPreview = pendingNew
    ? { feedUrl: pendingNew.feedUrl, feedName: newEditor.name, mapping: newEditor.fieldMapping, channelIds: newEditor.channelIds }
    : openFeedForEdit
      ? { feedUrl: openFeedForEdit.feedUrl, feedName: feedEditor.name, mapping: feedEditor.fieldMapping, channelIds: feedEditor.channelIds }
      : null;
  const isEditing = editingPreview !== null;

  const listColumn = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Add-feed bar */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ flex: '1 1 280px' }}>
            <input
              id="rss-url"
              className="input"
              style={{ ...grayInput, height: 'var(--control-height-sm)' }}
              value={feedUrl}
              onChange={(e) => setFeedUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !pendingNew) startAdd(); }}
              placeholder="https://www.mywebsite.com/feed.xml"
              aria-label="Feed URL"
            />
          </div>
          {!pendingNew && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={startAdd}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}
            >
              <PlusIcon />
              Add feed
            </button>
          )}
        </div>

        {/* New feed: pick channels + mode before saving */}
        {pendingNew && (
          <div style={{ paddingTop: '4px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <FeedEditor channels={channels} value={newEditor} onChange={setNewEditor} availableFields={previewFields} />
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={saveNew} style={{ minWidth: '84px' }}>
                {saving ? 'Adding…' : 'Add feed'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setPendingNew(null); setAddError(null); }}>Cancel</button>
            </div>
          </div>
        )}

        {addError && <ApiError error={addError} />}
      </div>

      {/* Empty state */}
      {feeds.length === 0 && !pendingNew && (
        <EmptyState
          icon={<RssIcon />}
          title="No feeds yet"
          description="Add your blog, newsletter, or any RSS/Atom feed above and new articles will flow into your queue automatically."
        />
      )}

      {/* Feed list */}
      {feeds.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <h2 style={{ fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--stone-900)', margin: '0 0 4px' }}>
            My feeds
          </h2>
          {feeds.map((feed) => {
            const open = openFeedId === feed.id;
            const dotColor = feed.lastError
              ? 'var(--color-error)'
              : feed.enabled
                ? 'var(--color-success)'
                : 'var(--color-warning)';
            return (
              <div key={feed.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                {/* Collapsed row */}
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 20px', cursor: 'pointer' }}
                  onClick={() => openFeed(feed)}
                >
                  <span
                    title={feed.lastError ? 'Feed error' : feed.enabled ? 'Active' : 'Paused'}
                    style={{
                      width: '10px',
                      height: '10px',
                      borderRadius: '50%',
                      background: dotColor,
                      flexShrink: 0,
                      alignSelf: 'center',
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--stone-900)' }}>{feed.name}</span>
                      {feed.mode === 'publish' && feed.requireApproval && (
                        <Badge variant="warning">Needs approval</Badge>
                      )}
                      <Badge variant={feed.mode === 'publish' ? 'info' : 'neutral'}>
                        {feed.mode === 'publish' ? 'Auto-publish' : 'Drafts'}
                      </Badge>
                      {!feed.enabled && <Badge variant="warning">Paused</Badge>}
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)', marginTop: '3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {feed.feedUrl}
                      {feed.lastCheckedAt && ` · Checked ${new Date(feed.lastCheckedAt).toLocaleDateString()}`}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      title={open ? 'Collapse' : 'Edit feed'}
                      aria-label={open ? 'Collapse' : 'Edit feed'}
                      style={iconBtn}
                      onClick={() => openFeed(feed)}
                    >
                      {open ? <ChevronIcon open /> : <PencilIcon />}
                    </button>
                    {confirmDeleteId === feed.id ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <button
                          type="button"
                          onClick={() => deleteFeed(feed)}
                          style={{ border: 'none', background: 'transparent', color: 'var(--color-error-text)', fontSize: 'var(--text-xs)', fontWeight: 600, cursor: 'pointer', padding: '4px 6px' }}
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          style={{ border: 'none', background: 'transparent', color: 'var(--stone-500)', fontSize: 'var(--text-xs)', fontWeight: 500, cursor: 'pointer', padding: '4px 6px' }}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        title="Delete feed"
                        aria-label="Delete feed"
                        style={iconBtn}
                        onClick={() => setConfirmDeleteId(feed.id)}
                        onMouseOver={(e) => { e.currentTarget.style.background = 'var(--color-error-bg)'; e.currentTarget.style.color = 'var(--color-error-text)'; }}
                        onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--stone-400)'; }}
                      >
                        <TrashIcon />
                      </button>
                    )}
                  </div>
                </div>

                {/* Expanded editor */}
                {open && (
                  <div style={{ borderTop: '1px solid var(--stone-150)', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    {feed.lastError && <Badge variant="error">{feed.lastError}</Badge>}
                    <FeedEditor channels={channels} value={feedEditor} onChange={setFeedEditor} availableFields={previewFields} />
                    {editError && <ApiError error={editError} />}
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <button type="button" className="btn btn-primary btn-sm" disabled={savingEdit} onClick={() => saveFeed(feed)} style={{ minWidth: '84px' }}>
                        {savingEdit ? 'Saving…' : 'Save'}
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpenFeedId(null)}>Cancel</button>
                      <div style={{ flex: 1 }} />
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => toggleFeed(feed)}>
                        {feed.enabled ? 'Pause feed' : 'Resume feed'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div
      style={{
        width: '100%',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        gap: isEditing ? '24px' : 0,
      }}
    >
      <div style={{ flex: isEditing ? '1 1 460px' : '1 1 100%', minWidth: 0 }}>{listColumn}</div>
      {editingPreview && (
        <div style={{ flex: '1 1 360px', minWidth: 0, paddingTop: '4px' }}>
          <MappingPreview
            key={editingPreview.feedUrl}
            feedUrl={editingPreview.feedUrl}
            feedName={editingPreview.feedName}
            mapping={editingPreview.mapping}
            channelIds={editingPreview.channelIds}
            onFields={setPreviewFields}
          />
        </div>
      )}
    </div>
  );
}

const grayInput: CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--stone-200)',
};

const iconBtn: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '32px',
  height: '32px',
  borderRadius: 'var(--radius-md)',
  border: 'none',
  background: 'transparent',
  color: 'var(--stone-400)',
  cursor: 'pointer',
  transition: 'all var(--transition-fast)',
};
