/**
 * Shared surface for the Post Details pane.
 *
 * Every block — content, media, platform status, labels, metadata, the comments
 * openPublish posted, performance, engagement — renders on the same card so the
 * pane reads as one stack instead of a mix of cards and bare rows.
 *
 * Spacing between sections comes ONLY from the pane's root `gap`. A section that
 * adds its own margin drifts out of rhythm with the rest, which is exactly what
 * made Engagement and Performance sit further apart than everything else.
 */

export const sectionStyles: Record<string, React.CSSProperties> = {
  card: {
    background: 'var(--surface-card)',
    borderRadius: 'var(--radius-lg)',
    padding: '16px 18px',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
    marginBottom: '12px',
  },
  title: {
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    color: 'var(--stone-500)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    margin: 0,
  },
  titleSpaced: {
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    color: 'var(--stone-500)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    margin: '0 0 12px',
  },
};

export function DetailSection({
  title,
  action,
  children,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={sectionStyles.card}>
      {(title || action) && (
        <div style={sectionStyles.head}>
          {title && <p style={sectionStyles.title}>{title}</p>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
