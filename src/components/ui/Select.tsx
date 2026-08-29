import { forwardRef, type SelectHTMLAttributes } from 'react';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  label?: string;
  error?: string;
  hint?: string;
  options: SelectOption[];
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, hint, options, placeholder, className, id, style, ...rest }, ref) => {
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {label && (
          <label className="label" htmlFor={inputId}>
            {label}
          </label>
        )}
        <div style={{ position: 'relative' }}>
          <select
            ref={ref}
            id={inputId}
            className={['input', className].filter(Boolean).join(' ')}
            style={{
              appearance: 'none',
              paddingRight: '36px',
              cursor: 'pointer',
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
          >
            {placeholder && (
              <option value="" disabled>
                {placeholder}
              </option>
            )}
            {options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
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
        </div>
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

Select.displayName = 'Select';
