// HeatmapView.tsx — the heatmap VIEW (DEC-18: a BitmapLayer RGBA data-texture,
// Vitessce pattern). Data-shaping (value columns + categorical → a row-major
// `HeatmapMatrix`) is the pure exported `heatmapMatrixFromColumns` helper (wraps the
// shared `heatmapMatrix` mean aggregation + pivots it into rows × cols); the component
// wires load → helper → `buildHeatmapProps` → layer → `ChartCanvas`.
//
// Enrichment (ITEM-36/37/38): optional row/col hierarchical clustering (reorder the
// matrix by the leaf order + draw `PathLayer` dendrograms), a per-row z-score toggle
// (diverging `magma` LUT centered at 0), and a categorical annotation track (a thin
// `BitmapLayer` beside the matrix). The pure math lives in `./heatmapExtras`.
//
// STEP 3-4 (EXTENSIBILITY_STUDY): the cross-plot selection is READ through the injected
// `coordination` handle (the row-band emphasis), and the matrix dataZoom WINDOW is owned by
// the core `DataZoomMatrix` component (not this View). `HeatmapView` is the OUTER (load +
// cluster toolbar + selection→row-codes + the window-independent layers); the `DataZoomMatrix`
// is hosted INSIDE it — BELOW the cluster toolbar so the DOM is byte-identical — and feeds the
// window to the passive `HeatmapBody`, which re-frames the fit bounds.

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { PlotCellIdContext, usePublishPlotData, usePublishValueLegend } from './plotCellId'
import { BitmapLayer, PathLayer, PolygonLayer } from '@deck.gl/layers'
import type { Layer } from '@deck.gl/core'
import { ChartCanvas } from './ChartCanvas'
import { useAsyncChartData, ChartError, ChartLoading, ChartEmpty } from './useAsyncChartData'
import { VizTooltip } from '../tooltip/VizTooltip'
import {
  buildMatrixTooltipFields,
  resolveMatrixTooltip,
  type MatrixTooltipField,
  type TooltipMatrix,
} from '../tooltip/tooltipModel'
import { LIGHT_THEME, type VizTheme } from '../theme'
import { type Typography } from '../controls/typography'
import { resolveEffectivePalette, displayCategory, DEFAULT_CONTINUOUS_COLORMAP, type CategoricalOverrides, type ContinuousColormap } from '../data/color'
import { defaultCoordinationHandle } from '../../adapter/coordinationHandle'
import type { CoordinationHandle } from '../registry/types'
import {
  buildGroupIndex,
  highlightedRowPositions,
  resolveSelectionGroupCodes,
} from '../coordination/selectionSync'
import { type DataZoomConfig } from './AxisDataZoom'
import { gatePointSelection, gateMatrixDataZoom } from './capabilityGates'
import { DataZoomMatrix } from '../datazoom/DataZoom'
import { windowToBounds, type MatrixWindow } from './matrixWindow'
import { buildHeatmapProps, type HeatmapBuildOpts, type HeatmapMatrix } from './chartLayers'
import { heatmapMatrix } from './aggregate'
import { heatmapMatrixGpu } from './aggregateGpu'
import { getComputeDevice } from '../gpu/computeDevice'
import { densifyColumns, matrixAxisTitleLayers } from './DotplotView'
import {
  annotationTrackTexture,
  dendrogramPaths,
  zscoreRows,
  type DendrogramPath,
} from './heatmapExtras'
import {
  hierarchicalClustering,
  type DistanceMetric,
  type Linkage,
  type Merge,
} from '../data/statsKernels'
import type { CategoricalColumn, DataSource } from '../data/wire'

/**
 * Turn a set of (densified) value columns + a categorical column into a row-major
 * `HeatmapMatrix` (rows = groups/categories, cols = value columns, cell = mean value):
 * run the shared `heatmapMatrix` aggregation, then pivot the cell list into a dense
 * `Float32Array` of length rows×cols. Pure — no GL, no I/O.
 */
export function heatmapMatrixFromColumns(
  columns: ReadonlyMap<string, Float32Array>,
  cat: CategoricalColumn,
): HeatmapMatrix {
  const rows = [...cat.categories]
  const cols = [...columns.keys()]
  const colIdx = new Map(cols.map((c, i) => [c, i] as const))
  const rowIdx = new Map(rows.map((r, i) => [r, i] as const))
  const values = new Float32Array(rows.length * cols.length)
  for (const cell of heatmapMatrix(columns, cat.codes, cat.categories)) {
    const r = rowIdx.get(cell.group)
    const c = colIdx.get(cell.column)
    if (r === undefined || c === undefined) continue
    values[r * cols.length + c] = cell.value
  }
  return { rows, cols, values }
}

export interface HeatmapViewProps {
  source: DataSource
  valueKeys: readonly string[]
  groupKey: string
  /** Initial toggle states (the toolbar lets the user flip them live). */
  clusterRows?: boolean
  clusterCols?: boolean
  zscore?: boolean
  showDendrogram?: boolean
  showAnnotation?: boolean
  linkage?: Linkage
  distance?: DistanceMetric
  /**
   * CUSTOMIZED heatmap tooltip fields (overrides the defaults built from the displayed
   * matrix). Each accessor `(row,col)` must be O(1) — read one matrix index. Absent ⇒ the
   * default group / feature / value / cell / n fields.
   */
  tooltipFields?: MatrixTooltipField[]
  /** Theme-aware chrome colors for the hover tooltip; default light. */
  theme?: VizTheme
  /**
   * Per-instance dataZoom config: `false` disables the zoom UI entirely; `{ x, y, wheel }` picks
   * each axis' control kind + wheel gate. Default (omitted) = both sliders + wheel.
   */
  dataZoom?: false | DataZoomConfig
  /** The Selection coordination handle (STEP 3); defaults to the store-backed singleton. */
  coordination?: CoordinationHandle
  /** ENFORCED capability (Area B, ITEM-5). `false` ⇒ this View does NOT consume the shared
   *  selection (no group-row band highlight). Unset/true ⇒ consume (byte-identical). */
  consumesSelection?: boolean
  /** ENFORCED capability (Area B, ITEM-6). The axes the matrix zoom honors; an empty set disables
   *  it. Unset / `['x','y']` ⇒ unchanged. */
  dataZoomAxes?: readonly ('x' | 'y')[]
  /**
   * OPTIONAL categorical overrides — a custom/by-name palette recolors the row ANNOTATION track
   * and `categoryLabels` renames the group ROW labels (tooltip). Absent ⇒ built-in palette + raw
   * names (byte-identical). Export picks them up (rendered track + tooltip).
   */
  overrides?: CategoricalOverrides
  /** Plot-editing (ITEM-4): per-cell x/y AXIS title overrides (declarative). Absent ⇒ no titles.
   *  Rendered as a flipY-correct billboard `TextLayer` beside the matrix (mirrors the sibling frame
   *  titles; the shared `buildChartFrameLayers` is not flipY-aware, so the matrix draws its own). */
  axisTitles?: { x?: string; y?: string }
  /** Typography (font family + axis-title size) for the axis titles. Absent ⇒ built-in defaults. */
  typography?: Typography
  /** Continuous VALUE colormap override (edit-form Color section). Absent ⇒ the built-in default
   *  (z-scored → magma, else viridis). Published up as the on-plot value colorbar. */
  colormap?: ContinuousColormap
}

/** Perpendicular extent (data units) a dendrogram tree occupies beside the matrix. */
function dendroExtent(perpDim: number): number {
  return Math.max(2, perpDim * 0.6)
}

/** A labelled checkbox toggle for the heatmap toolbar. */
function Toggle({
  label,
  checked,
  onChange,
  testId,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  testId: string
}) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        data-testid={testId}
      />
      {label}
    </label>
  )
}

export function HeatmapView({
  source,
  valueKeys,
  groupKey,
  clusterRows: clusterRows0 = false,
  clusterCols: clusterCols0 = false,
  zscore: zscore0 = false,
  showDendrogram: showDendrogram0 = true,
  showAnnotation: showAnnotation0 = true,
  linkage = 'average',
  distance = 'euclidean',
  tooltipFields,
  theme = LIGHT_THEME,
  dataZoom,
  coordination = defaultCoordinationHandle,
  consumesSelection,
  dataZoomAxes,
  overrides,
  axisTitles,
  typography,
  colormap: valueColormap,
}: HeatmapViewProps) {
  // The cell's STABLE dataZoom id (ITEM-20): store-backed matrix window when inside a grid cell
  // (restore applies), `undefined` (local `useState`, byte-identical) in a story with no provider.
  const plotCellId = useContext(PlotCellIdContext)
  // Per-point group codes (from the grouping categorical) — needed to map a scatter
  // point-selection to the heatmap GROUP ROWS it covers (DEC-25 / ITEM-25). Rows are
  // the categories in code order, so an original row index == its group code. Set from
  // inside the loader (under its try/catch).
  const [catCodes, setCatCodes] = useState<Uint16Array | null>(null)
  const [clusterRows, setClusterRows] = useState(clusterRows0)
  const [clusterCols, setClusterCols] = useState(clusterCols0)
  const [zscore, setZscore] = useState(zscore0)
  const [showDendrogram, setShowDendrogram] = useState(showDendrogram0)
  const [showAnnotation, setShowAnnotation] = useState(showAnnotation0)

  const { data: rawMatrix, error } = useAsyncChartData<HeatmapMatrix>(async isAlive => {
    const cols = await Promise.all(valueKeys.map(async k => [k, await source.valueColumn(k)] as const))
    const cat = await source.categorical(groupKey)
    if (isAlive()) setCatCodes(cat.codes)
    // Prefer the GPU aggregation (auto-falls back to the CPU `heatmapMatrix` oracle when
    // no compute device); pivot the cells into the same row-major `HeatmapMatrix` shape
    // as `heatmapMatrixFromColumns`.
    const device = await getComputeDevice()
    const dense = densifyColumns(cols)
    const cells = await heatmapMatrixGpu(dense, cat.codes, cat.categories, device)
    if (!isAlive()) return undefined
    const rows = [...cat.categories]
    const colNames = [...dense.keys()]
    const colIdx = new Map(colNames.map((c, i) => [c, i] as const))
    const rowIdx = new Map(rows.map((r, i) => [r, i] as const))
    const values = new Float32Array(rows.length * colNames.length)
    for (const cell of cells) {
      const r = rowIdx.get(cell.group)
      const c = colIdx.get(cell.column)
      if (r === undefined || c === undefined) continue
      values[r * colNames.length + c] = cell.value
    }
    return { rows, cols: colNames, values }
    // PERF: key on a STABLE joined string, not the `valueKeys` array reference. The registry passes a
    // fresh `valueKeys` array on every render (bindingList returns a new array), so an array-identity dep
    // re-fired this whole GPU reduce + synchronous readPixels readback on EVERY re-render — the CPU spike
    // / hang on scatter→heatmap. The joined string only changes when the columns actually change.
  }, [source, valueKeys.join('\n'), groupKey])

  // HIDDEN group rows (interactive legend / form): drop them so the matrix ROWS collapse + re-space.
  // `matrix` is the VISIBLE-filtered matrix (rebuilt values); `visToOrig[visibleRow] = originalCode`
  // remaps the row-band emphasis after the collapse. The point→group index stays on the ORIGINAL row
  // count so a scatter selection still resolves to the right original group codes.
  const nRowsOrig = rawMatrix?.rows.length ?? 0
  const { matrix, visToOrig } = useMemo(() => {
    if (!rawMatrix) return { matrix: null as HeatmapMatrix | null, visToOrig: [] as number[] }
    const hidden = overrides?.hiddenCodes
    if (!hidden || hidden.size === 0) return { matrix: rawMatrix, visToOrig: rawMatrix.rows.map((_, i) => i) }
    const keep: number[] = []
    rawMatrix.rows.forEach((_, i) => {
      if (!hidden.has(i)) keep.push(i)
    })
    const nc = rawMatrix.cols.length
    const values = new Float32Array(keep.length * nc)
    keep.forEach((orig, vi) => {
      for (let c = 0; c < nc; c++) values[vi * nc + c] = rawMatrix.values[orig * nc + c]
    })
    return { matrix: { rows: keep.map(i => rawMatrix.rows[i]), cols: rawMatrix.cols, values }, visToOrig: keep }
  }, [rawMatrix, overrides?.hiddenCodes])
  const nRows = matrix?.rows.length ?? 0
  const nCols = matrix?.cols.length ?? 0

  // Publish the plotted matrix cells (VISIBLE group rows) to the pane's "Plot data" table. `value` is the
  // aggregated per-(group,feature) value (NOT the z-scored/clustered display value) for reproducibility.
  usePublishPlotData(() => {
    if (!matrix || nRows === 0 || nCols === 0) return null
    const r = (v: number) => Math.round(v * 1000) / 1000
    const rows: (string | number)[][] = []
    for (let ri = 0; ri < nRows; ri++) {
      const g = displayCategory(matrix.rows[ri], overrides?.categoryLabels)
      for (let ci = 0; ci < nCols; ci++) rows.push([g, matrix.cols[ci], r(matrix.values[ri * nCols + ci])])
    }
    return { columns: ['group', 'feature', 'value'], rows }
  }, [matrix, nRows, nCols, overrides])

  // Cross-plot selection sync (DEC-25 / ITEM-25) — READ THROUGH the coordination handle (STEP 3):
  // a point selection made in a scatter lights up the heatmap's GROUP ROWS (rows ARE the groups).
  // Mapping is the pure `resolveSelectionGroupCodes` (point indices → covered group codes, routed
  // through the ITEM-7 GroupIndex when built) + `highlightedRowPositions` (in the layers memo).
  // ENFORCED consume gate (ITEM-5): `consumesSelection:false` ⇒ ignore the shared point selection
  // (no row-band highlight); `null` reads as "no selection" downstream. Unset/true ⇒ byte-identical.
  const pointSelection = gatePointSelection(coordination.usePointSelection(), consumesSelection)
  // ITEM-7: the CSR group→point-indices membership index, built ONCE per grouping.
  const groupIndex = useMemo(
    // ORIGINAL row count — a point selection resolves to original group codes (independent of hiding).
    () => (catCodes ? buildGroupIndex(catCodes, nRowsOrig) : null),
    [catCodes, nRowsOrig],
  )
  const selectionGroupCodes = useMemo(
    () =>
      pointSelection && catCodes
        ? resolveSelectionGroupCodes(pointSelection, catCodes, groupIndex ?? undefined)
        : new Set<number>(),
    [pointSelection, catCodes, groupIndex],
  )

  // The layers PLUS the exact matrix that's rendered (reordered + optionally z-scored) and
  // the main heatmap layer id — the tooltip resolves against THIS `displayMatrix` so a
  // hovered texel maps to the cell the user actually sees. Window-INDEPENDENT (the window
  // only re-frames the fit bounds in the passive body), so it lives in the OUTER.
  const { layers, displayMatrix, heatmapId, valueLegend } = useMemo<{
    layers: Layer[]
    displayMatrix: TooltipMatrix | null
    heatmapId: string | null
    valueLegend: { colormap: ContinuousColormap; domain: readonly [number, number] } | null
  }>(() => {
    if (!matrix || nRows === 0 || nCols === 0)
      return { layers: [], displayMatrix: null, heatmapId: null, valueLegend: null }

    // 1. optional per-row z-score normalization.
    const base = zscore ? zscoreRows(matrix.values, nRows, nCols) : matrix.values

    // 2. optional hierarchical clustering → leaf orders + merge trees. Columns cluster
    //    on the transpose (rows of the transpose = original columns).
    let rowOrder = Array.from({ length: nRows }, (_, i) => i)
    let colOrder = Array.from({ length: nCols }, (_, i) => i)
    let rowMerges: readonly Merge[] = []
    let colMerges: readonly Merge[] = []
    if (clusterRows && nRows > 1) {
      const res = hierarchicalClustering(base, nRows, nCols, { linkage, distance })
      rowOrder = res.order
      rowMerges = res.merges
    }
    if (clusterCols && nCols > 1) {
      const t = new Float32Array(nCols * nRows)
      for (let r = 0; r < nRows; r++)
        for (let c = 0; c < nCols; c++) t[c * nRows + r] = base[r * nCols + c]
      const res = hierarchicalClustering(t, nCols, nRows, { linkage, distance })
      colOrder = res.order
      colMerges = res.merges
    }

    // 3. reorder the matrix by the leaf orders.
    const reordered = new Float32Array(nRows * nCols)
    for (let i = 0; i < nRows; i++)
      for (let j = 0; j < nCols; j++)
        reordered[i * nCols + j] = base[rowOrder[i] * nCols + colOrder[j]]

    // 4. colormap: z-scored → diverging magma centered at 0; else the default (viridis). A user-picked
    //    `valueColormap` (edit form) OVERRIDES the default hue while keeping the z-score domain centering.
    let opts: HeatmapBuildOpts = {}
    if (zscore) {
      let maxAbs = 0
      for (let i = 0; i < reordered.length; i++) {
        const a = Math.abs(reordered[i])
        if (a > maxAbs) maxAbs = a
      }
      if (!(maxAbs > 0)) maxAbs = 1
      opts = { colormap: 'magma', domain: [-maxAbs, maxAbs] }
    }
    if (valueColormap) opts = { ...opts, colormap: valueColormap }
    const { image, bounds, textureParameters, id, domain } = buildHeatmapProps(
      { rows: matrix.rows, cols: matrix.cols, values: reordered },
      opts,
    )
    const effColormap: ContinuousColormap = valueColormap ?? opts.colormap ?? DEFAULT_CONTINUOUS_COLORMAP
    // deck.gl v9 BitmapLayer renders a raw {data,width,height} object as black; an
    // ImageData is reliably uploaded as an RGBA texture. Copy the bytes into one.
    const imageData = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height)

    const out: Layer[] = [
      new BitmapLayer({
        id,
        image: imageData,
        bounds: [bounds[0], bounds[1], bounds[2], bounds[3]],
        textureParameters,
        // GPU picking ON so hover returns `info.bitmap.pixel` = [col,row] with NO CPU scan
        // → the O(1) rich tooltip. The other bitmap (annotation) stays non-pickable.
        pickable: true,
      }),
    ]

    // The rendered matrix (reordered + z-scored). The VALUES were reordered by the cluster
    // leaf orders (step 3), so the LABELS must be reordered by the SAME orders — display
    // index i renders original category rowOrder[i] / colOrder[j]. Pairing reordered values
    // with original-order labels silently mislabels every tooltip when clustering is on.
    // When clustering is off, rowOrder/colOrder are identity ⇒ these `.map`s return the
    // same labels (byte-identical behavior).
    const displayMatrix: TooltipMatrix = {
      // Group ROW labels routed through `displayCategory` so a `categoryLabels` rename shows in the
      // tooltip (order preserved by the cluster leaf order). No override ⇒ raw names.
      rows: rowOrder.map(i => displayCategory(matrix.rows[i], overrides?.categoryLabels)),
      cols: colOrder.map(j => matrix.cols[j]),
      values: reordered,
    }

    // 5. dendrograms (PathLayer polylines) beside the clustered axis.
    if (showDendrogram && clusterRows && rowMerges.length > 0) {
      out.push(
        new PathLayer<DendrogramPath>({
          id: 'viz-heatmap-row-dendro',
          data: dendrogramPaths(rowMerges, rowOrder, nRows, {
            side: 'row',
            extent: dendroExtent(nCols),
          }),
          getPath: d => d.path,
          getColor: d => d.color,
          getWidth: 1.5,
          widthUnits: 'pixels',
          widthMinPixels: 1,
        }),
      )
    }
    if (showDendrogram && clusterCols && colMerges.length > 0) {
      out.push(
        new PathLayer<DendrogramPath>({
          id: 'viz-heatmap-col-dendro',
          data: dendrogramPaths(colMerges, colOrder, nCols, {
            side: 'col',
            extent: dendroExtent(nRows),
          }),
          getPath: d => d.path,
          getColor: d => d.color,
          getWidth: 1.5,
          widthUnits: 'pixels',
          widthMinPixels: 1,
        }),
      )
    }

    // 6. categorical annotation track — one color per (reordered) row's own category,
    //    a thin vertical BitmapLayer to the right of the matrix.
    if (showAnnotation) {
      const codes = new Uint16Array(nRows)
      for (let i = 0; i < nRows; i++) codes[i] = rowOrder[i]
      // EFFECTIVE per-group palette (custom / by-name / auto-extended); no overrides ⇒ built-in.
      const annPalette = resolveEffectivePalette(matrix.rows, overrides)
      out.push(
        new BitmapLayer({
          id: 'viz-heatmap-annotation',
          image: annotationTrackTexture(codes, matrix.rows, 'row', annPalette),
          bounds: [nCols + 0.3, nRows, nCols + 1.1, 0],
          textureParameters,
        }),
      )
    }

    // 7. cross-plot selection band (DEC-25 / ITEM-25): outline + faint fill over each
    //    display row whose group is covered by the shared scatter point-selection. The
    //    matrix spans data-space x∈[0,nCols], y∈[0,nRows] (BitmapLayer bounds
    //    [0,height,width,0]), so display row `r` occupies the rect [0,r]→[nCols,r+1].
    // Map each display row's VISIBLE index → its ORIGINAL code so the row-band highlight matches the
    // selected (original) group codes even after hidden rows collapsed the matrix.
    const hlRows = highlightedRowPositions(rowOrder.map(vi => visToOrig[vi] ?? vi), selectionGroupCodes)
    if (hlRows.length > 0) {
      out.push(
        new PolygonLayer<{ row: number }>({
          id: 'viz-heatmap-selection',
          data: hlRows.map(row => ({ row })),
          getPolygon: (d: { row: number }) => [
            [0, d.row],
            [nCols, d.row],
            [nCols, d.row + 1],
            [0, d.row + 1],
          ],
          stroked: true,
          filled: true,
          getFillColor: [56, 132, 255, 40],
          getLineColor: [56, 132, 255, 230],
          getLineWidth: 2,
          lineWidthUnits: 'pixels',
          lineWidthMinPixels: 2,
          pickable: false,
          updateTriggers: { getPolygon: hlRows },
        }),
      )
    }

    return { layers: out, displayMatrix, heatmapId: id, valueLegend: { colormap: effColormap, domain } }
  }, [matrix, visToOrig, nRows, nCols, clusterRows, clusterCols, zscore, showDendrogram, showAnnotation, linkage, distance, selectionGroupCodes, overrides, valueColormap])

  // Default tooltip fields (group / feature / value / cell) from the displayed matrix,
  // unless the caller supplies a CUSTOM `tooltipFields`. Rebuilt only when the matrix
  // reference changes — never per hover.
  const resolvedFields = useMemo<MatrixTooltipField[] | null>(
    () => tooltipFields ?? (displayMatrix ? buildMatrixTooltipFields(displayMatrix) : null),
    [tooltipFields, displayMatrix],
  )
  // Publish the value scale (colormap + domain) up → GridWorkspace renders the on-plot colorbar + feeds
  // the edit-form colormap picker (the matrix analog of a scatter's continuous colorBy legend).
  usePublishValueLegend(() => valueLegend, [valueLegend?.colormap, valueLegend?.domain?.[0], valueLegend?.domain?.[1]])

  // M4: distinguish LOADING (matrix not yet resolved) from a legitimately EMPTY matrix (loaded
  // but zero rows/cols) — the latter shows an empty-state message, never a permanent spinner.
  if (error) return <ChartError message={error} />
  if (!matrix) return <ChartLoading />
  if (nRows === 0 || nCols === 0) return <ChartEmpty message="No data to plot" />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          gap: 12,
          flexWrap: 'wrap',
          padding: '4px 8px',
          fontSize: 12,
          // Re-arm pointer events for the shared-deck case (chart cell is pointerEvents:none).
          pointerEvents: 'auto',
        }}
        data-testid="viz-heatmap-toolbar"
      >
        <Toggle label="Cluster rows" checked={clusterRows} onChange={setClusterRows} testId="viz-heatmap-cluster-rows" />
        <Toggle label="Cluster cols" checked={clusterCols} onChange={setClusterCols} testId="viz-heatmap-cluster-cols" />
        <Toggle label="Dendrograms" checked={showDendrogram} onChange={setShowDendrogram} testId="viz-heatmap-dendrogram" />
        <Toggle label="Z-score rows" checked={zscore} onChange={setZscore} testId="viz-heatmap-zscore" />
        <Toggle label="Annotation" checked={showAnnotation} onChange={setShowAnnotation} testId="viz-heatmap-annotation-toggle" />
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {/* The matrix dataZoom WINDOW is owned by the core `DataZoomMatrix` (STEP 4), hosted HERE
            — below the cluster toolbar so the DOM is byte-identical — and feeds the window to the
            passive `HeatmapBody`. `viz-heatmap-datazoom` control testId + enable/disable preserved. */}
        {/* ENFORCED dataZoom-axes gate (ITEM-6): an EMPTY declared `dataZoomAxes` disables the
            matrix zoom; unset / any axis ⇒ unchanged (`['x','y']` is the descriptor default). */}
        <DataZoomMatrix nRows={nRows} nCols={nCols} dataZoom={gateMatrixDataZoom(dataZoom, dataZoomAxes)} testId="viz-heatmap-datazoom" dataZoomId={plotCellId}>
          {window => (
            <HeatmapBody
              layers={layers}
              heatmapId={heatmapId}
              resolvedFields={resolvedFields}
              theme={theme}
              window={window}
              nRows={nRows}
              nCols={nCols}
              clusterRows={clusterRows}
              clusterCols={clusterCols}
              showDendrogram={showDendrogram}
              showAnnotation={showAnnotation}
              axisTitles={axisTitles}
              typography={typography}
            />
          )}
        </DataZoomMatrix>
      </div>
    </div>
  )
}

/**
 * The passive heatmap body: REACTS to the injected `window` by re-framing the fit bounds
 * (DEC-38), and owns the O(1) hover tooltip over the rendered matrix.
 */
function HeatmapBody({
  layers,
  heatmapId,
  resolvedFields,
  theme,
  window,
  nRows,
  nCols,
  clusterRows,
  clusterCols,
  showDendrogram,
  showAnnotation,
  axisTitles,
  typography,
}: {
  layers: Layer[]
  heatmapId: string | null
  resolvedFields: MatrixTooltipField[] | null
  theme: VizTheme
  window: MatrixWindow | null
  nRows: number
  nCols: number
  clusterRows: boolean
  clusterCols: boolean
  showDendrogram: boolean
  showAnnotation: boolean
  axisTitles?: { x?: string; y?: string }
  typography?: Typography
}) {
  // Window-driven fit bounds (DEC-38): frame the dataZoom window's matrix sub-rect
  // ([col0,row0,col1,row1]). When the window still touches a decorated edge, extend that
  // edge to keep the row/col dendrograms (negative coords) + annotation track (right of
  // the matrix) framed — ChartCanvas' auto-fit doesn't inspect PathLayer paths. When
  // zoomed in past those edges the decorations clip out (you're inspecting cells).
  const fitBounds = useMemo<[number, number, number, number] | undefined>(() => {
    if (!window || nRows === 0 || nCols === 0) return undefined
    const [c0, r0, c1, r1] = windowToBounds(window)
    const padL = showDendrogram && clusterRows && window.col0 <= 0 ? dendroExtent(nCols) + 0.5 : 0
    const padR = showAnnotation && window.col1 >= nCols ? 1.3 : 0
    const padT = showDendrogram && clusterCols && window.row0 <= 0 ? dendroExtent(nRows) + 0.5 : 0
    return [c0 - padL, r0 - padT, c1 + padR, r1]
  }, [window, nRows, nCols, clusterRows, clusterCols, showDendrogram, showAnnotation])

  // rAF-throttled heatmap hover: deck's picking hands us `info.bitmap.pixel` = [col,row]
  // for the main heatmap layer. We coalesce to one setState per frame; the DATA access
  // (resolveMatrixTooltip, O(1)) runs in the render below. Ignore hovers over the other
  // layers (dendrograms / annotation track / selection band).
  const [tip, setTip] = useState<{ row: number; col: number; x: number; y: number } | null>(null)
  const rafRef = useRef<number | null>(null)
  const pendingRef = useRef<{ row: number; col: number; x: number; y: number } | null>(null)
  const flushTip = useCallback(() => {
    rafRef.current = null
    setTip(pendingRef.current)
  }, [])
  const handleHeatmapHover = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (info: any) => {
      const px = info?.bitmap?.pixel
      if (Array.isArray(px) && info?.layer?.id === heatmapId) {
        pendingRef.current = { col: px[0], row: px[1], x: info.x, y: info.y }
      } else {
        pendingRef.current = null
      }
      if (typeof requestAnimationFrame === 'undefined') flushTip()
      else if (rafRef.current == null) rafRef.current = requestAnimationFrame(flushTip)
    },
    [heatmapId, flushTip],
  )
  useEffect(
    () => () => {
      if (rafRef.current != null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(rafRef.current)
      }
    },
    [],
  )

  // Axis titles (plot-editing): a flipY-correct billboard TextLayer framed to the VISIBLE matrix rect
  // (mirrors the sibling charts framing their titles to the window). Appended on top of the data layers.
  const titledLayers = useMemo<Layer[]>(() => {
    const [x0, y0, x1, y1]: [number, number, number, number] = window
      ? windowToBounds(window)
      : [0, 0, nCols, nRows]
    const titles = matrixAxisTitleLayers({ bounds: [x0, y0, x1, y1], axisTitles, typography, idPrefix: 'viz-heatmap' })
    return titles.length > 0 ? [...layers, ...titles] : layers
  }, [layers, window, nRows, nCols, axisTitles, typography])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <ChartCanvas
        layers={titledLayers}
        bounds={fitBounds}
        controller={false}
        flipY
        testId="viz-heatmap-view"
        onHover={handleHeatmapHover}
      />
      {tip && resolvedFields && (
        <VizTooltip
          rows={resolveMatrixTooltip(resolvedFields, tip.row, tip.col).rows}
          x={tip.x}
          y={tip.y}
          theme={theme}
        />
      )}
    </div>
  )
}
