import { useState } from 'react';
import { sectionStyles } from '../posts/detail-section';
import { platformDisplayName } from '@lib/platforms/types';
import { useEngagement, EngagementLists, type PlatformEngagement } from './engagement-shared';

/**
 * Collapsible commenter/reactor panel for the Post Details dialog.
 *
 * Renders nothing at all when no channel on the post can report engagement —
 * a platform without a commenters API is silently omitted rather than
 * announced.
 */
export function EngagementPanel({ postId }: { postId: number }) {
  const [expanded, setExpanded] = useState(false);
  const [activePlatform, setActivePlatform] = useState<string | null>(null);
  const { data, loading, fetchedAt, reload } = useEngagement(postId, expanded);

  const platforms = data?.platforms ?? [];
  const active: PlatformEngagement | undefined =
    platforms.find((p) => p.platform === activePlatform) ?? platforms[0];

  const totals = data
    ? platforms.reduce(
        (acc, p) => ({
          comments: acc.comments + (p.engagement?.comments.length ?? 0),
          reactions: acc.reactions + (p.engagement?.reactions.length ?? 0),
        }),
        { comments: 0, reactions: 0 },
      )
    : null;

  // Once loaded, a post whose channels all lack a commenters API shows nothing.
  if (data && platforms.length === 0) return null;

  return (
    // No own margin: the details pane's root gap sets the spacing.
    <div style={sectionStyles.card}>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          width: '100%',
          padding: 0,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          fontSize: 'var(--text-sm)',
          fontWeight: 600,
          color: 'var(--stone-700)',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 9.5A1.5 1.5 0 0 1 12.5 11H4l-2 2V3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5z" />
        </svg>
        Engagement
        {totals && (
          <span style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', fontWeight: 500, color: 'var(--stone-500)' }}>
            {totals.comments} commenters · {totals.reactions} reactors
          </span>
        )}
        <svg
          width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"
          strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
          style={{
            transform: expanded ? 'rotate(180deg)' : 'none',
            transition: 'transform 150ms ease',
            flexShrink: 0,
            marginLeft: totals ? 0 : 'auto',
          }}
        >
          <polyline points="2,4 6,8 10,4" />
        </svg>
      </button>

      {expanded && (
        <div style={{ paddingTop: '14px' }}>
          {loading && !data && (
            <p style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-500)', margin: 0 }}>Loading engagement…</p>
          )}

          {platforms.length > 1 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
              {platforms.map((p) => (
                <button
                  key={p.platform}
                  onClick={() => setActivePlatform(p.platform)}
                  style={{
                    padding: '4px 10px',
                    fontSize: 'var(--text-xs)',
                    fontWeight: 600,
                    background: p.platform === active?.platform ? 'var(--stone-800)' : 'var(--stone-100)',
                    color: p.platform === active?.platform ? '#fff' : 'var(--stone-700)',
                    border: 'none',
                    borderRadius: 'var(--radius-pill)',
                    cursor: 'pointer',
                  }}
                >
                  {platformDisplayName(p.platform)}
                  {p.accountName ? ` · ${p.accountName}` : ''}
                </button>
              ))}
            </div>
          )}

          {active && (
            <>
              {/* Names the exact account/Page this content was read from. */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  flexWrap: 'wrap',
                  marginBottom: '12px',
                  fontSize: 'var(--text-xs)',
                  color: 'var(--stone-500)',
                }}
              >
                <span>
                  Showing activity from{' '}
                  <strong style={{ color: 'var(--stone-800)' }}>
                    {platformDisplayName(active.platform)}
                    {active.accountName ? `: ${active.accountName}` : ''}
                  </strong>
                </span>
                {active.platformUrl && (
                  <a
                    href={active.platformUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--accent-500)', fontWeight: 500, textDecoration: 'none' }}
                  >
                    View post ↗
                  </a>
                )}
                <button
                  onClick={reload}
                  disabled={loading}
                  title="Fetch the latest comments and reactions from the platform"
                  style={{
                    marginLeft: 'auto',
                    padding: '4px 10px',
                    fontSize: 'var(--text-xs)',
                    fontWeight: 600,
                    background: 'var(--surface-main)',
                    color: 'var(--stone-600)',
                    border: 'none',
                    borderRadius: 'var(--radius-pill)',
                    cursor: loading ? 'default' : 'pointer',
                  }}
                >
                  {loading ? 'Refreshing…' : 'Refresh'}
                </button>
                {fetchedAt && !loading && (
                  <span style={{ color: 'var(--stone-400)' }}>Updated {fetchedAt.toLocaleTimeString()}</span>
                )}
              </div>

              <EngagementLists entry={active} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
