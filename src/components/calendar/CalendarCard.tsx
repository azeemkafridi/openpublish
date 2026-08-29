import { memo, type CSSProperties } from 'react';

export interface CalendarPost {
  id: string;
  content: string;
  scheduled_at: string;
  status: 'draft' | 'scheduled' | 'publishing' | 'published' | 'partial' | 'failed' | 'processing';
  approvalStatus?: 'none' | 'pending' | 'approved' | 'rejected' | null;
  channels: Array<{ platform: string; status?: string; platformUrl?: string; errorMessage?: string | null }>;
  media?: Array<{ mimeType: string; thumbnailUrl?: string; previewUrl?: string; largeUrl?: string; originalUrl?: string }>;
}

export interface CalendarCardProps {
  post: CalendarPost;
  onClick?: (post: CalendarPost) => void;
  onHoverStart?: (post: CalendarPost, rect: DOMRect) => void;
  onHoverEnd?: () => void;
  isDragging?: boolean;
  onDragStart?: (post: CalendarPost) => void;
  onDragEnd?: () => void;
  variant?: 'month' | 'day';
}

const STATUS_CARD: Record<string, { bg: string; text: string; hover: string }> = {
  published:  { bg: '#ECFDF5', text: '#065F46', hover: '#D1FAE5' },
  scheduled:  { bg: '#FFF4E6', text: '#B85A00', hover: '#FFE8C7' },
  failed:     { bg: '#FEF2F2', text: '#991B1B', hover: '#FEE2E2' },
  draft:      { bg: '#F5F5F4', text: '#78716C', hover: '#E7E5E4' },
  publishing: { bg: '#EFF6FF', text: '#1E40AF', hover: '#DBEAFE' },
  partial:    { bg: '#FFFBEB', text: '#92400E', hover: '#FEF3C7' },
  processing: { bg: '#EFF6FF', text: '#1E40AF', hover: '#DBEAFE' },
};

// Platform-inspired palette for scheduled posts — picks color by first channel,
// falls back to ID-based rotation for variety
const PLATFORM_COLORS: Record<string, { bg: string; text: string; hover: string }> = {
  facebook:  { bg: '#E7F0FF', text: '#1264A3', hover: '#D0E2FF' },
  instagram: { bg: '#FCE7F3', text: '#9D174D', hover: '#FBCFE8' },
  x:         { bg: '#F0F0F0', text: '#1A1A1A', hover: '#E0E0E0' },
  threads:   { bg: '#F0F0F0', text: '#1A1A1A', hover: '#E0E0E0' },
  tiktok:    { bg: '#E0F7F7', text: '#00695C', hover: '#B2DFDB' },
  youtube:   { bg: '#FEECEC', text: '#B91C1C', hover: '#FDD' },
  linkedin:  { bg: '#E0F2FE', text: '#0369A1', hover: '#BAE6FD' },
  pinterest: { bg: '#FEECEC', text: '#B91C1C', hover: '#FDD' },
  bluesky:   { bg: '#E0F2FE', text: '#0369A1', hover: '#BAE6FD' },
  mastodon:  { bg: '#EDE9FE', text: '#5B21B6', hover: '#DDD6FE' },
  gmb:       { bg: '#E0F2FE', text: '#0369A1', hover: '#BAE6FD' },
  // Without these four, a Reddit/Discord/Telegram/Tumblr post fell through to
  // the id-rotation fallback below and changed colour depending on its id.
  reddit:    { bg: '#FFF0E6', text: '#C2410C', hover: '#FFE0CC' },
  discord:   { bg: '#EEF0FE', text: '#3730A3', hover: '#DDE0FD' },
  telegram:  { bg: '#E6F5FD', text: '#075985', hover: '#CCEAFA' },
  tumblr:    { bg: '#E8EBEF', text: '#1E293B', hover: '#D5DAE1' },
  snapchat:  { bg: '#FFFBD6', text: '#57530A', hover: '#FFF8B8' },
};

const FALLBACK_PALETTE = [
  { bg: '#FFF4E6', text: '#B85A00', hover: '#FFE8C7' },
  { bg: '#EDE9FE', text: '#5B21B6', hover: '#DDD6FE' },
  { bg: '#E0F2FE', text: '#0369A1', hover: '#BAE6FD' },
  { bg: '#FCE7F3', text: '#9D174D', hover: '#FBCFE8' },
  { bg: '#ECFCCB', text: '#3F6212', hover: '#D9F99D' },
  { bg: '#CCFBF1', text: '#115E59', hover: '#99F6E4' },
];

function getScheduledColor(post: CalendarPost) {
  // Single platform → use that platform's color
  if (post.channels?.length === 1) {
    const plat = post.channels[0].platform;
    if (PLATFORM_COLORS[plat]) return PLATFORM_COLORS[plat];
  }
  // Multiple platforms or no channels → rotate through palette by ID
  return FALLBACK_PALETTE[Number(post.id) % FALLBACK_PALETTE.length];
}

function CalendarCardImpl({ post, onClick, onHoverStart, onHoverEnd, isDragging, onDragStart, onDragEnd, variant = 'month' }: CalendarCardProps) {
  const sc = post.status === 'scheduled'
    ? getScheduledColor(post)
    : STATUS_CARD[post.status] ?? STATUS_CARD.draft;
  const label = post.content || new Date(post.scheduled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const isScheduled = post.status === 'scheduled';
  const isDay = variant === 'day';
  // A scheduled post held for approval won't publish at its slot — mark it so
  // the calendar doesn't read as "this is going out then".
  const awaitingApproval = post.approvalStatus === 'pending';

  const cardStyle: CSSProperties = {
    display: 'block',
    width: '100%',
    backgroundColor: sc.bg,
    borderRadius: isDay ? 0 : '4px',
    borderLeft: isDay ? `3px solid ${sc.text}` : 'none',
    padding: '3px 6px',
    cursor: isScheduled ? 'grab' : 'pointer',
    overflow: 'hidden',
    boxSizing: 'border-box',
    opacity: isDragging ? 0.4 : 1,
    transition: 'opacity 150ms ease',
  };

  return (
    <div
      style={cardStyle}
      draggable={isScheduled}
      onClick={(e) => { e.stopPropagation(); onClick?.(post); }}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', String(post.id));
        e.dataTransfer.effectAllowed = 'move';
        onDragStart?.(post);
      }}
      onDragEnd={() => onDragEnd?.()}
      onMouseOver={(e) => { e.currentTarget.style.backgroundColor = sc.hover; }}
      onMouseOut={(e) => { e.currentTarget.style.backgroundColor = sc.bg; }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = sc.hover;
        const rect = e.currentTarget.getBoundingClientRect();
        onHoverStart?.(post, rect);
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = sc.bg;
        onHoverEnd?.();
      }}
    >
      <p style={{
        margin: 0,
        fontSize: '10px',
        lineHeight: '13px',
        fontWeight: 500,
        color: sc.text,
        display: '-webkit-box',
        WebkitLineClamp: 1,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
        whiteSpace: 'normal',
      } as CSSProperties}>
        {awaitingApproval && (
          <span
            title="Awaiting approval"
            aria-label="Awaiting approval"
            style={{
              display: 'inline-block',
              width: '5px',
              height: '5px',
              borderRadius: '50%',
              background: 'var(--color-warning)',
              marginRight: '4px',
              verticalAlign: 'middle',
              flexShrink: 0,
            }}
          />
        )}
        {label}
      </p>
    </div>
  );
}

export const CalendarCard = memo(CalendarCardImpl);
