// VolcanoView.tsx — the volcano VIEW (DEC-18: a ScatterplotLayer colored by direction
// + LineLayer ±fc / p threshold guides + a TextLayer of the top-N labels). The
// fold-change (±) and significance thresholds are INTERACTIVE: two `DragRail`s (DEC-30)
// drive the thresholds, which recolor the points (up/down/ns) and re-place the guide
// lines in real time. Data-shaping (a bulk stat `DataTable` → `VolcanoPointInput[]`) is
// the pure exported `volcanoInputFromTable` helper; the recolor/label geometry is the
// pure `chartInteractions` helpers; the component only wires load → helpers →
// `buildVolcanoProps` → layers → `ChartCanvas`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAsyncChartData, ChartError, ChartLoading } from './useAsyncChartData'
import { ScatterplotLayer, LineLayer, TextLayer } from '@deck.gl/layers'
import type { Layer } from '@deck.gl/core'
import { ChartCanvas } from './ChartCanvas'
import { usePublishHover, useHoverHighlightIndex, useTooltipsEnabled } from './plotCellId'
import { formatNumber } from '../tooltip/tooltipModel'
import { buildVolcanoProps, type VolcanoPointInput } from './chartLayers'
import { chartFrameFont, type Typography } from '../controls/typography'
import { buildChartFrameLayers, defaultChartTheme, type ChartTheme } from './ChartFrame'
import { clipToBounds } from './clip'
import { volcanoPoints } from './aggregate'
import { topNLabels, volcanoCategorize } from './chartInteractions'
import { DragRail } from '../controls/DragRail'
import type { DataSource, DataTable } from '../data/wire'

/**
 * Bind ONE volcano column: an author's DECLARATION first, then the conventional name but only when
 * the table ACTUALLY carries it, then the sole remaining candidate. Never a positional pick.
 *
 * An explicit `opts.*Column` is evidence and is honoured verbatim — including when the table does
 * not have it, which resolves to nothing and lets the caller's empty state say so rather than
 * quietly binding some other column instead.
 */
function bindColumn(
  explicit: string | undefined,
  conventional: string,
  candidates: readonly string[],
): string | undefined {
  if (explicit !== undefined) return candidates.includes(explicit) ? explicit : undefined
  if (candidates.includes(conventional)) return conventional
  return candidates.length === 1 ? candidates[0] : undefined
}

/**
 * Turn a bulk stat `DataTable` (row per column; an effect-size column + a significance
 * column) into volcano points (`VolcanoPointInput[]`): run the shared `volcanoPoints`
 * classifier over the two numeric columns, mapping each to `{ label, x: log2fc, y:
 * negLog10P, direction }`. Unresolvable columns → empty. Pure — no GL, no I/O.
 *
 * ── THE COLUMN NAMES ARE NOT INVENTED ────────────────────────────────────────────────
 *
 * This read used to be `table.columns[opts.effectColumn ?? 'effect']` and `?? 'signif'`.
 * Those `??`s are not fallbacks: they are two hardcoded column literals — the in-package
 * fixtures' vocabulary asserted over a host's stat table, which per
 * `docs/design/binding-resolution-refusal.md` is "a claim about the data that no
 * contributor made". A host table whose columns are, say, `log2FoldChange` / `padj` had
 * neither literal, so the plot silently rendered nothing with no statement of why; worse,
 * a table that happened to carry an UNRELATED column called `effect` would have been
 * plotted as the fold change.
 *
 * Now: a declared `opts.*Column` binds (a declaration is evidence); otherwise the
 * conventional name binds only when the table really has it (so every existing
 * `effect`/`signif` table is byte-identical); otherwise the SOLE remaining candidate, which
 * asserts nothing because there is no choice to make. Two-or-more candidates and none, both
 * resolve to NOTHING — no throw, `[]`, and the view's existing empty state handles it. The
 * significance column is bound against the candidates MINUS the one the effect channel took,
 * since a volcano's two axes are two different columns.
 */
export function volcanoInputFromTable(
  table: DataTable,
  opts: { effectColumn?: string; significanceColumn?: string; fcThreshold?: number; pThreshold?: number } = {},
): VolcanoPointInput[] {
  // Every `DataTable` column is a `Float32Array`, so "numeric candidate" is every column.
  const columns = Object.keys(table.columns)
  const effectKey = bindColumn(opts.effectColumn, 'effect', columns)
  const signifKey = bindColumn(
    opts.significanceColumn,
    'signif',
    columns.filter(c => c !== effectKey),
  )
  const effect = effectKey === undefined ? undefined : table.columns[effectKey]
  const signif = signifKey === undefined ? undefined : table.columns[signifKey]
  if (!effect || !signif) return []
  const labels = [...table.rowLabels]
  const pts = volcanoPoints(labels, effect, signif, {
    fcThreshold: opts.fcThreshold,
    pThreshold: opts.pThreshold,
  })
  return pts.map(p => ({ label: p.column, x: p.log2fc, y: p.negLog10P, direction: p.direction }))
}

const DEFAULT_FC = 1
const DEFAULT_P = 1.30103 // −log10(0.05)
/** How many of the most-significant points to label with a `TextLayer`. */
const TOP_LABELS = 8

export interface VolcanoViewProps {
  source: DataSource
  tableName?: string
  fcThreshold?: number
  pThreshold?: number
  /** Draw the top-N labels + the drag controls (default true). */
  interactive?: boolean
  /** Draw the axes / ticks / labels / gridlines frame (default true). */
  showFrame?: boolean
  /** Draw gridlines within the frame (default true). */
  showGrid?: boolean
  /** Theme-aware chrome colors (DEC-39); defaults to the light theme. */
  theme?: ChartTheme
  /** Opt-in axis-pointer crosshair (ITEM-33); default off. Both axes are free value axes (x = log2 fold change, y = -log10 p). */
  axisPointer?: boolean
  /** Plot-editing (ITEM-4): per-cell x/y AXIS title overrides (declarative). Absent ⇒ default. */
  axisTitles?: { x?: string; y?: string }
  /** Typography (font family + tick/axis-title sizes) for the chart frame. */
  typography?: Typography
}

// Cross-plot selection emphasis (DEC-25 / ITEM-25) — DOCUMENTED NO-OP for the volcano.
// The shared `pointSelection` is a set of dense CELL indices (a selection made over the
// scatter/embedding of the sample point cloud). The volcano, however, plots one point per
// FEATURE (a table row / column from a bulk-stat `DataTable`: log2 fold-change vs −log10 p)
// — a DIFFERENT entity with no index correspondence to the selected cells. There is no
// meaningful cell→feature mapping, so (per the task) the volcano deliberately does NOT
// react to the point-selection rather than force a wrong one. If a future feature-level
// selection scope is added, THAT is what a volcano would emphasise against.
export function VolcanoView({
  source,
  tableName = 'de',
  fcThreshold,
  pThreshold,
  interactive = true,
  showFrame = true,
  showGrid = true,
  theme = defaultChartTheme(),
  axisPointer = false,
  axisTitles,
  typography,
}: VolcanoViewProps) {
  const [fcT, setFcT] = useState(fcThreshold ?? DEFAULT_FC)
  const [pT, setPT] = useState(pThreshold ?? DEFAULT_P)

  // Adopt new threshold PROPS if the parent changes them (keeps prop-driven stories in sync).
  useEffect(() => {
    setFcT(fcThreshold ?? DEFAULT_FC)
  }, [fcThreshold])
  useEffect(() => {
    setPT(pThreshold ?? DEFAULT_P)
  }, [pThreshold])

  const { data: points, error } = useAsyncChartData<VolcanoPointInput[]>(async isAlive => {
    const table = await source.table(tableName)
    if (!isAlive()) return undefined
    return volcanoInputFromTable(table)
  }, [source, tableName])

  // Rail domains: derive from the loaded point cloud so the handles span the data — AND always
  // CONTAIN the INITIAL (prop) thresholds, so a threshold set beyond the data extent (e.g.
  // fcThreshold=3 on a tight dataset where every |x|<0.5) still gets an on-rail handle + on-frame
  // guide lines, instead of a saturated handle that snaps DOWN to the rail max on first drag. Uses the
  // PROP thresholds (not the live `fcT`/`pT`) so dragging clamps at a fixed domain, no feedback loop.
  const domain = useMemo(() => {
    let maxAbsFc = Math.max(DEFAULT_FC, Math.abs(fcThreshold ?? DEFAULT_FC))
    let maxP = Math.max(DEFAULT_P, pThreshold ?? DEFAULT_P)
    for (const p of points ?? []) {
      if (Math.abs(p.x) > maxAbsFc) maxAbsFc = Math.abs(p.x)
      if (p.y > maxP) maxP = p.y
    }
    return { maxAbsFc: maxAbsFc * 1.05, maxP: maxP * 1.05 }
  }, [points, fcThreshold, pThreshold])

  // Frame bounds from the rail domains: x symmetric around 0, y from 0 up.
  const bounds = useMemo<[number, number, number, number] | null>(() => {
    if (!points) return null
    return [-domain.maxAbsFc, 0, domain.maxAbsFc, domain.maxP]
  }, [points, domain])

  // ── HOVER parity with ViolinView (a volcano plots INDIVIDUAL points, so it earns full parity):
  // a direct point hover publishes its index up for cross-plot highlight + shows a per-point tooltip;
  // a cross-plot / direct hover draws a highlight RING. `volcanoCategorize` preserves order + length,
  // so the scatter layer's picked index == the ORIGINAL `points[]` index (no display-sample remap).
  const hoverHighlightIdx = useHoverHighlightIndex()
  const tooltipsOn = useTooltipsEnabled()
  const publishHover = usePublishHover()
  // Direct hover on a volcano point (rAF-throttled — one setState/frame; gated to the point layer id).
  const [dotPick, setDotPick] = useState<number | null>(null)
  const dotPickPending = useRef<number | null>(null)
  const dotPickRaf = useRef<number | null>(null)
  const flushDotPick = useCallback(() => {
    dotPickRaf.current = null
    setDotPick(dotPickPending.current)
  }, [])
  const handlePointHover = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (info: any) => {
      const id = typeof info?.layer?.id === 'string' ? info.layer.id : ''
      dotPickPending.current = info && info.index >= 0 && id.endsWith('viz-volcano') ? info.index : null
      if (typeof requestAnimationFrame === 'undefined') flushDotPick()
      else if (dotPickRaf.current == null) dotPickRaf.current = requestAnimationFrame(flushDotPick)
    },
    [flushDotPick],
  )
  useEffect(
    () => () => {
      if (dotPickRaf.current != null && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(dotPickRaf.current)
    },
    [],
  )
  // Publish the hovered ORIGINAL point index up so OTHER plots cross-highlight (null on leave / no pick).
  useEffect(() => {
    const n = points?.length ?? 0
    publishHover(dotPick != null && dotPick >= 0 && dotPick < n ? dotPick : null)
  }, [dotPick, points, publishHover])
  // Release the cross-plot hover latch when this cell UNMOUNTS (removed / type-swapped mid-hover).
  useEffect(() => () => publishHover(null), [publishHover])

  const base = useMemo<{ frame: Layer[]; dataMarks: Layer[]; labels: Layer[] }>(() => {
    if (!points) return { frame: [], dataMarks: [], labels: [] }
    // Re-classify against the CURRENT (possibly dragged) thresholds, then build. This O(N-points) work
    // (categorize + typed-array build + the point ScatterplotLayer) must NOT depend on the per-frame
    // `hoverHighlightIdx` — the hover RING is appended cheaply in the `layers` memo below.
    const categorized = volcanoCategorize(points, fcT, pT)
    const { points: p, guides } = buildVolcanoProps(categorized, { fcThreshold: fcT, pThreshold: pT })
    const frame: Layer[] =
      showFrame && bounds
        ? buildChartFrameLayers({
            id: 'viz-volcano-frame',
            bounds,
            xTitle: axisTitles?.x ?? 'log2 fold change',
            yTitle: axisTitles?.y ?? '-log10 p',
            showGrid,
            theme,
            font: chartFrameFont(typography),
          })
        : []
    const dataMarks: Layer[] = [new LineLayer(guides), new ScatterplotLayer(p)]
    const labels: Layer[] = interactive
      ? [
          new TextLayer({
            id: 'viz-volcano-labels',
            data: topNLabels(categorized, TOP_LABELS),
            getPosition: d => d.position,
            getText: d => d.text,
            getSize: 12,
            sizeUnits: 'pixels',
            ...(chartFrameFont(typography).family ? { fontFamily: chartFrameFont(typography).family } : {}),
            getColor: [40, 40, 40, 255],
            getTextAnchor: 'start',
            getAlignmentBaseline: 'bottom',
            getPixelOffset: [5, -5],
            background: true,
            getBackgroundColor: [255, 255, 255, 180],
            backgroundPadding: [2, 1],
          }),
        ]
      : []
    return { frame, dataMarks, labels }
  }, [points, fcT, pT, interactive, bounds, showFrame, showGrid, theme, typography, axisTitles?.x, axisTitles?.y])

  // Cheap per-frame layer: append the hover RING to the (stable) data marks + clip. `hoverHighlightIdx`
  // is the ORIGINAL `points[]` index (direct hover via publish round-trip OR a cross-hover). Only this
  // memo depends on it, so a hover no longer rebuilds the whole point cloud (perf).
  const layers = useMemo(() => {
    const marks: Layer[] = [...base.dataMarks]
    if (points && hoverHighlightIdx != null && hoverHighlightIdx >= 0 && hoverHighlightIdx < points.length) {
      const hp = points[hoverHighlightIdx]
      if (hp && Number.isFinite(hp.x) && Number.isFinite(hp.y)) {
        marks.push(
          new ScatterplotLayer<{ position: [number, number] }>({
            id: 'viz-volcano-hover-highlight',
            data: [{ position: [hp.x, hp.y] as [number, number] }],
            getPosition: d => d.position,
            radiusUnits: 'pixels',
            getRadius: 5,
            radiusMinPixels: 4,
            filled: false,
            stroked: true,
            getLineColor: [255, 138, 0, 255],
            getLineWidth: 2,
            lineWidthUnits: 'pixels',
            pickable: false,
          }),
        )
      }
    }
    return [...base.frame, ...(bounds ? clipToBounds(marks, bounds) : marks), ...base.labels]
  }, [base, hoverHighlightIdx, points, bounds])

  // The tooltip follows the cross-plot highlighted point (`hoverHighlightIdx` — direct hover OR a
  // hover in another linked plot). Gated by the global tooltip toggle (the ring shows regardless).
  const pointTooltip = useMemo(() => {
    if (!tooltipsOn || hoverHighlightIdx == null || !points) return null
    const i = hoverHighlightIdx
    if (i < 0 || i >= points.length) return null
    const hp = points[i]
    if (!hp || !Number.isFinite(hp.x) || !Number.isFinite(hp.y)) return null
    return {
      world: [hp.x, hp.y] as [number, number],
      rows: [
        { label: 'Feature', value: hp.label },
        { label: axisTitles?.x ?? 'log2 fold change', value: formatNumber(hp.x) },
        { label: axisTitles?.y ?? '-log10 p', value: formatNumber(hp.y) },
      ],
    }
  }, [tooltipsOn, hoverHighlightIdx, points, axisTitles])

  if (error) return <ChartError message={error} />
  if (!points) return <ChartLoading />

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* Both axes are free value axes (x = log2FC, y = -log10 p) → no snap ticks passed. */}
      <ChartCanvas
        layers={layers}
        bounds={bounds ?? undefined}
        axisPointer={axisPointer}
        theme={theme}
        onHover={handlePointHover}
        pointTooltip={pointTooltip}
        testId="viz-volcano-view"
      />
      {interactive && (
        <div
          data-testid="viz-volcano-controls"
          style={{
            position: 'absolute',
            top: 8,
            left: 8,
            // Re-arm pointer events: on the shared grid deck the chart cell is pointerEvents:none
            // (pan/zoom falls through to the deck); this interactive toolbar must still work.
            pointerEvents: 'auto',
            display: 'flex',
            gap: 16,
            padding: '8px 10px',
            borderRadius: 6,
            background: 'rgba(255,255,255,0.82)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            fontSize: 11,
            color: '#222',
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <span>|fc| ≥ {fcT.toFixed(2)}</span>
            <DragRail
              data-testid="viz-volcano-fc-rail"
              orientation="horizontal"
              handles={1}
              min={0}
              max={domain.maxAbsFc}
              value={[0, fcT]}
              onChange={([, hi]) => setFcT(hi)}
              length={120}
              thickness={14}
            >
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  top: '50%',
                  height: 3,
                  transform: 'translateY(-50%)',
                  background: 'linear-gradient(90deg,#bbb,#d62728)',
                  borderRadius: 2,
                }}
              />
            </DragRail>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <span>−log10p ≥ {pT.toFixed(2)}</span>
            <DragRail
              data-testid="viz-volcano-p-rail"
              orientation="horizontal"
              handles={1}
              min={0}
              max={domain.maxP}
              value={[0, pT]}
              onChange={([, hi]) => setPT(hi)}
              length={120}
              thickness={14}
            >
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  top: '50%',
                  height: 3,
                  transform: 'translateY(-50%)',
                  background: 'linear-gradient(90deg,#bbb,#333)',
                  borderRadius: 2,
                }}
              />
            </DragRail>
          </label>
        </div>
      )}
    </div>
  )
}
