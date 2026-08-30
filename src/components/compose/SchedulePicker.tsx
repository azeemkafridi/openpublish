import { useMemo } from 'react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface AutomationConfig {
  frequency: 'daily' | 'weekly' | 'monthly';
  daysOfWeek: number[];   // 0-6 (Sun-Sat) for weekly
  dayOfMonth: number;     // 1-28 for monthly
  timeOfDay: string;      // HH:mm
  timezone: string;
}

export interface SchedulePickerProps {
  scheduledAt: string | null; // ISO string
  timezone: string;
  onChange: (scheduledAt: string | null, timezone: string) => void;
  automationMode?: boolean;
  automationConfig?: AutomationConfig | null;
  onAutomationChange?: (config: AutomationConfig) => void;
}

/* ------------------------------------------------------------------ */
/*  Timezone list                                                      */
/* ------------------------------------------------------------------ */

function buildTimezoneList(): { value: string; label: string }[] {
  try {
    const zones = Intl.supportedValuesOf('timeZone');
    const now = new Date();
    return [
      { value: 'UTC', label: 'UTC (+00:00)' },
      ...zones
        .filter((tz) => tz !== 'UTC')
        .map((tz) => {
          // Get UTC offset for display
          const fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            timeZoneName: 'shortOffset',
          });
          const parts = fmt.formatToParts(now);
          const offsetPart = parts.find((p) => p.type === 'timeZoneName');
          const offset = offsetPart?.value?.replace('GMT', '') || '';
          const offsetLabel = offset ? ` (GMT${offset})` : '';
          // Friendly label: "America/New_York" → "New York"
          const city = tz.split('/').pop()!.replace(/_/g, ' ');
          const region = tz.split('/')[0];
          return { value: tz, label: `${city}${offsetLabel}`, region, offsetMin: getOffsetMinutes(tz, now) };
        })
        .sort((a, b) => a.offsetMin - b.offsetMin || a.label.localeCompare(b.label))
        .map(({ value, label }) => ({ value, label })),
    ];
  } catch {
    // Fallback for older environments
    return [
      { value: 'UTC', label: 'UTC (+00:00)' },
      { value: 'America/New_York', label: 'New York (GMT-5)' },
      { value: 'America/Chicago', label: 'Chicago (GMT-6)' },
      { value: 'America/Denver', label: 'Denver (GMT-7)' },
      { value: 'America/Los_Angeles', label: 'Los Angeles (GMT-8)' },
      { value: 'Europe/London', label: 'London (GMT+0)' },
      { value: 'Europe/Paris', label: 'Paris (GMT+1)' },
      { value: 'Asia/Tokyo', label: 'Tokyo (GMT+9)' },
      { value: 'Australia/Sydney', label: 'Sydney (GMT+11)' },
    ];
  }
}

function getOffsetMinutes(tz: string, date: Date): number {
  const utc = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const local = date.toLocaleString('en-US', { timeZone: tz });
  return (new Date(local).getTime() - new Date(utc).getTime()) / 60_000;
}

const TIMEZONES = buildTimezoneList();

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const FREQUENCIES = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
] as const;

const DAYS_OF_WEEK = [
  { value: 1, label: 'M' },
  { value: 2, label: 'T' },
  { value: 3, label: 'W' },
  { value: 4, label: 'T' },
  { value: 5, label: 'F' },
  { value: 6, label: 'S' },
  { value: 0, label: 'S' },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Extract date/time parts in a specific timezone using formatToParts (reliable).
 */
function getPartsInTz(date: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

function toDateInputValue(iso: string, tz: string): string {
  const p = getPartsInTz(new Date(iso), tz);
  return `${p.year}-${p.month}-${p.day}`;
}

function toTimeInputValue(iso: string, tz: string): string {
  const p = getPartsInTz(new Date(iso), tz);
  return `${p.hour}:${p.minute}`;
}

/**
 * Convert a local date+time in a given timezone to a UTC ISO string.
 */
function localToUtc(dateStr: string, timeStr: string, tz: string): string {
  const t = timeStr || '09:00';
  // Treat the input as UTC to get a reference point
  const refUtc = new Date(`${dateStr}T${t}:00Z`);
  // See what this UTC instant looks like in the target timezone
  const p = getPartsInTz(refUtc, tz);
  const actualInTz = new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
  // The difference tells us the timezone offset
  const tzOffset = actualInTz.getTime() - refUtc.getTime();
  // Subtract the offset to get the correct UTC time
  return new Date(refUtc.getTime() - tzOffset).toISOString();
}

function relativeTimeLabel(iso: string): string {
  const target = new Date(iso).getTime();
  const now = Date.now();
  const diff = target - now;

  if (diff < 0) return 'in the past';

  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'right now';
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? '' : 's'}`;

  const days = Math.floor(hours / 24);
  if (days === 1) {
    const d = new Date(iso);
    const timeStr = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `tomorrow at ${timeStr}`;
  }

  return `in ${days} days`;
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const s = {
  pill: (active: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '6px 16px',
    borderRadius: 'var(--radius-pill)',
    border: 'none',
    fontSize: 'var(--text-sm)',
    fontWeight: active ? 600 : 500,
    background: active ? 'var(--stone-900)' : 'var(--stone-100)',
    color: active ? '#fff' : 'var(--stone-600)',
    cursor: 'pointer',
    transition: 'all 150ms ease',
    whiteSpace: 'nowrap' as const,
  }),
  dayToggle: (active: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    borderRadius: '50%',
    border: 'none',
    fontSize: 'var(--text-xs)',
    fontWeight: active ? 600 : 500,
    background: active ? 'var(--stone-900)' : 'var(--stone-100)',
    color: active ? '#fff' : 'var(--stone-500)',
    cursor: 'pointer',
    transition: 'all 150ms ease',
  }),
  monthDay: (active: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '34px',
    height: '34px',
    borderRadius: '50%',
    border: 'none',
    fontSize: 'var(--text-xs)',
    fontWeight: active ? 600 : 500,
    background: active ? 'var(--stone-900)' : 'var(--stone-100)',
    color: active ? '#fff' : 'var(--stone-500)',
    cursor: 'pointer',
    transition: 'all 150ms ease',
  }),
  fieldLabel: {
    display: 'block',
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-500)',
    marginBottom: '4px',
  } as React.CSSProperties,
  selectWrap: {
    position: 'relative',
  } as React.CSSProperties,
  chevron: {
    position: 'absolute',
    right: '12px',
    top: '50%',
    transform: 'translateY(-50%)',
    pointerEvents: 'none',
  } as React.CSSProperties,
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function SchedulePicker({
  scheduledAt, timezone, onChange,
  automationMode, automationConfig, onAutomationChange,
}: SchedulePickerProps) {

  /* ---- Automation mode ---- */
  if (automationMode && automationConfig && onAutomationChange) {
    const config = automationConfig;
    const update = (patch: Partial<AutomationConfig>) =>
      onAutomationChange({ ...config, ...patch });

    const toggleDay = (day: number) => {
      const has = config.daysOfWeek.includes(day);
      update({
        daysOfWeek: has
          ? config.daysOfWeek.filter((d) => d !== day)
          : [...config.daysOfWeek, day],
      });
    };

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <label className="label" style={{ marginBottom: 0 }}>Repeat Schedule</label>

        {/* Frequency pills */}
        <div>
          <label style={s.fieldLabel}>Frequency</label>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {FREQUENCIES.map((f) => (
              <button
                key={f.value}
                type="button"
                style={s.pill(config.frequency === f.value)}
                onClick={() => update({ frequency: f.value })}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Weekly: day-of-week toggles */}
        {config.frequency === 'weekly' && (
          <div>
            <label style={s.fieldLabel}>Days</label>
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
              {DAYS_OF_WEEK.map((d) => (
                <button
                  key={d.value}
                  type="button"
                  style={s.dayToggle(config.daysOfWeek.includes(d.value))}
                  onClick={() => toggleDay(d.value)}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Monthly: day-of-month grid */}
        {config.frequency === 'monthly' && (
          <div>
            <label style={s.fieldLabel}>Day of month</label>
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', maxWidth: '310px' }}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                <button
                  key={d}
                  type="button"
                  style={s.monthDay(config.dayOfMonth === d)}
                  onClick={() => update({ dayOfMonth: d })}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Time + Timezone */}
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 120px' }}>
            <label style={s.fieldLabel}>Time</label>
            <input
              type="time"
              className="input"
              value={config.timeOfDay}
              onChange={(e) => update({ timeOfDay: e.target.value })}
            />
          </div>
          <div style={{ flex: '1 1 180px' }}>
            <label style={s.fieldLabel}>Timezone</label>
            <div style={s.selectWrap}>
              <select
                className="input"
                value={config.timezone}
                onChange={(e) => update({ timezone: e.target.value })}
                style={{ appearance: 'none', paddingRight: '36px', cursor: 'pointer' }}
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz.value} value={tz.value}>{tz.label}</option>
                ))}
              </select>
              <ChevronIcon />
            </div>
          </div>
        </div>

        {/* Summary hint */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: 'var(--text-xs)',
          color: 'var(--accent-600)',
        }}>
          <svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9a6 6 0 0111.5-2.4" />
            <polyline points="15 3 15 7 11 7" />
            <path d="M15 9a6 6 0 01-11.5 2.4" />
            <polyline points="3 15 3 11 7 11" />
          </svg>
          <span>{buildSummary(config)}</span>
        </div>
      </div>
    );
  }

  /* ---- Standard schedule mode ---- */
  const dateValue = scheduledAt ? toDateInputValue(scheduledAt, timezone) : '';
  const timeValue = scheduledAt ? toTimeInputValue(scheduledAt, timezone) : '';

  const relativeLabel = useMemo(
    () => (scheduledAt ? relativeTimeLabel(scheduledAt) : null),
    [scheduledAt],
  );

  const buildIso = (date: string, time: string, tz: string): string | null => {
    if (!date) return null;
    return localToUtc(date, time, tz);
  };

  const handleDateChange = (val: string) => {
    onChange(buildIso(val, timeValue, timezone), timezone);
  };

  const handleTimeChange = (val: string) => {
    onChange(buildIso(dateValue, val, timezone), timezone);
  };

  const handleTimezoneChange = (val: string) => {
    // When timezone changes, re-interpret the same displayed date/time in the new timezone
    if (scheduledAt) {
      onChange(buildIso(dateValue, timeValue, val), val);
    } else {
      onChange(null, val);
    }
  };

  const handleClear = () => {
    onChange(null, timezone);
  };

  // "Today" in the SELECTED timezone, not UTC — otherwise a user west of UTC (e.g. US
  // Pacific) after ~5pm gets a UTC-tomorrow min and can't pick today at all.
  let todayStr: string;
  try {
    todayStr = new Date().toLocaleDateString('en-CA', { timeZone: timezone || undefined });
  } catch {
    todayStr = new Date().toLocaleDateString('en-CA');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <label className="label" style={{ marginBottom: 0 }}>
          Schedule
        </label>
        {scheduledAt && (
          <button
            type="button"
            onClick={handleClear}
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--accent-600)',
              cursor: 'pointer',
              textDecoration: 'underline',
              background: 'none',
              border: 'none',
            }}
          >
            Clear schedule
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        {/* Date */}
        <div style={{ flex: '1 1 140px' }}>
          <label style={s.fieldLabel}>Date</label>
          <input
            type="date"
            className="input"
            value={dateValue}
            min={todayStr}
            onChange={(e) => handleDateChange(e.target.value)}
          />
        </div>

        {/* Time */}
        <div style={{ flex: '1 1 120px' }}>
          <label style={s.fieldLabel}>Time</label>
          <input
            type="time"
            className="input"
            value={timeValue}
            onChange={(e) => handleTimeChange(e.target.value)}
            disabled={!dateValue}
          />
        </div>

        {/* Timezone */}
        <div style={{ flex: '1 1 180px' }}>
          <label style={s.fieldLabel}>Timezone</label>
          <div style={s.selectWrap}>
            <select
              className="input"
              value={timezone}
              onChange={(e) => handleTimezoneChange(e.target.value)}
              style={{ appearance: 'none', paddingRight: '36px', cursor: 'pointer' }}
            >
              {TIMEZONES.map((tz) => (
                <option key={tz.value} value={tz.value}>
                  {tz.label}
                </option>
              ))}
            </select>
            <ChevronIcon />
          </div>
        </div>

      </div>

      {/* Relative time hint */}
      {scheduledAt && relativeLabel && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: 'var(--text-xs)',
            color: 'var(--color-scheduled)',
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <span>Scheduled {relativeLabel}</span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared sub-components                                              */
/* ------------------------------------------------------------------ */

function ChevronIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="var(--stone-400)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        position: 'absolute',
        right: '12px',
        top: '50%',
        transform: 'translateY(-50%)',
        pointerEvents: 'none',
      }}
    >
      <polyline points="4 6 8 10 12 6" />
    </svg>
  );
}

function buildSummary(config: AutomationConfig): string {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const time = config.timeOfDay || '09:00';

  if (config.frequency === 'daily') {
    return `Publishes every day at ${time}`;
  }
  if (config.frequency === 'weekly') {
    if (config.daysOfWeek.length === 0) return 'Select at least one day';
    const sorted = [...config.daysOfWeek].sort((a, b) => a - b);
    const names = sorted.map((d) => dayNames[d]);
    return `Publishes every ${names.join(', ')} at ${time}`;
  }
  if (config.frequency === 'monthly') {
    const suffix = config.dayOfMonth === 1 ? 'st' : config.dayOfMonth === 2 ? 'nd' : config.dayOfMonth === 3 ? 'rd' : 'th';
    return `Publishes on the ${config.dayOfMonth}${suffix} of every month at ${time}`;
  }
  return '';
}
