import { forwardRef, type InputHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, className, id, style, ...rest }, ref) => {
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {label && (
          <label className="label" htmlFor={inputId}>
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={['input', className].filter(Boolean).join(' ')}
          style={{
            ...(error
              ? {
                  borderColor: 'var(--color-error)',
                  boxShadow: '0 0 0 3px var(--color-error-bg)',
                }
              : {}),
            ...style,
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            error
              ? `${inputId}-error`
              : hint
                ? `${inputId}-hint`
                : undefined
          }
          {...rest}
        />
        {error && (
          <span
            id={`${inputId}-error`}
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--color-error)',
              marginTop: '4px',
            }}
          >
            {error}
          </span>
        )}
        {!error && hint && (
          <span
            id={`${inputId}-hint`}
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--stone-400)',
              marginTop: '4px',
            }}
          >
            {hint}
          </span>
        )}
      </div>
    );
  },
);

Input.displayName = 'Input';
