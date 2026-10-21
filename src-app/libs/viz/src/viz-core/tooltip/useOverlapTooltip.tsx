// useOverlapTooltip.tsx — the shared glue that turns a hover (in WORLD coords) into the overlap
// badge + "N more" dialog, for BOTH point mode and raster mode. It owns the lazy per-instance bin
// index (built on first hover over the resident positions), the hover/dialog state, and the render
// of `OverlapTooltip` + `OverlapDialog`. A host wires it in ~3 lines: build it, call `hoverAt` /
// `clear` from its hover handler, and drop `render(theme)` into its positioned container.
//
// Per-instance (a fresh index per hook) → a popped-out / portalled plot never shares another plot's
// index (the isolation model). The index is additive + lazy → non-hovering large-N renders pay
// nothing.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { VizTheme } from '../theme'
import { buildBinIndex, queryRadius, type BinBounds, type BinIndex } from '../spatial/binIndex'
import { resolveOverlap, type OverlapResolution } from './overlapModel'
import type { TooltipField } from './tooltipModel'
import { OverlapTooltip } from './OverlapTooltip'
import { OverlapDialog } from './OverlapDialog'

export interface UseOverlapTooltipOptions {
  /** resident interleaved xy positions (length N*2); `null` disables. */
  readonly positions: Float32Array | null
  /** the resident-column tooltip fields (same as a single-point hover); `null` disables. */
  readonly fields: readonly TooltipField[] | null
  /** master enable (opt-in; when false the hook is inert and renders nothing). */
  readonly enabled: boolean
  /** grid resolution per axis for the bin index (default 512). */
  readonly bins?: number
  /** how many points to show inline before "N more" (default 3). */
  readonly topN?: number
  /** explicit data bounds; else computed once from `positions`. */
  readonly bounds?: BinBounds
  /** bump when `positions` CONTENTS change under a STABLE reference (mirrors the codebase's
   *  epoch contract) so the bin index rebuilds; omit for immutable buffers. */
  readonly epoch?: number
  /** optional dialog aggregate header (raster mode: count/mean/dominant). */
  readonly aggregate?: (ordered: Uint32Array) => ReactNode
}

/** Hard clamp: the overlap query never spans more than this many bins per axis from the cursor, so a
 *  zoomed-WAY-out hover (a few screen px unproject to a huge world span) can't gather the whole cloud
 *  → the gather stays O(a bounded neighborhood), not O(N). */
const MAX_QUERY_BIN_RADIUS = 6

export interface OverlapTooltipHandle {
  /** feed a hover: world coords (for the query + ordering) + canvas-local screen coords (badge
   *  placement) + the overlap radius in WORLD units (host converts its px radius via the viewport). */
  readonly hoverAt: (
    worldX: number,
    worldY: number,
    screenX: number,
    screenY: number,
    worldRadius: number,
  ) => void
  /** clear the hover badge (mouse leave / empty pick). Does NOT close an open dialog. */
  readonly clear: () => void
  /** render the badge + dialog into the host's positioned container. */
  readonly render: (theme?: VizTheme) => ReactNode
}

function boundsOf(positions: Float32Array): BinBounds {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < positions.length; i += 2) {
    const x = positions[i]
    const y = positions[i + 1]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  return { minX, minY, maxX, maxY }
}

interface HoverState {
  resolution: OverlapResolution
  x: number
  y: number
}
interface DialogState {
  ordered: Uint32Array
  total: number
  header: ReactNode
}

export function useOverlapTooltip(opts: UseOverlapTooltipOptions): OverlapTooltipHandle {
  const { positions, fields, enabled, bins = 512, topN = 3, bounds, epoch, aggregate } = opts
  // Lazy per-instance bin index, keyed by the positions reference + `epoch` so a data swap OR an
  // in-place content change (epoch bump) rebuilds it.
  const indexRef = useRef<{ positions: Float32Array; epoch?: number; index: BinIndex } | null>(null)
  const [hover, setHover] = useState<HoverState | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)

  // rAF-coalesce the hover→setState: deck fires `onHover` many times per frame; without this the
  // heavy host canvas would re-render on every event (H1). Store the pending badge; flush once/frame.
  const pendingRef = useRef<HoverState | null>(null)
  const rafRef = useRef<number | null>(null)
  const scheduleFlush = useCallback((next: HoverState | null) => {
    pendingRef.current = next
    if (typeof requestAnimationFrame === 'undefined') {
      setHover(next)
    } else if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        setHover(pendingRef.current)
      })
    }
  }, [])
  useEffect(
    () => () => {
      if (rafRef.current != null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(rafRef.current)
      }
    },
    [],
  )

  const ensureIndex = useCallback((): BinIndex | null => {
    if (!positions || positions.length < 2) return null
    const cur = indexRef.current
    if (cur && cur.positions === positions && cur.epoch === epoch) return cur.index
    const index = buildBinIndex(positions, bounds ?? boundsOf(positions), bins, bins)
    indexRef.current = { positions, epoch, index }
    return index
  }, [positions, bounds, bins, epoch])

  const hoverAt = useCallback(
    (worldX: number, worldY: number, screenX: number, screenY: number, worldRadius: number) => {
      if (!enabled || !positions || !fields) return
      const index = ensureIndex()
      if (!index) return
      // Clamp the world radius to a bounded bin neighborhood so a zoomed-way-out hover can't gather
      // the whole cloud (H2): a few screen px unproject to a huge world span at extreme zoom-out.
      const binW = (index.bounds.maxX - index.bounds.minX) / index.bx
      const binH = (index.bounds.maxY - index.bounds.minY) / index.by
      const maxR = Math.max(binW, binH) * MAX_QUERY_BIN_RADIUS
      const r = maxR > 0 ? Math.min(worldRadius, maxR) : worldRadius
      const set = queryRadius(index, worldX, worldY, r)
      if (set.length === 0) {
        scheduleFlush(null)
        return
      }
      const resolution = resolveOverlap(set, positions, worldX, worldY, fields, topN)
      scheduleFlush({ resolution, x: screenX, y: screenY })
    },
    [enabled, positions, fields, ensureIndex, topN, scheduleFlush],
  )

  const clear = useCallback(() => scheduleFlush(null), [scheduleFlush])

  // Stable handlers so the dialog's Esc-listener effect doesn't churn on every host re-render (L2).
  const closeDialog = useCallback(() => setDialog(null), [])
  const openDialog = useCallback(() => {
    const h = pendingRef.current ?? hover
    if (!h) return
    setDialog({
      ordered: h.resolution.ordered,
      total: h.resolution.total,
      header: aggregate?.(h.resolution.ordered) ?? null,
    })
  }, [hover, aggregate])

  const render = useCallback(
    (theme?: VizTheme): ReactNode => {
      if (!enabled) return null
      return (
        <>
          {hover && (
            <OverlapTooltip
              resolution={hover.resolution}
              x={hover.x}
              y={hover.y}
              theme={theme}
              onMore={openDialog}
            />
          )}
          {dialog && fields && (
            <OverlapDialog
              total={dialog.total}
              ordered={dialog.ordered}
              fields={fields}
              header={dialog.header}
              theme={theme}
              onClose={closeDialog}
            />
          )}
        </>
      )
    },
    [enabled, hover, dialog, fields, openDialog, closeDialog],
  )

  return { hoverAt, clear, render }
}
