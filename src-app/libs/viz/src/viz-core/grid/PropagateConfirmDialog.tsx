// PropagateConfirmDialog.tsx — (segmentation-scale Track C, ITEM-14) the confirm-before-overwrite
// step for "apply display to link group". ESC-1 (owner decision): clean cells are applied directly,
// but cells that already carry their OWN display overrides are only overwritten after the user
// confirms — this dialog lists exactly those cells. Modeled on `RestoreChoiceDialog` (viz-core inline
// style, role="dialog" + aria-modal, backdrop, testids, focus trap between the two actions).

import { useEffect, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'

export interface PropagateConfirmDialogProps {
  /** human labels of the cells that WILL be overwritten (they have their own overrides). */
  readonly overwriteLabels: readonly string[]
  /** what is being applied, for the prompt copy. */
  readonly scopeLabel: string
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

const backdrop: CSSProperties = {
  position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
}
const panel: CSSProperties = {
  background: 'var(--popover, #fff)', color: 'var(--popover-foreground, #111)',
  border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: 16,
  maxWidth: 420, width: '90%', boxShadow: '0 10px 40px rgba(0,0,0,0.25)',
}

/** Confirm overwriting the listed cells' existing display overrides. */
export function PropagateConfirmDialog({ overwriteLabels, scopeLabel, onConfirm, onCancel }: PropagateConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    confirmRef.current?.focus()
  }, [])
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
      return
    }
    if (e.key !== 'Tab') return
    const first = confirmRef.current
    const last = cancelRef.current
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
    <div style={backdrop} data-testid="viz-propagate-confirm" onKeyDown={onKeyDown}>
      <div role="dialog" aria-modal="true" aria-labelledby="viz-propagate-confirm-title" style={panel}>
        <div id="viz-propagate-confirm-title" style={{ fontWeight: 600, marginBottom: 8 }}>
          Overwrite {overwriteLabels.length} cell{overwriteLabels.length === 1 ? '' : 's'}?
        </div>
        <div style={{ fontSize: 13, marginBottom: 12, opacity: 0.85 }}>
          Applying {scopeLabel} to the link group will overwrite the existing settings on:
          <ul style={{ margin: '6px 0 0', paddingInlineStart: 18 }} data-testid="viz-propagate-confirm-list">
            {overwriteLabels.map((l, i) => (
              <li key={`${l}-${i}`}>{l}</li>
            ))}
          </ul>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            ref={cancelRef}
            data-testid="viz-propagate-confirm-cancel"
            onClick={onCancel}
            style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border, #ccc)', background: 'transparent' }}
          >
            Cancel
          </button>
          <button
            type="button"
            ref={confirmRef}
            data-testid="viz-propagate-confirm-apply"
            onClick={onConfirm}
            style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--primary, #2563eb)', background: 'var(--primary, #2563eb)', color: 'var(--primary-foreground, #fff)' }}
          >
            Overwrite
          </button>
        </div>
      </div>
    </div>
  )
}
