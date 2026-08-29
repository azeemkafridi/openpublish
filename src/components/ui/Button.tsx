import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Spinner } from './Spinner';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
}

const variantClasses: Record<string, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
};

const sizeClasses: Record<string, string> = {
  sm: 'btn-sm',
  lg: 'btn-lg',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      disabled,
      icon,
      children,
      className,
      style,
      ...rest
    },
    ref,
  ) => {
    const classes = [
      'btn',
      variant !== 'danger' ? variantClasses[variant] : undefined,
      sizeClasses[size],
      className,
    ]
      .filter(Boolean)
      .join(' ');

    const dangerStyle: React.CSSProperties | undefined =
      variant === 'danger'
        ? {
            background: '#EF4444',
            color: '#FFFFFF',
          }
        : undefined;

    return (
      <button
        ref={ref}
        className={classes}
        disabled={disabled || loading}
        style={{ ...dangerStyle, ...style }}
        {...rest}
      >
        {loading ? <Spinner size="sm" /> : icon ? icon : null}
        {children}
      </button>
    );
  },
);

Button.displayName = 'Button';
