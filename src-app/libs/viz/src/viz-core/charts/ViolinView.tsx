// ViolinView.tsx — the violin chart VIEW (DEC-18), now a FIRST-CLASS, fully-synced
// selection surface. A group's KDE shape is a `SolidPolygonLayer`; INSIDE each violin sits a
// narrow Tukey box (`SolidPolygonLayer` rect + `LineLayer` whiskers/median). Around each
// violin is a jittered raw-value DOT CLOUD (`ScatterplotLayer`) that is now backed by the FULL
// per-cell set — the dots are a real cell-level selection surface, not a capped display sample.
//
// The dot cloud plays THREE roles, all GPU / no-SVG:
//   • DISPLAY (density-aware): every cell's screen position is a DETERMINISTIC per-index jitter
//     (`violinJitter.buildJitterPositions`), so dense groups read as a smooth cloud and sparse
//     groups show individual dots. For very large N the LAYER draws a density-adaptive SUBSET
//     (`adaptiveSample`) — the DISPLAY SAMPLE — while the FULL jitter positions stay resident
//     for selection (display sample ≠ selection set).
//   • CONSUME (per-dot emphasis): a shared point-selection dims UNSELECTED dots to `DIM_OPACITY`
//     and redraws SELECTED dots at full opacity via a `DataFilterExtension` mask overlay (a GPU
//     attribute swap, NOT a per-point CPU recolor). The group-body dim (KDE + box) is kept too.
//   • PRODUCE (two gestures): a value-BAND brush (drag a Y range over a group → that group's
//     cells whose value ∈ [y0,y1]) and a free LASSO over the dot cloud (polygon → the SAME
//     KD-tree `selectInPolygon` the scatter uses). Both emit `onSelectPoints(indices)`; the
//     STORY wires that to `coordination.setSelection('violin', indices)`. A pan/band/lasso mode
//     toggle gates the gestures against pan (only enabled when `onSelectPoints` is provided).
//
// STEP 3-4 (EXTENSIBILITY_STUDY): the cross-plot selection is READ through the injected
// `coordination` handle (group emphasis + per-dot mask), and the value-axis dataZoom WINDOW is
// owned by the core `ValueDataZoom` component (not this View). `ViolinView` is the OUTER (load +
// jitter + emphasis + gestures + producer toolbar); the window→KDE-**re-densify** effect is a
// REAL data recompute and STAYS INSIDE the passive `ViolinBody`, driven by the injected window.

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { PlotCellIdContext, usePublishPlotData, useHoverHighlightIndex, usePublishHover, useTooltipsEnabled } from './plotCellId'
import { ChartSelectModeContext, ChartSelectMultiContext } from './chartSelectionMode'
import { useAsyncChartData, ChartError, ChartLoading } from './useAsyncChartData'
import { SolidPolygonLayer, ScatterplotLayer, LineLayer, TextLayer, PolygonLayer } from '@deck.gl/layers'
import { DataFilterExtension } from '@deck.gl/extensions'
import type { Layer } from '@deck.gl/core'
import { ChartCanvas, robustValueRange, type ChartInteraction } from './ChartCanvas'
import { type DataZoomConfig } from './AxisDataZoom'
import { ValueDataZoom } from '../datazoom/DataZoom'
import {
  filterCellsToWindow,
  isFullValueWindow,
  type ValueWindow,
} from './valueWindow'
import { buildViolinProps, buildBoxProps, type BoxStat } from './chartLayers'
import { deckTransitions, type TransitionProp } from './transitions'
import { buildChartFrameLayers, defaultChartTheme, parseColor, type ChartTheme } from './ChartFrame'
import { chartFrameFont, type Typography } from '../controls/typography'
import { clipToBounds } from './clip'
import { categoryTicks } from './axisTicks'
import { violinByGroup, type ViolinGroup } from './aggregate'
import { violinByGroupGpu } from './aggregateGpu'
import { mannWhitneyUGpu } from './groupStatsGpu'
import { getComputeDevice } from '../gpu/computeDevice'
import { bracketSegments } from './chartInteractions'
import { packBrackets, quartiles } from '../data/statsKernels'
import { densify } from '../data/wire'
import { categoryColor, resolveEffectivePalette, displayCategory, visibleByCode, type CategoricalOverrides } from '../data/color'
import { buildJitterPositions, cellsInGroupValueBand } from './violinJitter'
import { formatNumber } from '../tooltip/tooltipModel'
import { buildPointIndex } from '../spatial/pointIndex'
import { selectInPolygon } from '../data/selection'
import { areaContainsPoint, controllerAreasToShapes, translateArea } from '../selection/areaGestures'
import type { Area } from '../selection/SelectionController'
import { buildSelectionOutlineLayer } from '../selection/useAreaSelection'
import { adaptiveSample, planAdaptiveCap, gatherByIndices } from '../scale/adaptiveSample'
import { boundsForPositions } from '../density/densityBin'
import { defaultCoordinationHandle } from '../../adapter/coordinationHandle'
import type { CoordinationHandle } from '../registry/types'
import {
  applyMarkOpacity,
  buildGroupIndex,
  buildIdToRow,
  DIM_OPACITY,
  hasAnySelection,
  highlightMaskForIds,
  highlightMaskForPoints,
  markOpacity,
  type GroupEmphasis,
  type GroupIndex,
  type IdToRow,
} from '../coordination/selectionSync'
import { gateGroupEmphasis, gatePointSelection, producesEnabled, gateValueDataZoom } from './capabilityGates'
import type { CategoricalColumn, DataSource, SparseColumn } from '../data/wire'

/** Reused empty codes column so the emphasis memo has a stable input before load. */
const EMPTY_CODES = new Uint16Array(0)

/**
 * Turn a sparse value column + a categorical column into the per-group density input
 * (`ViolinGroup[]`) the violin builder consumes: densify the sparse column, then run
 * the shared per-group KDE (`violinByGroup`). Pure — no GL, no I/O.
 */
export function violinGroupsFromColumn(
  col: SparseColumn,
  cat: CategoricalColumn,
  opts: { ticks?: number; bandwidth?: number } = {},
): ViolinGroup[] {
  const dense = densify(col)
  return violinByGroup(dense, cat.codes, cat.categories, opts)
}

/**
 * Bucket a densified value column by category code, in category order — the raw
 * per-group values the inner-box, jitter, and significance-test overlays consume. Pure.
 */
export function violinRawByGroup(col: SparseColumn, cat: CategoricalColumn): number[][] {
  const dense = densify(col)
  const buckets: number[][] = cat.categories.map(() => [])
  for (let i = 0; i < cat.codes.length; i++) {
    const g = cat.codes[i]
    if (g < buckets.length) buckets[g].push(dense[i])
  }
  return buckets
}

interface ViolinData {
  groups: ViolinGroup[]
  raw: number[][]
  /** The DENSE per-cell value column (length N) — the jitter y + value-band input. */
  values: Float32Array
  boxes: BoxStat[]
  maxVal: number
  /** value-axis (y) extent across the KDE shapes + raw values, for the frame. */
  valMin: number
  valMax: number
  /** Pairwise adjacent-group Mann-Whitney comparisons (p-values), precomputed off the hot path. */
  sig: { i: number; j: number; p: number }[]
}

/** Full jitter width (data units) of the dot band around a group center. Half sits each side. */
const JITTER_WIDTH = 0.24
/** Per-group cap on the values fed to the windowed KDE recompute (mirrors the legacy 50k). */
const KDE_SUBSAMPLE_CAP = 50_000
/** Debounce (ms) before recomputing the windowed KDE, so a scroll/drag-zoom stays smooth. */
const RECOMPUTE_DEBOUNCE_MS = 100
/** Above this cell count the DISPLAY layer draws a density-adaptive subset (selection stays full). */
const DISPLAY_BUDGET = 30_000
const DISPLAY_GRID = 96

/** The derived jitter geometry: FULL selection positions + KD-tree + group index + display sample. */
interface JitterGeom {
  /** FULL interleaved [x,y] jitter positions (length 2*N) — the KD-tree + lasso SELECTION set. */
  readonly full: Float32Array
  /** per-cell RGBA (length 4*N). */
  readonly colors: Uint8Array
  /** KD-tree over `full` for the lasso hit-test (O(log N + k)). */
  readonly index: ReturnType<typeof buildPointIndex>
  /** CSR group→members index for the value-band producer. */
  readonly gi: GroupIndex
  readonly nGroups: number
  readonly n: number
  /** kept indices for DISPLAY (null ⇒ draw all `full`); the display SAMPLE, not the selection set. */
  readonly displayIdx: Uint32Array | null
  /** DISPLAY positions (a subset of `full` when `displayIdx` is set, else `full`). */
  readonly dispPos: Float32Array
  readonly dispCol: Uint8Array
  /** Collapsed x-slot → ORIGINAL group code (hidden groups excluded), for the value-band selection. */
  readonly visibleCodes: number[]
  /** Number of VISIBLE groups (collapsed x-axis length); == `nGroups` when nothing is hidden. */
  readonly visCount: number
}

export interface ViolinViewProps {
  source: DataSource
  /** value column key (fixture demo label) */
  valueKey: string
  /** categorical column id to group by */
  groupKey: string
  ticks?: number
  bandwidth?: number
  /** Draw pairwise significance brackets between adjacent groups. Default FALSE — the brackets are a
   *  specialized statistical annotation that clutters the default violin (owner request); opt in
   *  explicitly (`showSignificance`) where the comparison is wanted (e.g. the significance demo story). */
  showSignificance?: boolean
  /** Draw the axes / ticks / labels / gridlines frame (default true). */
  showFrame?: boolean
  /** Draw gridlines within the frame (default true). */
  showGrid?: boolean
  /** Theme-aware chrome colors (DEC-39); defaults to the light theme. */
  theme?: ChartTheme
  /** Opt-in axis-pointer crosshair (ITEM-33); default off. x snaps to the group categories, y is a free value axis. */
  axisPointer?: boolean
  /**
   * PRODUCER sink: called with the point indices a value-band brush OR a lasso selected. When
   * provided, the view mounts the pan/band/lasso mode toggle + gesture overlay; the caller
   * typically forwards these to the shared coordination handle (`setSelection('violin', idx)`).
   * Absent ⇒ the view is display+consume only (no toolbar, no gesture overlay) — byte-unchanged.
   */
  onSelectPoints?: (indices: Uint32Array, accumulate?: boolean) => void
  /** This violin's coordination ORIGIN id (its grid cell id) — lets it reconcile its committed outline
   *  against the exclusive-selection signal (a single-mode select elsewhere / Clear drops it), for
   *  cross-cell lifecycle parity with a scatter cell. Absent (standalone story) ⇒ no reconciliation. */
  selectionOriginId?: string
  /**
   * OPTIONAL row→canonical-cell-id map (multi-source selection seam): `pointIds[row]` is
   * the STABLE canonical id of this view's local `row`. When present, the view PRODUCES a
   * selection in canonical ids (its local selected rows are mapped through `pointIds`) and
   * CONSUMES the shared selection by mapping canonical ids → its own rows — so it stays
   * correct when it doesn't share one cell array with the selecting view. ABSENT ⇒ identity
   * (`pointIds[i]=i`): every produce/consume path is byte-identical to the index-based
   * behavior (the single-source case — FixtureSource-backed stories keep identity).
   */
  pointIds?: Uint32Array
  /**
   * Per-instance value-axis dataZoom config: `false` disables the zoom UI entirely; `{ y, wheel }`
   * picks the value axis' control kind + wheel gate (the x/category axis is never zoomed). Default
   * (omitted) = slider + wheel.
   */
  dataZoom?: false | DataZoomConfig
  /**
   * OPT-IN per-plot animated transitions (default OFF). `false`/omitted ⇒ instant (byte-identical
   * to today); `{ duration?, easing? }` ⇒ the KDE shape + inner-box fills GPU-interpolate a recolor
   * (`getFillColor`). The density-adaptive DOT CLOUD is left instant (its display SAMPLE changes
   * count/positions between updates — not a clean attribute tween). Mirrors `dataZoom`'s shape.
   */
  transitions?: TransitionProp
  /** The Selection coordination handle (STEP 3); defaults to the store-backed singleton. */
  coordination?: CoordinationHandle
  /** ENFORCED capability (Area B, ITEM-5). `false` ⇒ this View does NOT consume the shared
   *  selection (no group-body emphasis, no per-dot highlight). Unset/true ⇒ consume (byte-identical). */
  consumesSelection?: boolean
  /** ENFORCED capability (Area B, ITEM-5). `false` ⇒ HIDE the value-band / lasso PRODUCE gesture
   *  even when an `onSelectPoints` sink is wired. Unset/true ⇒ the gesture shows when a sink is
   *  present (byte-identical). */
  producesSelection?: boolean
  /** ENFORCED capability (Area B, ITEM-6). Violins zoom only the value (y) axis, so a declared
   *  `dataZoomAxes` lacking `'y'` disables the value zoom. Unset ⇒ default. */
  dataZoomAxes?: readonly ('x' | 'y')[]
  /**
   * OPTIONAL categorical overrides — a custom/by-name palette recolors the violins + inner boxes
   * + jitter dots, and `categoryLabels` renames the group AXIS ticks. Absent ⇒ the built-in
   * palette + raw names (byte-identical). Because they live on the rendered marks/axis, export
   * picks them up with no export-path change.
   */
  overrides?: CategoricalOverrides
  /** Plot-editing (ITEM-4): per-cell x/y AXIS title overrides (declarative). Absent ⇒ default. */
  axisTitles?: { x?: string; y?: string }
  typography?: Typography
}

type Mode = 'pan' | 'band' | 'lasso' | 'move' | 'rect'

/** Wrap a world-space lasso ring as a shared-core `Area` (so hit-test/translate are the shared ops). */
function lassoAsArea(ring: [number, number][]): Area {
  return { kind: 'polygon', polygon: ring, mode: 'add' }
}
function areaRing(area: Area): [number, number][] {
  if (area.kind === 'polygon') {
    return area.polygon.map((v: readonly [number, number]) => [v[0], v[1]] as [number, number])
  }
  // rect: box [x0,y0,x1,y1] → the 4 corners as a closed ring (so point-in-polygon + translate reuse).
  const [x0, y0, x1, y1] = area.box
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
}
/** Build a rect `Area` from two world corners (normalized so min/max ordering is irrelevant). */
function rectArea(x0: number, y0: number, x1: number, y1: number): Area {
  return { kind: 'rect', box: [x0, y0, x1, y1], mode: 'add' }
}

export function ViolinView({
  source,
  valueKey,
  groupKey,
  ticks,
  bandwidth,
  showSignificance = false,
  showFrame = true,
  showGrid = true,
  theme = defaultChartTheme(),
  axisPointer = false,
  onSelectPoints,
  selectionOriginId,
  pointIds,
  dataZoom,
  transitions,
  coordination = defaultCoordinationHandle,
  consumesSelection,
  producesSelection,
  dataZoomAxes,
  overrides,
  axisTitles,
  typography,
}: ViolinViewProps) {
  // The cell's STABLE dataZoom id (ITEM-20): store-backed window when inside a grid cell (restore
  // applies), `undefined` (local `useState`, byte-identical) in a story with no provider.
  const plotCellId = useContext(PlotCellIdContext)
  // Per-point group codes — map a shared point-selection to the GROUP violins it covers
  // (cross-plot emphasis). Violins are the categories in code order, so a group's mark
  // INDEX equals its group code. Set from inside the loader (under its try/catch).
  const [catCodes, setCatCodes] = useState<Uint16Array | null>(null)

  const { data, error } = useAsyncChartData<ViolinData>(async isAlive => {
    const [col, cat, device] = await Promise.all([
      source.valueColumn(valueKey),
      source.categorical(groupKey),
      getComputeDevice(),
    ])
    if (!isAlive()) return undefined
    setCatCodes(cat.codes)
    // Prefer the GPU 2-D-histogram KDE (DEC-26/29); no device → the exact CPU oracle.
    const dense = densify(col)
    const groups = await violinByGroupGpu(dense, cat.codes, cat.categories, { ticks, bandwidth }, device)
    if (!isAlive()) return undefined
    const raw = violinRawByGroup(col, cat)
    const boxes: BoxStat[] = cat.categories.map((group, g) => {
      const q = quartiles(raw[g])
      return {
        group,
        q1: q.q1,
        median: q.median,
        q3: q.q3,
        lowerFence: q.lowerFence,
        upperFence: q.upperFence,
        outliers: q.outliers,
      }
    })
    let maxVal = 0
    let valMin = Infinity
    let valMax = -Infinity
    for (const bucket of raw) {
      for (const v of bucket) {
        if (!Number.isFinite(v)) continue
        if (v > maxVal) maxVal = v
        if (v < valMin) valMin = v
        if (v > valMax) valMax = v
      }
    }
    // include the KDE-shape extent (it can spill past the raw min/max by the bandwidth)
    for (const g of groups) {
      for (const d of g.density) {
        if (!Number.isFinite(d.x)) continue
        if (d.x < valMin) valMin = d.x
        if (d.x > valMax) valMax = d.x
      }
    }
    if (!Number.isFinite(valMin)) {
      valMin = 0
      valMax = 1
    }
    // Pairwise adjacent-group Mann-Whitney significance — prefer the GPU histogram U
    // (DEC-26/29); no device → the exact `mannWhitneyU` oracle. Computed here off the
    // render path (the useMemo below just reads the precomputed p-values).
    const sig: { i: number; j: number; p: number }[] = []
    if (showSignificance && cat.categories.length >= 2) {
      for (let i = 0; i + 1 < cat.categories.length; i++) {
        const { p } = await mannWhitneyUGpu(cat.codes, dense, i, i + 1, device)
        sig.push({ i, j: i + 1, p })
      }
    }
    if (!isAlive()) return undefined
    return { groups, raw, values: dense, boxes, maxVal: maxVal || 1, valMin, valMax, sig }
  }, [source, valueKey, groupKey, ticks, bandwidth, showSignificance])

  // Publish the RAW per-point data (group + value) to the "Plot data" table — a violin draws individual
  // jitter DOTS, so the reproducible data is the raw points, not the distribution summary. VISIBLE groups
  // only (hidden/collapsed groups excluded); the source is already value-window-filtered when linked.
  usePublishPlotData(() => {
    if (!data || !catCodes) return null
    const hidden = overrides?.hiddenCodes
    const rows: (string | number)[][] = []
    // Each row's ORIGINAL index into values/catCodes (== the `jitter.full` index) so hovering a table row
    // highlights the exact jitter dot.
    const pointIndices: number[] = []
    const n = Math.min(data.values.length, catCodes.length)
    for (let i = 0; i < n; i++) {
      const code = catCodes[i]
      if (hidden?.has(code)) continue
      rows.push([displayCategory(data.groups[code]?.group ?? String(code), overrides?.categoryLabels), data.values[i]])
      pointIndices.push(i)
    }
    return { columns: ['group', valueKey], rows, pointIndices }
  }, [data, catCodes, overrides, valueKey])

  // ── the derived jitter geometry (FULL selection positions + KD-tree + display sample) ──
  const jitter = useMemo<JitterGeom | null>(() => {
    if (!data || !catCodes) return null
    const nGroups = data.groups.length
    // HIDDEN groups (interactive legend / form): the dots collapse WITH the bodies. Map each original
    // group code → its collapsed x slot (hidden ⇒ -1); a hidden group's dots draw at alpha 0 so only the
    // visible groups show + they re-space. `visibleCodes[x]` recovers the original code of collapsed slot x
    // (for the value-band selection). Group index (`gi`) stays keyed by the ORIGINAL code.
    const hidden = overrides?.hiddenCodes
    const visibleCodes: number[] = []
    const codeToSlot = data.groups.map((_, code) => {
      if (hidden?.has(code)) return -1
      visibleCodes.push(code)
      return visibleCodes.length - 1
    })
    const centers = codeToSlot.map(s => (s < 0 ? 0 : s)) // hidden centers unused (points are alpha-0'd)
    const visCount = visibleCodes.length
    const values = data.values
    const n = values.length
    const full = buildJitterPositions(catCodes, values, centers, JITTER_WIDTH)
    // EFFECTIVE per-group palette (custom / by-name / auto-extended); no overrides ⇒ built-in.
    const effColors = resolveEffectivePalette(data.groups.map(g => g.group), overrides)
    const colors = new Uint8Array(n * 4)
    for (let i = 0; i < n; i++) {
      const code = catCodes[i]
      const [r, g, b] = code < nGroups ? effColors[code] ?? categoryColor(code) : [150, 150, 150]
      colors[i * 4] = r
      colors[i * 4 + 1] = g
      colors[i * 4 + 2] = b
      colors[i * 4 + 3] = hidden?.has(code) ? 0 : 200 // hidden group's dots vanish
    }
    const index = buildPointIndex(full)
    const gi = buildGroupIndex(catCodes, nGroups)
    let displayIdx: Uint32Array | null = null
    if (n > DISPLAY_BUDGET) {
      const bounds = boundsForPositions(full)
      const cap = planAdaptiveCap(DISPLAY_BUDGET, DISPLAY_GRID * DISPLAY_GRID)
      displayIdx = adaptiveSample({
        positions: full,
        bounds,
        gridW: DISPLAY_GRID,
        gridH: DISPLAY_GRID,
        capPerCell: cap,
        budget: DISPLAY_BUDGET,
      }).indices
    }
    const dispPos = displayIdx ? gatherByIndices(full, displayIdx, 2)! : full
    const dispCol = displayIdx ? gatherByIndices(colors, displayIdx, 4)! : colors
    return { full, colors, index, gi, nGroups, n, displayIdx, dispPos, dispCol, visibleCodes, visCount }
  }, [data, catCodes, overrides])

  // Cross-plot selection emphasis (DEC-25 / ITEM-25) — READ THROUGH the coordination handle
  // (STEP 3): group-body emphasis (KDE + box) via `useGroupEmphasis`, per-DOT mask via the raw
  // shared selection. Multi-source seam (identity default): with `pointIds` the shared selection
  // carries canonical CELL IDs, so both consume paths map ids → this view's local rows via
  // `idToRow`.
  const idToRow = useMemo<IdToRow | null>(
    () => (pointIds ? buildIdToRow(pointIds) : null),
    [pointIds],
  )
  // ENFORCED consume gate (ITEM-5): `consumesSelection:false` ⇒ discard BOTH the group emphasis
  // and the per-dot point selection (no dim, no highlight). Unset/true ⇒ byte-identical.
  const emphasis = gateGroupEmphasis(coordination.useGroupEmphasis(catCodes ?? EMPTY_CODES, idToRow), consumesSelection)
  const pointSelection = gatePointSelection(coordination.usePointSelection(), consumesSelection)

  // Per-DOT emphasis mask, gathered to the DISPLAY subset. Built once per selection change; the
  // per-frame render never touches it in JS (a `DataFilterExtension` attribute swap).
  const dotHighlight = useMemo<Uint8Array | null>(() => {
    if (!jitter || !hasAnySelection(pointSelection)) return null
    const fullMask = idToRow
      ? highlightMaskForIds(pointSelection!, idToRow, jitter.n)
      : highlightMaskForPoints(pointSelection!, jitter.n)
    return jitter.displayIdx ? gatherByIndices(fullMask, jitter.displayIdx, 1)! : fullMask
  }, [jitter, pointSelection, idToRow])

  // ENFORCED produce gate (ITEM-5): the value-band / lasso gesture is exposed ONLY when a producer
  // sink is wired AND `producesSelection` is not an explicit `false`. Unset/true ⇒ the sink alone
  // decides (byte-identical). Drives BOTH the drawing `interaction` and the toolbar render below.
  const produceEnabled = producesEnabled(onSelectPoints != null, producesSelection)

  // ── gesture state (only meaningful when `onSelectPoints` is provided) ──────────
  // The mode is DRIVEN BY THE GRID TOOL RAIL when this violin is inside a grid (ChartSelectModeContext),
  // so the global Select/Pan/Zoom drives its lasso — no per-plot toolbar. Outside a grid (standalone
  // story) the context is null ⇒ fall back to a LOCAL mode + the mode toolbar (byte-identical to before).
  const railMode = useContext(ChartSelectModeContext)
  // The rail's single/multi toggle drives this violin's publish accumulate (union across plots when
  // multi) — read via a ref so the publish callbacks don't churn on every toggle.
  const railMulti = useContext(ChartSelectMultiContext)
  const railMultiRef = useRef(railMulti)
  railMultiRef.current = railMulti
  const [localMode, setLocalMode] = useState<Mode>('pan')
  // Rail modes ('pan'/'rect'/'lasso'/'move') map straight through to the violin's gesture. Rect is a
  // free 2-D drag-rectangle over the dot cloud (spans groups — NOT column-confined); lasso is the
  // click polygon. Standalone (railMode null) ⇒ the local mode toolbar drives it (incl. the value band).
  const mode: Mode = railMode ?? localMode
  const setMode = setLocalMode
  const [bandDraft, setBandDraft] = useState<{ group: number; y0: number; y1: number } | null>(null)
  // Free 2-D drag-rectangle draft (rail Rect tool) over the dot cloud — world coords, spans groups.
  const [rectDraft, setRectDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [lassoDraft, setLassoDraft] = useState<[number, number][]>([])
  // The COMMITTED lasso ring (world coords) — persists after finish so its outline stays + is
  // draggable (selection-unification: the violin lasso gains what SelectableScatter has).
  // COMMITTED selection regions (rect + polygon), persisted so their outlines stay + are draggable.
  // Single mode holds ≤1; multi accumulates. Mirrors the scatter grid's committedByCell[cell] model,
  // so the violin respects EVERY rail behavior: rect, lasso, single/multi, move, cross-plot sync.
  // ⇒ The FULL selection contract this must satisfy (identical to the scatter) is the header comment
  //   of `viz-core/selection/SelectionController.ts`. Any divergence from that table is a bug.
  const [committedRegions, setCommittedRegions] = useState<Area[]>([])
  const committedRegionsRef = useRef<Area[]>([])
  committedRegionsRef.current = committedRegions
  const dragRef = useRef<{ startWorld: [number, number]; index: number; origArea: Area } | null>(null)
  // Plot data bounds [minX,minY,maxX,maxY] in world coords, kept in a ref so onWorldUp can test whether
  // a dragged region was released OUTSIDE the plot border (drag-out-to-remove). Assigned during render
  // once `valueRange` is known (below); x spans the group centers [-0.5 … nGroups-0.5].
  const plotBoundsRef = useRef<[number, number, number, number] | null>(null)
  // true while the cursor hovers a grabbable committed region → move cursor + press-to-drag in any mode.
  const [hoverMove, setHoverMove] = useState(false)
  // Rail-driven: switching the rail tool resets any in-progress DRAFT (committed regions persist).
  useEffect(() => {
    setBandDraft(null)
    setRectDraft(null)
    setLassoDraft([])
    dragRef.current = null
  }, [railMode])

  // CROSS-CELL LIFECYCLE PARITY: reconcile this violin's committed outline against the EXCLUSIVE
  // selection signal. When a single-mode select happens on ANOTHER surface (a scatter cell) or a Clear
  // fires, this violin is no longer the exclusive owner ⇒ drop its committed outline — exactly as a
  // scatter cell's outline clears. Multi-mode selections never bump the epoch, so they don't clear.
  const exclusiveSel = coordination.useExclusiveSelection()
  const lastExclusiveEpochRef = useRef(exclusiveSel.epoch)
  useEffect(() => {
    if (exclusiveSel.epoch === lastExclusiveEpochRef.current) return
    lastExclusiveEpochRef.current = exclusiveSel.epoch
    if (selectionOriginId == null) return // standalone story: no cross-cell reconciliation
    if (exclusiveSel.origin !== selectionOriginId && committedRegionsRef.current.length > 0) {
      setCommittedRegions([])
    }
  }, [exclusiveSel.epoch, exclusiveSel.origin, selectionOriginId])

  const clampGroup = useCallback(
    // Clamp to the VISIBLE (collapsed) x range — the band drags over the collapsed slots.
    (g: number) => Math.max(0, Math.min((jitter?.visCount ?? 1) - 1, Math.round(g))),
    [jitter],
  )

  // UNION every region's point-in-polygon hit-test → publish the combined ids (with the rail's
  // cross-plot accumulate). ONE place computes the violin's selection from its region set.
  const publishRegions = useCallback(
    (regions: readonly Area[]) => {
      if (!jitter) return
      let combined: ReturnType<typeof selectInPolygon> | null = null
      for (const region of regions) {
        const ring = areaRing(region)
        if (ring.length < 3) continue
        const mask = selectInPolygon(jitter.full, ring, jitter.n, undefined, jitter.index)
        combined = combined ? combined.union(mask) : mask
      }
      onSelectPoints?.(combined ? combined.toIndices() : new Uint32Array(0), railMultiRef.current)
    },
    [jitter, onSelectPoints],
  )

  // The region set INCLUDING an in-progress draft: single ⇒ [draft] (REPLACES), multi ⇒ committed+draft.
  const withDraft = useCallback((draft: Area | null): Area[] => {
    const base = railMultiRef.current ? committedRegionsRef.current : []
    return draft ? [...base, draft] : [...base]
  }, [])

  // COMMIT a finished region (rect or lasso): single replaces, multi appends; publish the union.
  const commitRegion = useCallback(
    (area: Area) => {
      const regions = withDraft(area)
      setCommittedRegions(regions)
      publishRegions(regions)
    },
    [withDraft, publishRegions],
  )

  const commitBand = useCallback(
    (slot: number, y0: number, y1: number) => {
      if (!jitter || !data) return
      // `slot` is the collapsed x position; map it back to the ORIGINAL group code the band selects.
      const group = jitter.visibleCodes[slot] ?? slot
      const idx = cellsInGroupValueBand(jitter.gi, group, data.values, y0, y1)
      // Standalone value-band (no rail): a value-range selection with no persistent Area outline — clear
      // any committed regions so the boundary reflects the CURRENT selection.
      setCommittedRegions([])
      onSelectPoints?.(idx, railMultiRef.current)
    },
    [jitter, data, onSelectPoints],
  )

  const finishLasso = useCallback(() => {
    if (jitter && lassoDraft.length >= 3) {
      commitRegion(lassoAsArea(lassoDraft.map(v => [v[0], v[1]] as [number, number])))
    }
    setLassoDraft([])
  }, [jitter, lassoDraft, commitRegion])

  // Keyboard finish/cancel for the lasso: Enter commits the current lasso, Esc discards the draft
  // (re-publishing just the committed regions). Active only while a lasso draft is under way.
  useEffect(() => {
    if (mode !== 'lasso' || lassoDraft.length === 0) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        finishLasso()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setLassoDraft([])
        publishRegions(committedRegionsRef.current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, lassoDraft.length, finishLasso, publishRegions])

  // Which committed region (if any) contains a world point — topmost first (grab-to-move).
  const regionAt = useCallback((world: [number, number]): number => {
    const regions = committedRegionsRef.current
    for (let i = regions.length - 1; i >= 0; i--) {
      if (areaContainsPoint(regions[i], [world[0], world[1]])) return i
    }
    return -1
  }, [])

  // World-space pointer handlers (fed by ChartCanvas' drawing overlay).
  const onWorldDown = useCallback(
    (world: [number, number], e: React.PointerEvent<HTMLDivElement>) => {
      // GRAB-TO-MOVE: a press inside a committed region drags it — in any mode, except mid-lasso-draft.
      const midDraft = mode === 'lasso' && lassoDraft.length > 0
      const grab = midDraft ? -1 : regionAt(world)
      if (grab >= 0) {
        ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
        dragRef.current = { startWorld: world, index: grab, origArea: committedRegionsRef.current[grab] }
        return
      }
      if (mode === 'band') {
        ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
        setBandDraft({ group: clampGroup(world[0]), y0: world[1], y1: world[1] })
      } else if (mode === 'rect') {
        ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
        setRectDraft({ x0: world[0], y0: world[1], x1: world[0], y1: world[1] })
      } else if (mode === 'lasso') {
        const next = [...lassoDraft, world]
        setLassoDraft(next)
        // Rail-driven: AUTO-PREVIEW the live union (committed regions + this draft) as vertices are
        // added — no Finish button. ≥3 vertices ⇒ show the live selection.
        if (railMode && next.length >= 3 && jitter) {
          publishRegions(withDraft(lassoAsArea(next.map(v => [v[0], v[1]] as [number, number]))))
        }
      }
    },
    [mode, lassoDraft, railMode, jitter, clampGroup, regionAt, publishRegions, withDraft],
  )
  const onWorldMove = useCallback(
    (world: [number, number]) => {
      // Active drag translates the grabbed region.
      if (dragRef.current) {
        const d = dragRef.current
        const moved = translateArea(d.origArea, world[0] - d.startWorld[0], world[1] - d.startWorld[1])
        const regions = committedRegionsRef.current.slice()
        regions[d.index] = moved
        setCommittedRegions(regions)
        publishRegions(regions)
        return
      }
      // Update an in-progress draft (functional ⇒ a no-op when not currently drafting).
      if (mode === 'band') setBandDraft(d => (d ? { ...d, y1: world[1] } : d))
      if (mode === 'rect') setRectDraft(d => (d ? { ...d, x1: world[0], y1: world[1] } : d))
      // Hover-move affordance in EVERY mode (parity with the scatter grid): the cursor turns to 'move'
      // over a grabbable committed region so the user knows they can drag the selection. Suppressed only
      // mid-lasso-draft (there a click adds a vertex). Previously skipped in rect/band mode via an early
      // return, so a violin selection had no grab affordance — the scatter-vs-violin mismatch.
      const midDraft = mode === 'lasso' && lassoDraft.length > 0
      const over = !midDraft && regionAt(world) >= 0
      setHoverMove(prev => (prev === over ? prev : over))
    },
    [mode, lassoDraft.length, regionAt, publishRegions],
  )
  const onWorldUp = useCallback(
    (world: [number, number]) => {
      if (dragRef.current) {
        const d = dragRef.current
        dragRef.current = null
        // DRAG-OUT-TO-REMOVE: releasing a dragged region OUTSIDE the plot border deletes it (parity with
        // the scatter). The region tracked the cursor, so a release past the data bounds = dropped off-plot.
        const bnd = plotBoundsRef.current
        const outside = !!bnd && (world[0] < bnd[0] || world[0] > bnd[2] || world[1] < bnd[1] || world[1] > bnd[3])
        if (outside) {
          const regions = committedRegionsRef.current.slice()
          regions.splice(d.index, 1)
          setCommittedRegions(regions)
          publishRegions(regions)
        }
        return
      }
      if (mode === 'band' && bandDraft) {
        commitBand(bandDraft.group, bandDraft.y0, world[1])
        setBandDraft(null)
      } else if (mode === 'rect' && rectDraft) {
        if (Math.abs(rectDraft.x1 - rectDraft.x0) > 1e-6 && Math.abs(rectDraft.y1 - rectDraft.y0) > 1e-6) {
          // A real drag-rectangle → a region.
          commitRegion(rectArea(rectDraft.x0, rectDraft.y0, rectDraft.x1, rectDraft.y1))
        } else if (!railMultiRef.current) {
          // Contract row 13: a zero-size CLICK on empty space (a press on a region was already grabbed
          // above) in SINGLE mode CLEARS the selection — drop this violin's outline + publish empty so
          // the coordination clears this origin (+ bumps the exclusive epoch → other plots reconcile).
          setCommittedRegions([])
          onSelectPoints?.(new Uint32Array(0), false)
        }
        setRectDraft(null)
      }
    },
    [mode, bandDraft, rectDraft, commitBand, commitRegion, onSelectPoints, publishRegions],
  )

  const interaction = useMemo<ChartInteraction | undefined>(() => {
    if (!produceEnabled) return undefined
    return {
      drawing: mode !== 'pan',
      onPointerDown: onWorldDown,
      onPointerMove: onWorldMove,
      onPointerUp: onWorldUp,
      overlayTestId: 'viz-violin-draw-overlay',
      cursor: hoverMove || mode === 'move' ? 'move' : 'crosshair',
    }
  }, [produceEnabled, mode, hoverMove, onWorldDown, onWorldMove, onWorldUp])

  // ROBUST value range: the inner-box bodies (q1..q3), medians, and whisker fences are the
  // CORE that must fill the frame; the raw/KDE full extent + outliers get clamped headroom
  // so a far KDE tail / lone outlier can't stretch the frame and squish the violins into a
  // sliver (see robustValueRange). Drives BOTH the frame and the significance-bracket base.
  const valueRange = useMemo<[number, number] | null>(() => {
    if (!data || data.groups.length === 0) return null
    const core: number[] = []
    const soft: number[] = [data.valMin, data.valMax]
    for (const b of data.boxes) {
      core.push(b.lowerFence, b.upperFence, b.q1, b.q3, b.median)
      for (const o of b.outliers) soft.push(o)
    }
    return robustValueRange(core, soft)
  }, [data])
  // Keep the drag-out-to-remove bounds ref current: x = group-center span, y = the value range.
  plotBoundsRef.current =
    jitter && valueRange ? [-0.5, valueRange[0], jitter.visCount - 0.5, valueRange[1]] : null

  // x = group categories (nearest-category snap); y = value (free, follows the cursor).
  const axisPointerTicks = useMemo(
    () =>
      data
        ? {
            x: categoryTicks(
              visibleByCode(data.groups, overrides?.hiddenCodes).items.map(g => displayCategory(g.group, overrides?.categoryLabels)),
            ),
          }
        : undefined,
    [data, overrides],
  )

  if (error) return <ChartError message={error} />
  if (!data) return <ChartLoading />

  // The value-axis dataZoom WINDOW is owned by the core `ValueDataZoom` component (STEP 4); the
  // window→KDE-re-densify effect STAYS INSIDE the passive `ViolinBody` (a chart-specific data
  // recompute). Drag-pan of the value axis is enabled ONLY in 'pan' mode so it doesn't fight the
  // value-band / lasso drawing overlay. `viz-violin-value-zoom` control testId unchanged.
  // ENFORCED dataZoom-axes gate (ITEM-6): violins self-host only a VALUE (y) zoom, so a declared
  // `dataZoomAxes` that omits `'y'` disables it. Unset / includes `'y'` ⇒ unchanged.
  const effDataZoom = gateValueDataZoom(dataZoom, dataZoomAxes)
  const canvas = (
    <ValueDataZoom
      domain={valueRange}
      enablePan={mode === 'pan'}
      dataZoom={effDataZoom}
      testId="viz-violin-value-zoom"
      dataZoomId={plotCellId}
    >
      {window => (
        <ViolinBody
          data={data}
          catCodes={catCodes}
          jitter={jitter}
          dotHighlight={dotHighlight}
          emphasis={emphasis}
          valueRange={valueRange}
          window={window}
          ticks={ticks}
          bandwidth={bandwidth}
          showSignificance={showSignificance}
          showFrame={showFrame}
          showGrid={showGrid}
          theme={theme}
          axisPointer={axisPointer}
          axisPointerTicks={axisPointerTicks}
          interaction={interaction}
          bandDraft={bandDraft}
          rectDraft={rectDraft}
          lassoDraft={lassoDraft}
          committedRegions={committedRegions}
          transitions={transitions}
          overrides={overrides}
          axisTitles={axisTitles}
          typography={typography}
        />
      )}
    </ValueDataZoom>
  )

  // No producer sink (or `producesSelection:false`) ⇒ display+consume only: a plain canvas
  // (byte-unchanged layout). The ITEM-5 produce gate hides the toolbar without touching the canvas.
  if (!produceEnabled) return canvas

  // Producer sink present ⇒ the gesture-capable violin. The mode toolbar shows only in STANDALONE mode
  // (no rail); inside a grid the rail drives the mode + only a contextual Finish-lasso appears mid-draw.
  // Rail-driven ⇒ NO per-plot control bar at all (the lasso auto-commits, the rail owns the tools).
  const showToolbarBar = railMode == null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }} data-testid="viz-violin-selectable">
      {showToolbarBar && (
      <div
        style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 13, pointerEvents: 'auto' }}
        data-testid="viz-violin-toolbar"
      >
        {/* MODE buttons + hint only in STANDALONE mode. Inside a grid the left tool RAIL drives the mode,
            so the mode strip is hidden — only the contextual "Finish lasso" action remains while drawing. */}
        {railMode == null && (
          <span style={{ display: 'inline-flex', gap: 4 }}>
            {(['pan', 'band', 'lasso', 'move'] as Mode[]).map(m => (
              <button
                key={m}
                type="button"
                data-testid={`viz-violin-mode-${m}`}
                aria-pressed={mode === m}
                onClick={() => {
                  setMode(m)
                  setBandDraft(null)
                  setRectDraft(null)
                  setLassoDraft([])
                  dragRef.current = null
                }}
                style={{ fontWeight: mode === m ? 700 : 400 }}
              >
                {m === 'pan' ? 'Pan' : m === 'band' ? 'Value band' : m === 'lasso' ? 'Lasso' : 'Move'}
              </button>
            ))}
          </span>
        )}
        {mode === 'lasso' && lassoDraft.length > 0 && (
          <button
            type="button"
            data-testid="viz-violin-lasso-finish"
            onClick={finishLasso}
            disabled={lassoDraft.length < 3}
          >
            Finish lasso ({lassoDraft.length})
          </button>
        )}
        {railMode == null && (
          <span style={{ opacity: 0.55 }}>
            {mode === 'band'
              ? 'Drag a value range over a group'
              : mode === 'lasso'
                ? 'Click to drop lasso points, then Finish'
                : 'Pan / zoom'}
          </span>
        )}
      </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>{canvas}</div>
    </div>
  )
}

/**
 * The passive violin body: REACTS to the injected `window`. The window→KDE-re-densify effect (a
 * REAL data recompute over ONLY the in-window values — the DEFINING legacy behavior) STAYS HERE
 * (chart-specific); the window VALUE itself is owned by the core `ValueDataZoom`.
 */
function ViolinBody({
  data,
  catCodes,
  jitter,
  dotHighlight,
  emphasis,
  valueRange,
  window,
  ticks,
  bandwidth,
  showSignificance,
  showFrame,
  showGrid,
  theme,
  axisPointer,
  axisPointerTicks,
  interaction,
  bandDraft,
  rectDraft,
  lassoDraft,
  committedRegions,
  transitions,
  overrides,
  axisTitles,
  typography,
}: {
  data: ViolinData
  catCodes: Uint16Array | null
  jitter: JitterGeom | null
  dotHighlight: Uint8Array | null
  emphasis: GroupEmphasis
  valueRange: [number, number] | null
  window: ValueWindow | null
  ticks?: number
  bandwidth?: number
  showSignificance: boolean
  showFrame: boolean
  showGrid: boolean
  theme: ChartTheme
  axisPointer: boolean
  axisPointerTicks: { x: ReturnType<typeof categoryTicks> } | undefined
  interaction: ChartInteraction | undefined
  bandDraft: { group: number; y0: number; y1: number } | null
  rectDraft: { x0: number; y0: number; x1: number; y1: number } | null
  lassoDraft: [number, number][]
  committedRegions: Area[]
  transitions?: TransitionProp
  overrides?: CategoricalOverrides
  axisTitles?: { x?: string; y?: string }
  typography?: Typography
}) {
  const { selectedCodes, active } = emphasis
  // Data-table row-hover → highlight the matching raw jitter dot (this cell's hovered point index).
  const hoverHighlightIdx = useHoverHighlightIndex()
  const [windowedGroups, setWindowedGroups] = useState<ViolinGroup[] | null>(null)
  const [windowedBoxes, setWindowedBoxes] = useState<BoxStat[] | null>(null)

  // ── KDE RE-DENSIFY over the visible value window (the DEFINING legacy behavior) ──────
  // When `window` is a strict sub-range, recompute each group's KDE (and inner box) over ONLY
  // the in-window values — zooming the value axis reveals finer structure in the focused band
  // rather than merely magnifying. Debounced; a ~50k per-group subsample caps the KDE compute at
  // large N. Driven by the INJECTED window (owned by the core `ValueDataZoom`), but the recompute
  // itself is chart-specific and STAYS in the View.
  useEffect(() => {
    if (!data || !catCodes || !valueRange || !window) return
    if (isFullValueWindow(window, valueRange[0], valueRange[1])) {
      setWindowedGroups(null)
      setWindowedBoxes(null)
      return
    }
    let alive = true
    const categories = data.groups.map(g => g.group)
    const nGroups = categories.length
    const timer = setTimeout(() => {
      void (async () => {
        const device = await getComputeDevice()
        if (!alive) return
        const { values: fv, codes: fc } = filterCellsToWindow(
          data.values,
          catCodes,
          window.lo,
          window.hi,
          nGroups,
          KDE_SUBSAMPLE_CAP,
        )
        const groups = await violinByGroupGpu(
          fv,
          fc,
          categories,
          { ticks, bandwidth, domain: [window.lo, window.hi] },
          device,
        )
        if (!alive) return
        // Windowed inner box: quartiles over each group's UN-sampled in-window raw values.
        const boxes: BoxStat[] = data.raw.map((bucket, g) => {
          const inWin: number[] = []
          for (const v of bucket) {
            if (Number.isFinite(v) && v >= window.lo && v <= window.hi) inWin.push(v)
          }
          const q = quartiles(inWin)
          return {
            group: categories[g],
            q1: q.q1,
            median: q.median,
            q3: q.q3,
            lowerFence: q.lowerFence,
            upperFence: q.upperFence,
            outliers: q.outliers,
          }
        })
        setWindowedGroups(groups)
        setWindowedBoxes(boxes)
      })()
    }, RECOMPUTE_DEBOUNCE_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [data, catCodes, valueRange, window, ticks, bandwidth])

  const windowIsFull = useMemo(
    () => !window || !valueRange || isFullValueWindow(window, valueRange[0], valueRange[1]),
    [window, valueRange],
  )

  const bounds = useMemo<[number, number, number, number] | null>(() => {
    if (!data || !valueRange || !window || data.groups.length === 0) return null
    // Frame only the VISIBLE group count so hidden groups collapse + the rest re-space edge-to-edge.
    const n = data.groups.length - (overrides?.hiddenCodes?.size ?? 0)
    if (n <= 0) return null
    const span = valueRange[1] - valueRange[0] || 1
    // Frame the VALUE WINDOW on y; the group (x) axis is fixed. Brackets stack above the data
    // and are only drawn at the full window (they'd clip out when zoomed), so reserve their
    // headroom only then — keeping the un-zoomed framing byte-identical to before.
    const topExtra = windowIsFull && showSignificance && n >= 2 ? span * 0.3 : 0
    return [-0.6, window.lo, n - 1 + 0.6, window.hi + topExtra]
  }, [data, valueRange, window, windowIsFull, showSignificance, overrides?.hiddenCodes])

  const filterExt = useMemo(() => new DataFilterExtension({ filterSize: 1 }), [])

  const layers = useMemo<Layer[]>(() => {
    if (!data) return []
    // Use the value-window RE-DENSIFIED groups/box when zoomed (else the full-data compute).
    const groups = windowedGroups ?? data.groups
    const boxes = windowedBoxes ?? data.boxes

    // HIDDEN groups (interactive legend / form): collapse the KDE + box to the VISIBLE groups so their
    // columns re-space (the dots already collapse via the jitter rebuild). `vCodes[i]` recovers the
    // original code of visible slot i, so the palette + cross-plot emphasis map by the true code.
    const hidden = overrides?.hiddenCodes
    const { items: vGroups, codes: vCodes } = visibleByCode(groups, hidden)
    const { items: vBoxes } = visibleByCode(boxes, hidden)

    // Color the collapsed bodies by ORIGINAL group code (index the FULL palette by vCodes[i]) — the dot
    // cloud colors by catCode, so resolving the bodies by the COLLAPSED position instead shifts every
    // remaining group's color and the dots no longer match the shape (the reported hide bug). Indexing
    // the full palette keeps body ↔ dot ↔ legend-swatch consistent after a hide.
    const fullEffColors = resolveEffectivePalette(groups.map(g => g.group), overrides)
    const effColors = vCodes.map(c => fullEffColors[c] ?? categoryColor(c))

    // OPT-IN GPU tween on the KDE + inner-box fill recolor (default off ⇒ no `transitions` key ⇒
    // instant). The dot cloud is left instant (its display sample changes count between updates).
    const fillTx = deckTransitions(transitions, ['getFillColor'])
    const fillTxProp = fillTx ? { transitions: fillTx } : {}

    // 1. violin KDE shape.
    const { violin } = buildViolinProps(vGroups, { colors: effColors })
    const violinData = active
      ? violin.data.map((d, i) => ({
          ...d,
          fillColor: applyMarkOpacity(d.fillColor, markOpacity(vCodes[i], selectedCodes, true)),
        }))
      : violin.data
    const out: Layer[] = [new SolidPolygonLayer({ ...violin, data: violinData, ...fillTxProp })]

    // 2. inner Tukey box.
    const { boxes: boxRects, lines } = buildBoxProps(vBoxes, { id: 'viz-violin-box', width: 0.06, fillAlpha: 220, colors: effColors })
    const boxData = active
      ? boxRects.data.map((d, i) => ({
          ...d,
          fillColor: applyMarkOpacity(d.fillColor, markOpacity(vCodes[i], selectedCodes, true)),
        }))
      : boxRects.data
    out.push(new SolidPolygonLayer({ ...boxRects, data: boxData, ...fillTxProp }), new LineLayer(lines))

    // 3. the DOT CLOUD (density-aware display over the FULL deterministic jitter).
    if (jitter) {
      const dispLen = jitter.dispPos.length / 2
      out.push(
        new ScatterplotLayer({
          id: 'viz-violin-dots',
          data: {
            length: dispLen,
            attributes: {
              getPosition: { value: jitter.dispPos, size: 2 },
              getFillColor: { value: jitter.dispCol, size: 4, normalized: true },
            },
          },
          radiusUnits: 'pixels',
          getRadius: 1.4,
          radiusMinPixels: 1,
          radiusMaxPixels: 4,
          stroked: false,
          filled: true,
          opacity: dotHighlight ? DIM_OPACITY : 1,
          // Pickable so hovering a raw dot yields its index → a per-dot tooltip (group + value).
          pickable: true,
        }),
      )
      if (dotHighlight) {
        out.push(
          new ScatterplotLayer({
            id: 'viz-violin-dots-highlight',
            data: {
              length: dispLen,
              attributes: {
                getPosition: { value: jitter.dispPos, size: 2 },
                getFillColor: { value: jitter.dispCol, size: 4, normalized: true },
                getFilterValue: { value: dotHighlight, size: 1 },
              },
            },
            radiusUnits: 'pixels',
            getRadius: 1.8,
            radiusMinPixels: 1.5,
            radiusMaxPixels: 5,
            stroked: false,
            filled: true,
            opacity: 1,
            pickable: false,
            extensions: [filterExt],
            filterRange: [1, 1],
            updateTriggers: { getFilterValue: dotHighlight },
          }),
        )
      }
      // Data-table HOVER→HIGHLIGHT: a hollow amber ring on the hovered row's raw dot. `hoverHighlightIdx`
      // is the ORIGINAL point index (== the `jitter.full` index the publish emitted).
      if (
        hoverHighlightIdx != null &&
        hoverHighlightIdx >= 0 &&
        hoverHighlightIdx < jitter.n
      ) {
        const hx = jitter.full[hoverHighlightIdx * 2]
        const hy = jitter.full[hoverHighlightIdx * 2 + 1]
        if (Number.isFinite(hx) && Number.isFinite(hy)) {
          out.push(
            new ScatterplotLayer({
              id: 'viz-violin-hover-highlight',
              data: [{ position: [hx, hy] as [number, number] }],
              getPosition: (d: { position: [number, number] }) => d.position,
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
    }

    // 4. optional pairwise significance brackets (adjacent groups, Mann-Whitney U). Skipped while any
    // group is hidden — the precomputed adjacent-pair positions don't match the collapsed x layout.
    if (showSignificance && !hidden?.size && groups.length >= 2 && data.sig.length > 0 && valueRange) {
      const comparisons = data.sig
      const [lo, hi] = valueRange
      const step = (hi - lo || 1) * 0.06
      const packed = packBrackets(comparisons, hi + step, step)
      const { segments, labels } = bracketSegments(packed, {
        spacing: 1,
        tickDrop: step * 0.4,
        labelDy: step * 0.15,
      })
      out.push(
        new LineLayer({
          id: 'viz-violin-brackets',
          data: segments,
          getSourcePosition: s => s.source,
          getTargetPosition: s => s.target,
          getColor: s => s.color,
          getWidth: 1.5,
          widthUnits: 'pixels',
          widthMinPixels: 1,
        }),
        new TextLayer({
          id: 'viz-violin-bracket-labels',
          data: labels,
          getPosition: d => d.position,
          getText: d => d.text,
          getSize: 12,
          sizeUnits: 'pixels',
          ...(chartFrameFont(typography).family ? { fontFamily: chartFrameFont(typography).family } : {}),
          // Theme foreground (NOT hardcoded near-black — that vanished on a dark plot).
          getColor: parseColor(theme.fg),
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'bottom',
        }),
      )
    }

    // 5. in-progress gesture DRAFT (GPU PolygonLayer — no SVG): the band rect or lasso ring.
    const draftShapes: { polygon: [number, number][] }[] = []
    if (bandDraft) {
      const cx = bandDraft.group
      const hw = 0.45
      draftShapes.push({
        polygon: [
          [cx - hw, bandDraft.y0],
          [cx + hw, bandDraft.y0],
          [cx + hw, bandDraft.y1],
          [cx - hw, bandDraft.y1],
        ],
      })
    }
    if (rectDraft) {
      draftShapes.push({
        polygon: [
          [rectDraft.x0, rectDraft.y0],
          [rectDraft.x1, rectDraft.y0],
          [rectDraft.x1, rectDraft.y1],
          [rectDraft.x0, rectDraft.y1],
        ],
      })
    }
    if (lassoDraft.length >= 2) {
      draftShapes.push({ polygon: lassoDraft.map(v => [v[0], v[1]] as [number, number]) })
    }
    if (draftShapes.length > 0) {
      out.push(
        new PolygonLayer<{ polygon: [number, number][] }>({
          id: 'viz-violin-gesture-draft',
          data: draftShapes,
          getPolygon: d => d.polygon,
          stroked: true,
          filled: true,
          getFillColor: [56, 132, 255, 30],
          getLineColor: [56, 132, 255, 220],
          getLineWidth: 1.5,
          lineWidthUnits: 'pixels',
          pickable: false,
          updateTriggers: { getPolygon: [bandDraft, rectDraft, lassoDraft] },
        }),
      )
    }

    // COMMITTED region outlines (rect + lasso): persist after commit, subtle border, drawn by the
    // SHARED outline builder so they match every other surface; the Move tool drags each one.
    if (committedRegions.length > 0) {
      const committedOutline = buildSelectionOutlineLayer(
        controllerAreasToShapes(committedRegions),
        'viz-violin-sel-committed',
      )
      if (committedOutline) out.push(committedOutline as unknown as Layer)
    }

    if (showFrame && bounds) {
      const frame = buildChartFrameLayers({
        id: 'viz-violin-frame',
        bounds,
        xTitle: axisTitles?.x ?? 'Group',
        yTitle: axisTitles?.y ?? 'Value',
        xTicks: categoryTicks(vGroups.map(g => displayCategory(g.group, overrides?.categoryLabels))),
        showGrid,
        theme,
        font: chartFrameFont(typography),
      })
      return [...frame, ...clipToBounds(out, bounds)]
    }
    return out
  }, [
    data,
    windowedGroups,
    windowedBoxes,
    jitter,
    dotHighlight,
    filterExt,
    showSignificance,
    valueRange,
    bounds,
    showFrame,
    showGrid,
    theme,
    selectedCodes,
    active,
    bandDraft,
    rectDraft,
    lassoDraft,
    committedRegions,
    transitions,
    overrides,
    typography,
    hoverHighlightIdx,
  ])

  // Per-DOT hover tooltip (group + value): the shared deck (or a standalone ChartCanvas) forwards the
  // pick info here; the picked index is into the DISPLAY sample — mapped back through `displayIdx` to the
  // original cell in render. rAF-throttled (one setState per frame), pointer-transparent — mirrors
  // HeatmapView's per-texel tooltip.
  const [dotPick, setDotPick] = useState<{ idx: number; x: number; y: number } | null>(null)
  const dotPickPending = useRef<{ idx: number; x: number; y: number } | null>(null)
  const dotPickRaf = useRef<number | null>(null)
  const flushDotPick = useCallback(() => {
    dotPickRaf.current = null
    setDotPick(dotPickPending.current)
  }, [])
  const handleDotHover = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (info: any) => {
      const id = typeof info?.layer?.id === 'string' ? info.layer.id : ''
      dotPickPending.current =
        info && info.index >= 0 && id.endsWith('viz-violin-dots')
          ? { idx: info.index, x: info.x, y: info.y }
          : null
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
  // Publish the hovered dot's ORIGINAL index up so GridWorkspace cross-highlights the same cell in the
  // scatters (bidirectional hover). `null` on leave. (`dotPick` only detects a DIRECT hover here.)
  const publishHover = usePublishHover()
  useEffect(() => {
    if (!dotPick || !jitter) {
      publishHover(null)
      return
    }
    const orig = jitter.displayIdx ? jitter.displayIdx[dotPick.idx] : dotPick.idx
    publishHover(orig != null && orig >= 0 && orig < jitter.n ? orig : null)
  }, [dotPick, jitter, publishHover])
  // Release the cross-plot hover latch when this chart cell UNMOUNTS (removed / type-swapped mid-hover),
  // so a stale `chartHover` can't keep highlighting other cells. Separate from the effect above (whose
  // per-frame cleanup would flicker); fires only on unmount / a rare `publishHover` identity change.
  useEffect(() => () => publishHover(null), [publishHover])
  // The dot to TOOLTIP is the cross-plot highlighted one (`hoverHighlightIdx` — set on BOTH a direct
  // violin hover via the publish round-trip AND a hover in another linked plot). Its WORLD position feeds
  // ChartCanvas, which projects it to screen. Gated by the global tooltip toggle (the ring shows either way).
  const tooltipsOn = useTooltipsEnabled()
  const pointTooltip = useMemo(() => {
    if (!tooltipsOn || hoverHighlightIdx == null || !jitter || !catCodes || !data) return null
    const i = hoverHighlightIdx
    if (i < 0 || i >= jitter.n) return null
    const wx = jitter.full[i * 2]
    const wy = jitter.full[i * 2 + 1]
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return null
    const code = catCodes[i]
    const group = displayCategory(data.groups[code]?.group ?? String(code), overrides?.categoryLabels)
    return {
      world: [wx, wy] as [number, number],
      rows: [
        { label: 'Group', value: group },
        { label: axisTitles?.y ?? 'Value', value: formatNumber(data.values[i]) },
      ],
    }
  }, [tooltipsOn, hoverHighlightIdx, jitter, catCodes, data, overrides, axisTitles])

  // VALUE-AXIS (y) zoom, NOT a free 2-D camera (the legacy `dataZoom:{type:'inside',
  // yAxisIndex:[0]}`): `controller={false}` kills deck's pan/zoom; the core `ValueDataZoom` drives
  // the value window. The group/x axis stays fixed. `onHover` detects a direct dot hover (→ publish +
  // cross-highlight); `pointTooltip` renders the tooltip at the highlighted dot (ChartCanvas projects it).
  return (
    <ChartCanvas
      layers={layers}
      bounds={bounds ?? undefined}
      controller={false}
      axisPointer={axisPointer}
      axisPointerTicks={axisPointerTicks}
      theme={theme}
      interaction={interaction}
      onHover={handleDotHover}
      pointTooltip={pointTooltip}
      testId="viz-violin-view"
    />
  )
}
