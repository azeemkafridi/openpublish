import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Shared plumbing + presentation for post engagement (real commenters and
 * reactors pulled live from the platform).
 *
 * Two consumers: the collapsible panel in the Post Details dialog, and the
 * card under the metrics in the Analytics → Posts preview pane.
 *
 * Platforms that have no commenter/reactor API (the base handler returns
 * `unsupported: true`) are filtered out entirely — never surfaced as a
 * "not supported" message, which is noise the user can't act on.
 */

export interface Actor {
  id: string;
  name: string;
  handle?: string;
  headline?: string;
  profileImage?: string;
  profileUrl?: string;
}

export interface Comment {
  id: string;
  text: string;
  createdAt?: string;
  likeCount?: number;
  actor: Actor;
  /** Set when this comment replies to another — rendered indented beneath it. */
  parentId?: string;
}

export interface Reaction {
  id: string;
  type?: string;
  createdAt?: string;
  actor: Actor;
}

export interface PlatformEngagement {
  platform: string;
  accountName?: string | null;
  platformPostId: string | null;
  platformUrl: string | null;
  engagement: {
    comments: Comment[];
    reactions: Reaction[];
    hasMoreComments?: boolean;
    hasMoreReactions?: boolean;
    unsupported?: boolean;
    reactionsUnsupported?: boolean;
    notice?: string;
    /** Why the COMMENT read specifically produced nothing. See EngagementData. */
    commentsNotice?: string;
  } | null;
  error?: string;
}

export interface EngagementResponse {
  postId: number;
  platforms: PlatformEngagement[];
}

/**
 * A platform is worth showing only if it can report commenters/reactors at all.
 * `engagement: null` (not yet published to that platform) is kept, so the row
 * can still explain itself; `unsupported` is dropped.
 */
export function isEngagementCapable(p: PlatformEngagement): boolean {
  return !p.engagement?.unsupported;
}

/** Live-fetches engagement for a post. Only runs while `enabled`. */
export function useEngagement(postId: number, enabled: boolean) {
  const [data, setData] = useState<EngagementResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);

  // Guards against a slow response for a previously-selected post landing after
  // a newer one and overwriting it (clicking down the analytics list is fast).
  const requestRef = useRef(0);

  /** `force` bypasses the server's 60s cache — used by the Refresh control. */
  const load = useCallback((force = false) => {
    const seq = ++requestRef.current;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/posts/${postId}/engagement${force ? '?force=1' : ''}`);
        const d = (await res.json()) as EngagementResponse;
        if (seq !== requestRef.current) return; // superseded
        setData({ ...d, platforms: (d.platforms ?? []).filter(isEngagementCapable) });
        setFetchedAt(new Date());
      } catch {
        // Leave the previous data in place; the Refresh control stays available.
      } finally {
        if (seq === requestRef.current) setLoading(false);
      }
    })();
  }, [postId]);

  // Refetch when the post changes; drop stale data so the previous post's
  // commenters can't flash under the new selection.
  useEffect(() => {
    requestRef.current++;
    setData(null);
    setFetchedAt(null);
  }, [postId]);

  useEffect(() => {
    if (!enabled || data) return;
    load();
  }, [enabled, data, load]);

  return { data, loading, fetchedAt, reload: () => load(true) };
}

/* ------------------------------------------------------------------ */
/*  Lists                                                              */
/* ------------------------------------------------------------------ */

/**
 * Commenter/reactor tabs for a single platform. Borderless by design — the
 * caller supplies the surface, so this sits flush inside a card instead of
 * drawing a second box inside one.
 */
export function EngagementLists({ entry }: { entry: PlatformEngagement }) {
  const [tab, setTab] = useState<'comments' | 'reactions'>('comments');
  const e = entry.engagement;

  if (entry.error) {
    return <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-error-text)', margin: 0 }}>{entry.error}</p>;
  }

  if (!e) {
    return (
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-500)', margin: 0 }}>
        Not published to this channel yet.
      </p>
    );
  }

  // Threads/Instagram/YouTube expose repliers but never individual likers, so
  // their Reactors tab would be permanently "(0)" — hide it rather than show a
  // control that can never have content.
  const showReactions = !e.reactionsUnsupported;
  const activeTab = showReactions ? tab : 'comments';

  return (
    <>
      {showReactions ? (
        <div style={{ display: 'flex', gap: '4px', marginBottom: '12px' }}>
          <TabButton active={activeTab === 'comments'} onClick={() => setTab('comments')}>
            Commenters ({e.comments.length}{e.hasMoreComments ? '+' : ''})
          </TabButton>
          <TabButton active={activeTab === 'reactions'} onClick={() => setTab('reactions')}>
            Reactors ({e.reactions.length}{e.hasMoreReactions ? '+' : ''})
          </TabButton>
        </div>
      ) : (
        <p style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--stone-500)', margin: '0 0 10px' }}>
          Commenters ({e.comments.length}{e.hasMoreComments ? '+' : ''})
        </p>
      )}

      {e.notice && (
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-500)', margin: '0 0 10px' }}>{e.notice}</p>
      )}

      {activeTab === 'comments' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {/* Only claim an empty thread when the read actually came back — a
              failed one is explained by `commentsNotice` (shown as the notice
              line above), not by asserting a zero. */}
          {e.comments.length === 0 && (
            <EmptyLine>{e.commentsNotice ? 'Comments could not be read.' : 'No comments yet.'}</EmptyLine>
          )}
          {threadComments(e.comments).map(({ comment, depth }) => (
            <div key={comment.id} style={depth > 0 ? { marginLeft: '28px' } : undefined}>
              <CommentRow comment={comment} isReply={depth > 0} />
            </div>
          ))}
        </div>
      )}

      {activeTab === 'reactions' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {e.reactions.length === 0 && <EmptyLine>No reactions yet.</EmptyLine>}
          {e.reactions.map((r) => (
            <ReactorBadge key={r.id} reaction={r} />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Order comments so replies sit directly under the comment they answer.
 * Any reply whose parent isn't in the page (paging cut it off) falls back to
 * top level so it is never dropped.
 */
export function threadComments(comments: Comment[]): Array<{ comment: Comment; depth: number }> {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const childrenOf = new Map<string, Comment[]>();
  const roots: Comment[] = [];

  for (const c of comments) {
    if (c.parentId && byId.has(c.parentId)) {
      const list = childrenOf.get(c.parentId) ?? [];
      list.push(c);
      childrenOf.set(c.parentId, list);
    } else {
      roots.push(c);
    }
  }

  const out: Array<{ comment: Comment; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (c: Comment, depth: number) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    out.push({ comment: c, depth });
    // Facebook only nests one level, but guard the depth anyway.
    for (const child of childrenOf.get(c.id) ?? []) walk(child, Math.min(depth + 1, 1));
  };
  roots.forEach((r) => walk(r, 0));

  // A parent cycle (including a self-parenting comment, which Facebook has been
  // seen to return) leaves members unreachable from any root. Render them at top
  // level rather than dropping them — the count above the list would disagree
  // with the list itself.
  for (const c of comments) if (!seen.has(c.id)) walk(c, 0);
  return out;
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-400)', margin: 0 }}>{children}</p>;
}

/** Pill tabs — matches the chip styling used elsewhere on the analytics page. */
export function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '5px 12px',
        background: active ? 'var(--stone-800)' : 'transparent',
        border: 'none',
        borderRadius: 'var(--radius-pill)',
        cursor: 'pointer',
        fontSize: 'var(--text-xs)',
        fontWeight: 600,
        color: active ? '#fff' : 'var(--stone-500)',
      }}
    >
      {children}
    </button>
  );
}

/** A comment: avatar + name + text. No card border — separated by spacing. */
export function CommentRow({ comment, isReply }: { comment: Comment; isReply?: boolean }) {
  const { actor, text, createdAt, likeCount } = comment;
  return (
    <div style={{ display: 'flex', gap: '10px' }}>
      <Avatar actor={actor} size={isReply ? 24 : 32} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
          <ActorName actor={actor} small={isReply} />
          {isReply && (
            <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--stone-400)' }}>REPLY</span>
          )}
          {createdAt && (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>
              {new Date(createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </span>
          )}
        </div>
        {actor.headline && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-500)', marginTop: '1px' }}>{actor.headline}</div>
        )}
        <div
          style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--stone-700)',
            marginTop: '4px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            lineHeight: 1.5,
          }}
        >
          {text}
        </div>
        {typeof likeCount === 'number' && likeCount > 0 && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-500)', marginTop: '4px' }}>
            {likeCount} {likeCount === 1 ? 'like' : 'likes'}
          </div>
        )}
      </div>
    </div>
  );
}

export function ReactorBadge({ reaction }: { reaction: Reaction }) {
  const { actor, type } = reaction;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '4px 12px 4px 4px',
        background: 'var(--stone-50)',
        borderRadius: 'var(--radius-pill)',
      }}
    >
      <Avatar actor={actor} size={24} />
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <ActorName actor={actor} small />
        {type && type !== 'LIKE' && (
          <span style={{ fontSize: '10px', color: 'var(--stone-500)', textTransform: 'capitalize' }}>
            {type.toLowerCase()}
          </span>
        )}
      </div>
    </div>
  );
}

export function Avatar({ actor, size = 32 }: { actor: Actor; size?: number }) {
  if (actor.profileImage) {
    return (
      <img
        src={actor.profileImage}
        alt={actor.name}
        width={size}
        height={size}
        style={{ borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
      />
    );
  }
  return (
    <div
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: '50%',
        background: 'var(--stone-200)',
        color: 'var(--stone-600)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: `${Math.max(10, size / 2.5)}px`,
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {actor.name.charAt(0).toUpperCase()}
    </div>
  );
}

export function ActorName({ actor, small }: { actor: Actor; small?: boolean }) {
  const style: React.CSSProperties = {
    fontSize: small ? 'var(--text-xs)' : 'var(--text-sm)',
    fontWeight: 600,
    color: 'var(--stone-800)',
    textDecoration: 'none',
  };
  if (actor.profileUrl) {
    return (
      <a href={actor.profileUrl} target="_blank" rel="noopener noreferrer" style={style}>
        {actor.name}
        {actor.handle && actor.handle !== actor.name && (
          <span style={{ color: 'var(--stone-400)', fontWeight: 400, marginLeft: '4px' }}>@{actor.handle}</span>
        )}
      </a>
    );
  }
  return <span style={style}>{actor.name}</span>;
}
