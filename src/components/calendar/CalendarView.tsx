import React, { useState, useEffect, useMemo, useCallback, useRef, type CSSProperties } from 'react';
import { mediaImageUrl } from '@lib/media/display';
import { createPortal } from 'react-dom';
import { CalendarCard, type CalendarPost } from './CalendarCard';
import { StatusFilter } from '../posts/StatusFilter';
import { Spinner } from '../ui/Spinner';
import { useApi } from '@lib/swr';
import { PlatformIcon } from '../channels/PlatformIcon';
import { useQueryState } from '@lib/useQueryState';

const DAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const HOURS = Array.from({ length: 24 }, (_, i) => i);

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Local day start (00:00:00.000) → UTC ISO string */
function toLocalDayStartUTC(d: Date): string {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).toISOString();
}

/** Local day end (23:59:59.999) → UTC ISO string */
function toLocalDayEndUTC(d: Date): string {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).toISOString();
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

interface DayCell {
  date: Date;
  dateKey: string;
  inMonth: boolean;
}

function getCalendarDays(year: number, month: number): DayCell[] {
  const first = new Date(year, month, 1);
  const startDay = (first.getDay() + 6) % 7; // Monday-based
  const cells: DayCell[] = [];

  for (let i = startDay - 1; i >= 0; i--) {
    const d = new Date(year, month, -i);
    cells.push({ date: d, dateKey: toDateKey(d), inMonth: false });
  }

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month, day);
    cells.push({ date: d, dateKey: toDateKey(d), inMonth: true });
  }

  while (cells.length % 7 !== 0) {
    const last = cells[cells.length - 1].date;
    const next = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
    cells.push({ date: next, dateKey: toDateKey(next), inMonth: false });
  }

  return cells;
}

function groupPostsByDate(posts: CalendarPost[]): Map<string, CalendarPost[]> {
  const map = new Map<string, CalendarPost[]>();
  for (const post of posts) {
    const d = new Date(post.scheduled_at);
    const key = toDateKey(d);
    const arr = map.get(key) ?? [];
    arr.push(post);
    map.set(key, arr);
  }
  for (const [, arr] of map) {
    arr.sort((a, b) => new Date(b.scheduled_at).getTime() - new Date(a.scheduled_at).getTime());
  }
  return map;
}

function groupPostsByHour(posts: CalendarPost[]): Map<number, CalendarPost[]> {
  const map = new Map<number, CalendarPost[]>();
  for (const post of posts) {
    const hour = new Date(post.scheduled_at).getHours();
    const arr = map.get(hour) ?? [];
    arr.push(post);
    map.set(hour, arr);
  }
  for (const [, arr] of map) {
    arr.sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
  }
  return map;
}

/* ------------------------------------------------------------------ */
/*  Recurring-schedule ghost occurrences                                */
/* ------------------------------------------------------------------ */

interface GhostOccurrence {
  scheduleId: number;
  name: string;
  at: Date;
}

/**
 * A future run of a repeat schedule. Deliberately NOT a CalendarCard: no post
 * exists yet, so there is nothing to open, drag, or hover — the dashed border
 * says "planned, not created". Clicking goes to the schedule's management
 * surface instead.
 */
function GhostChip({ ghost, variant }: { ghost: GhostOccurrence; variant?: 'day' }) {
  const timeStr = ghost.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div
      title={`Repeat schedule "${ghost.name}" runs at ${timeStr}. Click to manage repeat schedules.`}
      onClick={(e) => { e.stopPropagation(); window.location.href = '/repeat-posts'; }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: variant === 'day' ? '6px 8px' : '1px 4px',
        borderRadius: 6,
        border: '1px dashed var(--stone-300)',
        background: 'transparent',
        cursor: 'pointer',
        overflow: 'hidden',
        minWidth: 0,
      }}
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="var(--stone-400)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
        <polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
      </svg>
      <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--stone-400)', flexShrink: 0 }}>{timeStr}</span>
      <span style={{ fontSize: 9, color: 'var(--stone-400)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {ghost.name}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Single-post rendering (shared by day view & PostHoverPopover)      */
/* ------------------------------------------------------------------ */

function PostCard({ post, onClick }: { post: CalendarPost; onClick: (post: CalendarPost) => void }) {
  const [imgError, setImgError] = React.useState(false);
  const firstMedia = post.media?.[0];
  const thumbUrl = firstMedia && !imgError ? mediaImageUrl(firstMedia, 'thumb') : null;
  const isVideo = firstMedia?.mimeType?.startsWith('video');
  const mediaCount = post.media?.length ?? 0;

  const timeStr = new Date(post.scheduled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div
      style={{ display: 'flex', gap: 10, background: 'var(--stone-50)', borderRadius: 8, padding: '10px 12px', cursor: 'pointer', transition: 'background 150ms ease' }}
      onMouseOver={(e) => { e.currentTarget.style.background = 'var(--stone-100)'; }}
      onMouseOut={(e) => { e.currentTarget.style.background = 'var(--stone-50)'; }}
      onClick={() => onClick(post)}
    >
      {/* Thumbnail */}
      <div style={{ width: 44, height: 44, borderRadius: 8, overflow: 'hidden', background: 'var(--stone-100)', flexShrink: 0, position: 'relative', alignSelf: 'flex-start', marginTop: 1 }}>
        {thumbUrl ? (
          <>
            <img src={thumbUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} onError={() => setImgError(true)} />
            {isVideo && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.28)' }}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="#fff"><polygon points="3,1.5 10.5,6 3,10.5" /></svg>
              </div>
            )}
            {mediaCount > 1 && (
              <div style={{ position: 'absolute', bottom: 3, right: 3, background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: 9, fontWeight: 700, padding: '1px 4px', borderRadius: 4 }}>
                +{mediaCount - 1}
              </div>
            )}
          </>
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--stone-300)', lineHeight: 1 }}>T</span>
          </div>
        )}
      </div>

      {/* Content area */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Row 1: content (post status is conveyed by the per-platform dots below) */}
        {post.content && (
          <p style={{ fontSize: 12, fontWeight: 500, color: '#44403C', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', margin: '0 0 6px' } as React.CSSProperties}>
            {post.content}
          </p>
        )}

        {/* Row 2: time + platform icons with per-platform status dots */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 500, color: '#A8A29E' }}>{timeStr}</span>
          {post.channels.length > 0 && (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              {post.channels.map((ch, idx) => {
                const dotColor =
                  ch.status === 'published' ? '#10B981' :
                  ch.status === 'failed' ? '#EF4444' :
                  ch.status === 'publishing' || ch.status === 'processing' ? '#3B82F6' :
                  ch.status === 'pending' ? '#F59E0B' : '#D6D3D1';
                const hasUrl = ch.status === 'published' && ch.platformUrl;
                const Wrapper = hasUrl ? 'a' : 'div';
                return (
                  <Wrapper
                    key={idx}
                    {...(hasUrl ? { href: ch.platformUrl, target: '_blank', rel: 'noopener noreferrer', onClick: (e: React.MouseEvent) => e.stopPropagation() } : {})}
                    style={{ position: 'relative', flexShrink: 0, textDecoration: 'none' }}
                    title={
                      ch.status === 'failed' && ch.errorMessage
                        ? `${ch.platform}: failed. ${ch.errorMessage}`
                        : ch.status === 'published' && !ch.platformUrl
                          ? `${ch.platform}: published (no link available)`
                          : `${ch.platform}${ch.status ? ': ' + ch.status : ''}`
                    }
                  >
                    <PlatformIcon platform={ch.platform} size="xs" />
                    <div style={{ position: 'absolute', bottom: -1, right: -1, width: 6, height: 6, borderRadius: '50%', background: dotColor, border: '1px solid #fff' }} />
                  </Wrapper>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Post Hover Popover (single post, triggered on card hover)          */
/* ------------------------------------------------------------------ */

const PostHoverPopover = React.forwardRef<HTMLDivElement, {
  post: CalendarPost;
  anchorRect: DOMRect;
  onPostClick: (post: CalendarPost) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}>(({ post, anchorRect, onPostClick, onMouseEnter, onMouseLeave }, ref) => {
  const POPOVER_W = 280;
  const GAP = 6;
  const vH = window.innerHeight;
  const vW = window.innerWidth;

  const spaceBelow = vH - anchorRect.bottom - GAP;
  const spaceAbove = anchorRect.top - GAP;
  const showBelow = spaceBelow >= 120 || spaceBelow >= spaceAbove;

  let left = anchorRect.left + anchorRect.width / 2 - POPOVER_W / 2;
  left = Math.max(12, Math.min(left, vW - POPOVER_W - 12));

  const arrowLeft = Math.max(16, Math.min(anchorRect.left + anchorRect.width / 2 - left, POPOVER_W - 16));

  const posStyle: CSSProperties = showBelow
    ? { top: anchorRect.bottom + GAP }
    : { bottom: vH - anchorRect.top + GAP };

  return (
    <div
      ref={ref}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: 'fixed',
        ...posStyle,
        left,
        width: POPOVER_W,
        zIndex: 10001,
        background: '#fff',
        borderRadius: '10px',
        border: '2px solid var(--accent-50)',
        padding: '8px',
        fontFamily: "'DM Sans', system-ui, sans-serif",
        animation: 'popoverIn 120ms cubic-bezier(0.2, 0, 0.13, 1.5) both',
      }}
    >
      {/* Arrow */}
      <div style={{
        position: 'absolute',
        ...(showBelow ? { top: -6 } : { bottom: -6 }),
        left: arrowLeft - 5,
        width: 10,
        height: 10,
        background: '#fff',
        borderRadius: 2,
        transform: 'rotate(45deg)',
        border: '2px solid var(--accent-50)',
        ...(showBelow
          ? { borderBottom: 'none', borderRight: 'none' }
          : { borderTop: 'none', borderLeft: 'none' }),
        zIndex: -1,
      }} />
      <PostCard post={post} onClick={onPostClick} />
    </div>
  );
});

PostHoverPopover.displayName = 'PostHoverPopover';

/* ------------------------------------------------------------------ */
/*  Main Component                                                      */
/* ------------------------------------------------------------------ */

export default function CalendarView() {
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  // posts, loading, error — defined after SWR hook below
  const [filterParam, setFilterParam] = useQueryState<string>('filter', '');
  // The Overview cards and hand-typed URLs use ?status= (the API's param
  // name); the calendar's own chips write ?filter=. Adopt ?status= once on
  // mount as the initial filter — it was silently ignored before.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const legacyStatus = params.get('status');
    if (legacyStatus && !params.get('filter')) {
      // Drop ?status= before writing ?filter= so clearing the filter later
      // doesn't resurrect it on reload.
      const url = new URL(window.location.href);
      url.searchParams.delete('status');
      window.history.replaceState({}, '', url.toString());
      setFilterParam(legacyStatus);
    }
  }, []);
  const statusFilter = filterParam || null;
  const setStatusFilter = (v: string | null) => setFilterParam(v ?? '');

  // View mode: month grid or day timeline
  const [viewMode, setViewMode] = useQueryState<string>('mode', 'month');
  const [selectedDate, setSelectedDate] = useQueryState<string>('date', '');

  // Hover popover state
  const [hoverPost, setHoverPost] = useState<CalendarPost | null>(null);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverGraceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverPopoverRef = useRef<HTMLDivElement>(null);
  const isOverPopoverRef = useRef(false);

  // Drag-and-drop rescheduling state
  const [dragPostId, setDragPostId] = useState<string | null>(null);
  const [dragOverDateKey, setDragOverDateKey] = useState<string | null>(null);
  const [dragOverHour, setDragOverHour] = useState<number | null>(null);

  const timelineRef = useRef<HTMLDivElement>(null);

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const today = new Date();

  const calendarDays = useMemo(() => getCalendarDays(year, month), [year, month]);

  // Build SWR key from calendar range + filter
  const _firstVisible = calendarDays[0].date;
  const _lastVisible = calendarDays[calendarDays.length - 1].date;

  const _calParams = useMemo(() => {
    const params = new URLSearchParams({ limit: '500' });
    if (viewMode === 'day' && selectedDate) {
      const d = new Date(selectedDate + 'T00:00:00');
      params.set('scheduledFrom', toLocalDayStartUTC(d));
      params.set('scheduledTo', toLocalDayEndUTC(d));
    } else {
      params.set('scheduledFrom', toLocalDayStartUTC(_firstVisible));
      params.set('scheduledTo', toLocalDayEndUTC(_lastVisible));
    }
    if (statusFilter) params.set('status', statusFilter);
    return params.toString();
  }, [viewMode, selectedDate, _firstVisible, _lastVisible, statusFilter]);

  const [_pollInterval, _setPollInterval] = useState(0);
  const { data: _rawCal, error: _calErr, isLoading: loading, mutate: mutatePosts } = useApi<any>(
    `/api/posts?${_calParams}`,
    { refreshInterval: _pollInterval },
  );
  const error = _calErr?.message ?? null;

  const posts: CalendarPost[] = useMemo(() => {
    if (!_rawCal) return [];
    const rawPosts = _rawCal.posts ?? _rawCal ?? [];
    return rawPosts.map((p: any) => ({
      id: p.id,
      content: p.content || '',
      scheduled_at: p.scheduledAt || p.scheduled_at || p.publishedAt || p.createdAt,
      status: p.status,
      approvalStatus: p.approvalStatus,
      channels: (p.postPlatforms || p.channels || []).map((pp: any) => ({ platform: pp.platform, status: pp.status, platformUrl: pp.platformUrl, errorMessage: pp.errorMessage })),
      media: (p.mediaFiles || []).map((m: any) => ({ mimeType: m.mimeType, thumbnailUrl: m.thumbnailUrl, previewUrl: m.previewUrl, largeUrl: m.largeUrl, originalUrl: m.originalUrl })),
    }));
  }, [_rawCal]);

  // Toggle polling when posts are in publishing/processing state
  useEffect(() => {
    const hasInProgress = posts.some(
      (p) => p.status === 'publishing' || p.status === 'processing',
    );
    _setPollInterval(hasInProgress ? 5000 : 0);
  }, [posts]);

  // Escape key returns to month view
  useEffect(() => {
    if (viewMode !== 'day') return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') navigateToMonth();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [viewMode, selectedDate]);

  // Auto-scroll timeline to first post's hour (or 8AM)
  useEffect(() => {
    if (viewMode !== 'day' || !timelineRef.current || loading || !selectedDate) return;
    const filtered = posts.filter((p) => toDateKey(new Date(p.scheduled_at)) === selectedDate);
    const byHour = groupPostsByHour(filtered);
    let targetHour = 8;
    for (let h = 0; h < 24; h++) {
      if (byHour.has(h)) { targetHour = h; break; }
    }
    const hourEl = timelineRef.current.querySelector(`[data-hour="${targetHour}"]`);
    if (hourEl) hourEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [viewMode, loading, posts, selectedDate]);

  // Hover popover handlers — wrapped in useCallback so memoized CalendarCards
  // don't re-render on every CalendarView state change (hover, polling, etc).
  const clearHoverTimers = useCallback(() => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    if (hoverGraceRef.current) { clearTimeout(hoverGraceRef.current); hoverGraceRef.current = null; }
  }, []);

  const dismissHover = useCallback(() => {
    clearHoverTimers();
    setHoverPost(null);
    setHoverRect(null);
    isOverPopoverRef.current = false;
  }, [clearHoverTimers]);

  // dragPostId read via ref so the handler ref stays stable while not dragging.
  const dragPostIdRef = useRef<string | null>(null);
  useEffect(() => { dragPostIdRef.current = dragPostId; }, [dragPostId]);

  const handleCardHoverStart = useCallback((post: CalendarPost, rect: DOMRect) => {
    if (dragPostIdRef.current) return;
    clearHoverTimers();
    hoverTimerRef.current = setTimeout(() => {
      setHoverPost(post);
      setHoverRect(rect);
    }, 400);
  }, [clearHoverTimers]);

  const handleCardHoverEnd = useCallback(() => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    hoverGraceRef.current = setTimeout(() => {
      if (!isOverPopoverRef.current) {
        setHoverPost(null);
        setHoverRect(null);
      }
    }, 150);
  }, []);

  const handleHoverPopoverEnter = useCallback(() => {
    isOverPopoverRef.current = true;
    if (hoverGraceRef.current) { clearTimeout(hoverGraceRef.current); hoverGraceRef.current = null; }
  }, []);

  const handleHoverPopoverLeave = useCallback(() => {
    isOverPopoverRef.current = false;
    setHoverPost(null);
    setHoverRect(null);
  }, []);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => clearHoverTimers();
  }, []);

  // Repeat-schedule ghost occurrences were removed with the automations
  // feature; the maps stay so the render paths below stay simple.
  const ghostsByDate = useMemo(() => new Map<string, GhostOccurrence[]>(), []);

  const postsByDate = useMemo(() => groupPostsByDate(posts), [posts]);
  // In day view, filter to posts whose local date matches selectedDate
  // (the API query is padded ±1 day for timezone safety)
  const dayViewPosts = useMemo(() => {
    if (viewMode !== 'day' || !selectedDate) return posts;
    return posts.filter((p) => toDateKey(new Date(p.scheduled_at)) === selectedDate);
  }, [posts, viewMode, selectedDate]);
  const postsByHour = useMemo(() => groupPostsByHour(dayViewPosts), [dayViewPosts]);
  const dayGhosts = viewMode === 'day' && selectedDate ? ghostsByDate.get(selectedDate) ?? [] : [];
  const ghostsByHour = useMemo(() => {
    const map = new Map<number, GhostOccurrence[]>();
    for (const g of dayGhosts) {
      const arr = map.get(g.at.getHours()) ?? [];
      arr.push(g);
      map.set(g.at.getHours(), arr);
    }
    return map;
  }, [dayGhosts]);
  const numWeeks = calendarDays.length / 7;

  // ---- Month navigation ----

  function prevMonth() {
    setCurrentMonth(new Date(year, month - 1, 1));
  }

  function nextMonth() {
    setCurrentMonth(new Date(year, month + 1, 1));
  }

  // ---- Day navigation ----

  function navigateToDay(dateKey: string) {
    dismissHover();
    setSelectedDate(dateKey);
    setViewMode('day');
  }

  function navigateToMonth() {
    if (selectedDate) {
      const d = new Date(selectedDate + 'T00:00:00');
      setCurrentMonth(new Date(d.getFullYear(), d.getMonth(), 1));
    }
    setViewMode('month');
    setSelectedDate('');
    setDragOverHour(null);
  }

  function prevDay() {
    if (!selectedDate) return;
    const d = new Date(selectedDate + 'T00:00:00');
    d.setDate(d.getDate() - 1);
    setSelectedDate(toDateKey(d));
  }

  function nextDay() {
    if (!selectedDate) return;
    const d = new Date(selectedDate + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    setSelectedDate(toDateKey(d));
  }

  function handleDayClick(dateKey: string, _e: React.MouseEvent<HTMLDivElement>) {
    if (dragPostId) return;
    navigateToDay(dateKey);
  }

  const handlePostClick = useCallback((post: CalendarPost) => {
    if (post.status === 'published' || post.status === 'partial') {
      window.location.href = `/analytics?tab=posts&post=${post.id}`;
    } else {
      window.location.href = `/compose?edit=${post.id}`;
    }
  }, []);

  // ---- Drag-and-drop rescheduling (shared) ----

  function isDropAllowed(dateKey: string): boolean {
    return dateKey >= toDateKey(new Date());
  }

  const handleCardDragStart = useCallback((post: CalendarPost) => {
    dismissHover();
    setDragPostId(String(post.id));
  }, [dismissHover]);

  const handleCardDragEnd = useCallback(() => {
    setDragPostId(null);
    setDragOverDateKey(null);
    setDragOverHour(null);
  }, []);

  // Month view: drop on a different date (keep time, change date)
  async function handlePostDrop(targetDateKey: string) {
    const postId = dragPostId;
    setDragPostId(null);
    setDragOverDateKey(null);
    if (!postId || !isDropAllowed(targetDateKey)) return;

    const post = posts.find((p) => String(p.id) === String(postId));
    if (!post) return;

    const originalDate = new Date(post.scheduled_at);
    const originalDateKey = toDateKey(originalDate);
    if (originalDateKey === targetDateKey) return;

    const [y, m, d] = targetDateKey.split('-').map(Number);
    const newScheduledAt = new Date(originalDate);
    newScheduledAt.setFullYear(y, m - 1, d);
    const iso = newScheduledAt.toISOString();

    const prev = _rawCal;
    mutatePosts((cur: any) => {
      if (!cur) return cur;
      const arr = cur.posts ?? cur ?? [];
      const updated = arr.map((p: any) =>
        String(p.id) === String(postId) ? { ...p, scheduledAt: iso, scheduled_at: iso } : p
      );
      return cur.posts ? { ...cur, posts: updated } : updated;
    }, { revalidate: false });

    try {
      const res = await fetch(`/api/posts/${postId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduledAt: iso }),
      });
      if (!res.ok) throw new Error();
      mutatePosts(undefined, { revalidate: true });
    } catch {
      mutatePosts(prev, { revalidate: false });
    }
  }

  // Day view: drop on a different hour (keep date+minutes, change hour)
  async function handleDayViewPostDrop(targetHour: number) {
    const postId = dragPostId;
    setDragPostId(null);
    setDragOverHour(null);
    if (!postId || !selectedDate) return;
    if (!isDropAllowed(selectedDate)) return;

    const post = posts.find((p) => String(p.id) === String(postId));
    if (!post) return;

    const originalDate = new Date(post.scheduled_at);
    if (originalDate.getHours() === targetHour) return; // same hour = no-op

    const [y, m, d] = selectedDate.split('-').map(Number);
    const newScheduledAt = new Date(originalDate);
    newScheduledAt.setFullYear(y, m - 1, d);
    newScheduledAt.setHours(targetHour);
    const iso = newScheduledAt.toISOString();

    const prev = _rawCal;
    mutatePosts((cur: any) => {
      if (!cur) return cur;
      const arr = cur.posts ?? cur ?? [];
      const updated = arr.map((p: any) =>
        String(p.id) === String(postId) ? { ...p, scheduledAt: iso, scheduled_at: iso } : p
      );
      return cur.posts ? { ...cur, posts: updated } : updated;
    }, { revalidate: false });

    try {
      const res = await fetch(`/api/posts/${postId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduledAt: iso }),
      });
      if (!res.ok) throw new Error();
      mutatePosts(undefined, { revalidate: true });
    } catch {
      mutatePosts(prev, { revalidate: false });
    }
  }

  const dayDropAllowed = selectedDate ? isDropAllowed(selectedDate) : false;

  // ---- Formatted date for day header ----
  const dayHeaderLabel = selectedDate
    ? new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : '';

  return (
    <div style={{ height: '100%', animation: 'fadeInUp 500ms cubic-bezier(0.4, 0, 0.2, 1) both', display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {/* Status filter + navigation row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', gap: '12px', flexWrap: 'wrap' }}>
          <StatusFilter value={statusFilter} onChange={setStatusFilter} />

          {viewMode === 'month' ? (
            /* Month picker */
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button type="button" style={navBtnStyle} onClick={prevMonth} aria-label="Previous month">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="10 4 6 8 10 12" />
                </svg>
              </button>

              <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--stone-900)', minWidth: '160px', textAlign: 'center', margin: 0 }}>
                {MONTH_NAMES[month]} {year}
              </h2>

              <button type="button" style={navBtnStyle} onClick={nextMonth} aria-label="Next month">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 4 10 8 6 12" />
                </svg>
              </button>
            </div>
          ) : (
            /* Day picker: back + date + prev/next */
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                type="button"
                style={{ ...navBtnStyle, width: 'auto', padding: '0 12px', gap: '6px', display: 'inline-flex', alignItems: 'center', fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--stone-500)' }}
                onClick={navigateToMonth}
                aria-label="Back to month"
                data-testid="back-to-month"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="10 4 6 8 10 12" />
                </svg>
                Back
              </button>

              <button type="button" style={navBtnStyle} onClick={prevDay} aria-label="Previous day">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="10 4 6 8 10 12" />
                </svg>
              </button>

              <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--stone-900)', minWidth: '220px', textAlign: 'center', margin: 0 }}>
                {dayHeaderLabel}
              </h2>

              <button type="button" style={navBtnStyle} onClick={nextDay} aria-label="Next day">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 4 10 8 6 12" />
                </svg>
              </button>
            </div>
          )}
        </div>

        {/* Content area */}
        <div style={{ background: 'var(--stone-100)', borderRadius: 'var(--radius-lg)', padding: '16px', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* Loading / Error */}
          {loading && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
              <Spinner size="lg" />
            </div>
          )}

          {error && (
            <div style={{ padding: '16px', background: 'var(--color-error-bg)', color: '#991B1B', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-sm)', marginBottom: '16px' }}>
              {error}
              <button className="btn btn-ghost btn-sm" onClick={() => mutatePosts()} style={{ marginLeft: '12px', color: '#991B1B', textDecoration: 'underline' }}>Retry</button>
            </div>
          )}

          {!loading && !error && viewMode === 'month' && (
            <>
              {/* Day headers */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', marginBottom: '12px' }}>
                {DAY_HEADERS.map((day, i) => (
                  <div key={day} style={{ padding: '6px 4px', fontSize: 'var(--text-xs)', fontWeight: 600, color: i >= 5 ? '#D97706' : 'var(--stone-400)', textTransform: 'uppercase' as const, letterSpacing: 'var(--tracking-wider)', textAlign: 'center' }}>
                    {day}
                  </div>
                ))}
              </div>

              {/* Calendar grid */}
              {/* A 6-week month's rows are content-sized ('auto'), so the grid is
                  taller than the flex space it is given. Without its own scroll
                  box those extra rows painted *outside* the grey card. minHeight
                  keeps flex from refusing to shrink it. */}
              {/*
                The SCROLLER is this wrapper, not the grid. A grid that is itself
                the flex child (`flex: 1`) has a DEFINITE height, and definite
                height + `auto` rows means the tracks get shrunk to min-content —
                90px, the cell's own min-height — while a full day cell needs 110
                (22px date + three chips + the "+N more" line). That is what
                clipped the last chip and swallowed the cell's 4px bottom padding,
                leaving padding on the sides and none underneath.

                Auto height here instead, so rows size to their content; the
                minHeight:100% keeps a sparse month filling the card rather than
                leaving a gap under the last week, and `auto` rows still stretch
                into that spare space.
              */}
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gridAutoRows: 'auto', minHeight: '100%', gap: '3px' }}>
                {calendarDays.map((cell) => {
                  const isToday = isSameDay(cell.date, today);
                  const dayPosts = postsByDate.get(cell.dateKey) ?? [];

                  const dropAllowed = isDropAllowed(cell.dateKey);
                  const isDragOver = dragPostId && dragOverDateKey === cell.dateKey;

                  return (
                    <div
                      key={cell.dateKey}
                      data-datekey={cell.dateKey}
                      style={{
                        minHeight: '90px',
                        padding: '4px',
                        borderRadius: '8px',
                        background: isDragOver && dropAllowed
                          ? 'var(--accent-50)'
                          : cell.inMonth ? '#FFFFFF' : 'var(--stone-50)',
                        cursor: dragPostId ? (dropAllowed ? 'default' : 'not-allowed') : 'pointer',
                        transition: 'background var(--transition-fast), opacity var(--transition-fast)',
                        overflow: 'hidden',
                        display: 'flex',
                        flexDirection: 'column',
                        opacity: dragPostId && !dropAllowed ? 0.4 : cell.inMonth ? 1 : 0.7,
                        ...(isDragOver && dropAllowed ? { outline: '2px dashed var(--accent-400)', outlineOffset: '-2px' } : {}),
                      }}
                      onClick={(e) => handleDayClick(cell.dateKey, e)}
                      onDragOver={(e) => {
                        if (!dragPostId) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = dropAllowed ? 'move' : 'none';
                        setDragOverDateKey(cell.dateKey);
                      }}
                      onDragLeave={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverDateKey(null);
                      }}
                      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handlePostDrop(cell.dateKey); }}
                    >
                      {/* Date number */}
                      <span style={{
                        fontSize: 'var(--text-sm)',
                        fontWeight: isToday ? 700 : 500,
                        color: isToday ? '#FFFFFF' : cell.inMonth ? 'var(--stone-700)' : 'var(--stone-400)',
                        width: '22px',
                        height: '22px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '50%',
                        background: isToday ? 'var(--accent-600)' : 'transparent',
                        flexShrink: 0,
                        marginBottom: dayPosts.length > 0 ? '3px' : 0,
                      }}>
                        {cell.date.getDate()}
                      </span>

                      {/* Posts full-width below date */}
                      {dayPosts.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', width: '100%' }}>
                          {dayPosts.slice(0, 3).map((post) => (
                            <CalendarCard
                              key={post.id}
                              post={post}
                              onClick={handlePostClick}
                              onHoverStart={handleCardHoverStart}
                              onHoverEnd={handleCardHoverEnd}
                              isDragging={dragPostId === String(post.id)}
                              onDragStart={handleCardDragStart}
                              onDragEnd={handleCardDragEnd}
                            />
                          ))}
                          {dayPosts.length > 3 && (
                            <span style={{ fontSize: '9px', color: 'var(--stone-400)', fontWeight: 600, paddingLeft: '2px', cursor: 'pointer' }}>
                              +{dayPosts.length - 3} more
                            </span>
                          )}
                        </div>
                      )}

                      {/* Upcoming repeat-schedule runs — planned, no post yet. */}
                      {(() => {
                        const ghosts = ghostsByDate.get(cell.dateKey) ?? [];
                        if (ghosts.length === 0) return null;
                        const GHOST_LIMIT = dayPosts.length > 0 ? 2 : 3;
                        return (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', width: '100%', marginTop: dayPosts.length > 0 ? '2px' : 0 }}>
                            {ghosts.slice(0, GHOST_LIMIT).map((g) => (
                              <GhostChip key={`${g.scheduleId}-${g.at.getTime()}`} ghost={g} />
                            ))}
                            {ghosts.length > GHOST_LIMIT && (
                              <span style={{ fontSize: '9px', color: 'var(--stone-400)', fontWeight: 600, paddingLeft: '2px' }}>
                                +{ghosts.length - GHOST_LIMIT} repeats
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
              </div>
            </>
          )}

          {/* ---- Day View: 24-hour timeline ---- */}
          {!loading && !error && viewMode === 'day' && (
            <div
              ref={timelineRef}
              data-testid="day-view-timeline"
              style={{ overflowY: 'auto', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', paddingTop: '20px' }}
            >
              {dayViewPosts.length === 0 && dayGhosts.length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, minHeight: '300px', color: 'var(--stone-400)' }}>
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: '12px', opacity: 0.5 }}>
                    <rect x="3" y="4" width="18" height="18" rx="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                  <p style={{ fontSize: 'var(--text-sm)', margin: 0 }}>No posts for this day</p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {HOURS.map((hour) => {
                    const hourPosts = postsByHour.get(hour) ?? [];
                    const hourGhosts = ghostsByHour.get(hour) ?? [];
                    const isHourDragOver = dragPostId && dragOverHour === hour;

                    // Assign columns for posts in this hour
                    const COL_WIDTH = 180;
                    const COL_GAP = 4;
                    const sortedPosts = [...hourPosts].sort((a, b) =>
                      new Date(a.scheduled_at).getMinutes() - new Date(b.scheduled_at).getMinutes()
                    );

                    // Calculate the needed height: base + space for staggered posts
                    const minuteMarks = [
                      ...sortedPosts.map((p) => new Date(p.scheduled_at).getMinutes()),
                      ...hourGhosts.map((g) => g.at.getMinutes()),
                    ];
                    const maxMinute = minuteMarks.length > 0 ? Math.max(...minuteMarks) : 0;
                    // Each minute-offset-pixel = roughly 1px per minute, plus card height
                    const dynamicHeight = Math.max(48, maxMinute + 28);

                    return (
                      <div
                        key={hour}
                        data-hour={hour}
                        style={{
                          display: 'flex',
                          minHeight: dynamicHeight,
                          borderTop: '1px solid var(--stone-200)',
                          background: isHourDragOver && dayDropAllowed ? 'var(--accent-50)' : 'transparent',
                          ...(isHourDragOver && dayDropAllowed ? { outline: '2px dashed var(--accent-400)', outlineOffset: '-2px', borderRadius: '6px' } : {}),
                          opacity: dragPostId && !dayDropAllowed ? 0.4 : 1,
                          transition: 'background var(--transition-fast)',
                        }}
                        onDragOver={(e) => {
                          if (!dragPostId) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = dayDropAllowed ? 'move' : 'none';
                          setDragOverHour(hour);
                        }}
                        onDragLeave={(e) => {
                          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverHour(null);
                        }}
                        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handleDayViewPostDrop(hour); }}
                      >
                        {/* Hour label — white bg so the border line doesn't cross through it */}
                        <div style={{
                          width: '60px',
                          flexShrink: 0,
                          paddingRight: '8px',
                          textAlign: 'right',
                          fontSize: 'var(--text-xs)',
                          fontWeight: 500,
                          color: 'var(--stone-400)',
                          fontFamily: 'var(--font-mono)',
                          userSelect: 'none',
                          lineHeight: '1',
                          transform: 'translateY(-7px)',
                          position: 'relative',
                        }}>
                          <span style={{ background: 'var(--stone-100)', padding: '0 4px' }}>
                            {String(hour).padStart(2, '0')}:00
                          </span>
                        </div>

                        {/* Posts area — relative container, posts positioned by minute offset */}
                        <div style={{ flex: 1, position: 'relative', minHeight: dynamicHeight }}>
                          {sortedPosts.map((post, colIdx) => {
                            const minuteInHour = new Date(post.scheduled_at).getMinutes();
                            return (
                              <div
                                key={post.id}
                                style={{
                                  position: 'absolute',
                                  top: minuteInHour,
                                  left: colIdx * (COL_WIDTH + COL_GAP),
                                  width: COL_WIDTH,
                                  zIndex: 1,
                                }}
                              >
                                <CalendarCard
                                  post={post}
                                  onClick={handlePostClick}
                                  onHoverStart={handleCardHoverStart}
                                  onHoverEnd={handleCardHoverEnd}
                                  isDragging={dragPostId === String(post.id)}
                                  onDragStart={handleCardDragStart}
                                  onDragEnd={handleCardDragEnd}
                                  variant="day"
                                />
                              </div>
                            );
                          })}
                          {/* Ghost runs sit to the right of any real posts in the hour. */}
                          {hourGhosts.map((g, gi) => (
                            <div
                              key={`${g.scheduleId}-${g.at.getTime()}`}
                              style={{
                                position: 'absolute',
                                top: g.at.getMinutes(),
                                left: (sortedPosts.length + gi) * (COL_WIDTH + COL_GAP),
                                width: COL_WIDTH,
                              }}
                            >
                              <GhostChip ghost={g} variant="day" />
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

      {/* Single-post hover popover (month view only) */}
      {hoverPost && hoverRect && typeof document !== 'undefined' && createPortal(
        <PostHoverPopover
          ref={hoverPopoverRef}
          post={hoverPost}
          anchorRect={hoverRect}
          onPostClick={handlePostClick}
          onMouseEnter={handleHoverPopoverEnter}
          onMouseLeave={handleHoverPopoverLeave}
        />,
        document.body,
      )}

    </div>
  );
}

/* Styles defined outside component for reuse */
const navBtnStyle: CSSProperties = {
  width: '30px',
  height: '30px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 'var(--radius-md)',
  border: 'none',
  color: 'var(--stone-500)',
  background: 'var(--stone-100)',
  cursor: 'pointer',
  transition: 'all var(--transition-fast)',
};
