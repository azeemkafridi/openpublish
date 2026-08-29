import { PostList } from '../posts/PostList';
import CalendarView from '../calendar/CalendarView';
import { useQueryState } from '@lib/useQueryState';

type Tab = 'list' | 'calendar';

export default function QueuePage({ userRole }: { userRole?: string } = {}) {
  const [tab, setTab] = useQueryState<Tab>('view', 'list');

  return (
    <div style={styles.wrapper}>
      {/* Tab bar */}
      <div style={styles.tabBar}>
        <button
          type="button"
          onClick={() => setTab('list')}
          style={{
            ...styles.tab,
            ...(tab === 'list' ? styles.tabActive : {}),
          }}
        >
          <svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="5" x2="15" y2="5" />
            <line x1="3" y1="9" x2="15" y2="9" />
            <line x1="3" y1="13" x2="11" y2="13" />
          </svg>
          List View
        </button>
        <button
          type="button"
          onClick={() => setTab('calendar')}
          style={{
            ...styles.tab,
            ...(tab === 'calendar' ? styles.tabActive : {}),
          }}
        >
          <svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3.5" width="14" height="12" rx="2" />
            <line x1="2" y1="7.5" x2="16" y2="7.5" />
            <line x1="6" y1="2" x2="6" y2="5" />
            <line x1="12" y1="2" x2="12" y2="5" />
          </svg>
          Calendar View
        </button>
      </div>

      {/* Content */}
      <div style={styles.content}>
        {tab === 'list' ? <PostList userRole={userRole} /> : <CalendarView />}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
    // Fill what is left of .app-main-content below the page header. `height:
    // 100%` measured the whole scroll container instead, so the calendar
    // overhung the container's 40px bottom padding by the header's height.
    flex: 1,
    minHeight: 0,
  },
  tabBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '4px',
    background: 'var(--stone-100)',
    borderRadius: 'var(--radius-lg)',
    marginBottom: '16px',
    width: 'fit-content',
  },
  tab: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '7px 16px',
    borderRadius: '8px',
    border: 'none',
    background: 'transparent',
    fontSize: 'var(--text-sm)',
    fontWeight: 500,
    color: 'var(--stone-500)',
    cursor: 'pointer',
    transition: 'all 150ms ease',
    whiteSpace: 'nowrap' as const,
  },
  tabActive: {
    background: '#fff',
    color: 'var(--stone-900)',
    fontWeight: 600,
    boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
  },
  content: {
    flex: 1,
    minHeight: 0,
  },
};
