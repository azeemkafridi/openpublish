import { useState, type CSSProperties } from 'react';

export interface MiniCalendarProps {
  selectedDate: Date;
  onDateSelect: (date: Date) => void;
  postDates?: Set<string>;
  /** Hide the built-in month header (when parent provides its own navigation) */
  hideHeader?: boolean;
  /** Externally-controlled view month (0-indexed). When set, internal nav is disabled. */
  viewMonth?: number;
  /** Externally-controlled view year */
  viewYear?: number;
}

// Week starts on Monday
const DAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Event dot colors: cycle through green, amber, purple
const DOT_COLORS = ['#10B981', '#F59E0B', '#8B5CF6'];

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

interface DayCell {
  date: Date;
  inMonth: boolean;
}

function getCalendarDays(year: number, month: number): DayCell[] {
  const first = new Date(year, month, 1);
  // getDay() returns 0=Sun,1=Mon,...,6=Sat
  // Convert to Monday-based: Mon=0, Tue=1, ..., Sun=6
  const startDay = (first.getDay() + 6) % 7;
  const cells: DayCell[] = [];

  // Fill leading days from previous month
  for (let i = startDay - 1; i >= 0; i--) {
    const d = new Date(year, month, -i);
    cells.push({ date: d, inMonth: false });
  }

  // Days in current month
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push({ date: new Date(year, month, day), inMonth: true });
  }

  // Fill trailing days to complete last week
  while (cells.length % 7 !== 0) {
    const last = cells[cells.length - 1].date;
    const next = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
    cells.push({ date: next, inMonth: false });
  }

  return cells;
}

function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6; // Sunday or Saturday
}

export function MiniCalendar({ selectedDate, onDateSelect, postDates, hideHeader, viewMonth, viewYear }: MiniCalendarProps) {
  const [viewDate, setViewDate] = useState(() => new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));

  // Use external values if provided, otherwise internal state
  const year = viewYear ?? viewDate.getFullYear();
  const month = viewMonth ?? viewDate.getMonth();
  const days = getCalendarDays(year, month);
  const today = new Date();

  function prevMonth() {
    setViewDate(new Date(year, month - 1, 1));
  }

  function nextMonth() {
    setViewDate(new Date(year, month + 1, 1));
  }

  const containerStyle: CSSProperties = {
    width: '100%',
    padding: hideHeader ? '0' : '16px',
    fontFamily: 'var(--font-body)',
  };

  const headerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '12px',
  };

  const monthLabelStyle: CSSProperties = {
    fontSize: '15px',
    fontWeight: 600,
    color: 'var(--stone-800)',
  };

  const navBtnStyle: CSSProperties = {
    width: '28px',
    height: '28px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '50%',
    color: 'var(--stone-500)',
    cursor: 'pointer',
    border: 'none',
    background: 'transparent',
    transition: 'background var(--transition-fast)',
  };

  const gridStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
    gap: '0',
  };

  const dayHeaderStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '12px',
    fontWeight: 500,
    color: '#78716C',
    textAlign: 'center',
    padding: '4px 0',
  };

  return (
    <div style={containerStyle}>
      {/* Header with month navigation (hidden when parent provides its own) */}
      {!hideHeader && (
        <div style={headerStyle}>
          <button
            type="button"
            style={navBtnStyle}
            onClick={prevMonth}
            onMouseOver={(e) => (e.currentTarget.style.background = 'var(--stone-200)')}
            onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
            aria-label="Previous month"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 3 5 7 9 11" />
            </svg>
          </button>

          <span style={monthLabelStyle}>
            {MONTH_NAMES[month]} {year}
          </span>

          <button
            type="button"
            style={navBtnStyle}
            onClick={nextMonth}
            onMouseOver={(e) => (e.currentTarget.style.background = 'var(--stone-200)')}
            onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
            aria-label="Next month"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="5 3 9 7 5 11" />
            </svg>
          </button>
        </div>
      )}

      {/* Day of week headers */}
      <div style={gridStyle}>
        {DAY_LABELS.map((label, idx) => {
          // Sa and Su are at indices 5 and 6 in our Monday-start array
          const isWeekendHeader = idx === 5 || idx === 6;
          return (
            <div
              key={label}
              style={{
                ...dayHeaderStyle,
                color: isWeekendHeader ? '#D97706' : '#78716C',
              }}
            >
              {label}
            </div>
          );
        })}

        {/* Day cells */}
        {days.map((cell, i) => {
          const isToday = isSameDay(cell.date, today);
          const isSelected = isSameDay(cell.date, selectedDate);
          const hasPost = postDates?.has(toDateKey(cell.date));
          const weekend = isWeekend(cell.date);

          // Determine the dot color based on the day index for variety
          const dotColor = DOT_COLORS[cell.date.getDate() % DOT_COLORS.length];

          // Determine text color
          let textColor: string;
          if (isSelected) {
            textColor = '#FFFFFF';
          } else if (isToday) {
            textColor = '#FFFFFF';
          } else if (!cell.inMonth) {
            textColor = '#D6D3CD';
          } else if (weekend) {
            textColor = '#D97706';
          } else {
            textColor = 'var(--stone-700)';
          }

          const cellStyle: CSSProperties = {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            width: '36px',
            height: '36px',
            cursor: 'pointer',
            borderRadius: 'var(--radius-sm)',
            transition: 'background var(--transition-fast)',
            position: 'relative',
            margin: '0 auto',
          };

          const numStyle: CSSProperties = {
            width: isSelected ? '32px' : '30px',
            height: isSelected ? '32px' : '30px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '50%',
            fontSize: '13px',
            fontWeight: isToday || isSelected ? 600 : 400,
            color: textColor,
            background: isSelected
              ? '#1C1917'
              : isToday
                ? '#1C1917'
                : 'transparent',
            boxShadow: isSelected ? '0 0 0 2px #1C1917, 0 0 0 4px rgba(28, 25, 23, 0.15)' : 'none',
            transition: 'all var(--transition-fast)',
          };

          const dotStyle: CSSProperties = {
            width: '5px',
            height: '5px',
            borderRadius: '50%',
            background: isSelected ? 'rgba(255,255,255,0.7)' : dotColor,
            marginTop: '1px',
            position: 'absolute',
            bottom: '2px',
            left: '50%',
            transform: 'translateX(-50%)',
          };

          return (
            <div
              key={i}
              style={cellStyle}
              onClick={() => onDateSelect(cell.date)}
              onMouseOver={(e) => {
                if (!isSelected) {
                  e.currentTarget.style.background = 'var(--stone-100)';
                }
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <span style={numStyle}>{cell.date.getDate()}</span>
              {hasPost && <span style={dotStyle} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
