import { useState, useRef, useEffect } from 'react';
import { platformDisplayName } from '@lib/platforms/types';
import { PlatformDots } from '../channels/PlatformIcon';
import { MetricsBadge } from './MetricsBadge';

/* ------------------------------------------------------------------ */
/*  Shared post type for both Overview and Analytics consumers         */
/* ------------------------------------------------------------------ */

export interface TopPostItem {
  postId: number;
  content: string;
  thumbnail?: string;
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
  platforms: Array<{ platform: string; platformUrl?: string | null }>;
}

/** Normalize post data from /api/posts into the shared TopPostItem format */
export function normalizePostsApiData(post: {
  id: number;
  content: string;
  mediaFiles?: Array<{ thumbnailUrl?: string | null }>;
  postPlatforms: Array<{ platform: string; status?: string; platformUrl?: string | null }>;
  metrics?: { impressions?: number; likes?: number; comments?: number; shares?: number } | null;
}): TopPostItem {
  const firstMedia = Array.isArray(post.mediaFiles) && post.mediaFiles.length > 0 ? post.mediaFiles[0] : null;
  return {
    postId: post.id,
    content: post.content || '',
    thumbnail: firstMedia?.thumbnailUrl ?? undefined,
    impressions: post.metrics?.impressions ?? 0,
    likes: post.metrics?.likes ?? 0,
    comments: post.metrics?.comments ?? 0,
    shares: post.metrics?.shares ?? 0,
    platforms: post.postPlatforms.map((pp) => ({
      platform: pp.platform,
      platformUrl: pp.status === 'published' ? pp.platformUrl : undefined,
    })),
  };
}

/* ------------------------------------------------------------------ */
/*  TopPosts list component                                            */
/* ------------------------------------------------------------------ */

export function TopPosts({ posts }: { posts: TopPostItem[] }) {
  if (!posts || posts.length === 0) {
    return (
      <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--stone-400)', fontSize: 'var(--text-sm)' }}>
        No published posts with engagement data yet
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {posts.map((post) => (
        <TopPostRow key={post.postId} post={post} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Single post row                                                    */
/* ------------------------------------------------------------------ */

function TopPostRow({ post }: { post: TopPostItem }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  return (
    <div
      style={{ ...s.row, cursor: 'pointer' }}
      className="overview-feed-item"
      onClick={() => { window.location.href = `/analytics?tab=posts&post=${post.postId}`; }}
    >
      {/* Thumbnail */}
      {post.thumbnail ? (
        <div style={s.thumb}>
          <img src={post.thumbnail} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>
      ) : (
        <div style={{ ...s.thumb, background: 'var(--stone-100)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--stone-300)' }}>T</span>
        </div>
      )}

      {/* Content + platforms + metrics stacked */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={s.content}>{post.content || '(no text)'}</p>
        {/* Platform icons on one line, metrics always on their own line below */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '6px', marginTop: '6px' }}>
          {/* Platform dots — brand-colored, matching the channel breakdown */}
          <PlatformDots platforms={post.platforms.map((p) => p.platform)} />

          {/* Metrics inline */}
          <MetricsBadge
            impressions={post.impressions}
            likes={post.likes}
            comments={post.comments}
            shares={post.shares}
          />
        </div>
      </div>

      {/* 3-dot menu */}
      <div ref={menuRef} style={{ position: 'relative', flexShrink: 0 }}>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}
          style={s.menuBtn}
          onMouseOver={(e) => (e.currentTarget.style.background = 'var(--stone-150)')}
          onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
          aria-label="Post actions"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="8" cy="3" r="1.5" />
            <circle cx="8" cy="8" r="1.5" />
            <circle cx="8" cy="13" r="1.5" />
          </svg>
        </button>

        {menuOpen && (
          <div style={s.menu}>
            <MenuAction label="Post again" onClick={() => { setMenuOpen(false); window.location.href = `/compose?repost=${post.postId}`; }} />
            {post.platforms.map((p, idx) =>
              p.platformUrl ? (
                <MenuAction
                  key={idx}
                  label={`View on ${platformDisplayName(p.platform)}`}
                  onClick={() => { setMenuOpen(false); window.open(p.platformUrl!, '_blank'); }}
                />
              ) : null,
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MenuAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '8px 12px',
        fontSize: 'var(--text-sm)',
        fontWeight: 500,
        color: 'var(--stone-700)',
        borderRadius: '8px',
        transition: 'background var(--transition-fast)',
      }}
      onMouseOver={(e) => (e.currentTarget.style.background = '#FFFFFF')}
      onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {label}
    </button>
  );
}

const s: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    padding: '10px 0',
    borderBottom: '1px solid var(--stone-100)',
  },
  thumb: {
    width: '40px',
    height: '40px',
    borderRadius: '8px',
    overflow: 'hidden',
    flexShrink: 0,
  },
  content: {
    fontSize: 'var(--text-sm)',
    color: 'var(--stone-800)',
    fontWeight: 500,
    margin: 0,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical' as any,
    overflow: 'hidden',
    lineHeight: '1.4',
  },
  menuBtn: {
    width: '28px',
    height: '28px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'var(--radius-md)',
    color: 'var(--stone-400)',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    transition: 'background var(--transition-fast)',
  },
  menu: {
    position: 'absolute' as const,
    top: '100%',
    right: 0,
    marginTop: '4px',
    background: 'var(--surface-main)',
    borderRadius: 'var(--radius-lg)',
    border: '1px solid var(--stone-200)',
    boxShadow: 'var(--shadow-lg)',
    minWidth: '180px',
    padding: '4px',
    zIndex: 50,
    animation: 'fadeIn 120ms ease both',
  },
};
