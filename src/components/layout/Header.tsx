import { useState, useEffect, useCallback } from 'react';
import NotificationBell from '../notifications/NotificationBell';

interface Props {
  breadcrumb: string;
  pageTitle: string;
  hideRightPanel?: boolean;
  hideNotificationBell?: boolean;
  showSettingsLink?: boolean;
}

export default function Header({ breadcrumb, pageTitle, hideRightPanel, hideNotificationBell, showSettingsLink }: Props) {
  const [rightCollapsed, setRightCollapsed] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('right-panel-collapsed') === 'true';
    }
    return false;
  });

  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);

  // Sync with external changes
  useEffect(() => {
    const shell = document.querySelector('.app-shell');
    if (shell) {
      setRightCollapsed(shell.getAttribute('data-right-collapsed') === 'true');
    }
  }, []);

  const toggleRightPanel = useCallback(() => {
    const shell = document.querySelector('.app-shell');
    const next = !rightCollapsed;
    setRightCollapsed(next);
    if (shell) {
      shell.setAttribute('data-right-collapsed', String(next));
    }
    localStorage.setItem('right-panel-collapsed', String(next));
    window.dispatchEvent(new CustomEvent('toggle-right-panel'));
  }, [rightCollapsed]);

  const btnStyle = (id: string): React.CSSProperties => ({
    ...styles.iconBtn,
    background: hoveredBtn === id ? '#F5F3F0' : 'none',
  });

  return (
    <header style={styles.header}>
      <div style={styles.leftSection}>
        {/* Breadcrumb */}
        <nav style={styles.breadcrumb}>
          <a href="/overview" style={styles.breadcrumbRoot}>openPublish</a>
          <span style={styles.breadcrumbSep}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M5 3l4 4-4 4" stroke="#A8A29E" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
          <span style={styles.breadcrumbCurrent}>{breadcrumb}</span>
        </nav>
      </div>

      {/* Actions */}
      <div style={styles.actions}>
        {/* Notifications — hidden on mobile, where the mobile header shows its own bell */}
        {!hideNotificationBell && (
          <span className="header-desktop-bell">
            <NotificationBell />
          </span>
        )}

        {/* Settings link — shown on Notifications page where bell is hidden */}
        {showSettingsLink && (
          <a
            href="/settings"
            style={btnStyle('settings')}
            onMouseEnter={() => setHoveredBtn('settings')}
            onMouseLeave={() => setHoveredBtn(null)}
            title="Notification Settings"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="9" cy="9" r="2.5" />
              <path d="M14.7 11.1a1.2 1.2 0 00.24 1.32l.04.04a1.44 1.44 0 11-2.04 2.04l-.04-.04a1.2 1.2 0 00-1.32-.24 1.2 1.2 0 00-.72 1.08v.12a1.44 1.44 0 11-2.88 0v-.06a1.2 1.2 0 00-.78-1.08 1.2 1.2 0 00-1.32.24l-.04.04a1.44 1.44 0 11-2.04-2.04l.04-.04a1.2 1.2 0 00.24-1.32 1.2 1.2 0 00-1.08-.72h-.12a1.44 1.44 0 010-2.88h.06a1.2 1.2 0 001.08-.78 1.2 1.2 0 00-.24-1.32l-.04-.04a1.44 1.44 0 112.04-2.04l.04.04a1.2 1.2 0 001.32.24h.06a1.2 1.2 0 00.72-1.08V2.64a1.44 1.44 0 012.88 0v.06a1.2 1.2 0 00.72 1.08 1.2 1.2 0 001.32-.24l.04-.04a1.44 1.44 0 112.04 2.04l-.04.04a1.2 1.2 0 00-.24 1.32v.06a1.2 1.2 0 001.08.72h.12a1.44 1.44 0 010 2.88h-.06a1.2 1.2 0 00-1.08.72z" />
            </svg>
          </a>
        )}

        {/* Right-panel toggle — only on pages that have a right panel */}
        {!hideRightPanel && (
          <button
            onClick={toggleRightPanel}
            style={btnStyle('panel')}
            onMouseEnter={() => setHoveredBtn('panel')}
            onMouseLeave={() => setHoveredBtn(null)}
            title={rightCollapsed ? 'Expand right panel' : 'Collapse right panel'}
            aria-label={rightCollapsed ? 'Expand right panel' : 'Collapse right panel'}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="14" height="12" rx="2" />
              <line x1="11.5" y1="3" x2="11.5" y2="15" />
              {rightCollapsed ? (
                <polyline points="8,7.5 5.5,9 8,10.5" />
              ) : (
                <polyline points="6,7.5 8.5,9 6,10.5" />
              )}
            </svg>
          </button>
        )}
      </div>
    </header>
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: '56px',
    borderBottom: 'none',
    flexShrink: 0,
    maxWidth: '1024px',
    width: '100%',
    margin: '0 auto',
  },
  leftSection: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  breadcrumb: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  breadcrumbRoot: {
    fontSize: '13px',
    color: '#A8A29E',
    textDecoration: 'none',
    fontWeight: 400,
    transition: 'color 150ms ease',
  },
  breadcrumbSep: {
    display: 'flex',
    alignItems: 'center',
  },
  breadcrumbCurrent: {
    fontSize: '13px',
    color: '#44403C',
    fontWeight: 500,
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  iconBtn: {
    position: 'relative' as const,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    borderRadius: '10px',
    color: '#57534E',
    cursor: 'pointer',
    transition: 'all 150ms ease',
    border: 'none',
    background: 'none',
    textDecoration: 'none',
  },
};
