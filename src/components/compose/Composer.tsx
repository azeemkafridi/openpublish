import { useState, useRef, useCallback, useEffect, useMemo, lazy, Suspense } from 'react';
import { useApi } from '@lib/swr';
import { Spinner } from '@components/ui/Spinner';
import { Dialog } from '@components/ui/Dialog';
import { ConfirmDialog } from '@components/ui/ConfirmDialog';
import { Button } from '@components/ui/Button';
import { ApiError, parseApiError, type ApiErrorData } from '@components/ui/ApiError';
import { ChannelSelector, type SelectedChannel } from './ChannelSelector';
import { MediaUploader, type MediaFile } from './MediaUploader';
import { SchedulePicker } from './SchedulePicker';
import { LabelDropdown } from '../labels/LabelDropdown';
import { PlatformOptions, validatePlatformOptions, tiktokDisclosureIncomplete, type PlatformSpecific } from './PlatformOptions';
import { PostFormatBar, POST_FORMATS } from './PostFormatBar';
import { PLATFORM_DEFAULTS, PLATFORM_POST_TYPES, PostTypeSummary, getMediaWarning } from './PostTypeSelector';
import { ThreadEditor, getThreadCharLimit } from './ThreadEditor';
import type { ThreadPart } from '@lib/db/schema';
import type { Platform, LinkPreviewData } from './PostPreview';
import { extractFirstUrl, platformLength } from '@lib/url';
import { PLATFORM_CHAR_LIMITS, validatePostTypeOverridesShape } from '@lib/platforms/validation';
import { platformDisplayName, ALL_PLATFORMS } from '@lib/platforms/types';
import { can } from '@lib/team/permissions';
import { track } from '@lib/track';

const PostPreview = lazy(() => import('./PostPreview'));

/* ------------------------------------------------------------------ */
/*  Format-level media limits                                          */
/* ------------------------------------------------------------------ */

interface MediaLimits {
  maxMedia: number;
  minMedia: number;
  mediaRequired: boolean;
  allowedTypes: ('image' | 'video')[];
}

/**
 * Platform defaults for formats that DON'T appear in PLATFORM_POST_TYPES.
 * Must cover every platform (a miss silently falls back to the generic cap and
 * lets the user attach more files than the platform accepts) — pinned by
 * tests/unit/compose/post-format-coverage.test.ts.
 */
export const PLATFORM_MAX_MEDIA: Record<string, number> = {
  facebook: 10, instagram: 10, x: 4, tiktok: 35, youtube: 1,
  threads: 20, bluesky: 4, pinterest: 5, gmb: 1, linkedin: 20, mastodon: 4,
  reddit: 1, discord: 10, telegram: 10, tumblr: 30, snapchat: 1,
};

function getFormatMediaLimits(
  format: string,
  platforms: Platform[],
  resolvedPostTypes: Record<string, string>,
): MediaLimits {
  if (format === 'video' || format === 'reel') {
    return { maxMedia: 1, minMedia: 1, mediaRequired: true, allowedTypes: ['video'] };
  }
  if (format === 'story') {
    return { maxMedia: 1, minMedia: 1, mediaRequired: true, allowedTypes: ['image', 'video'] };
  }

  // For 'post' and 'carousel', derive limits from per-platform post type configs
  let maxMedia = Infinity;
  let minMedia = 0;
  let mediaRequired = format === 'carousel';
  // 'post' format = image posts; video is handled by the 'video' format
  const allowedTypes = new Set<'image' | 'video'>(
    format === 'post' ? ['image'] : ['image', 'video'],
  );

  for (const p of platforms) {
    const ptKey = resolvedPostTypes[p];
    const options = PLATFORM_POST_TYPES[p as keyof typeof PLATFORM_POST_TYPES];
    const ptOption = options?.find((o) => o.value === ptKey);

    if (ptOption) {
      if (ptOption.maxMedia !== undefined) maxMedia = Math.min(maxMedia, ptOption.maxMedia);
      if (ptOption.minMedia !== undefined) minMedia = Math.max(minMedia, ptOption.minMedia);
      if (ptOption.mediaRequired) mediaRequired = true;
      if (ptOption.allowedMediaTypes) {
        // Intersect allowed types
        for (const t of [...allowedTypes]) {
          if (!ptOption.allowedMediaTypes.includes(t)) allowedTypes.delete(t);
        }
      }
    } else {
      // Platform without explicit post type config — use defaults
      maxMedia = Math.min(maxMedia, PLATFORM_MAX_MEDIA[p] ?? 10);
    }
  }

  if (maxMedia === Infinity) maxMedia = 10;
  if (format === 'carousel' && minMedia < 2) minMedia = 2;
  // 'post' format allows single files even if a platform's resolved type has minMedia > 1
  if (format === 'post') minMedia = Math.min(minMedia, 1);

  return { maxMedia, minMedia, mediaRequired, allowedTypes: [...allowedTypes] };
}
const ComposeSidebar = lazy(() => import('../layout/ComposeSidebar'));

/* ------------------------------------------------------------------ */
/*  Character-limit map                                                */
/* ------------------------------------------------------------------ */

/**
 * The client counter reads the SAME table the server validates against.
 *
 * This used to be a hand-maintained copy and it drifted: reddit/discord/telegram
 * were never added, and Facebook sat at 10000 against the server's 63206. A
 * missing row didn't degrade gracefully — `CHAR_LIMITS[p]` returned `undefined`,
 * which sailed past the `!== null` guard and poisoned `Math.min`/ratio math with
 * NaN, so the counter vanished for EVERY selected channel.
 *
 * `PLATFORM_CHAR_LIMITS` is typed `Record<PlatformName, number>`, so it is
 * exhaustive by construction — a new platform cannot be missing here without
 * failing to compile in validation.ts. Keep it that way; don't reintroduce a
 * partial copy.
 *
 * `null` stays in the value type on purpose: it is the deliberate "this platform
 * has no character limit" state. `undefined` means "platform unknown to this
 * table", which is a bug, not a state — the two must never be conflated.
 */
export const CHAR_LIMITS: Record<string, number | null> = PLATFORM_CHAR_LIMITS;

/* ------------------------------------------------------------------ */
/*  Toast                                                              */
/* ------------------------------------------------------------------ */

function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
  // Store callback in a ref so the timeout doesn't re-fire on every parent render
  // (inline `() => setToast(null)` creates a new function reference each render)
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const t = setTimeout(() => onCloseRef.current(), 4000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div style={{ ...toastStyles.container, background: type === 'error' ? 'var(--color-error)' : 'var(--color-success)' }}>
      {message}
      <button type="button" onClick={onClose} style={toastStyles.close}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

const toastStyles: Record<string, React.CSSProperties> = {
  container: {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    padding: '12px 20px',
    borderRadius: 'var(--radius-lg)',
    background: 'var(--color-success)',
    color: '#fff',
    fontSize: 'var(--text-sm)',
    fontWeight: 500,
    zIndex: 500,
    animation: 'fadeInUp 300ms ease both',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  close: {
    background: 'none',
    border: 'none',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '16px',
    lineHeight: 1,
    opacity: 0.7,
  },
};

/* ------------------------------------------------------------------ */
/*  Toolbar Button                                                     */
/* ------------------------------------------------------------------ */

function ToolbarButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  const [showTip, setShowTip] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const onEnter = () => {
    timer.current = setTimeout(() => setShowTip(true), 500);
  };
  const onLeave = (e: React.MouseEvent<HTMLButtonElement>) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setShowTip(false), 150);
    if (!active) e.currentTarget.style.background = 'transparent';
  };

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '36px',
        height: '36px',
        borderRadius: 'var(--radius-md)',
        border: 'none',
        background: active ? '#fff' : 'transparent',
        color: active ? 'var(--stone-800)' : 'var(--stone-500)',
        boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
        cursor: 'pointer',
        transition: 'all var(--transition-fast)',
        outline: 'none',
      }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onMouseOver={(e) => {
        if (!active) e.currentTarget.style.background = 'var(--stone-100)';
      }}
    >
      {icon}
      {showTip && (
        <span style={{
          position: 'absolute',
          bottom: 'calc(100% + 6px)',
          left: '50%',
          transform: 'translateX(-50%)',
          padding: '4px 10px',
          borderRadius: 'var(--radius-md)',
          background: '#fff',
          color: 'var(--stone-700)',
          boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
          fontSize: '11px',
          fontWeight: 500,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          animation: 'fadeIn 150ms ease',
          zIndex: 10,
        }}>
          {label}
        </span>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Icons                                                              */
/* ------------------------------------------------------------------ */

const icons = {
  image: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="14" height="12" rx="2" />
      <circle cx="6.5" cy="7.5" r="1.5" />
      <polyline points="16,12 12,8 5,15" />
    </svg>
  ),
  calendar: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3.5" width="14" height="12" rx="2" />
      <line x1="2" y1="7.5" x2="16" y2="7.5" />
      <line x1="6" y1="2" x2="6" y2="5" />
      <line x1="12" y1="2" x2="12" y2="5" />
    </svg>
  ),
  tag: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15.5 9.5l-6-6a1 1 0 00-.7-.3H4a1 1 0 00-1 1v4.8a1 1 0 00.3.7l6 6a1 1 0 001.4 0l4.8-4.8a1 1 0 000-1.4z" />
      <circle cx="6" cy="6" r="1" fill="currentColor" />
    </svg>
  ),
  x: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
};

/* ------------------------------------------------------------------ */
/*  Composer                                                           */
/* ------------------------------------------------------------------ */

interface ComposerProps {
  automationMode?: boolean;
  /** The viewer's org role (SSR-provided). Drives the approval flow: roles
   *  without post:publish submit for approval instead of scheduling/publishing. */
  userRole?: string;
}

export default function Composer({ automationMode: automationModeProp, userRole }: ComposerProps = {}) {
  // Approval flow (team roles Phase 2)
  const canPublish = can(userRole ?? 'owner', 'post:publish');
  const canApprove = can(userRole ?? 'owner', 'post:approve');
  // Deliberately has no UI toggle. It is still set when editing a schedule that
  // was already approval-gated (so saving doesn't silently un-gate future
  // occurrences), the `requestApproval` request field keeps the flow reachable
  // via the API, and contributors (canPublish === false) are routed through
  // approval by `needsApproval` regardless.
  const [requestApproval, setRequestApproval] = useState(false);
  const [editApproval, setEditApproval] = useState<{ status: string; reason: string | null } | null>(null);
  const needsApproval = !canPublish || requestApproval;
  /* ---- State ---- */
  const [content, setContent] = useState('');
  const [selectedChannels, setSelectedChannels] = useState<SelectedChannel[]>([]);
  const [mediaFiles, setMediaFiles] = useState<MediaFile[]>([]);
  const [scheduledAt, setScheduledAt] = useState<string | null>(null);
  const [confirmScheduleClear, setConfirmScheduleClear] = useState(false);
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  const [selectedLabels, setSelectedLabels] = useState<number[]>([]);
  const [platformSpecific, setPlatformSpecific] = useState<PlatformSpecific>({});
  const [firstComment, setFirstComment] = useState('');
  const [autoPlugEnabled, setAutoPlugEnabled] = useState(false);
  const [autoPlugText, setAutoPlugText] = useState('');
  const [autoPlugThreshold, setAutoPlugThreshold] = useState(50);
  const [autoRepostEnabled, setAutoRepostEnabled] = useState(false);
  const [autoRepostThreshold, setAutoRepostThreshold] = useState(100);
  const [preserveMedia, setPreserveMedia] = useState(true); // keep media by default (reclaimed by 3-month retention)
  const [platformContent, setPlatformContent] = useState<Record<string, string>>({});
  const [activeChannelId, setActiveChannelId] = useState<number | null>(null);
  const [selectedFormat, setSelectedFormat] = useState('post');
  const [threadParts, setThreadParts] = useState<ThreadPart[]>([
    { content: '', mediaFileIds: [] },
    { content: '', mediaFileIds: [] },
  ]);
  const [platformThreadParts, setPlatformThreadParts] = useState<Record<string, ThreadPart[]>>({});
  const [threadMediaPool, setThreadMediaPool] = useState<MediaFile[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [submitPhase, setSubmitPhase] = useState<
    'idle' | 'saving' | 'publishing' | 'polling' | 'done' | 'error'
  >('idle');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [quotaError, setQuotaError] = useState<ApiErrorData | null>(null);

  // Repeat/automation mode was removed with the automations feature.
  const automationMode = false;
  void automationModeProp;

  // Link preview — debounced URL detection from content
  const [linkPreview, setLinkPreview] = useState<LinkPreviewData | null>(null);
  const linkPreviewUrlRef = useRef<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      const url = extractFirstUrl(content);
      if (!url) {
        if (linkPreviewUrlRef.current) {
          linkPreviewUrlRef.current = null;
          setLinkPreview(null);
        }
        return;
      }
      if (url === linkPreviewUrlRef.current) return;
      linkPreviewUrlRef.current = url;
      fetch(`/api/link-preview?url=${encodeURIComponent(url)}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.error) {
            setLinkPreview(null);
          } else {
            setLinkPreview(data);
          }
        })
        .catch(() => setLinkPreview(null));
    }, 500);
    return () => clearTimeout(timer);
  }, [content]);

  // Edit / repost: preload from existing post
  const [loadingPost, setLoadingPost] = useState(false);
  const [editPostId, setEditPostId] = useState<number | null>(null);
  useEffect(() => {
    let postId: string | null = null;
    let isEdit = false;
    try {
      const params = new URLSearchParams(window.location.search);
      postId = params.get('edit') || params.get('repost') || params.get('post');
      isEdit = !!params.get('edit');
    } catch { /* ignore */ }
    if (!postId) return;

    if (isEdit) setEditPostId(Number(postId));

    setLoadingPost(true);
    fetch(`/api/posts/${postId}`)
      .then((res) => res.ok ? res.json() : null)
      .then((post) => {
        if (!post) return;
        if (post.content) setContent(post.content);
        if (post.mediaFiles?.length) {
          setMediaFiles(
            post.mediaFiles.map((m: any) => ({
              id: m.id,
              originalPath: m.originalUrl ?? m.originalPath ?? '',
              thumbnailPath: m.thumbnailUrl ?? m.thumbnailPath ?? '',
              fileName: m.fileName ?? (m.originalUrl ?? '').split('/').pop() ?? `media-${m.id}`,
              mimeType: m.mimeType ?? '',
              sizeBytes: m.sizeBytes ?? 0,
              width: m.width ?? 0,
              height: m.height ?? 0,
              duration: m.duration ?? undefined,
            })),
          );
        }
        if (post.labels?.length) setSelectedLabels(post.labels.map((l: any) => l.id));
        if (post.postPlatforms?.length) {
          const loadedChannels = post.postPlatforms.map((pp: any) => ({
            channelId: pp.channelId,
            platform: pp.platform,
          }));
          setSelectedChannels(loadedChannels);
          setFullChannels(loadedChannels);
        }
        if (post.postFormat) setSelectedFormat(post.postFormat);
        // Restore saved per-platform post types — without this, saving an edit
        // sends resolvedPostTypes built from format defaults and silently
        // reverts overrides like LinkedIn's PDF Carousel.
        if (post.postTypeOverrides && Object.keys(post.postTypeOverrides).length > 0) {
          setPlatformPostTypeOverrides(post.postTypeOverrides);
        }
        if (post.postFormat === 'thread' && post.threadParts && Array.isArray(post.threadParts) && post.threadParts.length >= 2) {
          setThreadParts(post.threadParts);
          // Resolve thread part media files from post.mediaFiles for display
          const allPartMediaIds = new Set<number>(
            post.threadParts.flatMap((p: any) => p.mediaFileIds || []),
          );
          if (allPartMediaIds.size > 0 && post.mediaFiles?.length) {
            const pool = post.mediaFiles
              .filter((m: any) => allPartMediaIds.has(m.id))
              .map((m: any) => ({
                id: m.id,
                originalPath: m.originalUrl ?? m.originalPath ?? '',
                thumbnailPath: m.thumbnailUrl ?? m.thumbnailPath ?? '',
                fileName: m.fileName ?? (m.originalUrl ?? '').split('/').pop() ?? `media-${m.id}`,
                mimeType: m.mimeType ?? '',
                sizeBytes: m.sizeBytes ?? 0,
                width: m.width ?? 0,
                height: m.height ?? 0,
                duration: m.duration ?? undefined,
              }));
            setThreadMediaPool(pool);
          }
        }
        if (post.platformSpecific && Object.keys(post.platformSpecific).length > 0) {
          const { _firstComment, ...rest } = post.platformSpecific as any;
          setPlatformSpecific(rest);
          if (_firstComment) setFirstComment(_firstComment);
        }
        if (post.platformContent && Object.keys(post.platformContent).length > 0) {
          setPlatformContent(post.platformContent);
        }
        if (post.platformThreadParts && Object.keys(post.platformThreadParts).length > 0) {
          setPlatformThreadParts(post.platformThreadParts);
        }
        if (post.autoPlugEnabled) {
          setAutoPlugEnabled(true);
          if (post.autoPlugText) setAutoPlugText(post.autoPlugText);
          if (post.autoPlugThreshold) setAutoPlugThreshold(post.autoPlugThreshold);
        }
        if (post.autoRepostEnabled) {
          setAutoRepostEnabled(true);
          if (post.autoRepostThreshold) setAutoRepostThreshold(post.autoRepostThreshold);
        }
        // Two-way load: a post saved with delete-after-publish ON must clear the
        // default-on "preserve" toggle, else editing silently flips it back to keep.
        setPreserveMedia(post.deleteMediaAfterPublish !== true);
        if (post.scheduledAt) {
          setScheduledAt(post.scheduledAt);
          setShowSchedule(true);
        }
        if (post.timezone) setTimezone(post.timezone);
        if (post.labels?.length) setShowLabels(true);
        if (post.approvalStatus && post.approvalStatus !== 'none') {
          setEditApproval({ status: post.approvalStatus, reason: post.rejectionReason ?? null });
        }

      })
      .catch(() => { /* ignore */ })
      .finally(() => setLoadingPost(false));
  }, []);

  // Panel toggles
  const [showMedia, setShowMedia] = useState(true);
  const [showSchedule, setShowSchedule] = useState(automationMode);
  const [showLabels, setShowLabels] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /* ---- Derived state ---- */
  const isEditing = !!editPostId;
  const hasChannels = selectedChannels.length > 0;
  const hasContent = content.trim().length > 0 || mediaFiles.length > 0;

  // Active channel / platform (needed by title + per-platform content)
  const activeChannel = activeChannelId
    ? selectedChannels.find((c) => c.channelId === activeChannelId)
    : null;
  const activePlatform = activeChannel?.platform ?? null;

  /* ---- Title field for platforms that support it (YouTube, Pinterest) ---- */
  const TITLE_PLATFORMS = ['youtube', 'pinterest'] as const;
  const hasTitlePlatform = activePlatform
    ? TITLE_PLATFORMS.includes(activePlatform as any)
    : selectedChannels.some((c) => TITLE_PLATFORMS.includes(c.platform as any));

  const titleValue = activePlatform
    ? ((platformSpecific as any)[activePlatform]?.title || '')
    : (platformSpecific.youtube?.title || platformSpecific.pinterest?.title || '');

  const handleTitleChange = useCallback((newTitle: string) => {
    setPlatformSpecific((prev) => {
      const updated = { ...prev };
      if (activePlatform) {
        // Per-platform: only update the active platform's title
        if (activePlatform === 'youtube') {
          updated.youtube = {
            ...(updated.youtube ?? { title: '', privacyStatus: 'public', categoryId: '22', madeForKids: false, playlistId: '' }),
            title: newTitle,
          };
        } else if (activePlatform === 'pinterest') {
          updated.pinterest = { ...(updated.pinterest ?? {}), title: newTitle };
        }
      } else {
        // All mode: update all title-supporting platforms
        const hasYT = selectedChannels.some((c) => c.platform === 'youtube');
        const hasPin = selectedChannels.some((c) => c.platform === 'pinterest');
        if (hasYT) {
          updated.youtube = {
            ...(updated.youtube ?? { title: '', privacyStatus: 'public', categoryId: '22', madeForKids: false, playlistId: '' }),
            title: newTitle,
          };
        }
        if (hasPin) {
          updated.pinterest = { ...(updated.pinterest ?? {}), title: newTitle };
        }
      }
      return updated;
    });
  }, [selectedChannels, activePlatform]);

  /* ---- Derived preview props ---- */
  const previewPlatforms = useMemo(
    () => [...new Set(selectedChannels.map((ch) => ch.platform))] as Platform[],
    [selectedChannels],
  );
  const firstMedia = mediaFiles[0] ?? null;
  const previewMediaUrl = firstMedia
    ? (firstMedia.originalPath || firstMedia.thumbnailPath)
    : null;
  const previewMediaType = firstMedia
    ? (firstMedia.mimeType?.startsWith('video') ? 'video' as const : 'image' as const)
    : null;

  const activeFormat = POST_FORMATS.find((f) => f.value === selectedFormat);
  // Shared list, not a local literal: this one stopped at mastodon, so the four
  // newest platforms were never even considered for the "unsupported by this
  // format" treatment.
  const disabledPlatforms = (ALL_PLATFORMS as Platform[]).filter(
    (p) => !activeFormat?.supportedPlatforms.includes(p),
  );

  // Per-platform post type overrides (e.g. LinkedIn Gallery vs PDF Carousel)
  const [platformPostTypeOverrides, setPlatformPostTypeOverrides] = useState<Record<string, string>>({});

  const resolvedPostTypes = useMemo(() => {
    const map: Record<string, string> = {};
    const fmt = POST_FORMATS.find((f) => f.value === selectedFormat);
    if (fmt) {
      for (const ch of selectedChannels) {
        if (!map[ch.platform]) {
          map[ch.platform] = platformPostTypeOverrides[ch.platform]
            ?? fmt.platformPostTypes[ch.platform]
            ?? PLATFORM_DEFAULTS[ch.platform]
            ?? 'default';
        }
      }
    }
    return map;
  }, [selectedChannels, selectedFormat, platformPostTypeOverrides]);

  const handlePostTypeOverride = useCallback((platform: string, postType: string) => {
    setPlatformPostTypeOverrides((prev) => ({ ...prev, [platform]: postType }));
  }, []);

  /* ---- Media limits for current format + platforms ---- */
  const mediaLimits = useMemo(() =>
    getFormatMediaLimits(selectedFormat, previewPlatforms, resolvedPostTypes),
    [selectedFormat, previewPlatforms, resolvedPostTypes],
  );

  const mediaDuration = firstMedia?.duration ?? null;

  const videoDurationSec = useMemo(
    () => mediaFiles.find((f) => (f.mimeType ?? '').startsWith('video'))?.duration ?? null,
    [mediaFiles],
  );

  // TikTok UX guidelines: grey out the action buttons while commercial-content
  // disclosure is on with no option picked (not just block on click).
  const ttDisclosureIncomplete = tiktokDisclosureIncomplete(selectedChannels, platformSpecific);

  const allMediaUrls = useMemo(
    () => mediaFiles.map((f) => f.originalPath || f.thumbnailPath).filter(Boolean),
    [mediaFiles],
  );

  const mediaWarning = useMemo(() => {
    const count = mediaFiles.length;
    const hasImages = mediaFiles.some((f) => (f.mimeType ?? '').startsWith('image'));
    const hasVideos = mediaFiles.some((f) => (f.mimeType ?? '').startsWith('video'));

    // Too many
    if (mediaLimits.maxMedia > 0 && count > mediaLimits.maxMedia) {
      return `Maximum ${mediaLimits.maxMedia} file${mediaLimits.maxMedia > 1 ? 's' : ''} allowed for this format. Remove ${count - mediaLimits.maxMedia}.`;
    }
    // Too few (only warn when user has started uploading, or for carousel-like formats with minMedia > 1)
    if (mediaLimits.minMedia > 1 && count > 0 && count < mediaLimits.minMedia) {
      return `This format requires at least ${mediaLimits.minMedia} files. Add ${mediaLimits.minMedia - count} more.`;
    }
    // Wrong media type
    if (count > 0 && hasImages && !mediaLimits.allowedTypes.includes('image')) {
      return 'This format only accepts video files. Remove images.';
    }
    if (count > 0 && hasVideos && !mediaLimits.allowedTypes.includes('video')) {
      return 'This format only accepts image files. Remove videos.';
    }
    return null;
  }, [mediaFiles, mediaLimits]);

  /* ---- Auto-expand textarea ---- */
  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, 160)}px`;
  }, []);

  useEffect(() => {
    autoGrow();
  }, [content, autoGrow]);

  /* ---- Thread ↔ format content transfer ---- */
  const handleFormatChange = useCallback((newFormat: string) => {
    const prevFormat = selectedFormat;
    if (prevFormat === 'thread' && newFormat !== 'thread') {
      // Moving away from thread: put first part's content into content field
      setContent(threadParts[0]?.content || '');
      setThreadMediaPool([]);
    } else if (prevFormat !== 'thread' && newFormat === 'thread') {
      // Moving to thread: move content into first part
      setThreadParts([
        { content: content, mediaFileIds: [] },
        { content: '', mediaFileIds: [] },
      ]);
    }
    // Overrides are per-format choices; carrying them across formats silently
    // publishes a stale post type (e.g. a PDF Carousel override under "Post").
    setPlatformPostTypeOverrides({});
    setSelectedFormat(newFormat);
  }, [selectedFormat, content, threadParts]);

  const isThreadFormat = selectedFormat === 'thread';

  /* ---- Thread per-part media limits ---- */
  const threadMediaLimits = useMemo(() => {
    if (!isThreadFormat) return { maxMedia: 4, acceptTypes: ['image'] as ('image' | 'video')[] };
    let max = Infinity;
    const allowed = new Set<'image' | 'video'>(['image', 'video']);
    for (const ch of selectedChannels) {
      const opts = PLATFORM_POST_TYPES[ch.platform as keyof typeof PLATFORM_POST_TYPES];
      const threadOpt = opts?.find((o) => o.value === 'thread');
      if (threadOpt) {
        if (threadOpt.maxMedia !== undefined) max = Math.min(max, threadOpt.maxMedia);
        if (threadOpt.allowedMediaTypes) {
          for (const t of [...allowed]) {
            if (!threadOpt.allowedMediaTypes.includes(t)) allowed.delete(t);
          }
        }
      }
    }
    if (max === Infinity) max = 4;
    return { maxMedia: max, acceptTypes: [...allowed] as ('image' | 'video')[] };
  }, [isThreadFormat, selectedChannels]);

  const handleThreadMediaUploaded = useCallback((file: MediaFile) => {
    setThreadMediaPool((prev) => [...prev, file]);
  }, []);

  /* ---- Auto-hide unsupported channels when format changes ---- */
  // Keep a "full" selection so channels are restored when switching back
  const [fullChannels, setFullChannels] = useState<SelectedChannel[]>([]);

  // When user manually changes channels, update the full list too
  const handleChannelsChange = useCallback((channels: SelectedChannel[]) => {
    setSelectedChannels(channels);
    // Merge into fullChannels: add new ones, remove deselected ones
    setFullChannels((prev) => {
      const newIds = new Set(channels.map((c) => c.channelId));
      // Keep only prev channels the current format actually hides (the user
      // could not have deselected those) plus all channels from the new
      // selection. Keying off "not currently visible" instead resurrected
      // manually deselected channels on the next format change. With an
      // unknown format nothing is format-hidden.
      const hidden = activeFormat
        ? prev.filter(
            (c) =>
              !activeFormat.supportedPlatforms.includes(c.platform) &&
              !newIds.has(c.channelId),
          )
        : [];
      const merged = [...hidden, ...channels];
      // Deduplicate by channelId
      const seen = new Set<number>();
      return merged.filter((c) => {
        if (seen.has(c.channelId)) return false;
        seen.add(c.channelId);
        return true;
      });
    });
  }, [activeFormat]);

  useEffect(() => {
    if (!activeFormat) return;
    // Restore from fullChannels: show all that are supported by current format
    const restored = fullChannels.filter((ch) =>
      activeFormat.supportedPlatforms.includes(ch.platform),
    );
    const currentIds = selectedChannels.map((c) => c.channelId).sort().join(',');
    const restoredIds = restored.map((c) => c.channelId).sort().join(',');
    if (currentIds !== restoredIds) {
      setSelectedChannels(restored);
    }
  }, [selectedFormat]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- Sync content + platforms to sidebar for char limits ---- */
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('compose-update', {
        detail: { content, platforms: previewPlatforms, format: selectedFormat, mediaCount: mediaFiles.length },
      }),
    );
  }, [content, previewPlatforms, selectedFormat, mediaFiles.length]);

  /* ---- Character counters ---- */
  const charStatus = useMemo(() => {
    const limits: { platform: string; limit: number; over: boolean }[] = [];
    const seen = new Set<string>();
    for (const ch of selectedChannels) {
      if (seen.has(ch.platform)) continue;
      seen.add(ch.platform);
      const limit = CHAR_LIMITS[ch.platform];
      // `null` — platform deliberately has no limit; nothing to count against.
      // `undefined` — platform missing from the table (drift). Both are skipped,
      // but neither may be pushed: a non-number `limit` here becomes NaN in
      // `Math.min` and in the ratio math below, which blanks the counter for
      // every OTHER selected channel too.
      if (typeof limit === 'number') {
        // Use platform-specific content if it exists, otherwise global content
        const effectiveContent = platformContent[ch.platform]?.trim()
          ? platformContent[ch.platform]
          : content;
        limits.push({ platform: ch.platform, limit, over: platformLength(effectiveContent, ch.platform) > limit });
      }
    }
    return limits;
  }, [selectedChannels, content, platformContent]);

  const hasOverLimit = charStatus.some((c) => c.over);
  const lowestLimit = charStatus.length > 0 ? Math.min(...charStatus.map((c) => c.limit)) : null;

  /* ---- Per-platform content ---- */
  const textareaValue = activePlatform
    ? (platformContent[activePlatform] ?? '')
    : content;
  const platformsWithOverrides = useMemo(
    () => {
      const set = new Set(Object.entries(platformContent).filter(([, v]) => v.length > 0).map(([k]) => k));
      for (const [k, v] of Object.entries(platformThreadParts)) {
        if (v.length > 0 && v.some((p) => p.content.trim().length > 0)) set.add(k);
      }
      return set;
    },
    [platformContent, platformThreadParts],
  );

  /* ---- Per-channel validation warnings ---- */
  const channelWarnings = useMemo(() => {
    const map = new Map<number, string[]>();
    const fmt = POST_FORMATS.find((f) => f.value === selectedFormat);
    if (!fmt) return map;

    for (const sel of selectedChannels) {
      const warnings: string[] = [];
      const platform = sel.platform;
      const label = platformDisplayName(platform);

      // Char limit. Thread parts have their own per-part counters in the
      // ThreadEditor, so the whole-content check only applies off-thread.
      if (!isThreadFormat) {
        const limit = CHAR_LIMITS[platform];
        const text = platformContent[platform]?.length > 0 ? platformContent[platform] : content;
        const textLength = platformLength(text, platform);
        if (limit && textLength > limit) {
          warnings.push(`Exceeds ${label}'s ${limit} char limit (${textLength} chars)`);
        }
      }

      // Media checks — must use the RESOLVED type so a per-platform override
      // (e.g. LinkedIn PDF Carousel) is validated as what will actually
      // publish, not the format's default. getMediaWarning is the single
      // source for these rules (also used by PostTypeSummary and submit).
      if (!isThreadFormat) {
        const ptKey = resolvedPostTypes[platform];
        const options = PLATFORM_POST_TYPES[platform as keyof typeof PLATFORM_POST_TYPES];
        const pt = options?.find((o) => o.value === ptKey);
        const mediaMsg = getMediaWarning(pt, mediaFiles);
        if (mediaMsg) warnings.push(`${label}: ${mediaMsg}`);
      }

      if (warnings.length > 0) map.set(sel.channelId, warnings);
    }
    return map;
  }, [selectedFormat, selectedChannels, content, platformContent, mediaFiles, isThreadFormat, resolvedPostTypes]);

  // Per-platform thread parts: which parts to show in ThreadEditor
  const activeThreadParts = activePlatform
    ? (platformThreadParts[activePlatform] ?? threadParts)
    : threadParts;

  const handleThreadPartsChange = (newParts: ThreadPart[]) => {
    if (activePlatform) {
      setPlatformThreadParts((prev) => ({ ...prev, [activePlatform]: newParts }));
    } else {
      setThreadParts(newParts);
    }
  };

  const handleContentChange = (value: string) => {
    if (activePlatform) {
      setPlatformContent((prev) => ({ ...prev, [activePlatform]: value }));
    } else {
      setContent(value);
    }
  };

  const handleChannelClick = (channelId: number) => {
    setActiveChannelId((prev) => (prev === channelId ? null : channelId));
  };

  // URL-weighted for x/mastodon (URLs count as 23 chars). When no platform is
  // active the headline counter tracks the MOST CONSTRAINED selected platform —
  // highest used/limit ratio, each measured the way that platform measures —
  // so its number and limit always agree with the per-channel warnings.
  const mostConstrained = useMemo(() => {
    let best: { platform: string; limit: number; ratio: number } | null = null;
    for (const c of charStatus) {
      const ratio = platformLength(textareaValue, c.platform) / c.limit;
      if (!best || ratio > best.ratio) best = { platform: c.platform, limit: c.limit, ratio };
    }
    return best;
  }, [charStatus, textareaValue]);
  const activeLimit = activePlatform
    ? (CHAR_LIMITS[activePlatform] ?? null)
    : (mostConstrained?.limit ?? null);
  const weightPlatform = activePlatform ?? mostConstrained?.platform ?? '';
  const activeLength = platformLength(textareaValue, weightPlatform);
  const activeOverLimit = activeLimit !== null && activeLength > activeLimit;

  // Link tracking only concerns posts that actually contain a link. Checks the
  // thread parts too, since a thread's URL is usually not in the main box.
  const hasLinkInContent = useMemo(() => {
    if (extractFirstUrl(textareaValue)) return true;
    return threadParts.some((p) => extractFirstUrl(p.content || ''));
  }, [textareaValue, threadParts]);

  // Clear activeChannelId if that channel is deselected
  useEffect(() => {
    if (activeChannelId && !selectedChannels.some((c) => c.channelId === activeChannelId)) {
      setActiveChannelId(null);
    }
  }, [selectedChannels, activeChannelId]);

  /* ---- Poll post status until terminal ---- */
  async function pollPostStatus(postId: number): Promise<string> {
    // Ramped back-off: fast polls early so snappy publishes feel instant,
    // settling into 2s after ~6 seconds. Fetch BEFORE sleeping so we never
    // pay a full interval if the worker is already done.
    const delays = [500, 500, 1000, 1000, 1500, 1500];
    const fallback = 2000;
    const maxAttempts = 80; // ~2.5 min total budget
    // `processing` means the platform accepted the content but is still
    // finalizing it in the background (IG/Threads container flow). After a
    // brief grace window we treat that as success and let the status-check
    // worker finalize asynchronously — failure later surfaces as a notification.
    let firstSawProcessingAt = -1;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await fetch(`/api/posts/${postId}`);
        if (res.ok) {
          const post = await res.json();
          if (['published', 'partial', 'failed'].includes(post.status)) {
            return post.status;
          }
          if (post.status === 'processing') {
            if (firstSawProcessingAt < 0) firstSawProcessingAt = i;
            // Give it ~2 more polls to transition before optimistically returning.
            if (i - firstSawProcessingAt >= 2) return 'processing';
          }
        }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, delays[i] ?? fallback));
    }
    return 'failed'; // timeout
  }

  /* ---- Add to Queue ---- */
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueDone, setQueueDone] = useState(false);

  const handleQueue = async () => {
    const errors: string[] = [];

    if (isThreadFormat) {
      if (threadParts.length < 2) {
        errors.push('A thread needs at least 2 parts.');
      }
      const emptyParts = threadParts.filter((p) => !p.content.trim());
      if (emptyParts.length > 0) {
        errors.push('All thread parts must have content.');
      }
      const threadLimit = getThreadCharLimit(previewPlatforms);
      if (threadLimit) {
        const overParts = threadParts.filter((p) => p.content.length > threadLimit);
        if (overParts.length > 0) {
          errors.push(`Some thread parts exceed the ${threadLimit} character limit.`);
        }
      }
    } else if (!content.trim() && mediaFiles.length === 0) {
      errors.push('Add content or media.');
    }
    if (selectedChannels.length === 0) {
      errors.push('Select at least one channel.');
    }
    if (hasOverLimit) {
      const overPlatforms = charStatus.filter((c) => c.over).map((c) => c.platform);
      errors.push(`Content exceeds character limit for ${overPlatforms.join(', ')}.`);
    }
    if (mediaWarning) {
      errors.push(mediaWarning);
    }
    if (mediaLimits.mediaRequired && mediaFiles.length === 0) {
      errors.push(`This format requires media. Please upload ${mediaLimits.allowedTypes.join(' or ')}.`);
    }
    errors.push(...validatePlatformOptions(selectedChannels, platformSpecific, resolvedPostTypes, { content: platformContent.tiktok?.trim() ? platformContent.tiktok : content, videoDurationSec }));

    // Block resolved post types the server would reject or the platform
    // can't publish with the attached media (e.g. a Reel with no video).
    const shapeError = validatePostTypeOverridesShape(resolvedPostTypes);
    if (shapeError) errors.push(shapeError);
    if (!isThreadFormat) {
      for (const platform of new Set(selectedChannels.map((c) => c.platform))) {
        const pt = PLATFORM_POST_TYPES[platform as keyof typeof PLATFORM_POST_TYPES]
          ?.find((o) => o.value === resolvedPostTypes[platform]);
        if (!pt) continue;
        const mediaMsg = getMediaWarning(pt, mediaFiles);
        if (mediaMsg) {
          errors.push(`${platformDisplayName(platform)}: ${mediaMsg.replace(/\.?$/, '.')} Change ${platformDisplayName(platform)}'s post type or the attached media.`);
        }
      }
    }

    if (errors.length > 0) {
      track('composer_validation_failed', { mode: 'queue', errors: errors.slice(0, 5) });
      setValidationErrors(errors);
      return;
    }

    setQueueLoading(true);
    setQueueDone(false);
    setSubmitting(true);
    setToast(null);
    setQuotaError(null);

    try {
      // Step 1: Fetch next available queue slot
      const slotRes = await fetch(`/api/posts/queue-slot?timezone=${encodeURIComponent(timezone)}`);
      if (!slotRes.ok) {
        const slotErr = await slotRes.json().catch(() => ({}));
        throw new Error(slotErr.error?.message ?? 'No available queue slots');
      }
      const slot = await slotRes.json();

      // Step 2: Create the post as scheduled with the slot time
      const queuePlatformContent = Object.fromEntries(
        Object.entries(platformContent).filter(([, v]) => v.trim().length > 0),
      );
      const queuePlatformThreadParts = Object.fromEntries(
        Object.entries(platformThreadParts).filter(([, v]) => v.length > 0 && v.some((p) => p.content.trim().length > 0)),
      );
      const body = {
        // In thread mode the main textarea is empty — the first part carries the text.
        // Mirror handleSubmit so queued threads don't persist an empty content column.
        content: isThreadFormat ? (threadParts[0]?.content || '') : content,
        platformContent: Object.keys(queuePlatformContent).length > 0 ? queuePlatformContent : undefined,
        platformThreadParts: isThreadFormat && Object.keys(queuePlatformThreadParts).length > 0 ? queuePlatformThreadParts : undefined,
        mediaFiles: mediaFiles.map((m) => m.id),
        status: 'scheduled',
        scheduledAt: slot.scheduledAt,
        timezone,
        channels: selectedChannels.map((c) => ({
          channelId: c.channelId,
          platform: c.platform,
        })),
        labels: selectedLabels,
        postFormat: selectedFormat,
        postTypeOverrides: resolvedPostTypes,
        platformSpecific: firstComment.trim()
          ? { ...platformSpecific, _firstComment: firstComment.trim() }
          : platformSpecific,
        threadParts: isThreadFormat ? threadParts : undefined,
        autoPlugEnabled: autoPlugEnabled || undefined,
        autoPlugText: autoPlugEnabled ? autoPlugText.trim() || undefined : undefined,
        autoPlugThreshold: autoPlugEnabled ? autoPlugThreshold : undefined,
        autoRepostEnabled: autoRepostEnabled || undefined,
        autoRepostThreshold: autoRepostEnabled ? autoRepostThreshold : undefined,
        deleteMediaAfterPublish: !preserveMedia,
        requestApproval: requestApproval || undefined,
      };

      const res = await fetch(isEditing ? `/api/posts/${editPostId}` : '/api/posts', {
        method: isEditing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const parsed = parseApiError(errBody, 'Failed to queue post');
        if (parsed.upgrade || parsed.code === 'QUOTA_EXCEEDED' || parsed.code === 'FEATURE_DISABLED') {
          track('composer_submit_blocked', { mode: 'queue', code: parsed.code });
          setQuotaError(parsed);
          setSubmitting(false);
          return;
        }
        throw new Error(parsed.message);
      }

      const slotTime = new Date(slot.scheduledAt).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: timezone,
      });

      setQueueDone(true);
      setToast({
        message: needsApproval
          ? `Queued for ${slot.dayLabel} at ${slotTime}, awaiting approval`
          : `Queued for ${slot.dayLabel} at ${slotTime}`,
        type: 'success',
      });
      setTimeout(() => {
        window.location.href = '/calendar';
      }, 1500);
    } catch (err: any) {
      track('composer_submit_failed', { mode: 'queue', message: String(err?.message ?? 'unknown').slice(0, 200) });
      setToast({ message: err.message ?? 'Failed to queue post.', type: 'error' });
    } finally {
      setQueueLoading(false);
      setSubmitting(false);
    }
  };

  /* ---- Submit ---- */
  const handleSubmit = async (
    status: 'draft' | 'scheduled' | 'published',
    opts: { approveAfter?: boolean } = {},
  ) => {
    // Members who can't publish directly (contributors) submit for approval:
    // "Publish now" becomes an ASAP submission (scheduled at the current time,
    // held as pending until an approver releases it).
    const submitForApproval = needsApproval && !opts.approveAfter;
    if (status === 'published' && submitForApproval) {
      status = 'scheduled';
    }
    const errors: string[] = [];

    if (isThreadFormat) {
      const hasContent = threadParts.some((p) => p.content.trim().length > 0);
      if (!hasContent) errors.push('Add content to at least one thread part.');
      if (threadParts.length < 2) errors.push('A thread needs at least 2 parts.');
      if (lowestLimit !== null) {
        const overParts = threadParts.filter((p) => p.content.length > lowestLimit);
        if (overParts.length > 0) errors.push(`Some thread parts exceed the ${lowestLimit} character limit.`);
      }
    } else if (!content.trim() && mediaFiles.length === 0) {
      errors.push('Add content or media.');
    }
    if (status !== 'draft' && selectedChannels.length === 0) {
      errors.push('Select at least one channel.');
    }
    if (hasOverLimit) {
      const overPlatforms = charStatus.filter((c) => c.over).map((c) => c.platform);
      errors.push(`Content exceeds character limit for ${overPlatforms.join(', ')}.`);
    }
    if (mediaWarning) {
      errors.push(mediaWarning);
    }
    if (mediaLimits.mediaRequired && mediaFiles.length === 0) {
      errors.push(`This format requires media. Please upload ${mediaLimits.allowedTypes.join(' or ')}.`);
    }
    // An approval submission without a picked time is an "ASAP" submission —
    // it's stamped with the current time and publishes as soon as it's approved.
    const asapApproval = status === 'scheduled' && submitForApproval && !scheduledAt && !automationMode;
    if (status === 'scheduled' && !scheduledAt && !automationMode && !asapApproval) {
      errors.push('Pick a date and time before scheduling.');
    }
    if (status !== 'draft') {
      errors.push(...validatePlatformOptions(selectedChannels, platformSpecific, resolvedPostTypes, { content: platformContent.tiktok?.trim() ? platformContent.tiktok : content, videoDurationSec }));

    // Block resolved post types the server would reject or the platform
    // can't publish with the attached media (e.g. a Reel with no video).
    const shapeError = validatePostTypeOverridesShape(resolvedPostTypes);
    if (shapeError) errors.push(shapeError);
    if (!isThreadFormat) {
      for (const platform of new Set(selectedChannels.map((c) => c.platform))) {
        const pt = PLATFORM_POST_TYPES[platform as keyof typeof PLATFORM_POST_TYPES]
          ?.find((o) => o.value === resolvedPostTypes[platform]);
        if (!pt) continue;
        const mediaMsg = getMediaWarning(pt, mediaFiles);
        if (mediaMsg) {
          errors.push(`${platformDisplayName(platform)}: ${mediaMsg.replace(/\.?$/, '.')} Change ${platformDisplayName(platform)}'s post type or the attached media.`);
        }
      }
    }
    }

    if (errors.length > 0) {
      track('composer_validation_failed', { mode: status, errors: errors.slice(0, 5) });
      setValidationErrors(errors);
      return;
    }

    setSubmitting(true);
    setSubmitPhase('saving');
    setToast(null);
    setQuotaError(null);
    try {
      // Step 1: Create/update the post
      // Filter out empty platform content overrides
      const cleanedPlatformContent = Object.fromEntries(
        Object.entries(platformContent).filter(([, v]) => v.trim().length > 0),
      );
      // Filter out empty platform thread parts overrides
      const cleanedPlatformThreadParts = Object.fromEntries(
        Object.entries(platformThreadParts).filter(([, v]) => v.length > 0 && v.some((p) => p.content.trim().length > 0)),
      );

      const body = {
        content: isThreadFormat ? (threadParts[0]?.content || '') : content,
        platformContent: Object.keys(cleanedPlatformContent).length > 0 ? cleanedPlatformContent : undefined,
        platformThreadParts: isThreadFormat && Object.keys(cleanedPlatformThreadParts).length > 0 ? cleanedPlatformThreadParts : undefined,
        mediaFiles: mediaFiles.map((m) => m.id),
        status: status === 'published' ? 'draft' : status,
        // ASAP submissions get a near-now stamp (+2min clears the PUT route's
        // future-time check); the post publishes on approval regardless.
        scheduledAt: status === 'scheduled' ? (asapApproval ? new Date(Date.now() + 120_000).toISOString() : scheduledAt) : null,
        requestApproval: submitForApproval || undefined,
        timezone,
        channels: selectedChannels.map((c) => ({
          channelId: c.channelId,
          platform: c.platform,
        })),
        labels: selectedLabels,
        postFormat: selectedFormat,
        postTypeOverrides: resolvedPostTypes,
        platformSpecific: firstComment.trim()
          ? { ...platformSpecific, _firstComment: firstComment.trim() }
          : platformSpecific,
        threadParts: isThreadFormat ? threadParts : undefined,
        autoPlugEnabled: autoPlugEnabled || undefined,
        autoPlugText: autoPlugEnabled ? autoPlugText.trim() || undefined : undefined,
        autoPlugThreshold: autoPlugEnabled ? autoPlugThreshold : undefined,
        autoRepostEnabled: autoRepostEnabled || undefined,
        autoRepostThreshold: autoRepostEnabled ? autoRepostThreshold : undefined,
        deleteMediaAfterPublish: !preserveMedia,
      };

      const res = await fetch(isEditing ? `/api/posts/${editPostId}` : '/api/posts', {
        method: isEditing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const parsed = parseApiError(errBody, isEditing ? 'Failed to update post' : 'Failed to create post');
        if (parsed.upgrade || parsed.code === 'QUOTA_EXCEEDED' || parsed.code === 'FEATURE_DISABLED') {
          track('composer_submit_blocked', { mode: status, code: parsed.code });
          setQuotaError(parsed);
          setSubmitPhase('error');
          setSubmitting(false);
          return;
        }
        throw new Error(parsed.message);
      }

      const created = await res.json();

      // Approver flow: "Approve & Schedule" saves the edit, then approves it
      // (which also publishes immediately if the scheduled time has passed).
      if (opts.approveAfter) {
        const apRes = await fetch(`/api/posts/${created.id}/approve`, { method: 'POST' });
        if (!apRes.ok) {
          const apErr = await apRes.json().catch(() => ({}));
          throw new Error(apErr.error?.message ?? 'Saved, but approving failed');
        }
      }

      if (submitForApproval && status === 'scheduled') {
        setSubmitPhase('done');
        setToast({ message: 'Submitted for approval', type: 'success' });
        setTimeout(() => {
          window.location.href = '/calendar';
        }, 800);
        return;
      }

      // Step 2: If "Publish Now", trigger publish and poll for result
      if (status === 'published') {
        setSubmitPhase('publishing');
        const pubRes = await fetch(`/api/posts/${created.id}/publish`, {
          method: 'POST',
        });

        if (!pubRes.ok) {
          const pubErr = await pubRes.json().catch(() => ({}));
          const pubMsg = pubErr.error?.message ?? pubErr.message ?? 'Post saved but publishing failed';
          throw new Error(pubMsg);
        }

        // Poll for completion
        setSubmitPhase('polling');
        const finalStatus = await pollPostStatus(created.id);

        if (finalStatus === 'published') {
          setSubmitPhase('done');
          setTimeout(() => {
            window.location.href = '/calendar';
          }, 400);
        } else if (finalStatus === 'processing') {
          // Platform (IG/Threads) is still finalizing in the background.
          // Treat as success; the worker will notify on background failure.
          setSubmitPhase('done');
          setToast({ message: 'Publishing. Some platforms are still finalizing in the background.', type: 'success' });
          setTimeout(() => {
            window.location.href = '/calendar';
          }, 400);
        } else if (finalStatus === 'partial') {
          setSubmitPhase('done');
          setToast({ message: 'Some platforms failed. Check post details.', type: 'error' });
          setTimeout(() => {
            window.location.href = '/calendar';
          }, 2000);
        } else {
          setSubmitPhase('error');
          setToast({ message: 'Publishing failed. Check notifications for details.', type: 'error' });
        }
      } else if (status === 'scheduled') {
        setSubmitPhase('done');
        setTimeout(() => {
          window.location.href = '/calendar';
        }, 400);
      } else {
        setSubmitPhase('done');
        setTimeout(() => {
          window.location.href = '/calendar';
        }, 400);
      }
    } catch (err: any) {
      track('composer_submit_failed', { mode: status, message: String(err?.message ?? 'unknown').slice(0, 200) });
      setSubmitPhase('error');
      setToast({ message: err.message ?? 'Something went wrong.', type: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  /* ---- Render ---- */
  return (
    <div style={styles.outerWrapper}>
      {/* Two-column grid: left (format bar + composer), right (preview) */}
      <div className="r-compose-row" style={styles.topRow}>
        {/* Left column */}
        <div style={styles.leftColumn}>
          {/* Post format bar */}
          <PostFormatBar selectedFormat={selectedFormat} onChange={handleFormatChange} />

          {/* Approval state banner (editing a pending/rejected post) */}
          {isEditing && editApproval?.status === 'pending' && (
            <div style={{ padding: '10px 14px', borderRadius: 'var(--radius-md)', background: 'var(--color-warning-bg)', border: '1px solid var(--color-warning-border)', fontSize: 'var(--text-sm)', color: 'var(--stone-700)' }}>
              This post is awaiting approval. It will not publish until an approver releases it.
            </div>
          )}
          {isEditing && editApproval?.status === 'rejected' && (
            <div style={{ padding: '10px 14px', borderRadius: 'var(--radius-md)', background: 'var(--color-error-bg)', border: '1px solid var(--color-error-border)', fontSize: 'var(--text-sm)', color: 'var(--stone-700)' }}>
              This post was rejected{editApproval.reason ? `: “${editApproval.reason}”` : '.'} Edit and reschedule it to resubmit for approval.
            </div>
          )}

          {/* Per-channel validation warnings */}
          {channelWarnings.size > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', padding: '0 4px' }}>
              {[...new Set([...channelWarnings.values()].flat())].map((msg, i) => (
                <span key={i} style={{ fontSize: 'var(--text-xs)', color: 'var(--color-error)', lineHeight: 'var(--leading-relaxed)' }}>
                  {msg}
                </span>
              ))}
            </div>
          )}

          {/* Composer card */}
          <div style={styles.composer}>
            {/* Channel selector - always visible */}
            <div style={styles.channelSection}>
              <ChannelSelector
                selectedChannels={selectedChannels}
                onChange={handleChannelsChange}
                disabledPlatforms={disabledPlatforms}
                formatLabel={activeFormat?.label}
                activeChannelId={activeChannelId}
                onChannelClick={handleChannelClick}
                onAllClick={() => setActiveChannelId(null)}
                platformsWithOverrides={platformsWithOverrides}
                channelWarnings={channelWarnings}
              />
            </div>

            {/* Per-platform resolved post type + override picker */}
            {!isThreadFormat && selectedChannels.length > 0 && (
              <div style={{ padding: '12px 20px 4px' }}>
                <PostTypeSummary
                  platformTypes={[...new Set(selectedChannels.map((c) => c.platform))].map(
                    (platform) => ({ platform, postType: resolvedPostTypes[platform] ?? 'default' }),
                  )}
                  mediaFiles={mediaFiles}
                  onOverride={handlePostTypeOverride}
                />
              </div>
            )}

            {/* Title field — shown for YouTube / Pinterest */}
            {hasTitlePlatform && (
              <div style={styles.titleSection}>
                <div style={{ position: 'relative' }}>
                  <input
                    type="text"
                    value={titleValue}
                    onChange={(e) => handleTitleChange(e.target.value)}
                    placeholder="Title*"
                    maxLength={100}
                    style={styles.titleInput}
                  />
                  {titleValue.length > 0 && (
                    <span style={{
                      ...styles.titleCounter,
                      color: titleValue.length >= 100 ? 'var(--color-error)' : 'var(--stone-400)',
                    }}>
                      {titleValue.length} / 100
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Content area */}
            {isThreadFormat ? (
              <div style={styles.contentSection}>
                <ThreadEditor
                  parts={activeThreadParts}
                  onChange={handleThreadPartsChange}
                  charLimit={activePlatform ? (CHAR_LIMITS[activePlatform] ?? lowestLimit) : lowestLimit}
                  platforms={selectedChannels.map((ch) => ch.platform)}
                  allMediaFiles={threadMediaPool}
                  onMediaUploaded={handleThreadMediaUploaded}
                  maxMediaPerPart={threadMediaLimits.maxMedia}
                  acceptTypes={threadMediaLimits.acceptTypes}
                />
              </div>
            ) : (
              <div style={styles.contentSection}>
                <div style={{ position: 'relative' }}>
                  <textarea
                    ref={textareaRef}
                    value={textareaValue}
                    onChange={(e) => handleContentChange(e.target.value)}
                    placeholder={
                      activePlatform
                        ? `Custom text for ${activePlatform} (leave empty to use default)`
                        : hasTitlePlatform
                          ? 'Description'
                          : "What's on your mind?"
                    }
                    style={{ ...styles.textarea, paddingRight: 60 }}
                  />
                </div>

                {/* Character counter - minimal */}
                {activeLimit !== null && activeLength > 0 && (
                  <div style={styles.charCounter}>
                    <span style={{ color: activeOverLimit ? 'var(--color-error)' : 'var(--stone-400)' }}>
                      {activeLength} / {activeLimit}
                    </span>
                  </div>
                )}

                {/* Format media hint */}
                {activeFormat && selectedFormat !== 'post' && mediaFiles.length === 0 && (
                  <div style={styles.mediaHint}>
                    {activeFormat.mediaHint}
                  </div>
                )}
              </div>
            )}

            {/* Expandable panels */}
            {showMedia && !isThreadFormat && (
              <div style={styles.panel}>
                <MediaUploader mediaFiles={mediaFiles} onChange={setMediaFiles} maxFiles={mediaLimits.maxMedia} acceptTypes={mediaLimits.allowedTypes} />
                {mediaFiles.length > 0 && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginTop: '8px' }}>
                    <input
                      type="checkbox"
                      checked={preserveMedia}
                      onChange={(e) => setPreserveMedia(e.target.checked)}
                      style={{ accentColor: 'var(--color-primary)' }}
                    />
                    <span style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-600)' }}>Keep original media after publishing</span>
                  </label>
                )}
              </div>
            )}

            {/* Platform-specific options (Pinterest board, GMB CTA, etc.) */}
            <PlatformOptions
              selectedChannels={selectedChannels}
              platformSpecific={platformSpecific}
              onChange={setPlatformSpecific}
              postTypes={resolvedPostTypes}
              onPostTypeOverride={handlePostTypeOverride}
              mediaWarning={mediaWarning}
            />

            {/* First Comment — auto-posted as a reply after publish */}
            {selectedChannels.length > 0 && (
              <div style={{ padding: '0 20px', marginTop: '8px' }}>
                <label style={{ fontSize: 'var(--text-xs)', fontWeight: 500, color: 'var(--stone-500)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  First Comment
                </label>
                <textarea
                  className="input"
                  rows={2}
                  placeholder="Auto-posted as a reply after publishing (optional)"
                  value={firstComment}
                  onChange={(e) => setFirstComment(e.target.value)}
                  style={{ fontSize: 'var(--text-sm)', resize: 'vertical', marginTop: '4px' }}
                />
                <p style={{ fontSize: '11px', color: 'var(--stone-400)', margin: '4px 0 0', lineHeight: 1.4 }}>
                  Supported on Instagram, Facebook, X, LinkedIn, Threads, Bluesky, YouTube, and Mastodon.
                </p>
              </div>
            )}

            {/* Automation — Auto-Plug & Auto-Repost */}
            {selectedChannels.length > 0 && (
              <div style={{ padding: '0 20px', marginTop: '12px' }}>
                <label style={{ fontSize: 'var(--text-xs)', fontWeight: 500, color: 'var(--stone-500)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px', display: 'block' }}>
                  Automation
                </label>

                {/* Auto-Plug */}
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginBottom: '6px' }}>
                  <input
                    type="checkbox"
                    checked={autoPlugEnabled}
                    onChange={(e) => setAutoPlugEnabled(e.target.checked)}
                    style={{ accentColor: 'var(--color-primary)' }}
                  />
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-700)' }}>Auto-comment when post goes viral</span>
                </label>
                {autoPlugEnabled && (
                  <div style={{ paddingLeft: '26px', display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '10px' }}>
                    <textarea
                      className="input"
                      rows={2}
                      placeholder="Promotional comment to post (e.g. link to your product)"
                      value={autoPlugText}
                      onChange={(e) => setAutoPlugText(e.target.value)}
                      style={{ fontSize: 'var(--text-sm)', resize: 'vertical' }}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-500)' }}>Trigger at</span>
                      <input
                        type="number"
                        className="input"
                        min={1}
                        value={autoPlugThreshold}
                        onChange={(e) => setAutoPlugThreshold(Math.max(1, parseInt(e.target.value) || 50))}
                        style={{ width: '80px', fontSize: 'var(--text-sm)', textAlign: 'center' }}
                      />
                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-500)' }}>likes</span>
                    </div>
                  </div>
                )}

                {/* Auto-Repost */}
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginBottom: '6px' }}>
                  <input
                    type="checkbox"
                    checked={autoRepostEnabled}
                    onChange={(e) => setAutoRepostEnabled(e.target.checked)}
                    style={{ accentColor: 'var(--color-primary)' }}
                  />
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-700)' }}>Auto-repost when post goes viral</span>
                </label>
                {autoRepostEnabled && (
                  <div style={{ paddingLeft: '26px', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-500)' }}>Trigger at</span>
                    <input
                      type="number"
                      className="input"
                      min={1}
                      value={autoRepostThreshold}
                      onChange={(e) => setAutoRepostThreshold(Math.max(1, parseInt(e.target.value) || 100))}
                      style={{ width: '80px', fontSize: 'var(--text-sm)', textAlign: 'center' }}
                    />
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-500)' }}>likes</span>
                  </div>
                )}
              </div>
            )}

            {showSchedule && (
              <div style={styles.panel}>
                <SchedulePicker
                  scheduledAt={scheduledAt}
                  timezone={timezone}
                  onChange={(at, tz) => {
                    setScheduledAt(at);
                    setTimezone(tz);
                  }}
                />
              </div>
            )}

            {showLabels && (
              <div style={{ ...styles.panel, paddingTop: 0 }}>
                <LabelDropdown labelType="post" selectedIds={selectedLabels} onChange={setSelectedLabels} triggerLabel="Add Labels" />
              </div>
            )}


            {quotaError && <ApiError error={quotaError} style={{ margin: '0 0 12px' }} />}

            {/* Bottom toolbar */}
            <div className="r-compose-toolbar" style={styles.toolbar}>
              <div style={styles.toolbarLeft}>
                <ToolbarButton
                  icon={icons.image}
                  label="Media"
                  active={showMedia}
                  onClick={() => setShowMedia((v) => !v)}
                />
                <ToolbarButton
                  icon={icons.calendar}
                  label={automationMode ? 'Repeat' : scheduledAt ? 'Scheduled' : 'Schedule'}
                  active={showSchedule}
                  onClick={() => {
                    if (!showSchedule) {
                      setShowSchedule(true);
                    } else if (scheduledAt) {
                      // Closing the panel with a schedule set would leave an
                      // invisible schedule attached to the post — confirm first.
                      setConfirmScheduleClear(true);
                    } else {
                      setShowSchedule(false);
                    }
                  }}
                />
                <ToolbarButton
                  icon={icons.tag}
                  label={selectedLabels.length > 0 ? `${selectedLabels.length} Labels` : 'Labels'}
                  active={showLabels}
                  onClick={() => setShowLabels((v) => !v)}
                />
              </div>

              <div className="r-compose-actions" style={styles.toolbarRight}>
                <button
                  type="button"
                  style={styles.btnSecondary}
                  disabled={submitting}
                  onClick={() => handleSubmit('draft')}
                >
                  {submitPhase === 'saving' && !queueLoading
                    ? 'Saving...'
                    : submitPhase === 'done' && !queueLoading
                      ? 'Saved!'
                      : isEditing ? 'Save Changes' : 'Save Draft'}
                </button>

                {!automationMode && !scheduledAt && !isEditing && (
                  <button
                    type="button"
                    style={{
                      ...styles.btnSecondary,
                      ...(queueDone ? { background: 'var(--color-success)', color: '#fff' } : {}),
                    }}
                    disabled={submitting || ttDisclosureIncomplete}
                    onClick={handleQueue}
                  >
                    {queueLoading
                      ? 'Queuing...'
                      : queueDone
                        ? 'Queued!'
                        : 'Add to Queue'}
                  </button>
                )}

                {automationMode ? (
                  <button
                    type="button"
                    style={{
                      ...styles.btnPrimary,
                      ...(submitPhase === 'done' ? { background: 'var(--color-success)' } : {}),
                      ...(submitPhase === 'error' ? { background: 'var(--color-error)' } : {}),
                    }}
                    disabled={submitting || ttDisclosureIncomplete}
                    onClick={() => handleSubmit('scheduled')}
                  >
                    {submitPhase === 'saving'
                      ? 'Saving...'
                      : submitPhase === 'done'
                        ? (isEditing ? 'Updated!' : 'Created!')
                        : isEditing ? 'Update Repeat Post' : 'Create Repeat Post'}
                  </button>
                ) : scheduledAt ? (
                  <button
                    type="button"
                    style={{
                      ...styles.btnPrimary,
                      ...(submitPhase === 'done' ? { background: 'var(--color-success)' } : {}),
                      ...(submitPhase === 'error' ? { background: 'var(--color-error)' } : {}),
                    }}
                    disabled={submitting || ttDisclosureIncomplete}
                    onClick={() => handleSubmit('scheduled')}
                  >
                    {submitPhase === 'saving'
                      ? 'Saving...'
                      : submitPhase === 'done'
                        ? (needsApproval ? 'Submitted!' : isEditing ? 'Updated!' : 'Scheduled!')
                        : needsApproval
                          ? 'Submit for Approval'
                          : isEditing ? 'Update Schedule' : 'Schedule'}
                  </button>
                ) : (
                  <button
                    type="button"
                    style={{
                      ...styles.btnPrimary,
                      ...(submitPhase === 'done' ? { background: 'var(--color-success)' } : {}),
                      ...(submitPhase === 'error' ? { background: 'var(--color-error)' } : {}),
                    }}
                    disabled={submitting || ttDisclosureIncomplete}
                    onClick={() => handleSubmit('published')}
                  >
                    {submitPhase === 'saving'
                      ? 'Saving...'
                      : submitPhase === 'publishing'
                        ? 'Publishing...'
                        : submitPhase === 'polling'
                          ? 'Publishing...'
                          : submitPhase === 'done'
                            ? (needsApproval ? 'Submitted!' : 'Published!')
                            : submitPhase === 'error'
                              ? 'Failed'
                              : needsApproval
                                ? 'Submit for Approval'
                                : isEditing ? 'Save & Publish' : 'Publish'}
                  </button>
                )}

                {/* Approver opening a pending post: approve (optionally after edits) in one click */}
                {isEditing && canApprove && editApproval?.status === 'pending' && !automationMode && (
                  <button
                    type="button"
                    style={{
                      ...styles.btnPrimary,
                      background: 'var(--color-success)',
                    }}
                    disabled={submitting || ttDisclosureIncomplete}
                    onClick={() => handleSubmit(scheduledAt ? 'scheduled' : 'draft', { approveAfter: true })}
                  >
                    {submitPhase === 'saving' || submitPhase === 'publishing'
                      ? 'Approving...'
                      : submitPhase === 'done'
                        ? 'Approved!'
                        : 'Approve & Schedule'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Preview column — starts at top right */}
        <div style={styles.previewColumn}>
          <Suspense fallback={<div style={{ padding: '40px', textAlign: 'center', color: 'var(--stone-400)', fontSize: 'var(--text-sm)' }}>Loading preview...</div>}>
            <PostPreview
              content={isThreadFormat ? (activeThreadParts[0]?.content || '') : content}
              title={titleValue || undefined}
              platforms={previewPlatforms}
              mediaUrl={previewMediaUrl}
              mediaUrls={allMediaUrls}
              mediaType={previewMediaType}
              postTypes={resolvedPostTypes}
              linkPreview={linkPreview}
              mediaDuration={mediaDuration}
              threadParts={isThreadFormat ? activeThreadParts : undefined}
              activePlatform={activePlatform as any}
              platformContent={platformContent}
              gmbCta={(platformSpecific as any).gmb ?? null}
            />
          </Suspense>
        </div>
      </div>

      {/* Customized post legend */}
      {platformsWithOverrides.size > 0 && (
        <div style={styles.customLegend}>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="var(--stone-400)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11.5 1.5l3 3L5 14H2v-3z" />
            <line x1="9" y1="4" x2="12" y2="7" />
          </svg>
          <span style={styles.customLegendText}>
            Channels with a pencil icon have customized content.
          </span>
        </div>
      )}

      {/* Platform reference + tips below */}
      <Suspense fallback={null}>
        <ComposeSidebar />
      </Suspense>

      {/* Validation errors dialog */}
      <Dialog
        open={validationErrors.length > 0}
        onClose={() => setValidationErrors([])}
        title="Can't submit yet"
        size="sm"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {validationErrors.map((err, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '10px 14px',
                background: 'var(--color-error-bg)',
                borderRadius: 'var(--radius-md)',
                fontSize: 'var(--text-sm)',
                color: '#991B1B',
                lineHeight: 'var(--leading-normal)',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <circle cx="8" cy="8" r="6.5" />
                <line x1="8" y1="5.5" x2="8" y2="8.5" />
                <circle cx="8" cy="11" r="0.5" fill="currentColor" />
              </svg>
              {err}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '20px' }}>
          <Button variant="primary" size="sm" onClick={() => setValidationErrors([])}>
            Got it
          </Button>
        </div>
      </Dialog>

      {/* Schedule clear confirmation */}
      <ConfirmDialog
        open={confirmScheduleClear}
        title="Remove schedule?"
        message={
          isEditing
            ? 'The scheduled date and time will be cleared. If you save, this post will no longer publish automatically.'
            : 'The scheduled date and time will be cleared, and this post will not publish automatically.'
        }
        confirmLabel="Remove schedule"
        danger
        onConfirm={() => {
          setScheduledAt(null);
          setShowSchedule(false);
          setConfirmScheduleClear(false);
        }}
        onCancel={() => setConfirmScheduleClear(false)}
      />

      {/* Toast notifications */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const styles: Record<string, React.CSSProperties> = {
  outerWrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  topRow: {
    display: 'grid',
    gridTemplateColumns: '3fr 2fr',
    gap: '24px',
    alignItems: 'start',
  },
  leftColumn: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    width: '100%',
    minWidth: 0,
  },
  previewColumn: {
    width: '100%',
    minWidth: 0,
  },
  composer: {
    background: 'var(--surface-card)',
    borderRadius: 'var(--radius-lg)',
    display: 'flex',
    flexDirection: 'column',
  },
  channelSection: {
    padding: '16px 20px',
    borderBottom: 'none',
    background: 'var(--stone-100)',
    borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0',
  },
  titleSection: {
    padding: '16px 20px 0',
  },
  titleLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-500)',
    marginBottom: '6px',
  },
  titleCounter: {
    position: 'absolute' as const,
    right: '12px',
    top: '50%',
    transform: 'translateY(-50%)',
    fontSize: 'var(--text-xs)',
    fontFamily: 'var(--font-mono)',
    pointerEvents: 'none' as const,
  },
  titleInput: {
    width: '100%',
    padding: '10px 90px 10px 14px',
    fontSize: 'var(--text-md)',
    fontWeight: 500,
    lineHeight: 'var(--leading-normal)',
    color: 'var(--stone-800)',
    background: 'var(--surface-main)',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    outline: 'none',
    fontFamily: 'inherit',
    transition: 'border-color var(--transition-fast)',
  },
  contentSection: {
    position: 'relative',
    padding: '0',
  },
  textarea: {
    width: '100%',
    minHeight: '160px',
    padding: '16px 20px',
    fontSize: 'var(--text-md)',
    lineHeight: 'var(--leading-relaxed)',
    color: 'var(--stone-800)',
    background: 'transparent',
    border: 'none',
    outline: 'none',
    resize: 'none',
    fontFamily: 'inherit',
  },
  charCounter: {
    position: 'absolute',
    bottom: '8px',
    right: '16px',
    fontSize: 'var(--text-xs)',
    fontFamily: 'var(--font-mono)',
  },
  mediaHint: {
    padding: '0 20px 12px',
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-400)',
    fontStyle: 'italic',
  },
  panel: {
    padding: '16px 20px',
    borderTop: 'none',
    animation: 'fadeInUp 200ms ease both',
  },
  mediaWarning: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    margin: '0 20px',
    padding: '8px 14px',
    borderRadius: 'var(--radius-md)',
    background: 'var(--color-warning-bg)',
    fontSize: 'var(--text-xs)',
    color: '#92400E',
    fontWeight: 500,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    // Wrap instead of overflowing. The mobile stacking rule keys off VIEWPORT
    // width (max-width:640px), but the space actually available depends on the
    // sidebar — on a normal window the action buttons overran the toolbar's own
    // right padding and sat flush against the edge.
    flexWrap: 'wrap',
    gap: '12px',
    padding: '16px 20px',
    borderTop: 'none',
    background: 'var(--stone-100)',
    borderRadius: '0 0 var(--radius-lg) var(--radius-lg)',
  },
  toolbarLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  toolbarRight: {
    display: 'flex',
    alignItems: 'center',
    // Keeps the action buttons inside the toolbar's padding when the row wraps.
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: '8px',
  },
  btnPrimary: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    height: 'var(--control-height-md)',
    padding: '0 20px',
    fontSize: 'var(--text-sm)',
    fontWeight: 600,
    borderRadius: 'var(--radius-pill)',
    border: 'none',
    background: 'var(--stone-900)',
    color: '#FFFFFF',
    cursor: 'pointer',
    transition: 'all var(--transition-fast)',
    whiteSpace: 'nowrap',
    boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
  },
  btnSecondary: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    height: 'var(--control-height-md)',
    padding: '0 20px',
    fontSize: 'var(--text-sm)',
    fontWeight: 500,
    borderRadius: 'var(--radius-pill)',
    border: 'none',
    background: 'var(--surface-main)',
    color: 'var(--stone-700)',
    cursor: 'pointer',
    transition: 'all var(--transition-fast)',
    whiteSpace: 'nowrap',
    boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
  },
  customLegend: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '0 4px',
  },
  customLegendText: {
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-400)',
    lineHeight: 'var(--leading-normal)',
  },
};
