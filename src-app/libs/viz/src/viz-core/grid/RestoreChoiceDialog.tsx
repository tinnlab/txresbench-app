// RestoreChoiceDialog — the session-restore choice overlay (docking P5). When a reloaded session had
// panes docked in popup windows, those windows can't reopen automatically (a browser `window.open`
// needs a user GESTURE). So the main grid shows this dialog: MERGE the popup panes back into the main
// grid, or REOPEN their windows (the button click supplies the gesture). Modeled on `OverlapDialog`
// (role="dialog" + aria-modal, a backdrop, testids); viz-core inline-style convention (no @txresbench/*).

import { useEffect, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'

export interface RestoreChoiceDialogProps {
  /** how many popup windows the restored session had (still pending). */
  windowCount: number
  /** fold the popup panes back into the main grid. */
  onMerge: () => void
  /** reopen the popup windows (this click is the user gesture `window.open` needs). */
  onReopen: () => void
}

/** Non-dismissable choice dialog — there is no "close" (both actions resolve the pending restore); the
 *  user MUST pick merge or reopen so the restored panes never stay orphaned/invisible. */
export function RestoreChoiceDialog({ windowCount, onMerge, onReopen }: RestoreChoiceDialogProps) {
  const reopenRef = useRef<HTMLButtonElement>(null)
  const mergeRef = useRef<HTMLButtonElement>(null)
  // Move focus into the dialog on mount (the primary action) — a modal the user MUST resolve.
  useEffect(() => {
    reopenRef.current?.focus()
  }, [])
  // Trap Tab / Shift-Tab between the two actions so focus can't wander into the (visually obscured)
  // grid chrome behind the modal. (Escape is intentionally NOT handled — the dialog is non-dismissable.)
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return
    const first = reopenRef.current
    const last = mergeRef.current
    if (!first || !last) return
    const active = (e.target as HTMLElement).ownerDocument.activeElement
    if (e.shiftKey && active === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }
  return (
    <div
      data-testid="viz-restore-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Restore windows"
      style={ROOT_STYLE}
      onKeyDown={onKeyDown}
    >
      <div style={BACKDROP_STYLE} data-testid="viz-restore-dialog-backdrop" />
      <div style={PANEL_STYLE}>
        <div style={{ display: 'grid', gap: 10, placeItems: 'center', textAlign: 'center', maxWidth: 320 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>Restore your layout</span>
          <span style={{ opacity: 0.8, fontSize: 12 }}>
            This session had {windowCount} pop-out {windowCount === 1 ? 'window' : 'windows'}. Reopen{' '}
            {windowCount === 1 ? 'it' : 'them'}, or merge those panes back into the main grid.
          </span>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button
              ref={reopenRef}
              type="button"
              data-testid="viz-restore-reopen"
              onClick={onReopen}
              style={{ ...BTN_STYLE, ...PRIMARY_BTN_STYLE }}
            >
              Reopen {windowCount === 1 ? 'window' : `${windowCount} windows`}
            </button>
            <button
              ref={mergeRef}
              type="button"
              data-testid="viz-restore-merge"
              onClick={onMerge}
              style={BTN_STYLE}
            >
              Merge to main
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** The root COVERS the whole workspace (so the testid element has a real box + the modal traps the
 *  surface); the backdrop + panel sit inside it. */
const ROOT_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 40,
}

const BACKDROP_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'rgba(0,0,0,0.45)',
}

const PANEL_STYLE: CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  zIndex: 41,
  padding: 16,
  borderRadius: 8,
  background: 'rgba(28,28,30,0.98)',
  color: '#fff',
  border: '1px solid rgba(128,128,128,0.5)',
  boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
  font: '12px system-ui, sans-serif',
}

const BTN_STYLE: CSSProperties = {
  font: '12px system-ui, sans-serif',
  lineHeight: 1,
  height: 28,
  padding: '0 12px',
  background: 'rgba(255,255,255,0.08)',
  color: '#fff',
  border: '1px solid rgba(128,128,128,0.5)',
  borderRadius: 4,
  cursor: 'pointer',
}

const PRIMARY_BTN_STYLE: CSSProperties = {
  background: 'rgba(59,130,246,0.85)',
  border: '1px solid rgba(59,130,246,0.9)',
}
