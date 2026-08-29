import { useState, useCallback, useMemo, useEffect, useRef, lazy, Suspense } from 'react';
import { ChannelSelector, type SelectedChannel } from './ChannelSelector';
import { MediaUploader, type MediaFile } from './MediaUploader';
import { PlatformOptions, validatePlatformOptions, hasPlatformOptions, type PlatformSpecific } from './PlatformOptions';
import { Select } from '@components/ui/Select';
import type { Platform } from './PostPreview';

const PostPreview = lazy(() => import('./PostPreview'));

/**
 * BulkComposer — a single Composer-like master-detail view: a post list on the left,
 * one post's editor + live PostPreview on the right, and a shared schedule + channels
 * column. Posts can publish now, save as drafts, schedule (one shared time, per-post
 * overridable), or be added to the queue (auto-assigned slots). Drafts autosave.
 */

export type PublishMode = 'now' | 'draft' | 'schedule' | 'queue';
export type RepeatFreq = 'none' | 'daily' | 'weekly' | 'monthly';

export interface BulkPostDraft {
  id: string;
  content: string;
  media: MediaFile[];
  customizeChannels: boolean;
  channels: SelectedChannel[];
  customTime: boolean;
  scheduledAt: string;
  mediaUrls: string[];
  platformSpecific: PlatformSpecific;
}

interface SavedDraft {
  posts?: BulkPostDraft[];
  selectedId?: string;
  globalChannels?: SelectedChannel[];
  globalPlatformSpecific?: PlatformSpecific;
  publishMode?: PublishMode;
  timezone?: string;
  scheduleAt?: string;
  repeatFreq?: RepeatFreq;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const uid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

const newDraft = (content = ''): BulkPostDraft => ({ id: uid(), content, media: [], customizeChannels: false, channels: [], customTime: false, scheduledAt: '', mediaUrls: [], platformSpecific: {} });

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const TZ_OPTIONS: { value: string; label: string }[] = (() => {
  try {
    const zones = Intl.supportedValuesOf('timeZone');
    return [{ value: 'UTC', label: 'UTC' }, ...zones.filter((z) => z !== 'UTC').map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))];
  } catch {
    return ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Asia/Tokyo'].map((z) => ({ value: z, label: z.replace(/_/g, ' ') }));
  }
})();

const REPEAT_OPTIONS = [
  { value: 'none', label: 'Do not repeat' },
  { value: 'daily', label: 'Repeat daily' },
  { value: 'weekly', label: 'Repeat weekly' },
  { value: 'monthly', label: 'Repeat monthly' },
];

const p2 = (n: number) => String(n).padStart(2, '0');
const toLocalInput = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;

function tzOffsetMinutes(tz: string, date: Date): number {
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const local = new Date(date.toLocaleString('en-US', { timeZone: tz }));
  return (local.getTime() - utc.getTime()) / 60_000;
}

export function wallTimeToISO(local: string, tz: string): string | null {
  if (!local) return null;
  const [date, time] = local.split('T');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  if ([y, mo, d, h, mi].some((n) => Number.isNaN(n))) return null;
  const asUTC = Date.UTC(y, mo - 1, d, h, mi);
  return new Date(asUTC - tzOffsetMinutes(tz, new Date(asUTC)) * 60_000).toISOString();
}

const mediaTypeOf = (m?: MediaFile): 'image' | 'video' | null => (!m ? null : m.mimeType?.startsWith('video') ? 'video' : 'image');

const YT_DEFAULTS = { title: '', privacyStatus: 'public', categoryId: '22', madeForKids: false, playlistId: '' };

/**
 * Title is the one platform option that's genuinely per-post (each pin/video needs its own),
 * so it lives in the post's own platformSpecific and is edited in the composer. Everything else
 * (board, link, privacy, …) is shared via the "Apply to all" panel. For a post that doesn't
 * override channels, its effective options are the global ones with this post's title layered on.
 */
function withPerPostTitle(base: PlatformSpecific, post: BulkPostDraft, channels: SelectedChannel[]): PlatformSpecific {
  const title = (post.platformSpecific.youtube?.title || post.platformSpecific.pinterest?.title || '').trim();
  if (!title) return base;
  const out: PlatformSpecific = { ...base };
  if (channels.some((c) => c.platform === 'youtube')) out.youtube = { ...(base.youtube ?? YT_DEFAULTS), title };
  if (channels.some((c) => c.platform === 'pinterest')) out.pinterest = { ...(base.pinterest ?? {}), title };
  return out;
}

/** Minimal RFC-4180-ish CSV parser (handles quoted fields, commas, newlines). */
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/**
 * The downloadable CSV example.
 *
 * Dates are generated a week out rather than hardcoded: the literal dates this
 * shipped with (2026-06-02) were in the past within three months, so anyone
 * importing the template unedited got rows the scheduler had to reject.
 */
function csvTemplate(): string {
  const d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return (
    'content,scheduled_at,media_urls\n' +
    `"Big news: our spring update is live with faster composer, bulk scheduling, and analytics. 🚀",${day}T09:00,https://picsum.photos/id/1015/1080/1080\n` +
    `"Behind the scenes: how we plan a week of content in 20 minutes. 🎬",${day}T13:00,https://picsum.photos/id/1025/1080/1080\n`
  );
}

const GREY = { background: 'var(--surface-card)' } as const;

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function BulkComposer() {
  const DRAFT_KEY = 'bp-bulk-draft';

  const saved = useMemo<SavedDraft | null>(() => {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(DRAFT_KEY) : null;
      const parsed = raw ? (JSON.parse(raw) as SavedDraft) : null;
      // Only restore a draft that has at least one post with real content or media.
      // Otherwise the user lands on a fresh-feeling page with stale globalChannels/options
      // still applied from a previous session — surprising and hard to undo.
      const hasContent = parsed?.posts?.some((p) => (p.content?.trim() || p.media?.length || p.mediaUrls?.length));
      return hasContent ? parsed : null;
    } catch {
      return null;
    }
  }, [DRAFT_KEY]);

  const initialPosts = useMemo<BulkPostDraft[]>(() => {
    if (!saved?.posts?.length) return [newDraft()];
    // Normalize drafts written by older versions so newer fields (mediaUrls, etc.) always exist.
    return saved.posts.map((p) => ({
      ...newDraft(),
      ...p,
      media: Array.isArray(p.media) ? p.media : [],
      channels: Array.isArray(p.channels) ? p.channels : [],
      mediaUrls: Array.isArray(p.mediaUrls) ? p.mediaUrls : [],
      platformSpecific: p.platformSpecific ?? {},
    }));
  }, [saved]);
  const [posts, setPosts] = useState<BulkPostDraft[]>(initialPosts);
  const [selectedId, setSelectedId] = useState<string>(() => (initialPosts.find((p) => p.id === saved?.selectedId) ?? initialPosts[0]).id);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [globalChannels, setGlobalChannels] = useState<SelectedChannel[]>(saved?.globalChannels ?? []);
  const [globalPlatformSpecific, setGlobalPlatformSpecific] = useState<PlatformSpecific>(saved?.globalPlatformSpecific ?? {});
  const [publishMode, setPublishMode] = useState<PublishMode>(saved?.publishMode ?? 'schedule');
  const [timezone, setTimezone] = useState<string>(saved?.timezone ?? browserTimezone());
  const [scheduleAt, setScheduleAt] = useState<string>(saved?.scheduleAt ?? toLocalInput(new Date(Date.now() + 60 * 60 * 1000)));
  const [repeatFreq, setRepeatFreq] = useState<RepeatFreq>(saved?.repeatFreq ?? 'none');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [doneCount, setDoneCount] = useState<number | null>(null);
  const [showTip, setShowTip] = useState(false);
  const [showQueueTip, setShowQueueTip] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const bulkTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ posts, selectedId, globalChannels, globalPlatformSpecific, publishMode, timezone, scheduleAt, repeatFreq }));
    } catch {
      /* ignore */
    }
  }, [DRAFT_KEY, posts, selectedId, globalChannels, globalPlatformSpecific, publishMode, timezone, scheduleAt, repeatFreq]);

  const clearDraft = useCallback(() => {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
  }, [DRAFT_KEY]);

  const selected = posts.find((p) => p.id === selectedId) ?? posts[0];

  const patchPost = useCallback((id: string, patch: Partial<BulkPostDraft>) => {
    setPosts((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }, []);
  // Media accepts a functional updater so concurrent uploads compose against the latest
  // media for THIS post instead of clobbering each other (the MediaUploader race).
  const patchPostMedia = useCallback((id: string, update: MediaFile[] | ((prev: MediaFile[]) => MediaFile[])) => {
    setPosts((prev) => prev.map((x) => (x.id === id
      ? { ...x, media: typeof update === 'function' ? update(x.media) : update }
      : x)));
  }, []);
  const addPost = useCallback(() => {
    const d = newDraft();
    setPosts((prev) => [...prev, d]);
    setSelectedId(d.id);
  }, []);
  const duplicatePost = useCallback((id: string) => {
    setPosts((prev) => {
      const idx = prev.findIndex((x) => x.id === id);
      if (idx === -1) return prev;
      const copy = { ...prev[idx], id: uid() };
      setSelectedId(copy.id);
      return [...prev.slice(0, idx + 1), copy, ...prev.slice(idx + 1)];
    });
  }, []);
  const removePost = useCallback((id: string) => {
    setPosts((prev) => {
      if (prev.length <= 1) return prev;
      const idx = prev.findIndex((x) => x.id === id);
      const next = prev.filter((x) => x.id !== id);
      if (id === selectedId) setSelectedId((next[idx] ?? next[idx - 1] ?? next[0]).id);
      return next;
    });
  }, [selectedId]);

  const onCsvFile = useCallback((file: File) => {
    setCsvError(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const rows = parseCSV(String(reader.result || ''));
        if (rows.length < 2) { setCsvError('That CSV looks empty. Use the template as a guide.'); return; }
        const header = rows[0].map((h) => h.trim().toLowerCase());
        const ci = header.indexOf('content');
        const si = header.indexOf('scheduled_at');
        const mi = header.indexOf('media_urls');
        if (ci === -1) { setCsvError('CSV needs a "content" column.'); return; }
        const next = rows.slice(1).map((r) => {
          const d = newDraft((r[ci] ?? '').trim());
          if (si !== -1 && r[si]?.trim()) { d.customTime = true; d.scheduledAt = r[si].trim().slice(0, 16); }
          if (mi !== -1 && r[mi]?.trim()) { d.mediaUrls = r[mi].split(';').map((u) => u.trim()).filter(Boolean); }
          return d;
        }).filter((d) => d.content || d.mediaUrls.length > 0);
        if (next.length === 0) { setCsvError('No rows with content or media found.'); return; }
        // Append imported rows to the existing posts (dropping any blank placeholders).
        setPosts((prev) => [...prev.filter((p) => p.content.trim() || p.media.length > 0 || p.mediaUrls.length > 0), ...next]);
        setSelectedId(next[0].id);
      } catch {
        setCsvError('Could not read that CSV. Check the format and try again.');
      }
    };
    reader.readAsText(file);
  }, []);

  const effectiveChannels = useCallback((p: BulkPostDraft) => (p.customizeChannels ? p.channels : globalChannels), [globalChannels]);
  // Override posts carry their own full options; others inherit the "Apply to all" panel + their own title.
  const effectivePlatformSpecific = useCallback(
    (p: BulkPostDraft): PlatformSpecific => (p.customizeChannels ? p.platformSpecific : withPerPostTitle(globalPlatformSpecific, p, globalChannels)),
    [globalPlatformSpecific, globalChannels],
  );
  const isReady = useCallback((p: BulkPostDraft) => Boolean(p.content?.trim() || p.media?.length || p.mediaUrls?.length), []);
  const readyPosts = useMemo(() => posts.filter(isReady), [posts, isReady]);

  const blockers = useMemo(() => {
    const out: string[] = [];
    if (readyPosts.length === 0) out.push('Add text or media to at least one post.');
    if (readyPosts.some((p) => effectiveChannels(p).length === 0)) out.push('Every post needs at least one channel.');
    if (publishMode === 'schedule') {
      if (!scheduleAt) out.push('Pick a scheduled time.');
      if (readyPosts.some((p) => p.customTime && !p.scheduledAt)) out.push('Some posts are missing their custom time.');
    }
    // Platform-specific required fields (Pinterest board/title, YouTube title, etc.)
    for (const p of readyPosts) {
      const errs = validatePlatformOptions(effectiveChannels(p), effectivePlatformSpecific(p), undefined, { content: p.content ?? '' });
      if (errs.length > 0) { out.push(`Post ${posts.indexOf(p) + 1}: ${errs[0]}`); break; }
    }
    return out;
  }, [readyPosts, effectiveChannels, effectivePlatformSpecific, publishMode, scheduleAt, posts]);

  const submitLabel =
    publishMode === 'now' ? `Publish ${readyPosts.length} now`
    : publishMode === 'draft' ? `Save ${readyPosts.length} drafts`
    : publishMode === 'queue' ? `Add ${readyPosts.length} to queue`
    : `Schedule ${readyPosts.length} posts`;

  const handleSubmit = useCallback(async () => {
    if (blockers.length > 0 || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const status = publishMode === 'draft' ? 'draft' : 'scheduled';
      const repeatSchedule = repeatFreq !== 'none' ? { frequency: repeatFreq, timeOfDay: scheduleAt.split('T')[1] || '09:00', timezone } : undefined;
      const payload = {
        defaults: {
          channels: globalChannels.map((c) => ({ channelId: c.channelId, platform: c.platform })),
          timezone,
          status,
          useQueue: publishMode === 'queue',
          repeatSchedule,
        },
        posts: readyPosts.map((p) => {
          const ps = effectivePlatformSpecific(p);
          return {
            content: p.content,
            mediaFiles: p.media.map((m) => m.id),
            mediaUrls: p.mediaUrls.length > 0 ? p.mediaUrls : undefined,
            channels: p.customizeChannels ? p.channels.map((c) => ({ channelId: c.channelId, platform: c.platform })) : undefined,
            platformSpecific: Object.keys(ps).length > 0 ? ps : undefined,
            status,
            scheduledAt:
              publishMode === 'now' ? new Date().toISOString()
              : publishMode === 'queue' ? null
              : publishMode === 'schedule' ? wallTimeToISO(p.customTime ? p.scheduledAt : scheduleAt, timezone)
              : null,
          };
        }),
      };
      const res = await fetch('/api/posts/bulk-create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setSubmitError(data?.error?.message || 'Could not create posts. Please try again.'); return; }
      clearDraft();
      setDoneCount(data.count ?? readyPosts.length);
    } catch {
      setSubmitError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }, [blockers, submitting, publishMode, repeatFreq, scheduleAt, globalChannels, timezone, readyPosts, effectivePlatformSpecific, clearDraft]);

  /* ---- Success ---- */
  if (doneCount !== null) {
    return (
      <div style={styles.successBanner}>
        <span>✓ {publishMode === 'queue' ? 'Queued' : 'Created'} {doneCount} post{doneCount === 1 ? '' : 's'}.</span>
        <div style={{ display: 'flex', gap: '8px' }}>
          <a href="/calendar" className="btn btn-secondary">View in calendar</a>
          <button type="button" className="btn btn-ghost" onClick={() => { clearDraft(); setPosts([newDraft()]); setDoneCount(null); }}>Start over</button>
        </div>
      </div>
    );
  }

  const previewPlatforms = Array.from(new Set(effectiveChannels(selected).map((c) => c.platform))) as Platform[];
  const mediaUrls = selected.media.map((m) => m.originalPath).filter(Boolean);
  // First image available for vision captioning: an uploaded image, else a CSV image URL.
  const firstBulkImage =
    selected.media.find((m) => m.mimeType?.startsWith('image'))?.originalPath
    || selected.mediaUrls[0]
    || null;
  const selectedChannelsForPost = effectiveChannels(selected);
  const globalHasOptions = hasPlatformOptions(globalChannels);
  const perPostHasOptions = selected.customizeChannels && hasPlatformOptions(selected.channels);
  const showTitleField = selectedChannelsForPost.some((c) => c.platform === 'youtube' || c.platform === 'pinterest');
  const titleValue = selected.platformSpecific.youtube?.title || selected.platformSpecific.pinterest?.title || '';
  const onTitleChange = (t: string) => {
    const ps: PlatformSpecific = { ...selected.platformSpecific };
    if (selectedChannelsForPost.some((c) => c.platform === 'youtube')) {
      ps.youtube = { ...(ps.youtube ?? { title: '', privacyStatus: 'public', categoryId: '22', madeForKids: false, playlistId: '' }), title: t };
    }
    if (selectedChannelsForPost.some((c) => c.platform === 'pinterest')) {
      ps.pinterest = { ...(ps.pinterest ?? {}), title: t };
    }
    patchPost(selected.id, { platformSpecific: ps });
  };

  return (
    <div style={styles.page}>
      <div className="r-compose-row" style={styles.split}>
        <aside style={styles.listPanel}>
          {/* Posts */}
          <div style={styles.panelSection}>
            {/* Channels — at the top of the Posts card, above the POSTS label.
                Chips read left-to-right and wrap to a new row when they run out of space. */}
            <div style={styles.channelsRow}>
              <ChannelSelector selectedChannels={globalChannels} onChange={setGlobalChannels} />
            </div>
            <div style={styles.listHead}>
              <span style={styles.listHeadLabel}>Posts <span style={styles.listCount}>{posts.length}</span></span>
              <span style={styles.importHead}>
                <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) onCsvFile(f); e.target.value = ''; }} />
                <button type="button" style={styles.importLink} onClick={() => fileRef.current?.click()}>Import</button>
                <span
                  style={styles.infoIcon}
                  tabIndex={0}
                  aria-label="How CSV import works"
                  onMouseEnter={() => setShowTip(true)}
                  onMouseLeave={() => setShowTip(false)}
                  onFocus={() => setShowTip(true)}
                  onBlur={() => setShowTip(false)}
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="6.5" /><path d="M8 7.25v3.25" strokeLinecap="round" /><circle cx="8" cy="5" r="0.65" fill="currentColor" stroke="none" /></svg>
                  {showTip && (
                    <span style={styles.tipPop}>
                      Import posts from a CSV (content + scheduled time), appended to your list. <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(csvTemplate())}`} download="openpublish-template.csv" style={styles.tipLink}>Download template</a>
                    </span>
                  )}
                </span>
              </span>
            </div>
            <div style={styles.list}>
              {posts.map((post, i) => {
                const active = post.id === selectedId;
                const snippet = post.content.trim() ? post.content.trim().replace(/\s+/g, ' ').slice(0, 34) : 'Empty post';
                return (
                  <button key={post.id} type="button" onClick={() => setSelectedId(post.id)} style={{ ...styles.listRow, ...(active ? styles.listRowActive : {}) }}>
                    <span style={{ ...styles.listDot, background: isReady(post) ? 'var(--accent-500)' : 'var(--stone-300)' }} />
                    <span style={styles.listNum}>{i + 1}</span>
                    <span style={{ ...styles.listSnippet, color: post.content.trim() ? 'var(--stone-700)' : 'var(--stone-400)' }}>{snippet}</span>
                  </button>
                );
              })}
            </div>
            <button type="button" onClick={addPost} style={styles.addBtn}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="3" x2="8" y2="13" /><line x1="3" y1="8" x2="13" y2="8" /></svg>
              Add post
            </button>

            {csvError && <div style={styles.errorBanner}>{csvError}</div>}

            {/* Shared platform options live inside the Posts card, divided by the label.
                Title stays per-post in the composer; channel-override posts get their own panel. */}
            {globalHasOptions && (
              <div style={styles.applyAllBlock}>
                <span style={styles.applyAllHead}>Apply to all</span>
                <PlatformOptions
                  selectedChannels={globalChannels}
                  platformSpecific={globalPlatformSpecific}
                  onChange={setGlobalPlatformSpecific}
                  containerStyle={styles.applyAllOpts}
                />
              </div>
            )}
          </div>

          {/* Schedule — after the Add button */}
          <div style={styles.scheduleBlock}>
            <div style={styles.whenRow}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Select
                  aria-label="When to publish"
                  options={[
                    { value: 'now', label: 'Publish now' },
                    { value: 'draft', label: 'Save as drafts' },
                    { value: 'schedule', label: 'Schedule' },
                    { value: 'queue', label: 'Add to queue' },
                  ]}
                  value={publishMode}
                  onChange={(e) => setPublishMode(e.target.value as PublishMode)}
                  style={GREY}
                />
              </div>
              {publishMode === 'queue' && (
                <span
                  style={styles.infoIcon}
                  tabIndex={0}
                  aria-label="How the queue works"
                  onMouseEnter={() => setShowQueueTip(true)}
                  onMouseLeave={() => setShowQueueTip(false)}
                  onFocus={() => setShowQueueTip(true)}
                  onBlur={() => setShowQueueTip(false)}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="6.5" /><path d="M8 7.25v3.25" strokeLinecap="round" /><circle cx="8" cy="5" r="0.65" fill="currentColor" stroke="none" /></svg>
                  {showQueueTip && (
                    <span style={styles.tipPop}>Posts are added to your next open queue slots automatically.</span>
                  )}
                </span>
              )}
            </div>

            {publishMode === 'schedule' && (
              <>
                <Select aria-label="Timezone" options={TZ_OPTIONS} value={timezone} onChange={(e) => setTimezone(e.target.value)} style={GREY} />
                <input type="datetime-local" className="input" style={GREY} value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
              </>
            )}

            {(publishMode === 'schedule' || publishMode === 'queue') && (
              <Select
                aria-label="Repeat"
                options={REPEAT_OPTIONS}
                value={repeatFreq}
                onChange={(e) => setRepeatFreq(e.target.value as RepeatFreq)}
                style={GREY}
              />
            )}
          </div>

          {/* Publish action — in the sidebar, after the schedule controls */}
          <div style={styles.submitBlock}>
            {submitError && <div style={styles.errorBanner}>{submitError}</div>}
            <span style={styles.countText}>{blockers.length > 0 ? blockers[0] : `${readyPosts.length} post${readyPosts.length === 1 ? '' : 's'} ready`}</span>
            <button type="button" className="btn btn-primary" onClick={handleSubmit} disabled={blockers.length > 0 || submitting} style={{ width: '100%', ...(blockers.length > 0 || submitting ? { opacity: 0.5, cursor: 'not-allowed' } : null) }}>{submitting ? 'Working…' : submitLabel}</button>
          </div>
        </aside>

        <div style={styles.detail}>
          <div style={styles.detailHead}>
            <span style={styles.detailTitle}>Post {posts.findIndex((p) => p.id === selected.id) + 1}</span>
            <div style={{ display: 'flex', gap: '2px' }}>
              <button type="button" title="Duplicate post" onClick={() => duplicatePost(selected.id)} style={styles.iconBtn}>
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" /></svg>
              </button>
              <button type="button" title={posts.length > 1 ? 'Remove post' : 'At least one post is required'} onClick={() => removePost(selected.id)} disabled={posts.length <= 1} style={{ ...styles.iconBtn, opacity: posts.length <= 1 ? 0.4 : 1, cursor: posts.length <= 1 ? 'not-allowed' : 'pointer' }}>
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="4" x2="12" y2="12" /><line x1="12" y1="4" x2="4" y2="12" /></svg>
              </button>
            </div>
          </div>

          <div style={styles.composerCard}>
            {showTitleField && (
              <input type="text" value={titleValue} onChange={(e) => onTitleChange(e.target.value)} placeholder="Title*" maxLength={100} style={styles.titleInput} />
            )}
            <div style={{ position: 'relative' }}>
              <textarea
                ref={bulkTextareaRef}
                value={selected.content}
                onChange={(e) => patchPost(selected.id, { content: e.target.value })}
                placeholder={showTitleField ? 'Description' : "What's on your mind?"}
                style={{ ...styles.textarea, paddingRight: 52 }}
              />
            </div>
            <div style={styles.mediaWrap}><MediaUploader mediaFiles={selected.media} onChange={(update) => patchPostMedia(selected.id, update)} /></div>
          </div>

          {selected.mediaUrls.length > 0 && (
            <div style={styles.mediaUrlBlock}>
              <div style={styles.mediaUrlThumbs}>
                {selected.mediaUrls.map((url, i) => (
                  <div key={`${url}-${i}`} style={styles.mediaUrlThumb}>
                    <img src={url} alt="" loading="lazy" style={styles.mediaUrlThumbImg} />
                    <button
                      type="button"
                      title="Remove"
                      onClick={() => patchPost(selected.id, { mediaUrls: selected.mediaUrls.filter((_, idx) => idx !== i) })}
                      style={styles.mediaUrlThumbRemove}
                    >
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="4" x2="4" y2="12" /><line x1="4" y1="4" x2="12" y2="12" /></svg>
                    </button>
                  </div>
                ))}
              </div>
              <p style={styles.mediaUrlNote}>From your CSV: {selected.mediaUrls.length} image{selected.mediaUrls.length === 1 ? '' : 's'} downloaded into your library when you schedule.</p>
            </div>
          )}

          {/* Per-post overrides — each toggle on its own row, with its picker beside it */}
          <div style={styles.overrides}>
            <div className="r-bulk-override" style={styles.overrideRow}>
              <label style={styles.toggleRow}>
                <input type="checkbox" checked={selected.customizeChannels} onChange={(e) => patchPost(selected.id, { customizeChannels: e.target.checked, channels: e.target.checked && selected.channels.length === 0 ? globalChannels : selected.channels })} />
                <span>Use different channels for this post</span>
              </label>
              {selected.customizeChannels && (
                <div style={styles.pickerSlot}>
                  <ChannelSelector align="right" selectedChannels={selected.channels} onChange={(ch) => patchPost(selected.id, { channels: ch })} />
                </div>
              )}
            </div>

            {/* Per-post platform options — override the "Apply to all" panel for this post's channels */}
            {perPostHasOptions && (
              <PlatformOptions
                selectedChannels={selected.channels}
                platformSpecific={selected.platformSpecific}
                onChange={(ps) => patchPost(selected.id, { platformSpecific: ps })}
                containerStyle={styles.overridePlatformOpts}
              />
            )}

            {publishMode === 'schedule' && (
              <div className="r-bulk-override" style={styles.overrideRow}>
                <label style={styles.toggleRow}>
                  <input type="checkbox" checked={selected.customTime} onChange={(e) => patchPost(selected.id, { customTime: e.target.checked })} />
                  <span>Use a different time</span>
                </label>
                {selected.customTime && (
                  <input type="datetime-local" className="input" style={{ ...GREY, maxWidth: '240px' }} value={selected.scheduledAt} onChange={(e) => patchPost(selected.id, { scheduledAt: e.target.value })} />
                )}
              </div>
            )}
          </div>

          <div>
            <span className="label">Preview</span>
            <Suspense fallback={<div style={styles.previewLoading}>Loading preview…</div>}>
              <PostPreview content={selected.content} platforms={previewPlatforms} mediaUrl={mediaUrls[0] ?? null} mediaUrls={mediaUrls} mediaType={mediaTypeOf(selected.media[0])} />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { display: 'flex', flexDirection: 'column', gap: '20px', paddingBottom: '64px' },

  split: { display: 'grid', gridTemplateColumns: '300px 1fr', gap: '24px', alignItems: 'start' },
  listPanel: { display: 'flex', flexDirection: 'column', gap: '2px' },
  panelSection: { display: 'flex', flexDirection: 'column', gap: '2px', background: 'var(--surface-card)', padding: '12px', borderRadius: 'var(--radius-lg)' },
  scheduleBlock: { display: 'flex', flexDirection: 'column', gap: '2px' },
  whenRow: { display: 'flex', alignItems: 'center', gap: '6px' },

  channelsRow: { padding: '0 4px 12px', marginBottom: '10px', borderBottom: '1px solid var(--stone-150)' },
  listHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', padding: '0 4px', marginBottom: '12px' },
  listHeadLabel: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--stone-500)', textTransform: 'uppercase', letterSpacing: '0.04em' },
  listCount: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: '18px', height: '18px', padding: '0 5px', borderRadius: 'var(--radius-pill)', background: 'var(--stone-150)', color: 'var(--stone-500)', fontSize: '10px' },
  list: { display: 'flex', flexDirection: 'column', gap: '2px' },
  listRow: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '9px 10px', background: 'transparent', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', textAlign: 'left', transition: 'background 150ms ease' },
  listRowActive: { background: 'var(--stone-100)' },
  listDot: { width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0 },
  listNum: { fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--stone-400)', width: '14px', flexShrink: 0 },
  listSnippet: { fontSize: 'var(--text-sm)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  addBtn: { display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center', padding: '9px', marginTop: '2px', background: 'transparent', border: '1px dashed var(--stone-300)', borderRadius: 'var(--radius-md)', color: 'var(--stone-600)', fontSize: 'var(--text-sm)', fontWeight: 600, cursor: 'pointer' },
  importHead: { display: 'flex', alignItems: 'center', gap: '5px' },
  importLink: { background: 'transparent', border: 'none', padding: 0, color: 'var(--accent-600)', fontSize: 'var(--text-xs)', fontWeight: 600, textDecoration: 'none', cursor: 'pointer', fontFamily: 'inherit' },
  infoIcon: { position: 'relative', display: 'inline-flex', alignItems: 'center', color: 'var(--stone-400)', cursor: 'help' },
  tipPop: { position: 'absolute', top: '100%', right: 0, width: '210px', padding: '10px 12px', background: 'var(--surface-main)', border: '1px solid var(--stone-200)', borderRadius: 'var(--radius-md)', boxShadow: '0 10px 30px -10px rgba(0,0,0,0.18)', fontSize: 'var(--text-xs)', fontWeight: 400, textTransform: 'none', letterSpacing: 'normal', color: 'var(--stone-600)', lineHeight: 1.5, zIndex: 50, textAlign: 'left' },
  tipLink: { color: 'var(--accent-600)', textDecoration: 'underline', fontWeight: 600, whiteSpace: 'nowrap' },

  detail: { display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0 },
  detailHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  detailTitle: { fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--stone-800)' },
  iconBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '30px', height: '30px', background: 'transparent', border: 'none', borderRadius: 'var(--radius-sm)', color: 'var(--stone-400)', cursor: 'pointer' },

  composerCard: { background: 'var(--surface-card)', borderRadius: 'var(--radius-lg)', display: 'flex', flexDirection: 'column' },
  titleInput: { width: '100%', padding: '14px 20px 0', fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--stone-900)', background: 'transparent', border: 'none', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' },
  textarea: { width: '100%', minHeight: '140px', padding: '16px 20px', fontSize: 'var(--text-md)', lineHeight: 'var(--leading-relaxed)', color: 'var(--stone-800)', background: 'transparent', border: 'none', outline: 'none', resize: 'none', fontFamily: 'inherit', boxSizing: 'border-box' },
  mediaWrap: { padding: '0 16px 16px' },
  mediaUrlBlock: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '0 4px' },
  mediaUrlThumbs: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
  mediaUrlThumb: { position: 'relative', width: '72px', height: '72px', borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--stone-200)', background: 'var(--stone-100)' },
  mediaUrlThumbImg: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  mediaUrlThumbRemove: { position: 'absolute', top: '3px', right: '3px', width: '18px', height: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff', cursor: 'pointer', padding: 0 },
  mediaUrlNote: { fontSize: 'var(--text-xs)', color: 'var(--stone-500)', margin: 0 },
  overrides: { display: 'flex', flexDirection: 'column', gap: '10px' },
  overrideRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px' },
  overridePlatformOpts: { padding: 0, gap: '10px' },
  pickerSlot: { minWidth: 0 },
  toggleRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-sm)', color: 'var(--stone-600)', cursor: 'pointer', flexShrink: 0 },

  applyAllBlock: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '14px' },
  applyAllHead: { fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--stone-500)', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '0 4px' },
  applyAllOpts: { padding: 0, gap: '10px' },
  previewLoading: { padding: '40px', textAlign: 'center', color: 'var(--stone-400)', fontSize: 'var(--text-sm)' },

  submitBlock: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' },
  countText: { fontSize: 'var(--text-sm)', color: 'var(--stone-500)' },
  errorBanner: { padding: '12px 16px', borderRadius: 'var(--radius-md)', background: 'var(--color-error-bg)', color: '#B91C1C', fontSize: 'var(--text-sm)', fontWeight: 500 },
  successBanner: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', padding: '14px 16px', borderRadius: 'var(--radius-md)', background: 'var(--color-success-bg)', color: '#166534', fontSize: 'var(--text-sm)', fontWeight: 500 },
};
