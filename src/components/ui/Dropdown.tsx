import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  type ReactNode,
  type CSSProperties,
} from 'react';

export interface DropdownItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
}

export interface DropdownProps {
  trigger: ReactNode;
  items: DropdownItem[];
  align?: 'left' | 'right';
  /** Override the wrapper style. Pass `{ position: 'static' }` to let the menu anchor to a
   *  positioned ancestor instead of the trigger (e.g. to span a wider row). */
  containerStyle?: CSSProperties;
  /** Override the menu (popover) style — width, left/right offsets, minWidth, etc. */
  menuStyle?: CSSProperties;
  /** Override each menu item's style — e.g. to match a trigger's height. */
  itemStyle?: CSSProperties;
}

export function Dropdown({ trigger, items, align = 'left', containerStyle, menuStyle, itemStyle }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Flip the menu above the trigger when there isn't enough room below AND there
  // is more room above. Runs before paint (useLayoutEffect) so there's no visible
  // jump. Re-measured on every open since the trigger's viewport position varies.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = containerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const tr = trigger.getBoundingClientRect();
    const menuH = menu.offsetHeight;
    const gap = 8;
    const spaceBelow = window.innerHeight - tr.bottom;
    const spaceAbove = tr.top;
    setOpenUp(spaceBelow < menuH + gap && spaceAbove > spaceBelow);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [open]);

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-flex', ...containerStyle }}>
      <div
        onClick={() => setOpen((prev) => !prev)}
        style={{ cursor: 'pointer' }}
      >
        {trigger}
      </div>

      {open && (
        <div
          role="menu"
          ref={menuRef}
          style={{
            position: 'absolute',
            [openUp ? 'bottom' : 'top']: 'calc(100% + 4px)',
            [align === 'right' ? 'right' : 'left']: 0,
            zIndex: 'var(--z-dropdown)' as any,
            background: 'var(--surface-main)',
            border: '1px solid var(--stone-200)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-lg)',
            padding: '4px',
            minWidth: '180px',
            animation: 'dropdownIn 150ms cubic-bezier(0.4, 0, 0.2, 1) both',
            ...menuStyle,
          }}
        >
          {items.map((item, i) => (
            <button
              key={i}
              role="menuitem"
              onClick={() => {
                item.onClick();
                setOpen(false);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                width: '100%',
                padding: '12px',
                fontSize: 'var(--text-sm)',
                color: item.danger ? 'var(--color-error)' : 'var(--stone-700)',
                borderRadius: '8px',
                transition: 'background var(--transition-fast)',
                textAlign: 'left',
                ...itemStyle,
              }}
              onMouseOver={(e) =>
                (e.currentTarget.style.background = item.danger
                  ? 'var(--color-error-bg)'
                  : '#FFFFFF')
              }
              onMouseOut={(e) =>
                (e.currentTarget.style.background = 'transparent')
              }
            >
              {item.icon && (
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    color: item.danger ? 'var(--color-error)' : 'var(--stone-400)',
                    flexShrink: 0,
                  }}
                >
                  {item.icon}
                </span>
              )}
              {item.label}
            </button>
          ))}

          <style>{`
            @keyframes dropdownIn {
              from {
                opacity: 0;
                transform: translateY(-4px) scale(0.98);
              }
              to {
                opacity: 1;
                transform: translateY(0) scale(1);
              }
            }
          `}</style>
        </div>
      )}
    </div>
  );
}
