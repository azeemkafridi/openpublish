import { useState, useEffect, useCallback } from 'react';
import UserMenu from './UserMenu';
import { Dropdown } from '@components/ui/Dropdown';

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
  badge?: number;
}

interface Props {
  currentPath: string;
  userName: string;
  userEmail?: string;
  userRole: string;
  organizationId?: number;
  organizationName?: string;
  organizationPlan?: string;
  supportEnabled?: boolean;
}

// ---- Icons (inline SVGs for zero-dependency, crisp rendering) ----

const icons = {
  overview: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="5.5" height="5.5" rx="1.5" />
      <rect x="10.5" y="2" width="5.5" height="5.5" rx="1.5" />
      <rect x="2" y="10.5" width="5.5" height="5.5" rx="1.5" />
      <rect x="10.5" y="10.5" width="5.5" height="5.5" rx="1.5" />
    </svg>
  ),
  channels: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5" cy="5" r="2.5" />
      <circle cx="13" cy="5" r="2.5" />
      <circle cx="9" cy="13" r="2.5" />
      <line x1="5" y1="7.5" x2="9" y2="10.5" />
      <line x1="13" y1="7.5" x2="9" y2="10.5" />
    </svg>
  ),
  compose: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.5 2.5l3 3L6 15H3v-3L12.5 2.5z" />
      <line x1="10.5" y1="4.5" x2="13.5" y2="7.5" />
    </svg>
  ),
  schedule: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="9" r="7" />
      <polyline points="9,5 9,9 12,11" />
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
  media: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="14" height="12" rx="2" />
      <circle cx="6.5" cy="7.5" r="1.5" />
      <polyline points="16,12 12,8 5,15" />
    </svg>
  ),
  analytics: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="14" x2="4" y2="8" />
      <line x1="8" y1="14" x2="8" y2="4" />
      <line x1="12" y1="14" x2="12" y2="10" />
      <line x1="16" y1="14" x2="16" y2="6" />
    </svg>
  ),
  reports: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 2h7l5 5v9a2 2 0 01-2 2H4a2 2 0 01-2-2V4a2 2 0 012-2z" />
      <polyline points="11,2 11,7 16,7" />
      <line x1="6" y1="10" x2="12" y2="10" />
      <line x1="6" y1="13" x2="10" y2="13" />
    </svg>
  ),
  api: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="5 4 1 9 5 14" />
      <polyline points="13 4 17 9 13 14" />
      <line x1="10" y1="3" x2="8" y2="15" />
    </svg>
  ),
  settings: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="9" r="2.5" />
      <path d="M14.7 11.1a1.2 1.2 0 00.2 1.3l.04.04a1.44 1.44 0 11-2.04 2.04l-.04-.04a1.2 1.2 0 00-1.3-.2 1.2 1.2 0 00-.72 1.1v.12a1.44 1.44 0 01-2.88 0v-.06a1.2 1.2 0 00-.78-1.1 1.2 1.2 0 00-1.3.2l-.04.04a1.44 1.44 0 11-2.04-2.04l.04-.04a1.2 1.2 0 00.2-1.3 1.2 1.2 0 00-1.1-.72h-.12a1.44 1.44 0 010-2.88h.06a1.2 1.2 0 001.1-.78 1.2 1.2 0 00-.2-1.3l-.04-.04A1.44 1.44 0 115.4 3.34l.04.04a1.2 1.2 0 001.3.2h.06a1.2 1.2 0 00.72-1.1v-.12a1.44 1.44 0 012.88 0v.06a1.2 1.2 0 00.78 1.1 1.2 1.2 0 001.3-.2l.04-.04a1.44 1.44 0 112.04 2.04l-.04.04a1.2 1.2 0 00-.2 1.3v.06a1.2 1.2 0 001.1.72h.12a1.44 1.44 0 010 2.88h-.06a1.2 1.2 0 00-1.1.78z" />
    </svg>
  ),
  notifications: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13.5 6.5a4.5 4.5 0 00-9 0c0 5-2.25 6.5-2.25 6.5h13.5s-2.25-1.5-2.25-6.5" />
      <path d="M10.3 15a1.5 1.5 0 01-2.6 0" />
    </svg>
  ),
  // Parent "Automations" section — a lightning bolt reads as "automatic".
  automations: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="9.75 1.5 2.25 10.5 9 10.5 8.25 16.5 15.75 7.5 9 7.5 9.75 1.5" />
    </svg>
  ),
  // Repeat Posts — circular arrows (recurring).
  repeat: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9a6 6 0 0111.5-2.4" />
      <polyline points="15 3 15 7 11 7" />
      <path d="M15 9a6 6 0 01-11.5 2.4" />
      <polyline points="3 15 3 11 7 11" />
    </svg>
  ),
  // Publish from RSS — the standard feed mark (dot + two arcs).
  rss: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4.25" cy="13.75" r="1.3" fill="currentColor" stroke="none" />
      <path d="M4.25 9.25 A4.5 4.5 0 0 1 8.75 13.75" />
      <path d="M4.25 5.25 A8.5 8.5 0 0 1 12.75 13.75" />
    </svg>
  ),
  labels: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3.5A1.5 1.5 0 013.5 2h4.586a1.5 1.5 0 011.06.44l6.354 6.353a1.5 1.5 0 010 2.121l-4.586 4.586a1.5 1.5 0 01-2.121 0L2.44 9.147A1.5 1.5 0 012 8.086V3.5z" />
      <circle cx="5.5" cy="5.5" r="1" />
    </svg>
  ),
  document: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 2.5h12A1.5 1.5 0 0116.5 4v10a1.5 1.5 0 01-1.5 1.5H3A1.5 1.5 0 011.5 14V4A1.5 1.5 0 013 2.5z" />
      <line x1="5" y1="7.5" x2="13" y2="7.5" />
      <line x1="5" y1="10.5" x2="11" y2="10.5" />
    </svg>
  ),
  status: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="9" r="6.5" />
      <path d="M9 5.5v4l2.5 1.5" />
    </svg>
  ),
  // Bulk Compose — stacked sheets, i.e. "many posts at once".
  bulk: (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="2.5" width="7" height="7" rx="1.5" />
      <path d="M6.5 12.5h5a1 1 0 0 0 1-1v-5" />
    </svg>
  ),
};

/** Sidebar panel / collapse toggle icon */
const CollapseIcon = ({ collapsed }: { collapsed: boolean }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 18 18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{
      transform: collapsed ? 'scaleX(-1)' : 'none',
      transition: 'transform 200ms ease',
    }}
  >
    <rect x="2" y="2" width="14" height="14" rx="2" />
    <line x1="7" y1="2" x2="7" y2="16" />
    <polyline points="11,7 9,9 11,11" />
  </svg>
);

const composeNav: NavItem = { label: 'Compose', href: '/compose', icon: icons.compose };

const mainNav: NavItem[] = [
  { label: 'Overview', href: '/overview', icon: icons.overview },
  { label: 'Channels', href: '/channels', icon: icons.channels },
  { label: 'Calendar', href: '/calendar', icon: icons.calendar },
  { label: 'Media Library', href: '/media', icon: icons.media },
  { label: 'Labels', href: '/labels', icon: icons.labels },
  { label: 'Analytics', href: '/analytics', icon: icons.analytics },
];

const automationsNav: NavItem[] = [
  { label: 'Repeat Posts', href: '/repeat-posts', icon: icons.repeat },
  { label: 'Publish from RSS', href: '/rss-feeds', icon: icons.rss },
];

const developerNav: NavItem[] = [
  { label: 'Docs', href: '/docs', icon: icons.document },
  { label: 'API', href: '/developer', icon: icons.api },
];

const secondaryNavBase: NavItem[] = [];

const STORAGE_KEY = 'sidebar-collapsed';

function setAppShellAttribute(collapsed: boolean) {
  document
    .querySelector('.app-shell')
    ?.setAttribute('data-sidebar-collapsed', String(collapsed));
}

export default function Sidebar({ currentPath, userName, userEmail, userRole, organizationId, organizationName, organizationPlan, supportEnabled = false }: Props) {
  const showOrgSwitcher = !!organizationId && !!organizationName;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const [isMobile, setIsMobile] = useState(false);
  // Derive the initially-open nav group from the currentPath PROP, not
  // window.location: the prop renders identically on the server and the
  // client, while window.location is undefined during SSR — that asymmetry
  // rendered these groups collapsed in the server HTML and expanded on the
  // client's first render, a hydration mismatch (React #418, one Sentry event
  // per visit to /repeat-posts, /rss-feeds, /docs, /developer, /admin).
  const [autoOpen, setAutoOpen] = useState(() =>
    ['/repeat-posts', '/rss-feeds'].some((p) => currentPath.startsWith(p)),
  );
  const [devOpen, setDevOpen] = useState(() =>
    ['/docs', '/developer'].some((p) => currentPath.startsWith(p)),
  );
  const [adminOpen, setAdminOpen] = useState(() => currentPath.startsWith('/admin'));

  const secondaryNav: NavItem[] = secondaryNavBase;

  const adminNav: NavItem[] = [];

  // Listen for mobile breakpoint
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 640px)');
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  // On mobile, always show expanded sidebar
  const isCollapsed = isMobile ? false : collapsed;

  // Sync attribute on mount and whenever collapsed changes
  useEffect(() => {
    setAppShellAttribute(collapsed);
  }, [collapsed]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // ignore
      }
      window.dispatchEvent(new CustomEvent('toggle-sidebar'));
      return next;
    });
  }, []);

  const isActive = (href: string) => {
    if (href === '/overview' && currentPath === '/') return true;
    return currentPath.startsWith(href);
  };

  return (
    <div style={{ ...styles.container, padding: isCollapsed ? '16px 0' : '16px' }}>
      <style>{`.sidebar-nav-item:hover { background: var(--stone-100); } .sidebar-nav-scroll::-webkit-scrollbar { display: none; } .sidebar-nav-scroll { scrollbar-width: none; }`}</style>
      {/* ---- Logo row ---- */}
      <div
        style={{
          ...styles.logoRow,
          justifyContent: isCollapsed ? 'center' : 'flex-start',
        }}
      >
        <a
          href="/overview"
          style={{
            ...styles.logoLink,
            justifyContent: isCollapsed ? 'center' : 'flex-start',
            paddingLeft: isCollapsed ? 0 : '12px',
          }}
        >
          <img src="/assets/logo.svg" alt="openPublish" width="32" height="20" style={{ flexShrink: 0 }} />
        </a>
      </div>

      {/* ---- Main navigation ---- */}
      {/* Collapsed, every child is a bare 42px icon button and the groups lose
          their headers, so the column reads as one list and the rhythm has to be
          uniform. The lists carry gap:2px internally; without a matching gap on
          the nav the seams between groups fell to 1px (icon-only links used
          `margin: 1px auto`) and 5px (the Collapse toggle's marginTop). */}
      <nav
        className="sidebar-nav-scroll"
        style={{ ...styles.nav, alignItems: isCollapsed ? 'center' : 'stretch', ...(isCollapsed ? { gap: '2px' } : {}) }}
      >
        {/* Compose + Bulk — elevated top row */}
        <div
          style={{
            position: 'relative',
            // Collapsed, the Compose pair is just two more icons in the column,
            // so it takes the same 2px seam as everything else (the nav's own
            // gap supplies it). Expanded it keeps the 12px break, where Compose
            // is a full-width primary button and does need separating.
            marginBottom: isCollapsed ? 0 : '12px',
            display: 'flex',
            gap: '2px',
            alignItems: 'center',
            // Collapsed, Compose and Bulk stack, and they take the same 12px
            // seam the org switcher has above Compose — the two of them read as
            // the sidebar's action pair, set apart from the navigation below.
            ...(isCollapsed ? { flexDirection: 'column', gap: '12px' } : {}),
          }}
        >
          <a
            href={composeNav.href}
            className="sidebar-nav-item"
            style={{
              ...styles.navItem,
              ...(isCollapsed ? styles.navItemCollapsed : { flex: 1 }),
              background: 'var(--accent-500)',
              color: '#fff',
              fontWeight: 700,
            }}
            title={isCollapsed ? composeNav.label : undefined}
          >
            <span style={{ ...styles.navIcon, color: '#fff' }}>
              {composeNav.icon}
            </span>
            <span style={{ ...styles.navLabel, ...(isCollapsed ? styles.navLabelCollapsed : {}) }}>
              {composeNav.label}
            </span>
          </a>

          {/* Bulk Compose. Collapsed it is a plain link, not a split-button:
              a popover hanging off a 42px icon in a 56px column has nowhere to
              open into, and the menu only ever held this one destination — the
              chevron was two clicks for what an icon does in one. */}
          {isCollapsed ? (
            <a
              href="/compose/bulk"
              className="sidebar-nav-item"
              title="Bulk Compose"
              aria-label="Bulk Compose"
              // No background or border: collapsed, this is just another icon in
              // the column, and the split-button chrome it inherited from the
              // expanded row made it the only outlined thing in the sidebar.
              style={{ ...styles.navItem, ...styles.navItemCollapsed }}
            >
              <span style={styles.navIcon}>{icons.bulk}</span>
            </a>
          ) : (
          <Dropdown
            align="right"
            containerStyle={{ position: 'static' }}
            menuStyle={{ left: 0, right: 0, minWidth: 0, padding: 0, overflow: 'hidden', border: '1px solid var(--stone-300)' }}
            itemStyle={{ height: '38px', padding: '0 12px' }}
            items={[
              {
                label: 'Bulk Compose',
                icon: icons.bulk,
                onClick: () => {
                  window.location.href = '/compose/bulk';
                },
              },
            ]}
            trigger={
              <button
                type="button"
                aria-label="Bulk publishing options"
                title="Bulk Compose"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxSizing: 'border-box',
                  width: '40px',
                  height: '40px',
                  background: 'var(--surface-main)',
                  border: '1px solid var(--stone-300)',
                  borderRadius: '10px',
                  color: 'var(--stone-500)',
                  cursor: 'pointer',
                  flexShrink: 0,
                  transition: 'all 180ms ease',
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.background = 'var(--stone-100)';
                  e.currentTarget.style.color = 'var(--stone-700)';
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.background = 'var(--surface-main)';
                  e.currentTarget.style.color = 'var(--stone-500)';
                }}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 6 8 10 12 6" />
                </svg>
              </button>
            }
          />
          )}
        </div>

        <ul style={{ ...styles.navList, alignItems: isCollapsed ? 'center' : 'stretch' }} className="stagger-children">
          {mainNav.map((item) => {
            const active = isActive(item.href);
            return (
              <li key={item.href} style={isCollapsed ? { width: 'fit-content', margin: '0 auto' } : undefined}>
                <a
                  href={item.href}
                  className="sidebar-nav-item"
                  style={{
                    ...styles.navItem,
                    ...(active ? styles.navItemActive : {}),
                    ...(isCollapsed ? styles.navItemCollapsed : {}),
                  }}
                  title={isCollapsed ? item.label : undefined}
                >
                  <span
                    style={{
                      ...styles.navIcon,
                      ...(active ? styles.navIconActive : {}),
                    }}
                  >
                    {item.icon}
                  </span>
                  <span
                    style={{
                      ...styles.navLabel,
                      ...(isCollapsed ? styles.navLabelCollapsed : {}),
                    }}
                  >
                    {item.label}
                  </span>
                  {!isCollapsed && item.badge !== undefined && item.badge > 0 && (
                    <span style={styles.navBadge}>{item.badge}</span>
                  )}
                </a>
              </li>
            );
          })}
        </ul>

        {/* Automations submenu */}
        {!isCollapsed ? (
          // padding is uniform on purpose: with vertical-only padding the hovered
          // child's 10px corners sat flush against the container's left/right edges,
          // so the same rounded rect looked inset at the top and clipped at the
          // sides. 4px all round + a 14px shell keeps the radii concentric.
          <div style={{ marginTop: '2px', background: 'var(--surface-main)', borderRadius: '14px', padding: '4px' }}>
            <button
              type="button"
              className="sidebar-nav-item"
              onClick={() => setAutoOpen((v) => !v)}
              style={{
                ...styles.navItem,
                width: '100%',
                background: 'transparent',
                color: '#57534E',
                justifyContent: 'flex-start',
                textAlign: 'left',
              }}
            >
              <span style={styles.navIcon}>
                {icons.automations}
              </span>
              <span style={styles.navLabel}>Automations</span>
              <svg
                width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                style={{ marginLeft: 'auto', transition: 'transform 150ms ease', transform: autoOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
              >
                <polyline points="4 6 8 10 12 6" />
              </svg>
            </button>
            {autoOpen && (
              <ul style={{ ...styles.navList, marginTop: '2px' }}>
                {automationsNav.map((item) => {
                  const active = isActive(item.href);
                  return (
                    <li key={item.href}>
                      <a
                        href={item.href}
                        className="sidebar-nav-item"
                        style={{
                          ...styles.navItem,
                          fontSize: '13px',
                          padding: '8px 10px',
                          ...(active ? styles.navItemActive : {}),
                        }}
                        title={item.label}
                      >
                        <span style={{ ...styles.navIcon, ...(active ? styles.navIconActive : {}) }}>
                          {item.icon}
                        </span>
                        <span style={styles.navLabel}>{item.label}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : (
          automationsNav.map((item) => {
            const active = isActive(item.href);
            return (
              <a
                key={item.href}
                href={item.href}
                className="sidebar-nav-item"
                style={{
                  ...styles.navItem,
                  ...(active ? styles.navItemActive : {}),
                  ...styles.navItemCollapsed,
                  margin: '0 auto',
                }}
                title={item.label}
              >
                <span style={{ ...styles.navIcon, ...(active ? styles.navIconActive : {}) }}>
                  {item.icon}
                </span>
              </a>
            );
          })
        )}

        {/* Developer submenu */}
        {!isCollapsed ? (
          // padding is uniform on purpose: with vertical-only padding the hovered
          // child's 10px corners sat flush against the container's left/right edges,
          // so the same rounded rect looked inset at the top and clipped at the
          // sides. 4px all round + a 14px shell keeps the radii concentric.
          <div style={{ marginTop: '2px', background: 'var(--surface-main)', borderRadius: '14px', padding: '4px' }}>
            <button
              type="button"
              className="sidebar-nav-item"
              onClick={() => setDevOpen((v) => !v)}
              style={{
                ...styles.navItem,
                width: '100%',
                background: 'transparent',
                color: '#57534E',
                justifyContent: 'flex-start',
                textAlign: 'left',
              }}
            >
              <span style={styles.navIcon}>
                {icons.api}
              </span>
              <span style={styles.navLabel}>Developer</span>
              <svg
                width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                style={{ marginLeft: 'auto', transition: 'transform 150ms ease', transform: devOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
              >
                <polyline points="4 6 8 10 12 6" />
              </svg>
            </button>
            {devOpen && (
              <ul style={{ ...styles.navList, marginTop: '2px' }}>
                {developerNav.map((item) => {
                  const active = isActive(item.href);
                  return (
                    <li key={item.href}>
                      <a
                        href={item.href}
                        className="sidebar-nav-item"
                        style={{
                          ...styles.navItem,
                          fontSize: '13px',
                          padding: '8px 10px',
                          ...(active ? styles.navItemActive : {}),
                        }}
                        title={item.label}
                      >
                        <span style={{ ...styles.navIcon, ...(active ? styles.navIconActive : {}) }}>
                          {item.icon}
                        </span>
                        <span style={styles.navLabel}>{item.label}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : (
          /* Collapsed: show just the icon */
          developerNav.map((item) => {
            const active = isActive(item.href);
            return (
              <a
                key={item.href}
                href={item.href}
                className="sidebar-nav-item"
                style={{
                  ...styles.navItem,
                  ...(active ? styles.navItemActive : {}),
                  ...styles.navItemCollapsed,
                  margin: '0 auto',
                }}
                title={item.label}
              >
                <span style={{ ...styles.navIcon, ...(active ? styles.navIconActive : {}) }}>
                  {item.icon}
                </span>
              </a>
            );
          })
        )}

        {/* Secondary nav — guarded because the list is currently empty, and an
            empty <ul> is still a flex child: it contributed no height but ate a
            gap on each side, which is where the 4px seam mid-column came from. */}
        {secondaryNav.length > 0 && (
        <ul style={{ ...styles.navList, alignItems: isCollapsed ? 'center' : 'stretch' }}>
          {secondaryNav.map((item) => {
            const active = isActive(item.href);
            return (
              <li key={item.href} style={{ position: 'relative', ...(isCollapsed ? { width: 'fit-content', margin: '0 auto' } : {}) }}>
                <a
                  href={item.href}
                  className="sidebar-nav-item"
                  style={{
                    ...styles.navItem,
                    ...(active ? styles.navItemActive : {}),
                    ...(isCollapsed ? styles.navItemCollapsed : {}),
                  }}
                  title={isCollapsed ? item.label : undefined}
                >
                  <span
                    style={{
                      ...styles.navIcon,
                      ...(active ? styles.navIconActive : {}),
                      position: 'relative',
                    }}
                  >
                    {item.icon}
                    {/* Badge dot when collapsed */}
                    {isCollapsed && item.badge !== undefined && item.badge > 0 && (
                      <span style={styles.navBadgeDot} />
                    )}
                  </span>
                  <span
                    style={{
                      ...styles.navLabel,
                      ...(isCollapsed ? styles.navLabelCollapsed : {}),
                    }}
                  >
                    {item.label}
                  </span>
                  {!isCollapsed && item.badge !== undefined && item.badge > 0 && (
                    <span style={styles.navBadge}>{item.badge}</span>
                  )}
                </a>
              </li>
            );
          })}
        </ul>
        )}

        {/* Admin submenu — only for admins (routes are also enforced by middleware) */}
        {userRole === 'admin' && (!isCollapsed ? (
          // padding is uniform on purpose: with vertical-only padding the hovered
          // child's 10px corners sat flush against the container's left/right edges,
          // so the same rounded rect looked inset at the top and clipped at the
          // sides. 4px all round + a 14px shell keeps the radii concentric.
          <div style={{ marginTop: '2px', background: 'var(--surface-main)', borderRadius: '14px', padding: '4px' }}>
            <button
              type="button"
              className="sidebar-nav-item"
              onClick={() => setAdminOpen((v) => !v)}
              style={{
                ...styles.navItem,
                width: '100%',
                background: 'transparent',
                color: '#57534E',
                justifyContent: 'flex-start',
                textAlign: 'left',
              }}
            >
              <span style={styles.navIcon}>
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 1.5l6 2.5v4c0 3.5-2.5 6-6 7-3.5-1-6-3.5-6-7v-4l6-2.5z" />
                </svg>
              </span>
              <span style={styles.navLabel}>Admin</span>
              <svg
                width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                style={{ marginLeft: 'auto', transition: 'transform 150ms ease', transform: adminOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
              >
                <polyline points="4 6 8 10 12 6" />
              </svg>
            </button>
            {adminOpen && (
              <ul style={{ ...styles.navList, marginTop: '2px' }}>
                {adminNav.map((item) => {
                  const active = isActive(item.href);
                  return (
                    <li key={item.href}>
                      <a
                        href={item.href}
                        className="sidebar-nav-item"
                        style={{
                          ...styles.navItem,
                          fontSize: '13px',
                          padding: '8px 10px',
                          ...(active ? styles.navItemActive : {}),
                        }}
                        title={item.label}
                      >
                        <span style={{ ...styles.navIcon, ...(active ? styles.navIconActive : {}) }}>
                          {item.icon}
                        </span>
                        <span style={styles.navLabel}>{item.label}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : (
          /* Collapsed sidebar: show admin items as icons only */
          adminNav.map((item) => {
            const active = isActive(item.href);
            return (
              <a
                key={item.href}
                href={item.href}
                className="sidebar-nav-item"
                style={{
                  ...styles.navItem,
                  ...(active ? styles.navItemActive : {}),
                  ...styles.navItemCollapsed,
                  margin: '0 auto',
                }}
                title={item.label}
              >
                <span style={{ ...styles.navIcon, ...(active ? styles.navIconActive : {}) }}>
                  {item.icon}
                </span>
              </a>
            );
          })
        ))}

        {/* Collapse toggle — hidden on mobile */}
        {!isMobile && (
          <div style={{ ...(isCollapsed ? { marginTop: 0, display: 'flex', justifyContent: 'center' } : { marginTop: '4px' }) }}>
            <a
              onClick={toggleCollapsed}
              className="sidebar-nav-item"
              style={{
                ...styles.navItem,
                ...(isCollapsed ? styles.navItemCollapsed : {}),
                cursor: 'pointer',
              }}
              title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              <span style={styles.navIcon}>
                <CollapseIcon collapsed={collapsed} />
              </span>
              <span
                style={{
                  ...styles.navLabel,
                  ...(isCollapsed ? styles.navLabelCollapsed : {}),
                }}
              >
                Collapse
              </span>
            </a>
          </div>
        )}
      </nav>

      {/* ---- Account section at bottom ---- */}
      <div style={{ ...styles.accountSection, alignItems: isCollapsed ? 'center' : 'stretch' }}>
        {isCollapsed ? (
          <div style={styles.collapsedAccountWrapper}>
            <UserMenu name={userName} email={userEmail} role={userRole} plan={organizationPlan} supportEnabled={supportEnabled} collapsed />
          </div>
        ) : (
          <UserMenu name={userName} email={userEmail} role={userRole} plan={organizationPlan} supportEnabled={supportEnabled} />
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    position: 'relative',
    zIndex: 1,
    padding: '16px',
  },

  /* ---- Logo row ---- */
  logoRow: {
    display: 'flex',
    alignItems: 'center',
    marginBottom: '20px',
    minHeight: '32px',
  },
  logoLink: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    textDecoration: 'none',
  },
  logoText: {
    fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
    fontSize: '18px',
    fontWeight: 600,
    color: '#222222',
    letterSpacing: '-0.01em',
    whiteSpace: 'nowrap' as const,
  },

  /* ---- Nav ---- */
  nav: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'auto',
    minHeight: 0,
  },
  sectionLabel: {
    display: 'block',
    fontSize: '12px',
    fontWeight: 500,
    color: '#78716C',
    marginBottom: '10px',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
  },
  navList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    listStyle: 'none',
    margin: 0,
    padding: 0,
  },
  navItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px',
    borderRadius: '10px',
    fontSize: '13.5px',
    fontWeight: 400,
    color: '#57534E',
    textDecoration: 'none',
    transition: 'all 180ms ease',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    border: 'none',
  },
  composeBtn: {
    background: '#FFFFFF',
    border: '1px solid #E7E5E4',
    boxShadow: '0 1px 2px rgba(0,0,0,0.0), 0 1px 1px rgba(0,0,0,0.02)',
    fontWeight: 500,
    color: '#222222',
  },
  composeBtnActive: {
    borderColor: 'var(--accent-500)',
    boxShadow: '0 1px 3px rgba(250,129,18,0.15), 0 1px 2px rgba(0,0,0,0.04)',
  },
  navItemActive: {
    color: 'var(--accent-500)',
    fontWeight: 500,
  },
  navItemCollapsed: {
    justifyContent: 'center',
    padding: '10px',
    width: '42px',
    height: '42px',
    // The Automations / Developer / Admin icons render as bare <a>s, i.e. direct
    // children of the scrolling flex column, so the default flex-shrink squashed
    // them from 42px to 20px while the <li>-wrapped items kept their height. The
    // group icons were visibly smaller than the ones above them.
    flexShrink: 0,
    gap: 0,
  },
  navIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    flexShrink: 0,
    color: '#A8A29E',
    transition: 'color 180ms ease',
  },
  navIconActive: {
    color: 'var(--accent-500)',
  },
  navLabel: {
    flex: 1,
    opacity: 1,
    transition: 'opacity 180ms ease',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  navLabelCollapsed: {
    width: 0,
    flex: 0,
    opacity: 0,
    overflow: 'hidden',
    pointerEvents: 'none' as const,
  },
  navBadge: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '20px',
    height: '20px',
    padding: '0 6px',
    borderRadius: '999px',
    fontSize: '11px',
    fontWeight: 600,
    background: 'var(--accent-500)',
    color: 'white',
    flexShrink: 0,
  },
  navBadgeDot: {
    position: 'absolute' as const,
    top: '-2px',
    right: '-2px',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: 'var(--accent-500)',
    border: 'none',
  },
  navBadgeDotInline: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: 'var(--accent-500)',
    flexShrink: 0,
  },
  divider: {
    height: '0px',
    margin: '16px 0 16px',
  },

  /* ---- Account section ---- */
  accountSection: {
    marginTop: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  collapsedAccountWrapper: {
    display: 'flex',
    justifyContent: 'center',
  },
};
