// portalPopout.story.tsx — the PORTAL-MOVE pop-out (replacing the separate-root + BroadcastChannel
// demo). A single stateful component is `createPortal`ed into a REAL popup window via
// `useWindowPortal`; because the stable target node is MOVED (not recreated), it is the SAME React
// instance — so state survives pop-out AND pop-back-in with no sync. The counter proves it: it keeps
// its value across the move (a second synced copy would reset to 0).
//
// The e2e drives: increment → pop out (state intact in the popup) → increment in the popup → return
// (state intact in-place). window.open needs a user gesture; the "Pop out" click is one.

import { useState } from 'react'
import { useWindowPortal } from '../../viz-core/popout/windowPortal'
import { registerStory } from '../registry'

function PortalPopoutStory() {
  const portal = useWindowPortal({ id: 'demo', title: 'Popped-out pane', width: 680, height: 520 })
  const [count, setCount] = useState(0)

  // The MOVED content — one instance, portaled into either the in-place anchor or the popup body.
  const content = (
    <div
      data-testid="viz-portal-content"
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        alignItems: 'center',
        justifyContent: 'center',
        background: portal.isOpen ? '#0b1220' : '#f2f4f8',
        color: portal.isOpen ? '#e8ecf4' : '#1a1a1a',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div data-testid="viz-portal-count" style={{ fontSize: 28, fontVariantNumeric: 'tabular-nums' }}>
        count: {count}
      </div>
      <button
        type="button"
        data-testid="viz-portal-inc"
        onClick={() => setCount(c => c + 1)}
        style={{ fontSize: 18, padding: '6px 16px', cursor: 'pointer' }}
      >
        +1
      </button>
      <span data-testid="viz-portal-location" style={{ opacity: 0.7 }}>
        {portal.isOpen ? 'rendering in the POPUP window' : 'rendering IN-PLACE'}
      </span>
    </div>
  )

  return (
    <div
      data-testid="viz-portal-story"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'system-ui, sans-serif' }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>Portal-move pop-out</strong>
        <span style={{ opacity: 0.7, fontSize: 12 }}>
          One instance, MOVED into a real window. State (the counter) survives pop-out + return — no sync,
          no second copy.
        </span>
        <span style={{ flex: 1 }} />
        <span data-testid="viz-portal-isopen">{portal.isOpen ? 'open' : 'closed'}</span>
        <button type="button" data-testid="viz-portal-open" onClick={() => portal.open()}>
          Pop out ↗
        </button>
        <button type="button" data-testid="viz-portal-close" onClick={() => portal.close()}>
          Return
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: 8 }}>{portal.render(content)}</div>
    </div>
  )
}

registerStory({
  id: 'portal-popout',
  category: 'Grid + resize',
  title: 'Portal-move pop-out — one instance moved into a real window (state preserved)',
  Component: PortalPopoutStory,
})
