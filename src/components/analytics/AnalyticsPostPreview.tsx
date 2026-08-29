import { lazy, Suspense, useMemo, useState } from 'react';
import { PlatformIcon } from '../channels/PlatformIcon';
import { platformDisplayName } from '@lib/platforms/types';
import { COMMENTS_UNREADABLE } from '@lib/platforms/metrics-support';
import type { Platform } from '../compose/PostPreview';
import { useEngagement, EngagementLists } from './engagement-shared';
import { PreviewComments, supportsInlineComments } from './PreviewComments';

// Reuse the Composer's live-preview mockup so the styling is identical.
const PostPreview = lazy(() => import('../compose/PostPreview'));

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface PreviewPlatformMetric {
  platform: string;
  platformUrl: string;
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  clicks: number;
  videoViews: number;
  /** Metrics this platform's API can report. Absent on older cached payloads. */
  supportedMetrics?: string[];
  /** This channel's own engagement rate, in basis points (325 = 3.25%). */
  engagementRate?: number;
  /** false => every number above is a stored 0, not a measurement. */
  metricsSupported?: boolean;
}

export interface PreviewPost {
  postId: number;
  content: string;
  thumbnail?: string;
  publishedAt: string;
  engagementRate: number;
  platforms: Array<{ platform: string; platformUrl: string }>;
  platformMetrics: PreviewPlatformMetric[];
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

type MetricKey = 'impressions' | 'likes' | 'comments' | 'shares' | 'saves' | 'videoViews' | 'clicks';
const STAT_DEFS: { key: MetricKey; label: string }[] = [
  { key: 'impressions', label: 'Impressions' },
  { key: 'likes', label: 'Likes' },
  { key: 'comments', label: 'Comments' },
  { key: 'shares', label: 'Shares' },
  { key: 'saves', label: 'Saves' },
  { key: 'videoViews', label: 'Video Views' },
  { key: 'clicks', label: 'Clicks' },
];

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function formatRate(basisPoints: number): string {
  if (!basisPoints) return '—';
  return (basisPoints / 100).toFixed(2) + '%';
}

/** Sentinel for the combined view. Not a platform, so it can never collide. */
const ALL = '__all__';

/** Total engagement on one channel — used to rank platforms for the combined view. */
function score(m: PreviewPlatformMetric): number {
  return m.impressions + m.likes + m.comments + m.shares + m.saves + m.clicks + m.videoViews;
}

/**
 * Does this channel's API report `key` at all? Absent `supportedMetrics` means an
 * older cached payload with no support info — assume yes rather than dashing
 * out a real measurement.
 */
function reports(m: PreviewPlatformMetric, key: MetricKey | 'engagementRate'): boolean {
  if (m.metricsSupported === false) return false;
  return !m.supportedMetrics || m.supportedMetrics.includes(key);
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function AnalyticsPostPreview({ post }: { post: PreviewPost | null }) {
  const [active, setActive] = useState<string>('');

  const multi = (post?.platforms.length ?? 0) > 1;

  // Keep the selection valid as the selected post changes. An explicit user choice
  // wins; otherwise a post that went to more than one network opens on the combined
  // view — the per-network number is a detail of a thing the user published once.
  const selected = useMemo(() => {
    if (!post || post.platforms.length === 0) return '';
    if (active === ALL && multi) return ALL;
    if (post.platforms.some((p) => p.platform === active)) return active;
    return multi ? ALL : post.platforms[0].platform;
  }, [post, active, multi]);

  const combined = selected === ALL;

  /**
   * The mockup always renders exactly one network — "all networks" is a fact
   * about the numbers, not something a post card can look like. Show the one
   * with the most engagement, and say so in the header.
   */
  const shownPlatform = useMemo(() => {
    if (!post || post.platforms.length === 0) return '';
    if (!combined) return selected;
    const best = [...post.platformMetrics].sort((a, b) => score(b) - score(a))[0];
    return best?.platform ?? post.platforms[0].platform;
  }, [post, combined, selected]);

  // One fetch per post, shared by the in-mockup thread and the fallback card.
  // `post` may be null on first render, so the hook takes a harmless 0 and stays
  // disabled — hooks cannot be called conditionally.
  const engagement = useEngagement(post?.postId ?? 0, !!post);

  if (!post) {
    return (
      <div className="card" style={styles.emptyPane}>
        <p style={{ color: 'var(--stone-400)', fontSize: 'var(--text-sm)', margin: 0 }}>
          Select a post to preview it with its engagement.
        </p>
      </div>
    );
  }

  const metric = post.platformMetrics.find((m) => m.platform === shownPlatform);

  // Show exactly the metrics the ACTIVE platform's API can report — not the
  // union of "whatever happens to be non-zero on any platform of this post".
  // The old rule hid a genuine measured zero (a post with no likes yet dropped
  // the Likes cell entirely) and, via its `slice(0, 4)` fallback, printed
  // "Impressions 0" for Bluesky and Mastodon, which have no impressions field.
  const support = metric?.supportedMetrics;
  const statsToShow = support
    ? STAT_DEFS.filter((s) => support.includes(s.key))
    // Older cached payload with no support info: fall back to the previous
    // has-data heuristic rather than showing nothing.
    : (() => {
        const withData = STAT_DEFS.filter((s) => post.platformMetrics.some((m) => (m[s.key] ?? 0) > 0));
        return withData.length > 0 ? withData : STAT_DEFS.slice(0, 4);
      })();
  const unmeasured = metric?.metricsSupported === false;
  const platformUrl =
    metric?.platformUrl || post.platforms.find((p) => p.platform === shownPlatform)?.platformUrl;

  // The thread belongs to the network whose mockup is on screen — including in
  // the combined view, where that is the top performer. Prefer an account whose
  // read actually came back: with two accounts on one network, picking the
  // first blindly can select a failed read (engagement: null → renders
  // nothing) while the card below drops the successful account as "already
  // covered by the mockup" — real comments then render nowhere. The card's
  // slice below mirrors this pick.
  const inlineEntry =
    engagement.data?.platforms.find((p) => p.platform === shownPlatform && p.engagement !== null) ??
    engagement.data?.platforms.find((p) => p.platform === shownPlatform) ??
    null;
  // No mockup in the combined view, so there is nowhere to host a thread — the
  // standalone card comes back and covers every network at once.
  // The mockup can host the thread only if there IS an entry for this network
  // (or the response hasn't arrived yet, so the strip can show its loading
  // state instead of a detached "Loading engagement" card flashing below).
  // Without the entry check a platform missing from the response suppressed
  // the "Who engaged" card as well as the inline strip, so the post showed no
  // comment surface at all.
  const inline =
    !combined && supportsInlineComments(shownPlatform) && (!engagement.data || !!inlineEntry);
  const commentsSlot = inline ? (
    <PreviewComments
      platform={shownPlatform as Platform}
      entry={inlineEntry}
      loading={engagement.loading}
      onRefresh={engagement.reload}
    />
  ) : undefined;

  return (
    <div style={styles.pane}>
      {/* Header: channel dropdown (reuses the Composer's preview dropdown style) on the left,
          "View on …" on the right — space-between. */}
      <div style={styles.header}>
        <div style={styles.selectWrap}>
          {combined
            ? <StackedPlatformIcons platforms={post.platforms.map((p) => p.platform)} />
            : <PlatformIcon platform={shownPlatform as Platform} size="xs" />}
          <select
            value={selected}
            onChange={(e) => setActive(e.target.value)}
            style={styles.select}
            aria-label="Preview platform"
          >
            {multi && <option value={ALL}>All networks ({post.platforms.length})</option>}
            {post.platforms.map((p) => (
              <option key={p.platform} value={p.platform}>{platformDisplayName(p.platform)}</option>
            ))}
          </select>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--stone-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: 'none', flexShrink: 0 }}>
            <polyline points="3 4.5 6 7.5 9 4.5" />
          </svg>
        </div>
        {/* Only next to a mockup: under an "All networks" heading, a single
            "View on X" link reads as the post's one canonical home. The
            per-network rows below carry their own links instead. */}
        {!combined && platformUrl && (
          <a href={platformUrl} target="_blank" rel="noopener noreferrer" style={styles.viewLink}>
            View on {platformDisplayName(shownPlatform)} ↗
          </a>
        )}
      </div>

      {/* No mockup in the combined view. A post card can only ever render one
          network, so showing one under an "All networks" heading claimed to be
          the post when it was a single rendering of it — the combined view is
          about the numbers, so it shows only the numbers. */}
      {!combined && (
        <Suspense
          fallback={
            <div className="card" style={{ padding: '40px', textAlign: 'center', color: 'var(--stone-400)', fontSize: 'var(--text-sm)' }}>
              Loading preview…
            </div>
          }
        >
          <PostPreview
            content={post.content}
            platforms={[shownPlatform as Platform]}
            mediaUrl={post.thumbnail ?? null}
            mediaUrls={post.thumbnail ? [post.thumbnail] : []}
            mediaType={post.thumbnail ? 'image' : null}
            activePlatform={shownPlatform as Platform}
            hideHeader
            metrics={metric ?? null}
            commentsSlot={commentsSlot}
          />
        </Suspense>
      )}

      {combined ? (
        <CombinedStats post={post} />
      ) : (
        /* Real engagement for the active platform */
        <div className="card" style={styles.statsCard}>
          <div style={styles.statsHead}>
            <span style={styles.statsTitle}>Engagement · {platformDisplayName(shownPlatform)}</span>
            <span style={styles.statsDate}>
              {new Date(post.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
          </div>
          {unmeasured ? (
            // gmb / reddit / discord / telegram / tumblr and LinkedIn personal
            // profiles: the platform exposes no per-post statistics API at all.
            <p style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-500)', margin: 0 }}>
              {platformDisplayName(shownPlatform)} does not report per-post metrics.
            </p>
          ) : (
            <div style={styles.statGrid}>
              {statsToShow.map((s) => (
                <div key={s.key} style={styles.statCell}>
                  <span style={styles.statValue}>{formatNumber(metric?.[s.key] ?? 0)}</span>
                  <span style={styles.statLabel}>{s.label}</span>
                </div>
              ))}
              {(!support || support.includes('engagementRate')) && (
                <div style={styles.statCell}>
                  {/* THIS platform's rate, not post.engagementRate — that one is
                      averaged across the post's platforms, so it rendered another
                      network's percentage next to this network's counters. */}
                  <span style={styles.statValue}>{formatRate(metric?.engagementRate ?? 0)}</span>
                  <span style={styles.statLabel}>Eng. Rate</span>
                </div>
              )}
            </div>
          )}
          {/* A comment count with no thread anywhere looks like a broken
              drill-down. When the platform is the reason (TikTok, Pinterest,
              Snapchat report counts but close the comment list to apps), say
              so next to the number — the "View on …" link in the header is
              the only way to read them. */}
          {!unmeasured &&
            (metric?.comments ?? 0) > 0 &&
            COMMENTS_UNREADABLE[shownPlatform as keyof typeof COMMENTS_UNREADABLE] && (
              <p style={styles.combinedNote}>
                {COMMENTS_UNREADABLE[shownPlatform as keyof typeof COMMENTS_UNREADABLE]}
                {platformUrl && (
                  <>
                    {' '}
                    <a href={platformUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-500)', textDecoration: 'none' }}>
                      Read them on {platformDisplayName(shownPlatform)} ↗
                    </a>
                  </>
                )}
              </p>
            )}
        </div>
      )}

      {/* Who actually engaged. Suppressed when the network's own mockup already
          renders the thread inline — the whole point of that change was to stop
          showing comments in a detached box. Networks without a comment surface
          (and multi-account posts on one network) still get the card. */}
      <PostEngagementCard
        engagement={engagement}
        platform={combined ? null : shownPlatform}
        skipInline={inline}
      />
    </div>
  );
}

/**
 * Commenters/reactors for the previewed post, scoped to the platform whose
 * mockup is on screen. Styled as a sibling stats card so it lines up with the
 * metrics block above it.
 */
function PostEngagementCard({
  engagement, platform, skipInline,
}: {
  engagement: ReturnType<typeof useEngagement>;
  /** null = every network the post went to (the combined view). */
  platform: string | null;
  skipInline: boolean;
}) {
  const { data, loading, fetchedAt, reload } = engagement;

  // Nothing to show until we know this platform reports engagement at all.
  if (!data) {
    return loading && !skipInline ? (
      <div className="card" style={styles.statsCard}>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-400)', margin: 0 }}>Loading engagement…</p>
      </div>
    ) : null;
  }

  // One entry per connected account — a post can go to two Pages of the same
  // platform, and each has its own commenters.
  const all = platform === null
    ? data.platforms
    : data.platforms.filter((p) => p.platform === platform);

  // `engagement: null` on a channel we DID publish to means the read did not
  // come back — no token, an API error, a network we cannot query. There is
  // nothing to show, and EngagementLists' "Not published to this channel yet"
  // is actively wrong for a post that is live. Drop those, and if that empties
  // the card, render no card: an empty "Who engaged" box was the whole
  // complaint. A channel with no platformPostId genuinely has not published
  // yet, so it keeps its row.
  const entries = all.filter((p) => p.engagement !== null || !p.platformPostId);
  if (entries.length === 0) return null;

  // The mockup renders the thread for ONE account only — the first whose read
  // came back (matching inlineEntry's pick above) — so a post that went to two
  // Pages of the same network still needs the card for the rest. Drop exactly
  // the entry the mockup covers, not blindly the first: when the first
  // account's read failed, the mockup shows the SECOND, and slicing the head
  // off would print the mockup's account twice while a failed read hid a
  // successful one entirely.
  const inlineShown = skipInline
    ? entries.find((p) => p.engagement !== null) ?? entries[0] ?? null
    : null;
  let rest = inlineShown ? entries.filter((p) => p !== inlineShown) : entries;

  // The card exists to show WHO engaged. An entry whose read came back with
  // zero comments and zero reactions has no who — and "No comments yet." under
  // a bold "Who engaged" heading reads as a product gap, not information. Drop
  // empty entries (which also drops the never-published "Not yet on this
  // channel" rows), and when nothing with actual engagement remains, render no
  // card at all.
  rest = rest.filter(
    (p) => p.engagement !== null
      && (p.engagement.comments.length > 0 || p.engagement.reactions.length > 0),
  );
  if (rest.length === 0) return null;

  return (
    <div className="card" style={styles.statsCard}>
      <div style={styles.statsHead}>
        <span style={styles.statsTitle}>
          {skipInline ? 'Other accounts on this network' : 'Who engaged'}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
          {fetchedAt && !loading && (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-400)' }}>
              Updated {fetchedAt.toLocaleTimeString()}
            </span>
          )}
          {/* Always reads "Refresh" — folding the timestamp into the label made
              it stop looking clickable, so stale data looked like final data. */}
          <button
            onClick={reload}
            disabled={loading}
            title="Fetch the latest comments and reactions from the platform"
            style={styles.refreshBtn}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </span>
      </div>

      {rest.map((entry, i) => (
        <div
          key={`${entry.platform}-${entry.platformPostId ?? i}`}
          style={i > 0 ? { marginTop: '18px' } : undefined}
        >
          {/* Names the account the content was read from — required so the
              Page is identifiable, and the only way to tell two accounts
              on the same platform apart. */}
          {(entry.accountName || entries.length > 1) && (
            <p style={styles.engagementAccount}>
              {platform === null
                // Across networks the account name alone is ambiguous — the same
                // brand name is on five of them.
                ? `${platformDisplayName(entry.platform)}${entry.accountName ? ` · ${entry.accountName}` : ''}`
                : entry.accountName ?? platformDisplayName(entry.platform)}
            </p>
          )}
          <EngagementLists entry={entry} />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Combined view                                                      */
/* ------------------------------------------------------------------ */

/**
 * Totals across every network the post went to, plus the per-network breakdown
 * that makes the totals readable.
 *
 * The hard part is not the addition — it is that a sum across networks is only
 * honest for the networks that measure the thing. Pinterest reports no shares
 * and YouTube no saves, so a naive `reduce` prints a confident number that
 * silently omits half the post. Each metric is therefore summed over its
 * *reporting* networks only, hidden entirely when none of them report it, and
 * marked with an asterisk naming the ones left out when only some do — the same
 * rule the org-wide cards on the Overview tab use.
 */
function CombinedStats({ post }: { post: PreviewPost }) {
  const metrics = post.platformMetrics;
  const names = (list: PreviewPlatformMetric[]) =>
    list.map((m) => platformDisplayName(m.platform)).join(', ');

  const cells = STAT_DEFS.map((def) => {
    const reporting = metrics.filter((m) => reports(m, def.key));
    const missing = metrics.filter((m) => !reports(m, def.key));
    if (reporting.length === 0) return null;
    return {
      key: def.key,
      label: missing.length > 0 ? `${def.label} *` : def.label,
      title: missing.length > 0
        ? `Not reported by ${names(missing)}. ${missing.length === 1 ? 'That channel is' : 'Those channels are'} excluded from this total.`
        : undefined,
      value: reporting.reduce((sum, m) => sum + (m[def.key] ?? 0), 0),
    };
  }).filter(Boolean) as Array<{ key: MetricKey; label: string; title?: string; value: number }>;

  // Weighted by impressions rather than a flat mean: a network that reached 200
  // people should not move the post's rate as much as one that reached 40,000.
  // Networks with no impressions field fall back to counting once each.
  const rateSources = metrics.filter((m) => reports(m, 'engagementRate') && (m.engagementRate ?? 0) > 0);
  const weightOf = (m: PreviewPlatformMetric) => (m.impressions > 0 ? m.impressions : 1);
  const totalWeight = rateSources.reduce((sum, m) => sum + weightOf(m), 0);
  const blendedRate = totalWeight > 0
    ? Math.round(rateSources.reduce((sum, m) => sum + (m.engagementRate ?? 0) * weightOf(m), 0) / totalWeight)
    : 0;

  const unmeasured = post.platforms.filter(
    (p) => !metrics.some((m) => m.platform === p.platform && m.metricsSupported !== false),
  );

  return (
    <>
      <div className="card" style={styles.statsCard}>
        <div style={styles.statsHead}>
          <span style={styles.statsTitle}>Engagement · all networks</span>
          <span style={styles.statsDate}>
            {new Date(post.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </span>
        </div>

        {cells.length === 0 ? (
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-500)', margin: 0 }}>
            None of the networks this post went to report per-post metrics.
          </p>
        ) : (
          <div style={styles.statGrid}>
            {cells.map((c) => (
              <div key={c.key} style={styles.statCell} title={c.title}>
                <span style={styles.statValue}>{formatNumber(c.value)}</span>
                <span style={styles.statLabel}>{c.label}</span>
              </div>
            ))}
            {rateSources.length > 0 && (
              <div
                style={styles.statCell}
                title="Averaged across networks, weighted by impressions."
              >
                <span style={styles.statValue}>{formatRate(blendedRate)}</span>
                <span style={styles.statLabel}>Eng. Rate</span>
              </div>
            )}
          </div>
        )}

        {unmeasured.length > 0 && (
          <p style={styles.combinedNote}>
            {unmeasured.map((p) => platformDisplayName(p.platform)).join(', ')}{' '}
            {unmeasured.length === 1 ? 'reports' : 'report'} no per-post metrics, so{' '}
            {unmeasured.length === 1 ? 'it is' : 'they are'} not in these totals.
          </p>
        )}
      </div>

      {/* Per-network breakdown — the totals are only actionable next to the
          split that produced them. */}
      <div className="card" style={styles.statsCard}>
        <div style={styles.statsHead}>
          <span style={styles.statsTitle}>By network</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {post.platforms.map((p, i) => {
            const m = metrics.find((x) => x.platform === p.platform);
            const dead = !m || m.metricsSupported === false;
            return (
              <div key={p.platform} style={{ ...styles.breakdownRow, borderTop: i === 0 ? 'none' : '1px solid var(--stone-100)' }}>
                <span style={styles.breakdownName}>
                  <PlatformIcon platform={p.platform as Platform} size="xs" />
                  {platformDisplayName(p.platform)}
                  {/* Replaces the single header link the combined view drops —
                      each network's own post is reachable from its own row. */}
                  {p.platformUrl && (
                    <a href={p.platformUrl} target="_blank" rel="noopener noreferrer" style={styles.breakdownLink}>
                      View ↗
                    </a>
                  )}
                </span>
                {dead ? (
                  <span style={styles.breakdownDash}>no metrics reported</span>
                ) : (
                  <span style={styles.breakdownNums}>
                    {reports(m, 'impressions') && <BreakdownNum label="impr" value={m.impressions} />}
                    <BreakdownNum label="likes" value={m.likes} />
                    <BreakdownNum label="comments" value={m.comments} />
                    {reports(m, 'shares') && <BreakdownNum label="shares" value={m.shares} />}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function BreakdownNum({ label, value }: { label: string; value: number }) {
  return (
    <span style={styles.breakdownNum} title={label}>
      <b style={{ fontFamily: 'var(--font-numeric)', fontVariantNumeric: 'tabular-nums' }}>{formatNumber(value)}</b>{' '}
      <span style={{ color: 'var(--stone-400)' }}>{label}</span>
    </span>
  );
}

/** Overlapping platform marks — the standard "this is several things" affordance. */
function StackedPlatformIcons({ platforms }: { platforms: string[] }) {
  const shown = platforms.slice(0, 3);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
      {shown.map((p, i) => (
        <span key={p} style={{ marginLeft: i === 0 ? 0 : '-5px', display: 'inline-flex' }}>
          <PlatformIcon platform={p as Platform} size="xs" />
        </span>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const styles: Record<string, React.CSSProperties> = {
  pane: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  emptyPane: {
    padding: '40px 24px',
    textAlign: 'center',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
  },
  viewLink: {
    fontSize: 'var(--text-xs)',
    fontWeight: 500,
    color: 'var(--accent-500)',
    textDecoration: 'none',
    whiteSpace: 'nowrap',
  },
  selectWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    background: 'var(--surface-card)',
    borderRadius: 'var(--radius-pill)',
    padding: '6px 8px',
  },
  select: {
    appearance: 'none',
    border: 'none',
    background: 'transparent',
    fontSize: '12px',
    fontWeight: 500,
    color: 'var(--stone-700)',
    cursor: 'pointer',
    outline: 'none',
    paddingRight: '2px',
  },
  statsCard: {
    padding: '16px',
  },
  combinedNote: {
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-500)',
    margin: '12px 0 0',
    lineHeight: 1.5,
  },
  breakdownRow: {
    // Deliberately a column, not a wrapping row: with `flex-wrap` the numbers
    // dropped to a second line for most networks but fit beside the name for
    // the shorter ones (Bluesky reports no impressions), so rows of the same
    // table had different shapes.
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '10px 0',
  },
  breakdownName: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: 'var(--text-sm)',
    fontWeight: 500,
    color: 'var(--stone-700)',
  },
  breakdownNums: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '14px',
    flexWrap: 'wrap',
  },
  breakdownNum: {
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-700)',
    whiteSpace: 'nowrap',
  },
  breakdownDash: {
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-400)',
  },
  breakdownLink: {
    fontSize: 'var(--text-xs)',
    fontWeight: 500,
    color: 'var(--accent-500)',
    textDecoration: 'none',
    marginLeft: 'auto',
    whiteSpace: 'nowrap',
  },
  statsHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    marginBottom: '14px',
  },
  statsTitle: {
    fontSize: 'var(--text-sm)',
    fontWeight: 600,
    color: 'var(--stone-800)',
  },
  statsDate: {
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-400)',
  },
  engagementAccount: {
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    color: 'var(--stone-500)',
    margin: '0 0 10px',
  },
  refreshBtn: {
    padding: 0,
    background: 'transparent',
    border: 'none',
    fontSize: 'var(--text-xs)',
    fontWeight: 500,
    color: 'var(--stone-400)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  statGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))',
    gap: '12px',
  },
  statCell: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  statValue: {
    fontSize: 'var(--text-lg)',
    fontWeight: 700,
    color: 'var(--stone-900)',
    fontFamily: 'var(--font-numeric)',
    fontVariantNumeric: 'tabular-nums',
  },
  statLabel: {
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    color: 'var(--stone-500)',
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
  },
};
