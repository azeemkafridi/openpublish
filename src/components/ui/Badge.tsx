import type { ReactNode } from 'react';

export interface BadgeProps {
  variant?: 'success' | 'error' | 'warning' | 'info' | 'scheduled' | 'neutral';
  dot?: boolean;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

const variantClasses: Record<string, string> = {
  success: 'badge-success',
  error: 'badge-error',
  warning: 'badge-warning',
  info: 'badge-info',
  scheduled: 'badge-scheduled',
};

export function Badge({
  variant = 'neutral',
  dot = false,
  children,
  className,
  style,
}: BadgeProps) {
  const isNeutral = variant === 'neutral';

  const classes = [
    'badge',
    !isNeutral ? variantClasses[variant] : undefined,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const neutralStyle: React.CSSProperties | undefined = isNeutral
    ? { background: 'var(--stone-200)', color: 'var(--stone-700)' }
    : undefined;

  return (
    <span className={classes} style={{ ...neutralStyle, ...style }}>
      {dot && (
        <span
          className="badge-dot"
          style={
            isNeutral ? { background: 'var(--stone-500)' } : undefined
          }
        />
      )}
      {children}
    </span>
  );
}
