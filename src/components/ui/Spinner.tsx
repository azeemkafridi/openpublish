export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeMap: Record<string, number> = {
  sm: 14,
  md: 20,
  lg: 32,
};

export function Spinner({ size = 'md', className }: SpinnerProps) {
  const px = sizeMap[size];

  return (
    <>
      <svg
        className={className}
        width={px}
        height={px}
        viewBox="0 0 24 24"
        fill="none"
        style={{
          animation: 'spinnerRotate 800ms linear infinite',
          flexShrink: 0,
        }}
      >
        <circle
          cx="12"
          cy="12"
          r="10"
          stroke="var(--accent-200)"
          strokeWidth="3"
        />
        <path
          d="M12 2a10 10 0 0 1 10 10"
          stroke="var(--accent-600)"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      <style>{`
        @keyframes spinnerRotate {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </>
  );
}
