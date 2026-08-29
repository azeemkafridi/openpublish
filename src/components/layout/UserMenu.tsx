import { useState, useRef, useEffect } from 'react';

/** Public Help Center — the Chatwoot portal (Intercom-style docs site). */
const HELP_CENTER_URL = 'https://github.com/openpublish/openpublish';

/** The Chatwoot SDK attaches `$chatwoot` to window once its widget boots. */
function getChatwoot(): { toggle?: (state?: string) => void; reset?: () => void } | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { $chatwoot?: { toggle?: (state?: string) => void; reset?: () => void } }).$chatwoot;
}

interface Props {
  name: string;
  email?: string;
  role: string;
  plan?: string;
  avatarUrl?: string;
  collapsed?: boolean;
  /** Show the Help Center + "Chat with us" items (only when Chatwoot is configured). */
  supportEnabled?: boolean;
}

export default function UserMenu({ name, email, role, plan, avatarUrl, collapsed = false, supportEnabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const initials = name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const avatarSize = collapsed ? 20 : 34;

  // Close menu on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      document.cookie = 'bp_active_org=; Path=/; Max-Age=0';
      getChatwoot()?.reset?.(); // clear the support chat session so the next user starts fresh
      window.location.href = '/login';
    } catch {
      setSigningOut(false);
    }
  };

  const avatar = avatarUrl ? (
    <img
      src={avatarUrl}
      alt={name}
      style={{
        ...styles.avatar,
        width: avatarSize,
        height: avatarSize,
      }}
    />
  ) : (
    <div
      style={{
        ...styles.avatarFallback,
        width: avatarSize,
        height: avatarSize,
      }}
    >
      <span
        style={{
          ...styles.initials,
          fontSize: collapsed ? '9px' : '12px',
        }}
      >
        {initials}
      </span>
    </div>
  );

  const dropdown = open && (
    <div style={collapsed ? styles.dropdownCollapsed : styles.dropdown}>
      {/* User info in dropdown */}
      <div style={styles.dropdownHeader}>
        <span style={styles.dropdownName}>{name}</span>
        {email && <span style={styles.dropdownEmail}>{email}</span>}
        <span style={styles.dropdownRole}>
          {role}
          {plan && (
            <>
              {' · '}
              <span style={planStyles[plan] || planStyles.free}>{plan.charAt(0).toUpperCase() + plan.slice(1)}</span>
            </>
          )}
        </span>
      </div>
      <div style={styles.dropdownDivider} />
      <a href="/settings" style={styles.dropdownItem} onClick={() => setOpen(false)}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="7" cy="7" r="2" />
          <path d="M11.4 8.6a.93.93 0 00.16 1.01l.03.03a1.12 1.12 0 11-1.58 1.58l-.03-.03a.93.93 0 00-1.01-.16.93.93 0 00-.56.85v.1a1.12 1.12 0 01-2.24 0v-.05a.93.93 0 00-.61-.85.93.93 0 00-1.01.16l-.03.03a1.12 1.12 0 11-1.58-1.58l.03-.03a.93.93 0 00.16-1.01.93.93 0 00-.85-.56h-.1a1.12 1.12 0 010-2.24h.05a.93.93 0 00.85-.61.93.93 0 00-.16-1.01l-.03-.03A1.12 1.12 0 114.2 2.6l.03.03a.93.93 0 001.01.16h.05a.93.93 0 00.56-.85v-.1a1.12 1.12 0 012.24 0v.05a.93.93 0 00.61.85.93.93 0 001.01-.16l.03-.03a1.12 1.12 0 111.58 1.58l-.03.03a.93.93 0 00-.16 1.01v.05a.93.93 0 00.85.56h.1a1.12 1.12 0 010 2.24h-.05a.93.93 0 00-.85.61z" />
        </svg>
        Settings
      </a>
      <a href="/pricing" style={styles.dropdownItem} onClick={() => setOpen(false)}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <rect x="1.75" y="3.5" width="10.5" height="7" rx="1.2" />
          <line x1="1.75" y1="6.25" x2="12.25" y2="6.25" />
        </svg>
        Pricing
      </a>
      {supportEnabled && (
        <>
          <a href={HELP_CENTER_URL} target="_blank" rel="noopener noreferrer" style={styles.dropdownItem} onClick={() => setOpen(false)}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="7" cy="7" r="5.25" />
              <circle cx="7" cy="7" r="2.1" />
              <line x1="3.3" y1="3.3" x2="5.5" y2="5.5" />
              <line x1="8.5" y1="8.5" x2="10.7" y2="10.7" />
              <line x1="10.7" y1="3.3" x2="8.5" y2="5.5" />
              <line x1="5.5" y1="8.5" x2="3.3" y2="10.7" />
            </svg>
            Help Center
          </a>
          <button
            type="button"
            style={styles.dropdownItem}
            onClick={() => {
              setOpen(false);
              getChatwoot()?.toggle?.('open');
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <rect x="1.75" y="2.5" width="10.5" height="7.5" rx="2" />
              <path d="M4.75 10v1.9L7 10" />
            </svg>
            Chat with us
          </button>
        </>
      )}
      <div style={styles.dropdownDivider} />
      <button
        style={styles.dropdownItemDanger}
        onClick={handleSignOut}
        disabled={signingOut}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5.25 12.25H2.92A1.17 1.17 0 011.75 11.08V2.92A1.17 1.17 0 012.92 1.75H5.25" />
          <polyline points="9.33 9.92 12.25 7 9.33 4.08" />
          <line x1="12.25" y1="7" x2="5.25" y2="7" />
        </svg>
        {signingOut ? 'Signing out...' : 'Sign out'}
      </button>
    </div>
  );

  if (collapsed) {
    return (
      <div ref={menuRef} style={{ position: 'relative' }}>
        <button
          style={styles.buttonCollapsed}
          aria-label="Account menu"
          title={name}
          onClick={() => setOpen((v) => !v)}
        >
          {avatar}
        </button>
        {dropdown}
      </div>
    );
  }

  return (
    <div ref={menuRef} style={styles.container}>
      <button
        style={styles.button}
        aria-label="Account menu"
        onClick={() => setOpen((v) => !v)}
      >
        {avatar}
        <div style={styles.info}>
          <span style={styles.name}>{name}</span>
          {email && <span style={styles.email}>{email}</span>}
        </div>
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          style={{
            ...styles.chevron,
            transform: open ? 'none' : 'rotate(180deg)',
            transition: 'transform 200ms ease',
          }}
        >
          <path
            d="M4 5.5l3 3 3-3"
            stroke="#A8A29E"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {dropdown}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    paddingTop: '0',
    position: 'relative',
  },
  button: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    padding: '10px',
    borderRadius: '10px',
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    transition: 'background 150ms ease',
    textAlign: 'left' as const,
  },
  buttonCollapsed: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '42px',
    height: '42px',
    padding: '10px',
    border: 'none',
    borderRadius: '10px',
    background: 'none',
    cursor: 'pointer',
    transition: 'background 150ms ease',
  },
  avatar: {
    width: '34px',
    height: '34px',
    borderRadius: '50%',
    objectFit: 'cover' as const,
    flexShrink: 0,
  },
  avatarFallback: {
    width: '34px',
    height: '34px',
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #6366F1, #8B5CF6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  initials: {
    fontSize: '12px',
    fontWeight: 600,
    color: 'white',
    letterSpacing: '0.02em',
  },
  info: {
    display: 'flex',
    flexDirection: 'column' as const,
    flex: 1,
    minWidth: 0,
  },
  name: {
    fontSize: '13px',
    fontWeight: 500,
    color: '#292524',
    lineHeight: 1.3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  email: {
    fontSize: '11px',
    color: '#A8A29E',
    lineHeight: 1.3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  role: {
    fontSize: '11px',
    color: '#A8A29E',
    lineHeight: 1.3,
  },
  chevron: {
    flexShrink: 0,
    opacity: 0.6,
  },

  /* Dropdown */
  dropdown: {
    position: 'absolute' as const,
    bottom: 'calc(100% + 6px)',
    left: 0,
    right: 0,
    background: 'var(--surface-main)',
    border: '1px solid var(--stone-200)',
    borderRadius: 'var(--radius-lg)',
    boxShadow: 'none',
    zIndex: 100,
    overflow: 'hidden',
  },
  dropdownCollapsed: {
    position: 'absolute' as const,
    bottom: 0,
    left: 'calc(100% + 8px)',
    width: '200px',
    background: 'var(--surface-main)',
    border: '1px solid var(--stone-200)',
    borderRadius: 'var(--radius-lg)',
    boxShadow: '0 8px 24px rgba(0,0,0,0.1), 0 2px 8px rgba(0,0,0,0.05)',
    zIndex: 100,
    overflow: 'hidden',
  },
  dropdownHeader: {
    padding: '10px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '1px',
  },
  dropdownName: {
    fontSize: '13px',
    fontWeight: 500,
    color: '#292524',
  },
  dropdownEmail: {
    fontSize: '11px',
    color: '#A8A29E',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  dropdownRole: {
    fontSize: '11px',
    color: '#A8A29E',
  },
  dropdownDivider: {
    height: '1px',
    background: 'var(--stone-100)',
  },
  dropdownItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    padding: '10px',
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    fontSize: '13px',
    color: '#57534E',
    textDecoration: 'none',
    transition: 'background 100ms ease',
  },
  dropdownItemDanger: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    padding: '10px',
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    fontSize: '13px',
    color: '#DC2626',
    textAlign: 'left' as const,
    transition: 'background 100ms ease',
  },
};

const planStyles: Record<string, React.CSSProperties> = {
  free: { color: '#78716C' },
  pro: { color: '#C2410C', fontWeight: 500 },
  business: { color: '#6D28D9', fontWeight: 500 },
};
