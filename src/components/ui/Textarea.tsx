import { forwardRef, type TextareaHTMLAttributes } from 'react';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, hint, rows = 4, className, id, style, ...rest }, ref) => {
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {label && (
          <label className="label" htmlFor={inputId}>
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          id={inputId}
          rows={rows}
          className={['input', className].filter(Boolean).join(' ')}
          style={{
            resize: 'vertical',
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

Textarea.displayName = 'Textarea';
