import type { ReactNode } from 'react';
import type { Platform } from './ChannelSelector';
import { PlatformIcon } from '@components/channels/PlatformIcon';
import { Select } from '@components/ui/Select';
import { THREAD_PLATFORMS } from '@lib/platforms/thread-support';

/* ------------------------------------------------------------------ */
/*  Format config                                                      */
/* ------------------------------------------------------------------ */

export interface FormatOption {
  value: string;
  label: string;
  description: string;
  supportedPlatforms: Platform[];
  platformPostTypes: Partial<Record<Platform, string>>;
  mediaHint: string;
}

/*
 * `supportedPlatforms` is a product decision (which formats we offer), but it
 * must never claim MORE than the server accepts. Ground truth is MEDIA_CONSTRAINTS
 * in lib/platforms/validation.ts — a platform belongs in a format only if its
 * post type there tolerates that format's media shape.
 *
 * Reddit, Discord, Telegram and Tumblr were absent from every format for months
 * after they shipped, which quietly excluded them from the format bar's platform
 * row and from `disabledPlatforms`. Each offers exactly one post type (`post`):
 *   reddit   — 1 image OR 1 video, media optional → post, video
 *   discord  — up to 10 mixed attachments        → post, video, carousel
 *   telegram — up to 10 mixed attachments        → post, video, carousel
 *   tumblr   — up to 30 images or 1 video        → post, video, carousel
 *   snapchat — exactly 1 image or video per post  → post (story), video (story), story, reel (spotlight)
 * None do reels, stories, or threads. Pinned by
 * tests/unit/compose/post-format-coverage.test.ts.
 */
export const POST_FORMATS: FormatOption[] = [
  {
    value: 'post',
    label: 'Post',
    description: 'Standard feed post with text and optional image',
    supportedPlatforms: ['facebook', 'instagram', 'x', 'threads', 'bluesky', 'tiktok', 'pinterest', 'gmb', 'linkedin', 'mastodon', 'reddit', 'discord', 'telegram', 'tumblr', 'snapchat'],
    platformPostTypes: { facebook: 'post', instagram: 'feed_photo', x: 'tweet', threads: 'text', bluesky: 'post', tiktok: 'photo_slideshow', pinterest: 'pin', gmb: 'post', linkedin: 'post', mastodon: 'post', reddit: 'post', discord: 'post', telegram: 'post', tumblr: 'post', snapchat: 'story' },
    mediaHint: 'Add an image or write text',
  },
  {
    value: 'video',
    label: 'Video',
    description: 'Upload a video to share on supported platforms',
    supportedPlatforms: ['facebook', 'instagram', 'x', 'youtube', 'tiktok', 'threads', 'bluesky', 'pinterest', 'linkedin', 'mastodon', 'reddit', 'discord', 'telegram', 'tumblr', 'snapchat'],
    platformPostTypes: { facebook: 'video', instagram: 'feed_video', x: 'video', youtube: 'video', tiktok: 'video', threads: 'video', bluesky: 'video', pinterest: 'video_pin', linkedin: 'post', mastodon: 'post', reddit: 'post', discord: 'post', telegram: 'post', tumblr: 'post', snapchat: 'story' },
    mediaHint: 'Upload a video file',
  },
  {
    value: 'reel',
    label: 'Reel / Short',
    description: 'Vertical short-form video for maximum reach',
    supportedPlatforms: ['facebook', 'instagram', 'youtube', 'tiktok', 'snapchat'],
    platformPostTypes: { facebook: 'reel', instagram: 'reel', youtube: 'short', tiktok: 'video', snapchat: 'spotlight' },
    mediaHint: 'Upload a vertical video (9:16)',
  },
  {
    value: 'story',
    label: 'Story',
    description: 'Ephemeral content that disappears after 24 hours',
    supportedPlatforms: ['facebook', 'instagram', 'snapchat'],
    platformPostTypes: { facebook: 'story', instagram: 'story', snapchat: 'story' },
    mediaHint: 'Add an image or video for your story',
  },
  {
    value: 'carousel',
    label: 'Carousel',
    description: 'Multi-image or video swipeable post',
    supportedPlatforms: ['facebook', 'instagram', 'threads', 'tiktok', 'pinterest', 'linkedin', 'discord', 'telegram', 'tumblr'],
    platformPostTypes: { facebook: 'carousel', instagram: 'carousel', threads: 'carousel', tiktok: 'photo_slideshow', pinterest: 'carousel', linkedin: 'multi_image', discord: 'post', telegram: 'post', tumblr: 'post' },
    mediaHint: 'Upload 2 or more images/videos',
  },
  {
    value: 'thread',
    label: 'Thread',
    description: 'Chain of connected posts published as a reply thread',
    supportedPlatforms: [...THREAD_PLATFORMS],
    platformPostTypes: { x: 'thread', threads: 'thread', bluesky: 'thread', mastodon: 'thread' },
    mediaHint: 'Each post in the thread can have its own media',
  },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export interface PostFormatBarProps {
  selectedFormat: string;
  onChange: (format: string) => void;
  /** Optional element rendered at the right of the platform-icon row (e.g. a Connect CTA). */
  action?: ReactNode;
}

export function PostFormatBar({ selectedFormat, onChange, action }: PostFormatBarProps) {
  const activeFormat = POST_FORMATS.find((f) => f.value === selectedFormat);

  return (
    <div style={styles.container}>
      {/* Pill buttons (desktop) */}
      <div className="r-format-pills" style={styles.pillRow}>
        {POST_FORMATS.map((fmt) => {
          const active = selectedFormat === fmt.value;
          return (
            <button
              key={fmt.value}
              type="button"
              onClick={() => onChange(fmt.value)}
              style={{
                ...styles.pill,
                background: active ? '#FFFFFF' : 'transparent',
                color: active ? 'var(--stone-900)' : 'var(--stone-600)',
                fontWeight: active ? 600 : 500,
                boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
              }}
            >
              {fmt.label}
            </button>
          );
        })}
      </div>

      {/* Dropdown (mobile) */}
      <div className="r-format-select" style={styles.selectWrap}>
        <Select
          aria-label="Post type"
          options={POST_FORMATS.map((f) => ({ value: f.value, label: f.label }))}
          value={selectedFormat}
          onChange={(e) => onChange(e.target.value)}
          style={{ background: 'var(--surface-card)' }}
        />
      </div>

      {/* Description + platform icons, with an optional right-aligned action */}
      {activeFormat && (
        <div style={styles.infoColumn}>
          <span style={styles.description}>{activeFormat.description}</span>
          <div className={action ? 'r-format-iconrow' : undefined} style={styles.iconRow}>
            <div style={styles.platformIcons}>
              {activeFormat.supportedPlatforms.map((p) => (
                <PlatformIcon key={p} platform={p} size="xs" />
              ))}
            </div>
            {action && <div className="r-format-action" style={styles.actionSlot}>{action}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const OUTER_PADDING = 4;
const OUTER_RADIUS = 12; // --radius-lg
const INNER_RADIUS = OUTER_RADIUS - OUTER_PADDING; // 8
const PILL_RADIUS = INNER_RADIUS - 3; // 5

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  pillRow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    flexWrap: 'wrap',
    background: 'var(--stone-100)',
    padding: `${OUTER_PADDING}px`,
    borderRadius: `${INNER_RADIUS}px`,
    width: 'fit-content',
  },
  pill: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '7px 16px',
    borderRadius: `${PILL_RADIUS}px`,
    border: 'none',
    fontSize: 'var(--text-sm)',
    cursor: 'pointer',
    transition: 'all var(--transition-fast)',
    whiteSpace: 'nowrap',
  },
  selectWrap: {
    width: '220px',
    maxWidth: '100%',
  },
  infoColumn: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    paddingLeft: `${OUTER_PADDING}px`,
  },
  description: {
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-500)',
    lineHeight: 1.4,
  },
  iconRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    flexWrap: 'wrap',
  },
  platformIcons: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
    minWidth: 0,
  },
  actionSlot: {
    display: 'flex',
    justifyContent: 'flex-end',
    flexShrink: 0,
  },
};
