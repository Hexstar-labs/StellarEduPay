/**
 * SseDegradedBanner
 *
 * Renders a visible warning strip when the backend SSE service has signalled
 * that Redis pub/sub is unavailable and real-time updates may be incomplete
 * (Issue #1054). Dismissed automatically when an `sse.recovered` event arrives.
 *
 * Usage:
 *   import SseDegradedBanner from '../components/SseDegradedBanner';
 *   <SseDegradedBanner degraded={degraded} />
 */
export default function SseDegradedBanner({ degraded }) {
  if (!degraded) return null;

  return (
    <div
      role="alert"
      aria-live="polite"
      style={{
        background: '#7c2d12',
        color: '#fef2f2',
        padding: '0.5rem 1.5rem',
        textAlign: 'center',
        fontWeight: 600,
        fontSize: '0.8rem',
        letterSpacing: '0.01em',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.55rem',
        borderBottom: '1px solid rgba(0,0,0,0.2)',
        zIndex: 1000,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: '#fca5a5',
          flexShrink: 0,
        }}
      />
      Real-time updates degraded — some live events may not appear until connectivity is restored.
    </div>
  );
}
