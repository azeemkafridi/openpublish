import { useState } from 'react';
import { Avatar, threadComments, type PlatformEngagement } from './engagement-shared';
import type { Platform } from '../compose/PostPreview';

/**
 * Real comments rendered inside the post mockup, the way the network itself
 * shows them — attached under the action bar rather than in a separate "Who
 * engaged" card below the preview.
 *
 * WHY THIS IS PER-PLATFORM AND NOT ONE GENERIC LIST
 * -------------------------------------------------
 * The whole point of the mockup is that it looks like the network. A comment
 * thread in openPublish's own type scale and stone palette dropped into a
 * Facebook card reads as a bug, not as a comment thread. So this carries a
 * small skin per network — Facebook's grey bubbles, Instagram's flat
 * username-then-text lines, X's threaded replies, LinkedIn's bordered rows,
 * YouTube's avatar + timestamp — and nothing else.
 *
 * Only the networks with a skin here get inline comments. The four without one
 * (TikTok, Pinterest, Google Business, Telegram) have no readable comments API
 * at all — there is nothing to attach.
 */

/**
 * Networks whose mockup can host a comment thread — i.e. every network whose
 * handler implements getPostEngagement. The four that are missing (TikTok,
 * Pinterest, Google Business, Telegram) have no comment API at all, which their
 * handlers now state explicitly rather than inheriting the base default; there
 * is nothing to render for them and they are filtered out upstream.
 */
export const INLINE_COMMENT_PLATFORMS = new Set<string>([
  'facebook', 'instagram', 'x', 'linkedin', 'youtube',
  'threads', 'bluesky', 'mastodon', 'reddit', 'discord', 'tumblr',
]);

export function supportsInlineComments(platform: string): boolean {
  return INLINE_COMMENT_PLATFORMS.has(platform);
}

/** How many to show before the "view more" line — matches what the networks do. */
const COLLAPSED_COUNT = 2;

interface Props {
  platform: Platform;
  entry: PlatformEngagement | null;
  loading: boolean;
  onRefresh: () => void;
}

export function PreviewComments({ platform, entry, loading, onRefresh }: Props) {
  const [expanded, setExpanded] = useState(false);

  const comments = entry?.engagement?.comments ?? [];
  const threaded = threadComments(comments);
  const shown = expanded ? threaded : threaded.slice(0, COLLAPSED_COUNT);
  const hidden = threaded.length - shown.length;

  const skin = SKINS[platform] ?? SKINS.facebook;

  // Why the thread is empty, when it is empty for a reason. `entry.error` is the
  // route's own failure; `commentsNotice` is the handler saying the comment read
  // itself did not succeed (no token, a gate declined, the API errored). Plain
  // `notice` is NOT used here — it also carries reaction-scoped messages like
  // "YouTube does not expose individual likers", which explains nothing about a
  // missing thread.
  const reason = entry?.error ?? entry?.engagement?.commentsNotice ?? null;

  // Nothing fetched yet, and nothing to say — render nothing rather than an
  // empty bordered strip hanging off the bottom of the card.
  if (!entry && !loading) return null;
  // `engagement: null` with no error is a channel this post never published to;
  // there is genuinely no thread to host. With an error it IS published and the
  // read failed, which the user needs to see — that case falls through and the
  // reason is rendered below. Reporting it as "No comments yet" was the bug:
  // the metrics card above can say "2 comments" while this asserted zero.
  if (entry && entry.engagement === null && !entry.error && !loading) return null;

  return (
    <div style={{ borderTop: `1px solid ${skin.divider}`, background: skin.background, padding: skin.padding }}>
      {loading && comments.length === 0 && (
        <div style={{ ...skin.meta, padding: '2px 0' }}>Loading comments…</div>
      )}

      {!loading && comments.length === 0 && (
        <div style={{ ...skin.meta, padding: '2px 0' }}>
          {reason ?? 'No comments yet.'}
        </div>
      )}

      {shown.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: skin.rowGap }}>
          {shown.map(({ comment, depth }) => (
            <div key={comment.id} style={depth > 0 ? { marginLeft: skin.replyIndent } : undefined}>
              <NativeComment comment={comment} skin={skin} isReply={depth > 0} />
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginTop: shown.length > 0 ? '10px' : '4px' }}>
        {hidden > 0 ? (
          <button type="button" onClick={() => setExpanded(true)} style={{ ...skin.more, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
            {skin.moreLabel(hidden)}
          </button>
        ) : expanded && threaded.length > COLLAPSED_COUNT ? (
          <button type="button" onClick={() => setExpanded(false)} style={{ ...skin.more, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
            Show fewer comments
          </button>
        ) : <span />}

        {/* These are fetched live from the network, not from our metrics
            snapshot, so the user needs a way to re-read them. */}
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          title="Fetch the latest comments from the platform"
          style={{ ...skin.meta, background: 'none', border: 'none', padding: 0, cursor: loading ? 'default' : 'pointer' }}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  One comment, in the host network's clothes                         */
/* ------------------------------------------------------------------ */

function NativeComment({
  comment, skin, isReply,
}: {
  comment: ReturnType<typeof threadComments>[number]['comment'];
  skin: Skin;
  isReply: boolean;
}) {
  const { actor, text, likeCount, createdAt } = comment;
  // Replies use the SAME avatar size as top-level comments. Shrinking nested
  // ones made the thread look like a rendering glitch rather than a hierarchy —
  // the indent already carries the nesting.
  const size = skin.avatar;

  return (
    <div style={{ display: 'flex', gap: '8px' }}>
      <Avatar actor={actor} size={size} />
      <div style={{ minWidth: 0, flex: 1 }}>
        {skin.bubble ? (
          // Facebook / LinkedIn: name and text share a rounded block.
          <div style={{ background: skin.bubble, borderRadius: '16px', padding: '6px 12px', display: 'inline-block', maxWidth: '100%' }}>
            <div style={skin.name}>{actor.name}</div>
            <div style={skin.text}>{text}</div>
          </div>
        ) : (
          // Instagram / X / YouTube: name inline with, or directly above, the text.
          <div>
            <span style={skin.name}>{actor.name}</span>
            <span style={{ ...skin.text, marginLeft: skin.inlineName ? '6px' : 0, display: skin.inlineName ? 'inline' : 'block' }}>
              {text}
            </span>
          </div>
        )}
        <div style={{ ...skin.meta, display: 'flex', gap: '12px', marginTop: '3px' }}>
          {createdAt && <span>{relativeDate(createdAt)}</span>}
          {typeof likeCount === 'number' && likeCount > 0 && (
            <span>{likeCount} {likeCount === 1 ? 'like' : 'likes'}</span>
          )}
          <span>Reply</span>
        </div>
      </div>
    </div>
  );
}

function relativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  const days = Math.round(mins / 1440);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/* ------------------------------------------------------------------ */
/*  Skins                                                              */
/* ------------------------------------------------------------------ */

interface Skin {
  divider: string;
  background: string;
  padding: string;
  rowGap: string;
  replyIndent: string;
  avatar: number;
  /** Set to a colour to wrap name+text in a rounded block (Facebook style). */
  bubble?: string;
  /** Name sits on the same line as the text (Instagram style). */
  inlineName?: boolean;
  name: React.CSSProperties;
  text: React.CSSProperties;
  meta: React.CSSProperties;
  more: React.CSSProperties;
  moreLabel: (n: number) => string;
}

const SKINS: Record<string, Skin> = {
  facebook: {
    divider: '#DADDE1', background: '#FFFFFF', padding: '10px 16px 12px',
    rowGap: '10px', replyIndent: '36px', avatar: 32, bubble: '#F0F2F5',
    name: { fontSize: '13px', fontWeight: 600, color: '#050505' },
    text: { fontSize: '13px', color: '#050505', lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    meta: { fontSize: '12px', fontWeight: 600, color: '#65676B' },
    more: { fontSize: '13px', fontWeight: 600, color: '#65676B' },
    moreLabel: (n) => `View ${n} more comment${n === 1 ? '' : 's'}`,
  },
  instagram: {
    divider: '#EFEFEF', background: '#FFFFFF', padding: '8px 16px 12px',
    rowGap: '12px', replyIndent: '34px', avatar: 28, inlineName: true,
    name: { fontSize: '14px', fontWeight: 600, color: '#262626' },
    text: { fontSize: '14px', color: '#262626', lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    meta: { fontSize: '12px', color: '#8E8E8E' },
    more: { fontSize: '14px', color: '#8E8E8E' },
    moreLabel: (n) => `View all ${n} more comments`,
  },
  x: {
    divider: '#EFF3F4', background: '#FFFFFF', padding: '10px 16px 12px',
    rowGap: '14px', replyIndent: '32px', avatar: 32,
    name: { fontSize: '14px', fontWeight: 700, color: '#0F1419' },
    text: { fontSize: '14px', color: '#0F1419', lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    meta: { fontSize: '13px', color: '#536371' },
    more: { fontSize: '14px', color: '#1D9BF0' },
    moreLabel: (n) => `Show ${n} more repl${n === 1 ? 'y' : 'ies'}`,
  },
  linkedin: {
    divider: '#E0E0E0', background: '#FFFFFF', padding: '10px 16px 12px',
    rowGap: '12px', replyIndent: '36px', avatar: 32, bubble: '#F2F2F2',
    name: { fontSize: '13px', fontWeight: 600, color: 'rgba(0,0,0,0.9)' },
    text: { fontSize: '13px', color: 'rgba(0,0,0,0.9)', lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    meta: { fontSize: '12px', fontWeight: 600, color: 'rgba(0,0,0,0.6)' },
    more: { fontSize: '13px', fontWeight: 600, color: 'rgba(0,0,0,0.6)' },
    moreLabel: (n) => `Load ${n} more comment${n === 1 ? '' : 's'}`,
  },
  youtube: {
    divider: '#E5E5E5', background: '#FFFFFF', padding: '10px 12px 12px',
    rowGap: '14px', replyIndent: '32px', avatar: 28,
    name: { fontSize: '13px', fontWeight: 500, color: '#0F0F0F' },
    text: { fontSize: '13px', color: '#0F0F0F', lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    meta: { fontSize: '12px', color: '#606060' },
    more: { fontSize: '13px', fontWeight: 500, color: '#065FD4' },
    moreLabel: (n) => `Show ${n} more comment${n === 1 ? '' : 's'}`,
  },

  threads: {
    divider: '#DBDBDB', background: '#FFFFFF', padding: '10px 16px 12px',
    rowGap: '14px', replyIndent: '34px', avatar: 32,
    name: { fontSize: '14px', fontWeight: 600, color: '#000000' },
    text: { fontSize: '14px', color: '#000000', lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    meta: { fontSize: '13px', color: '#999999' },
    more: { fontSize: '14px', color: '#999999' },
    moreLabel: (n) => `View ${n} more repl${n === 1 ? 'y' : 'ies'}`,
  },
  bluesky: {
    divider: '#E5E6EB', background: '#FFFFFF', padding: '10px 16px 12px',
    rowGap: '14px', replyIndent: '32px', avatar: 30,
    name: { fontSize: '14px', fontWeight: 600, color: '#0B0F14' },
    text: { fontSize: '14px', color: '#0B0F14', lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    meta: { fontSize: '13px', color: '#6F869F' },
    more: { fontSize: '14px', color: '#1185FE' },
    moreLabel: (n) => `${n} more repl${n === 1 ? 'y' : 'ies'}`,
  },
  mastodon: {
    divider: '#C0CDD9', background: '#FFFFFF', padding: '10px 16px 12px',
    rowGap: '14px', replyIndent: '32px', avatar: 32,
    name: { fontSize: '14px', fontWeight: 700, color: '#191B22' },
    text: { fontSize: '14px', color: '#191B22', lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    meta: { fontSize: '13px', color: '#606984' },
    more: { fontSize: '14px', color: '#6364FF' },
    moreLabel: (n) => `Show ${n} more repl${n === 1 ? 'y' : 'ies'}`,
  },
  reddit: {
    // Reddit threads read as a rail of nested replies, so the indent does the
    // work and each comment is plain text under its author line.
    divider: '#EDEFF1', background: '#FFFFFF', padding: '10px 16px 12px',
    rowGap: '14px', replyIndent: '28px', avatar: 26,
    name: { fontSize: '12px', fontWeight: 700, color: '#1C1C1C' },
    text: { fontSize: '14px', color: '#1C1C1C', lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    meta: { fontSize: '12px', fontWeight: 700, color: '#7C7C7C' },
    more: { fontSize: '12px', fontWeight: 700, color: '#7C7C7C' },
    moreLabel: (n) => `${n} more comment${n === 1 ? '' : 's'}`,
  },
  discord: {
    // The only dark skin — a light comment strip under a Discord message would
    // look like a different app.
    divider: 'rgba(255,255,255,0.08)', background: '#2B2D31', padding: '10px 16px 12px',
    rowGap: '12px', replyIndent: '30px', avatar: 28,
    name: { fontSize: '14px', fontWeight: 500, color: '#F2F3F5' },
    text: { fontSize: '14px', color: '#DBDEE1', lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    meta: { fontSize: '12px', color: '#949BA4' },
    more: { fontSize: '13px', fontWeight: 500, color: '#00A8FC' },
    moreLabel: (n) => `Show ${n} more message${n === 1 ? '' : 's'}`,
  },
  tumblr: {
    divider: 'rgba(0,0,0,0.13)', background: '#FFFFFF', padding: '10px 16px 12px',
    rowGap: '14px', replyIndent: '30px', avatar: 28,
    name: { fontSize: '14px', fontWeight: 700, color: '#00101C' },
    text: { fontSize: '14px', color: '#00101C', lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    meta: { fontSize: '12px', color: 'rgba(0,16,28,0.65)' },
    more: { fontSize: '13px', fontWeight: 700, color: 'rgba(0,16,28,0.65)' },
    moreLabel: (n) => `Show ${n} more note${n === 1 ? '' : 's'}`,
  },
};
