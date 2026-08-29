import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface DialogProps {
  open: boolean;
  onClose?: () => void;
  title?: string;
  description?: string;
  children?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

const sizeWidths: Record<string, string> = {
  sm: '400px',
  md: '520px',
  lg: '680px',
};

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  size = 'md',
}: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 'var(--z-modal)' as any,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--surface-overlay)',
        animation: 'dialogOverlayIn 200ms ease both',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          background: 'var(--surface-main)',
          borderRadius: 'var(--radius-2xl)',
          boxShadow: 'var(--shadow-xl)',
          width: '90vw',
          maxWidth: sizeWidths[size],
          maxHeight: '85vh',
          overflow: 'auto',
          padding: '28px',
          position: 'relative',
          animation: 'dialogContentIn 280ms cubic-bezier(0.34, 1.56, 0.64, 1) both',
        }}
      >
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close dialog"
            style={{
              position: 'absolute',
              top: '16px',
              right: '16px',
              width: '32px',
              height: '32px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 'var(--radius-md)',
              color: 'var(--stone-400)',
              transition: 'color var(--transition-fast)',
            }}
            onMouseOver={(e) =>
              (e.currentTarget.style.color = 'var(--stone-800)')
            }
            onMouseOut={(e) =>
              (e.currentTarget.style.color = 'var(--stone-400)')
            }
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </button>
        )}

        {title && (
          <h3
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'var(--text-lg)',
              color: 'var(--stone-900)',
              marginBottom: description ? '6px' : '20px',
              paddingRight: '32px',
            }}
          >
            {title}
          </h3>
        )}

        {description && (
          <p
            style={{
              fontSize: 'var(--text-sm)',
              color: 'var(--stone-500)',
              lineHeight: 'var(--leading-relaxed)',
              marginBottom: '20px',
            }}
          >
            {description}
          </p>
        )}

        {children}
      </div>

      <style>{`
        @keyframes dialogOverlayIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes dialogContentIn {
          from {
            opacity: 0;
            transform: scale(0.95) translateY(8px);
          }
          to {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
        }
      `}</style>
    </div>,
    document.body,
  );
}
