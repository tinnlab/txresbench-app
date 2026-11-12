// ContextLostOverlay.tsx — a small, NON-BLOCKING "GPU context lost — recovering…"
// badge shown over the deck canvas while a WebGL context is down (ITEM-57). Kit-free
// (raw DOM, no @txresbench/*) so it stays inside viz-core. Purely informational: the
// workspace + data survive in JS memory; the badge disappears once the context
// restores and buffers re-upload (no page reload).

/** Non-blocking recovery badge. Rendered only while `lost` is true. */
export function ContextLostOverlay() {
  return (
    <div
      data-testid="viz-context-lost"
      role="status"
      aria-live="polite"
      style={{
        position: 'absolute',
        top: 8,
        left: 8,
        zIndex: 3,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 10px',
        borderRadius: 6,
        background: 'rgba(30,30,30,0.82)',
        color: '#fff',
        font: '12px system-ui, sans-serif',
        boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: '#f59e0b',
        }}
      />
      GPU context lost — recovering…
    </div>
  )
}
