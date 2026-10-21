// SelectableScatter.tsx — a GPU scatter with a multi-area selection tool (DEC-24/25).
// Framework-agnostic (viz-core): depends ONLY on @deck.gl/* + react. The user picks a
// TOOL (pan / rect / polygon / move) and a combine MODE (add / subtract / intersect) from the
// toolbar, then draws areas over the plot; a completed area is folded into the combined `IndexMask`.
//
// This is now the REFERENCE host for the SHARED area-selection interaction (`useAreaSelection`):
// all of the draft/commit/outline/preview/drag lifecycle lives in that hook + the pure
// `areaGestures` core, so the scatter, the grid, the spatial ROI, and the violin lasso behave
// IDENTICALLY (persistent committed outline + drag-to-move). This component only owns its OWN
// rendering (the dimmed base + selected-overlay scatter layers) and its viewport `unproject`.
//
// Highlight rendering (DEC-25): a per-point `selected` Uint8 attribute drives a
// `DataFilterExtension` overlay layer (filterRange [1,1]) that redraws ONLY the selected points at
// full opacity on top of a dimmed base layer — both share the SAME positions/colors buffers.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DeckGL } from '@deck.gl/react'
import { OrthographicView, type OrthographicViewState } from '@deck.gl/core'
import { ScatterplotLayer } from '@deck.gl/layers'
import { DataFilterExtension } from '@deck.gl/extensions'
import { IndexMask } from '../data/selection'
import { buildPointIndex } from '../spatial/pointIndex'
import {
  SELECTION_TOOLS,
  COMBINE_MODES,
  SELECTION_TOOL_LABEL,
  type SelectionTool,
  type CombineMode,
  type Vec2,
} from './areaGestures'
import type { VizSelectionOp } from '../option/types'
import { useAreaSelection, buildSelectionOutlineLayer } from './useAreaSelection'
import { useSelectionCamera } from './useSelectionCamera'

export type { SelectionTool }

export interface SelectableScatterProps {
  /** interleaved xy Float32Array (world space), length totalPoints*2. */
  positions: Float32Array
  /** RGBA Uint8Array, length totalPoints*4. */
  colors: Uint8Array
  totalPoints: number
  radius?: number
  /** bump when `colors` CONTENTS change so the layers re-upload. */
  colorEpoch?: number
  initialViewState?: Partial<OrthographicViewState>
  /** fired with the combined mask on every selection change. */
  onSelectionChange?: (mask: IndexMask) => void
  /** M9 / ITEM-9 — receive the selection's PROVENANCE (the ordered op list) alongside the mask, so a
   *  selection made outside the grid is not silently provenance-less. This component owns no store,
   *  so it hands the ops to its host rather than writing them itself. Omitted ⇒ byte-identical. */
  onCommitOps?: (ops: readonly VizSelectionOp[]) => void
}

const DEFAULT_VIEW_STATE: OrthographicViewState = {
  target: [0, 0, 0],
  zoom: 4,
} as OrthographicViewState

const DIM_OPACITY = 0.12

/** A GPU scatter view with a rect/polygon multi-area selection tool + GPU highlight. */
export function SelectableScatter({
  positions,
  colors,
  totalPoints,
  radius = 2,
  colorEpoch = 0,
  initialViewState,
  onSelectionChange,
  onCommitOps,
}: SelectableScatterProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const view = useMemo(() => new OrthographicView({ id: 'ortho', flipY: false }), [])

  const [tool, setTool] = useState<SelectionTool>('pan')
  const [mode, setMode] = useState<CombineMode>('add')
  const [viewState, setViewState] = useState<OrthographicViewState>({
    ...DEFAULT_VIEW_STATE,
    ...initialViewState,
  })

  // The CPU spatial index over the point cloud — built ONCE per positions buffer, reused for
  // every hit-test (O(log N + k), not O(N)).
  const pointIndex = useMemo(() => buildPointIndex(positions), [positions])

  // ── screen → world unprojection (against an EXPLICIT viewState — needed by the pan/zoom math,
  //    which reprojects under a hypothetical camera; the live `unproject` closes over the current one) ──
  const unprojectAt = useCallback(
    (vs: OrthographicViewState, clientX: number, clientY: number): Vec2 | null => {
      const el = containerRef.current
      if (!el) return null
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return null
      const vp = view.makeViewport({ width: rect.width, height: rect.height, viewState: vs })
      if (!vp) return null
      const world = vp.unproject([clientX - rect.left, clientY - rect.top])
      return [world[0], world[1]]
    },
    [view],
  )
  const unproject = useCallback(
    (clientX: number, clientY: number): Vec2 | null => unprojectAt(viewState, clientX, clientY),
    [unprojectAt, viewState],
  )

  // ALL selection logic lives in the shared hook (draft/commit/outline/preview/drag).
  const sel = useAreaSelection({ positions, totalPoints, pointIndex, unproject, tool, mode, onSelectionChange, onCommitOps })
  const hasSelection = sel.selCount > 0

  // ── camera pan/zoom that STAYS LIVE during a selection tool (shared helper) ──────────────────
  // WHEEL = zoom-to-cursor, MIDDLE-drag or SPACE+drag = pan, LEFT-drag = draw. Because the selection
  // outline + points are world-space layers in this controlled `viewState`, they anchor to the data
  // and move/scale WITH the camera. The exact same helper backs every 2D-area selection surface.
  const cam = useSelectionCamera({ viewState, setViewState, unprojectAt })
  const overlayHandlers = useMemo(
    () => cam.wrapPointerHandlers(sel.pointerHandlers),
    [cam, sel.pointerHandlers],
  )

  // ── layers ────────────────────────────────────────────────────────────────
  const baseData = useMemo(
    () => ({
      length: totalPoints,
      attributes: {
        getPosition: { value: positions, size: 2 } as const,
        getFillColor: { value: colors, size: 4, normalized: true } as const,
      },
    }),
    [positions, colors, totalPoints],
  )

  const filterExt = useMemo(() => new DataFilterExtension({ filterSize: 1 }), [])

  const layers = useMemo(() => {
    const out: unknown[] = []

    // 1) base scatter — dimmed when a selection exists, full when not.
    out.push(
      new ScatterplotLayer({
        id: 'sel-base',
        data: baseData,
        radiusUnits: 'pixels',
        getRadius: radius,
        radiusMinPixels: 1,
        radiusMaxPixels: 8,
        stroked: false,
        filled: true,
        opacity: hasSelection ? DIM_OPACITY : 1,
        pickable: false,
        updateTriggers: { getFillColor: colorEpoch },
      }),
    )

    // 2) highlight overlay — only the selected points (filterRange [1,1]), full opacity.
    if (hasSelection) {
      out.push(
        new ScatterplotLayer({
          id: 'sel-highlight',
          data: {
            length: totalPoints,
            attributes: {
              getPosition: { value: positions, size: 2 },
              getFillColor: { value: colors, size: 4, normalized: true },
              getFilterValue: { value: sel.selected, size: 1 },
            },
          },
          radiusUnits: 'pixels',
          getRadius: radius + 1,
          radiusMinPixels: 2,
          radiusMaxPixels: 10,
          stroked: false,
          filled: true,
          opacity: 1,
          pickable: false,
          extensions: [filterExt],
          filterRange: [1, 1],
          updateTriggers: { getFillColor: colorEpoch, getFilterValue: sel.selEpoch },
        }),
      )
    }

    // 3) drawn-area outlines (committed persist) + in-progress draft — the SHARED outline layer.
    const outline = buildSelectionOutlineLayer(sel.shapes)
    if (outline) out.push(outline)

    return out
  }, [baseData, positions, colors, totalPoints, sel.selected, sel.selEpoch, sel.shapes, colorEpoch, radius, hasSelection, filterExt])

  const drawing = tool !== 'pan'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }} data-testid="viz-selectable-scatter">
      {/* toolbar */}
      <div
        style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}
        data-testid="selection-toolbar"
      >
        <span style={{ display: 'inline-flex', gap: 4 }}>
          {SELECTION_TOOLS.map(t => (
            <button
              key={t}
              type="button"
              data-testid={`sel-tool-${t}`}
              aria-pressed={tool === t}
              onClick={() => {
                setTool(t)
                sel.resetDraft()
              }}
              style={{ fontWeight: tool === t ? 700 : 400 }}
            >
              {SELECTION_TOOL_LABEL[t]}
            </button>
          ))}
        </span>
        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
          <span style={{ opacity: 0.6 }}>Mode:</span>
          {COMBINE_MODES.map(m => (
            <button
              key={m}
              type="button"
              data-testid={`sel-mode-${m}`}
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              style={{ fontWeight: mode === m ? 700 : 400 }}
            >
              {m}
            </button>
          ))}
        </span>
        {tool === 'polygon' && (
          <button type="button" data-testid="sel-poly-finish" onClick={sel.finishPolygon} disabled={sel.polyDraftLength < 3}>
            Finish polygon ({sel.polyDraftLength})
          </button>
        )}
        <button type="button" data-testid="sel-clear" onClick={sel.clearSelection}>
          Clear
        </button>
        <span data-testid="selection-count" style={{ opacity: 0.7 }}>
          {sel.selCount.toLocaleString()} selected
        </span>
      </div>

      {/* canvas + drawing overlay */}
      <div ref={containerRef} style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <DeckGL
          views={view}
          controller={!drawing}
          viewState={viewState as never}
          onViewStateChange={((p: { viewState: OrthographicViewState }) => setViewState(p.viewState)) as never}
          layers={layers as never}
        />
        {drawing && (
          <div
            data-testid="selection-draw-overlay"
            ref={cam.overlayWheelRef}
            onPointerDown={overlayHandlers.onPointerDown}
            onPointerMove={overlayHandlers.onPointerMove}
            onPointerUp={overlayHandlers.onPointerUp}
            style={{
              position: 'absolute',
              inset: 0,
              cursor: cam.cursorFor(sel.cursor),
              touchAction: 'none',
            }}
          />
        )}
      </div>
    </div>
  )
}
