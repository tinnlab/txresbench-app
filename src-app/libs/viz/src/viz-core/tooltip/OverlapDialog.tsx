// OverlapDialog.tsx — the "+N more" full-list dialog: a scoped modal that VIRTUAL-scrolls ALL the
// overlapping points (rows built lazily per visible row via `resolveOverlapRow`) with an optional
// aggregate header (raster mode: "N points · mean … · dominant …"). It overlays its POSITIONED
// PARENT (the plot container), not the document body — so a popped-out / portalled plot keeps its
// dialog inside its own bounds (the isolation model). No SVG, no dependency.

import { useEffect, useRef, type ReactNode } from 'react'
import { LIGHT_THEME, type VizTheme } from '../theme'
import { resolveOverlapRow } from './overlapModel'
import type { TooltipField } from './tooltipModel'
import { WindowedList } from './WindowedList'

export interface OverlapDialogProps {
  /** total overlapping points (== `ordered.length`). */
  readonly total: number
  /** ALL overlapping indices, nearest-first (rows resolved lazily from these). */
  readonly ordered: Uint32Array
  /** the resident-column fields a row is built from (same as the hover tooltip). */
  readonly fields: readonly TooltipField[]
  /** optional aggregate summary (raster mode) rendered above the list. */
  readonly header?: ReactNode
  readonly onClose: () => void
  readonly theme?: VizTheme
  readonly title?: string
  readonly rowHeight?: number
  readonly testId?: string
}

export function OverlapDialog({
  total,
  ordered,
  fields,
  header,
  onClose,
  theme = LIGHT_THEME,
  title,
  rowHeight = 30,
  testId = 'viz-overlap-dialog',
}: OverlapDialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)

  // Esc closes; focus the close button on mount; TRAP Tab within the panel (full modal a11y — Tab
  // can't escape to the page behind, wrapping first↔last focusable).
  useEffect(() => {
    closeRef.current?.focus()
    // Resolve the document from the panel itself, never the ambient global: this dialog renders
    // inside a cell that may have been POPPED OUT into another window, where `document` is the
    // opener's — Escape and the Tab trap would listen on a document this panel is not in, and
    // `document.activeElement` would report the opener's focus. Same reasoning as
    // `@txresbench/dock`'s useGripDrag, which resolves its window via `ownerDocument.defaultView`.
    const doc = panelRef.current?.ownerDocument ?? document
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null)
      if (focusables.length === 0) {
        e.preventDefault()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = doc.activeElement as HTMLElement | null
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }
    doc.addEventListener('keydown', onKey, true)
    return () => doc.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const heading = title ?? `${total.toLocaleString()} points here`

  return (
    <div
      data-testid={`${testId}-backdrop`}
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 40,
        background: 'rgba(0,0,0,0.32)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        ref={panelRef}
        data-testid={testId}
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(420px, 92%)',
          maxHeight: '82%',
          display: 'flex',
          flexDirection: 'column',
          background: theme.surface,
          color: theme.fg,
          border: `1px solid ${theme.border}`,
          borderRadius: 6,
          boxShadow: '0 8px 28px rgba(0,0,0,0.35)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 10px',
            borderBottom: `1px solid ${theme.border}`,
          }}
        >
          <strong style={{ fontSize: 12 }}>{heading}</strong>
          <button
            ref={closeRef}
            type="button"
            data-testid={`${testId}-close`}
            aria-label="Close"
            title="Close"
            onClick={onClose}
            style={{
              cursor: 'pointer',
              fontSize: 14,
              lineHeight: 1,
              padding: '2px 6px',
              color: theme.fg,
              background: 'transparent',
              border: `1px solid ${theme.border}`,
              borderRadius: 3,
            }}
          >
            ×
          </button>
        </div>

        {header != null && (
          <div
            data-testid={`${testId}-aggregate`}
            style={{
              padding: '6px 10px',
              fontSize: 11,
              color: theme.muted,
              borderBottom: `1px solid ${theme.border}`,
            }}
          >
            {header}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0 }}>
          <WindowedList
            testId={`${testId}-list`}
            itemCount={total}
            rowHeight={rowHeight}
            height={Math.min(total * rowHeight, 420)}
            renderRow={i => {
              const pointIdx = ordered[i]
              const { rows } = resolveOverlapRow(pointIdx, fields)
              return (
                <div
                  data-testid={`${testId}-row-${i}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    height: '100%',
                    padding: '0 10px',
                    fontSize: 11,
                    borderBottom: `1px solid ${theme.border}`,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                  }}
                >
                  <span style={{ color: theme.muted, fontVariantNumeric: 'tabular-nums' }}>
                    #{pointIdx}
                  </span>
                  {rows.map(r => (
                    <span key={r.label} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <span style={{ color: theme.muted }}>{r.label} </span>
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{r.value}</span>
                    </span>
                  ))}
                </div>
              )
            }}
          />
        </div>
      </div>
    </div>
  )
}
