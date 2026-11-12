// GridDockLayer.tsx — SPLIT C (ITEM-17, DEC-18 / DEC-20).
//
// THE PER-PANE DOCK SURFACE LIVES HERE: the edit form, the plot-data table, the annotate-controls
// panel, the mask-review panel and the export dialog — each PORTALED into the host container its
// resolver returns for that pane, or STACKED in the grid's internal right panel. With them come the
// three large inline builders the shell used to run on every render (`buildEditForm`,
// `buildExportDialog`, `buildPlotDataTable`), the portal/internal partition and the two dock loops.
//
// ── The acceptance criterion is INV-8, not an element count ──────────────────────────────────────
// "every pane-attached editing surface is keyed by a `Set<paneId>`, may be open on SEVERAL panes
// simultaneously, each open instance is independently operable, and its HOST CONTAINER RESOLVER IS
// CALLED ONCE PER OPEN PANE." That is the property this file must not lose, and it is why every
// surface below is a LOOP over an open set with the resolver invoked inside it — never a single
// resolver call against a hidden "active pane", which is the defect this design exists to prevent.
// The loops themselves (`resolveAnnotateDocks` / `resolveMaskDocks`) are unchanged pure functions
// with their own node-tier tests; this split relocates their CALLER, not their contract.
//
// ── What crosses the boundary, and in which direction ────────────────────────────────────────────
// DOWN, as explicit props: the five open sets (`editCellIds`/`dataTableCellIds`/`annotateOpenIds`/
// `segmentOpenIds` + `maskReview`), the host resolvers, the cell/geometry inputs the builders read,
// and the shell-owned mutators each dock calls back into. None of these changes per frame — after
// Split A the shell does not re-render on a camera move at all, so this layer does not either.
//
// UP, through ONE ref handle — never as a context value (DEC-20):
//   * `apiRef.current` — `{ openExportCell, openExportGrid, closeExport }`. `exportTarget` is the one
//     piece of state this split MOVES, because it is the only one of ITEM-17's six whose every read
//     is in this file. Its openers, though, are rendered by the shell (a pane toolbar's Export
//     button, and the tool rail's whole-grid Export), so they reach the state the same way Split B's
//     four draft-reset sites reach the drafts: through a stable wrapper over this handle.
//
// ── What did NOT move, against ITEM-17's written list (re-derivation, 2026-07-29) ────────────────
// ITEM-17 names six open-set states. FIVE stay in the shell, and the criterion is DRIFT-9's — "named
// in the move list" is not the test; "read only by this layer" is. Each has at least one read this
// file cannot serve:
//   * `editCellIds`       — `editOpen` on `<CellView>` (pane chrome, Split D's region).
//   * `dataTableCellIds`  — `dataOpen` on `<CellView>`, AND `wantsCameraEpochRef` (DRIFT-11: the
//                           shell re-subscribes to the camera only while a table is open).
//   * `annotateOpenIds`   — `annotateMode` gates the deck layer, the overlay layer and the pointer
//                           path; `annotateOpenIdsRef` is read at gesture time; `annotateOpen` on
//                           `<CellView>`; and the set itself is a prop of `<GridOverlayLayer>`.
//   * `segmentOpenIds`    — `segmentMode` gates the same surfaces; `segmentOpen` on `<CellView>`.
//   * `maskReview`        — the LABEL-MASK LAYER builder reads it (hide/solo/LUT feed the deck), and
//                           ~15 shell-resident mask handlers write it through `patchMaskReview`.
// Moving any of those here would force a reactive up-flow to the shell on every dock interaction —
// the same component with more files, which is what DEC-21 rejects option (b) for. They stay in the
// shell and cross DOWN; Split D/E revisits them once `<CellView>` has left the shell too.
//
// The export dialog's camera read is the other thing this file must not regress: `getVectorScene`
// reads `seam.viewStateRef.current[cellId]` (Split A / DRIFT-8's THIRTEENTH camera read). It is
// resolved at EXPORT time inside a lazy closure, which is strictly fresher than the render-time
// capture it replaced. It must never become a render-time read of a camera value.

import React, { Fragment, memo, useCallback, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { createPortal } from 'react-dom'
import type { PaneRect } from '../layers/multiView'
import { unprojectInCell } from './gridSelection'
import {
  EMPTY_HIDDEN,
  cellTestId,
  filterLegendEntries,
  hiddenGroupSet,
  paneTestId,
  type GridCell,
  type LabelMaskData,
} from './gridModel'
import { PANE_TOOLBAR_H } from './CellView'
import { PlotDataTable } from './PlotDataTable'
import { InternalDockSection } from './InternalDockSection'
import { PaneEditForm } from '../controls/PaneEditForm'
import { resolveLegendCorner, DEFAULT_LEGEND_CORNER } from '../controls/legendRender'
import { resolveTextStyle } from '../controls/typography'
import { ExportDialog } from '../export/ExportDialog'
import { buildFigureManifest, type FigureManifest } from '../export/manifest'
import { gridDividerMarks } from '../export/gridDividerMarks'
import { scatterToVectorScene } from '../export/scatterVector'
import { chartLayersToVectorScene } from '../export/chartVector'
import { cropCanvasToRect, type Rect } from '../export/cropCanvas'
import type { LegendExportSpec } from '../export/legendMarks'
import { QUALITATIVE_PALETTES, displayCategory } from '../data/color'
import { AnnotateProvider } from '../annotate/AnnotateContext'
import { AnnotateControls } from '../annotate/AnnotateControls'
import { AnnotateHierarchyPanel } from '../annotate/AnnotateHierarchyPanel'
import { resolveAnnotateDocks } from '../annotate/annotateDock'
import { resolveMaskDocks, emptyMaskReview, type MaskCellReview } from '../annotate/maskDock'
import { MaskReviewControls } from '../annotate/MaskReviewControls'
import { deriveMaskCategories } from '../spatial/buildLabelMaskLayers'
import type { RasterChannelState } from '../spatial/rasterImageLayers'
import type { AnnotateStore } from '../annotate/Annotate.store'
import type { AnnotateEditorApi } from '../annotate/useAnnotateEditor'
import type { MaskCorrectController } from '../annotate/maskCorrectController'
import type { SharedLabelMask } from '../annotate/sharedMask'
import type { SharedMaskController } from '../annotate/sharedMaskController'
import type { GeoFeature } from '../annotate/processorPort'
import type { ChartContribution } from './chartLayerSink'
import type { CellLegend, PlotColorData } from '../../adapter/CellDisplay.store'
import { overridesForColumn } from '../../adapter/colorOverride.store'
import type { ColumnColorOverride } from '../../adapter/colorOverride.store'
import { defaultCellSeed } from '../rng'
import { useGridWorkspaceSeam, type CellDataResolved } from './GridWorkspaceContext'

/** ITEM-6: the @txresbench/viz version stamped into a figure's provenance manifest. */
const VIZ_VERSION = 'txresbench-viz/1'

/** Slug a plot title into a safe filename stem (lowercase, hyphenated); empty ⇒ 'export'. */
function slugifyFilename(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'export'
}

// Shared style for the in-grid mask-dock action buttons (Share/Unshare, Apply-to-group). The mask
// family styles inline by convention (MaskReviewControls); use semantic tokens (never a raw hue) so it
// reads as a real affordance in light + dark instead of a default browser button.
const maskDockBtnStyle: React.CSSProperties = {
  border: '1px solid var(--border)',
  background: 'var(--secondary)',
  color: 'var(--secondary-foreground)',
  borderRadius: 6,
  padding: '2px 8px',
  fontSize: 12,
  cursor: 'pointer',
}

/** The resolved image pyramid a pane's Channels section edits. Structural on purpose — this layer
 *  reads only the display fields, so the shell keeps the loader-carrying declaration. */
export interface DockPyramidEntry {
  channels: RasterChannelState[]
  colormap?: string
  contrastMax: number
}

// SPLIT M (ITEM-29): `GridDockApi` moved to the neutral `gridModel.ts`. Its `dockApiRef` owner is now
// `useGridWindows.ts`, and a HOOK MAY NOT IMPORT A LAYER (INV-10 (d), DRIFT-43) — the same rule and
// the same remedy Split I applied to `GridOverlayApi`. This layer still DEFINES the behaviour behind
// the handle; only the type declaration moved, and it is re-exported below so existing importers of
// `./GridDockLayer` are unaffected.
import type { GridDockApi } from './gridModel'
export type { GridDockApi }

export interface GridDockLayerProps {
  // ── mount gate + the upward handle ─────────────────────────────────────────────────────────────
  /** Popup containers render no docks — every dock belongs to the PRIMARY workspace. A prop, not a
   *  conditional mount, because this layer owns `exportTarget` (Split A/B's rule). */
  readonly isPrimaryContainer: boolean
  readonly apiRef: React.RefObject<GridDockApi | null>
  /** The workspace container element — the export dialog resolves the deck canvas + pane rect + grid
   *  dividers off it at EXPORT time (a `useRef` object, so stable). */
  readonly containerRef: React.RefObject<HTMLDivElement | null>

  // ── the host dock resolvers (INV-8: each is called ONCE PER OPEN PANE) ─────────────────────────
  readonly editFormContainer?: (paneId: string) => HTMLElement | null | undefined
  readonly exportDialogContainer?: (paneId: string) => HTMLElement | null | undefined
  readonly dataTableContainer?: (paneId: string) => HTMLElement | null | undefined
  readonly annotateControlsContainer?: (paneId: string) => HTMLElement | null | undefined
  readonly maskControlsContainer?: (paneId: string) => HTMLElement | null | undefined

  // ── cells + geometry the builders read ────────────────────────────────────────────────────────
  readonly cells: readonly GridCell[]
  readonly cellMap: Record<string, GridCell>
  readonly denseCells: readonly GridCell[]
  readonly denseIds: ReadonlySet<string>
  readonly rects: readonly PaneRect[]
  readonly insetPane: (r: PaneRect) => PaneRect
  readonly legendGutterFor: (cell: GridCell | undefined) => { w: number; side: 'left' | 'right' } | null
  readonly cellToolbarsOn: boolean
  readonly radius: number
  readonly cellData: (cell: GridCell) => CellDataResolved
  readonly chartContribs: ReadonlyMap<string, ChartContribution>

  // ── the EDIT FORM dock ────────────────────────────────────────────────────────────────────────
  readonly closeEditCell: (id: string) => void
  readonly legendForCell: (id: string) => CellLegend | undefined
  readonly perCellLegend: Record<string, CellLegend>
  readonly valueLegends: Record<string, CellLegend>
  readonly perCellHiddenCodes: Record<string, ReadonlySet<number>>
  readonly perCellRange: Record<string, readonly [number, number]>
  readonly perCellColors: Record<string, { colors: Uint8Array } | undefined>
  readonly setCellRange: (id: string, range: readonly [number, number]) => void
  readonly imagePyramids: Record<string, DockPyramidEntry | 'loading' | null>
  readonly setImageChannel: (cellId: string, i: number, patch: Partial<RasterChannelState>) => void
  readonly setImageColormap: (cellId: string, colormap: string | undefined) => void
  readonly autoContrastChannel: (cellId: string, i: number) => void

  // ── the PLOT-DATA TABLE dock ──────────────────────────────────────────────────────────────────
  readonly closeDataTable: (id: string) => void
  readonly publishChartHover: (cellId: string, index: number | null) => void
  readonly perCellColorData: Record<string, PlotColorData>
  readonly perCellPlotRows: Record<string, { columns: string[]; rows: (string | number)[][]; pointIndices?: number[] }>
  readonly colorOverrides: Record<string, ColumnColorOverride>
  /** DRIFT-11: the shell's camera-commit counter, bumped ONLY while ≥1 table is open. It is not read
   *  in the table body (that reads the live camera off `viewStateRef`) — it is the SIGNAL that the
   *  camera moved, so the visible-window row set is recomputed. */
  readonly cameraEpoch: number

  // ── the ANNOTATE-CONTROLS dock (ONE PER OPEN PANE — INV-8) ────────────────────────────────────
  readonly annotateMode: boolean
  readonly annotateCellIds: readonly string[]
  readonly annotateStoreFor: (id: string | null) => AnnotateStore | undefined
  readonly boundAnnotateCellId: string | null
  readonly closeAnnotateCell: (id: string) => void
  readonly annotateEditor: AnnotateEditorApi
  readonly onAnnotateExportSeeds?: (paneId: string, features: GeoFeature[]) => void

  // ── the MASK-REVIEW dock (ONE PER OPEN PANE — INV-8) ──────────────────────────────────────────
  readonly segmentMode: boolean
  readonly segmentCellIds: readonly string[]
  readonly patchMaskReview: (cellId: string, fn: (r: MaskCellReview) => MaskCellReview) => void
  readonly closeSegmentCell: (id: string) => void
  readonly ensureMaskSession: (cellId: string) => { controller: MaskCorrectController; data: LabelMaskData } | null
  readonly resolvedLabelMask: (cell: GridCell) => LabelMaskData | null
  readonly sharedSessionForCell: (cellId: string) => { mask: SharedLabelMask; controller: SharedMaskController } | null
  readonly cellLinkGroup: Record<string, string>
  readonly linkGroups: Record<string, string[]>
  readonly maskShareNotice: string | null
  readonly shareMaskAcrossGroup: (groupId: string) => void
  readonly detachSharedMask: (groupId: string) => void
  readonly applyDisplayToGroup: (sourceCellId: string) => void
  readonly bumpMask: () => void
}

function GridDockLayerImpl({
  isPrimaryContainer,
  apiRef,
  containerRef,
  editFormContainer,
  exportDialogContainer,
  dataTableContainer,
  annotateControlsContainer,
  maskControlsContainer,
  cells,
  cellMap,
  denseCells,
  denseIds,
  rects,
  insetPane,
  legendGutterFor,
  cellToolbarsOn,
  radius,
  cellData,
  chartContribs,
  closeEditCell,
  legendForCell,
  perCellLegend,
  valueLegends,
  perCellHiddenCodes,
  perCellRange,
  perCellColors,
  setCellRange,
  imagePyramids,
  setImageChannel,
  setImageColormap,
  autoContrastChannel,
  closeDataTable,
  publishChartHover,
  perCellColorData,
  perCellPlotRows,
  colorOverrides,
  cameraEpoch,
  annotateMode,
  annotateCellIds,
  annotateStoreFor,
  boundAnnotateCellId,
  closeAnnotateCell,
  annotateEditor,
  onAnnotateExportSeeds,
  segmentMode,
  segmentCellIds,
  patchMaskReview,
  closeSegmentCell,
  ensureMaskSession,
  resolvedLabelMask,
  sharedSessionForCell,
  cellLinkGroup,
  linkGroups,
  maskShareNotice,
  shareMaskAcrossGroup,
  detachSharedMask,
  applyDisplayToGroup,
  bumpMask,
}: GridDockLayerProps) {
  const {
    stores,
    storesRef,
    cellDisplay,
    viewStateRef,
    cellDataRef,
    cellSelectionSpaceRef,
    activeCellRef,
    paneDocks,
  } = useGridWorkspaceSeam()

  // SPLIT D (ITEM-15): the four open sets + the mask-review record are read off the per-workspace
  // `paneDocks` store rather than taken as props. DRIFT-20 recorded them as pinned at Split C
  // precisely because each is read by two or three of {pane chrome, this layer, the overlay, the
  // shell} — and INV-10 (d) forbids a layer from importing another layer's private module, so the
  // shared home had to be a store both sides already reach through the seam (DEC-21 option (a)).
  // These are whole-record reads on purpose: every one of them is iterated by a per-pane dock loop
  // here, so this layer genuinely re-renders when the set changes. The per-CELL narrowing that this
  // store buys lands in `GridPaneCell`, which subscribes to a boolean.
  const editCellIds = useStore(paneDocks, s => s.editCellIds)
  const dataTableCellIds = useStore(paneDocks, s => s.dataTableCellIds)
  const annotateOpenIds = useStore(paneDocks, s => s.annotateOpenIds)
  const segmentOpenIds = useStore(paneDocks, s => s.segmentOpenIds)
  const maskReview = useStore(paneDocks, s => s.maskReview)

  // SPLIT C — the ONE state this split moves. `cellId=null` ⇒ whole-grid export. One at a time (an
  // export is a one-off action); portaled via `exportDialogContainer` or the internal right panel.
  // Only used when the legacy host `onRequestExport*` callbacks are NOT supplied.
  const [exportTarget, setExportTarget] = useState<{ cellId: string | null } | null>(null)
  const openExportCell = useCallback(
    (cellId: string) => {
      // The pane an export was requested from becomes the active cell, exactly as before the split —
      // `activeCellRef` is a seam ref (a `useRef` object), so this is the same write at the same moment.
      activeCellRef.current = cellId
      setExportTarget({ cellId })
    },
    [activeCellRef],
  )
  const openExportGrid = useCallback(() => setExportTarget({ cellId: null }), [])
  const closeExport = useCallback(() => setExportTarget(null), [])
  // THE UPWARD HANDLE. Assigned during render (Split A/B's idiom): the shell's openers are
  // event-time callers, so they always observe this commit's closure.
  const api = useMemo<GridDockApi>(
    () => ({ openExportCell, openExportGrid, closeExport }),
    [openExportCell, openExportGrid, closeExport],
  )
  apiRef.current = api

  // Build the "plotting data" table for a pane's data-table overlay. Dense scatter: one row per point
  // (x, y in world coords) that is VISIBLE in the pane's current view window — pan/zoom OUT-of-view
  // points are excluded from BOTH the table and its CSV. Non-dense charts compute their plotted data
  // inside their own View (not reachable here), so they render the rows the View published.
  const buildPlotDataTable = useCallback(
    (cell: GridCell, rect: PaneRect): { columns: string[]; rows: (string | number)[][]; pointIndices?: number[] } => {
      // NON-DENSE (box/violin/bar/dotplot/heatmap): render the rows the chart View published via
      // `onPlotData` (raw per-point rows for box/violin; per-cell rows for matrix). Not yet published ⇒
      // a loading note. `pointIndices` (when the View published them) drives the hover→highlight channel.
      if (!denseIds.has(cell.id)) {
        const pub = perCellPlotRows[cell.id]
        if (pub) return { columns: pub.columns, rows: pub.rows, pointIndices: pub.pointIndices }
        return { columns: ['info'], rows: [['Preparing plot data…']] }
      }
      const cd = cellData(cell)
      const vs = viewStateRef.current[cell.id]
      // DENSE scatter: x, y, and the COLOR column (category name / continuous value) so the table holds
      // the plotted VALUE, not just the axes. Column data is resident from the recolor effect.
      const color = perCellColorData[cell.id]
      const colColumn = color ? [color.column] : []
      const catLabels = color?.categorical ? overridesForColumn(colorOverrides, color.column)?.categoryLabels : undefined
      const colValueAt = (i: number): string | number | null => {
        if (!color) return null
        if (color.categorical) {
          const code = color.codes?.[i]
          if (code === undefined) return null
          const raw = color.categories?.[code]
          return raw === undefined ? code : displayCategory(raw, catLabels)
        }
        const v = color.values?.[i]
        return v === undefined ? null : Math.round(v * 1000) / 1000
      }
      const columns = ['x', 'y', ...colColumn]
      if (!vs || cd.positions.length === 0) return { columns, rows: [], pointIndices: [] }
      const ir = insetPane(rect)
      const c0 = unprojectInCell(ir, vs, ir.x, ir.y)
      const c1 = unprojectInCell(ir, vs, ir.x + ir.width, ir.y + ir.height)
      if (!c0 || !c1) return { columns, rows: [], pointIndices: [] }
      const minX = Math.min(c0[0], c1[0])
      const maxX = Math.max(c0[0], c1[0])
      const minY = Math.min(c0[1], c1[1])
      const maxY = Math.max(c0[1], c1[1])
      const round = (v: number) => Math.round(v * 1000) / 1000
      const rows: (string | number)[][] = []
      // Carry each visible row's ORIGINAL point index so hovering a row highlights that exact point.
      const pointIndices: number[] = []
      for (let i = 0; i < cd.nPoints; i++) {
        const x = cd.positions[i * 2]
        const y = cd.positions[i * 2 + 1]
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
          const row: (string | number)[] = [round(x), round(y)]
          if (color) row.push(colValueAt(i) ?? '')
          rows.push(row)
          pointIndices.push(i)
        }
      }
      return { columns, rows, pointIndices }
    },
    // `cameraEpoch` is not READ in the body — the body reads the live camera off `viewStateRef` —
    // but it IS a real dependency: it is the signal that the camera moved, and listing it is what
    // makes the "table follows the camera" contract visible instead of implicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [denseIds, cellData, insetPane, perCellColorData, perCellPlotRows, colorOverrides, cameraEpoch],
  )

  // Shell redesign: build the EDIT FORM for one pane. Every edit writes through the SAME stores the
  // WYSIWYG plot reads, so the plot updates live. Multiple panes may be open at once (each portaled into
  // its own host-resolved container, or stacked in the internal right panel). Returns null for a
  // now-removed cell (a layout change while its form was open).
  const buildEditForm = (id: string, hosted: boolean): React.ReactElement | null => {
    const cell = cellMap[id]
    if (!cell) return null
    // Dense cells carry a `perCellLegend`; grouped charts (box/violin/…) carry a `perCellGroupLegend`.
    // Either drives the form's Legend title + Categories (per-group recolor/rename) sections.
    const legend = legendForCell(id)
    // Dense cells hide categories via colorBy.hidden; grouped cells hide GROUPS via cell.hiddenGroups
    // (shared with the on-plot legend → the form's per-group toggles stay in lockstep with a swatch click).
    const isDenseForm = !!perCellLegend[id]
    // A matrix chart's continuous VALUE legend: the colormap is editable (Color section) but there's no
    // value-range FILTER for matrix charts, so we withhold `domain` from the form → the Range section
    // (gated on domain) stays hidden while the colormap picker (gated on colormap) shows.
    const isMatrixValueLegend = !perCellLegend[id] && !!valueLegends[id]
    // ITEM-2: a resolved image pyramid drives the pane form's Channels section (per-channel visible /
    // color / contrast + colormap + auto-contrast), wired to the live per-cell channel state.
    const pyr = imagePyramids[id]
    const pyrEntry = pyr && pyr !== 'loading' ? pyr : null
    return (
      <PaneEditForm
        key={`edit-${id}`}
        // TWO IDS, and they are not interchangeable (`gridModel.cellTestId`). What a reader
        // addresses is the pane the DECLARATION named; what must be unique in the DOCUMENT — the
        // form's `htmlFor`/`id` label wiring, with N forms open at once (INV-8) — is the grid's own
        // key. `id` stays the key for every store call below, because that is what the stores are
        // keyed by; resolving it here would re-point the writes at an id no store holds.
        paneId={cellTestId(cell)}
        domIdScope={id}
        hosted={hosted}
        hasChannels={cell.kind === 'image' && !!pyrEntry}
        channels={pyrEntry?.channels}
        contrastMax={pyrEntry?.contrastMax}
        channelColormap={pyrEntry?.colormap}
        onSetChannel={(i, patch) => setImageChannel(id, i, patch)}
        onSetChannelColormap={c => setImageColormap(id, c)}
        onAutoContrast={i => autoContrastChannel(id, i)}
        plotTitle={cell.title ?? ''}
        axisX={cell.axisTitles?.x ?? ''}
        axisY={cell.axisTitles?.y ?? ''}
        legendTitle={cell.legendTitle ?? ''}
        legendTitlePlaceholder={legend?.columnId ?? legend?.title}
        hasLegend={!!legend}
        showLegend={cell.showLegend ?? true}
        legendCorner={cell.legendCorner ?? DEFAULT_LEGEND_CORNER}
        legendBeside={cell.legendBeside ?? false}
        hasGrid={['box', 'violin', 'bar', 'histogram', 'volcano'].includes(cell.kind)}
        showGrid={cell.showGrid ?? true}
        categoryEntries={legend?.descriptor.kind === 'categorical' ? legend.descriptor.entries : undefined}
        categoryNames={legend?.rawLabels}
        hidden={(isDenseForm ? perCellHiddenCodes[id] : hiddenGroupSet(cellMap[id]?.hiddenGroups)) ?? EMPTY_HIDDEN}
        colormap={legend?.descriptor.kind === 'continuous' ? (legend.colormap ?? legend.descriptor.colormap) : undefined}
        domain={isMatrixValueLegend ? undefined : (legend?.domain ?? (legend?.descriptor.kind === 'continuous' ? legend.descriptor.domain : undefined))}
        range={perCellRange[id]}
        showMarks={denseIds.has(id)}
        radius={cell.style?.radius ?? radius}
        opacity={cell.style?.opacity ?? 1}
        onClose={() => closeEditCell(id)}
        typography={cell.typography ?? {}}
        onSetPlotTitle={v => stores.gridWorkspace.getState().setCellTitles(id, { title: v })}
        onSetAxisTitle={(axis, v) => stores.gridWorkspace.getState().setCellTitles(id, { [axis]: v })}
        onSetLegendTitle={v => stores.gridWorkspace.getState().setCellTitles(id, { legendTitle: v })}
        onSetShowLegend={v => stores.gridWorkspace.getState().setCellShowLegend(id, v)}
        onSetLegendCorner={c => stores.gridWorkspace.getState().setCellLegendCorner(id, c)}
        onSetLegendBeside={b => stores.gridWorkspace.getState().setCellLegendBeside(id, b)}
        onSetShowGrid={v => stores.gridWorkspace.getState().setCellShowGrid(id, v)}
        onSetTypography={patch => stores.gridWorkspace.getState().setCellTypography(id, patch)}
        onSetColormap={c => {
          const cb = cellMap[id]?.colorBy
          if (cb) stores.gridWorkspace.getState().setCellColorBy(id, { ...cb, colormap: c })
          else if (isMatrixValueLegend) stores.gridWorkspace.getState().setCellValueColormap(id, c)
        }}
        onSetRadius={v => stores.gridWorkspace.getState().setCellStyle(id, { radius: v })}
        onSetOpacity={v => stores.gridWorkspace.getState().setCellStyle(id, { opacity: v })}
        onSetCategoryColor={(name, hex) => {
          if (legend?.columnId) stores.colorOverride.getState().setCategoryColor(legend.columnId, name, hex)
        }}
        onSetCategoryLabel={(name, label) => {
          if (legend?.columnId) stores.colorOverride.getState().setCategoryLabel(legend.columnId, name, label)
        }}
        onSetPalette={paletteName => {
          if (legend?.columnId) stores.colorOverride.getState().setColumnPalette(legend.columnId, QUALITATIVE_PALETTES[paletteName])
        }}
        onToggleCategory={code => {
          if (isDenseForm) {
            const next = new Set(perCellHiddenCodes[id] ?? EMPTY_HIDDEN)
            next.has(code) ? next.delete(code) : next.add(code)
            cellDisplay.getState().setHiddenCodes(id, next)
            const cb = cellMap[id]?.colorBy
            if (cb) stores.gridWorkspace.getState().setCellColorBy(id, { ...cb, hidden: next })
          } else {
            // Grouped: toggle the code in cell.hiddenGroups (→ collapse + syncs the on-plot legend).
            const next = new Set(cellMap[id]?.hiddenGroups ?? [])
            next.has(code) ? next.delete(code) : next.add(code)
            stores.gridWorkspace.getState().setCellHiddenGroups(id, [...next])
          }
        }}
        legendHidden={hiddenGroupSet(cellMap[id]?.legendHiddenCodes) ?? EMPTY_HIDDEN}
        onToggleLegendHidden={code => {
          // Toggle a code in cell.legendHiddenCodes — removes it from the legend list (marks stay).
          const next = new Set(cellMap[id]?.legendHiddenCodes ?? [])
          next.has(code) ? next.delete(code) : next.add(code)
          stores.gridWorkspace.getState().setCellLegendHiddenCodes(id, [...next])
        }}
        onSetRange={range => setCellRange(id, range)}
        legendUseRange={cellMap[id]?.legendUseRange ?? false}
        onSetLegendUseRange={on => stores.gridWorkspace.getState().setCellLegendUseRange(id, on)}
        linkColorScale={cellMap[id]?.linkColorScale ?? false}
        onToggleLinkColorScale={() => stores.gridWorkspace.getState().toggleCellLinkColorScale(id)}
        // Compare (shared color scale) is a no-op for matrix cells (heatmap/dotplot) — their colormap is
        // the intrinsic matrix value scale, not a share-able colorBy scale — and for kinds that opt out
        // of the shared-domain join (`linkableColorScale: false`). Hide the toggle there.
        compareApplicable={!isMatrixValueLegend && cellMap[id]?.linkableColorScale !== false}
      />
    )
  }
  // Build the GridWorkspace-OWNED export dialog for a target (self-resolves the deck canvas / pane rect /
  // legend / grid dividers, so no host wiring is needed — the export twin of buildEditForm).
  const buildExportDialog = (target: { cellId: string | null }): React.ReactElement => {
    const cellId = target.cellId
    const getDeckCanvas = (): HTMLCanvasElement | null => containerRef.current?.querySelector('canvas') ?? null
    const getPaneRect = (): Rect | null => {
      if (!cellId) return null // grid scope → whole canvas, no crop
      const root = containerRef.current
      const canvas = getDeckCanvas()
      if (!root || !canvas) return null
      const esc = typeof CSS !== 'undefined' ? CSS.escape(cellId) : cellId
      const pane = root.querySelector(`[data-viz-cell="${esc}"]`)
      if (!pane) return null
      const cb = canvas.getBoundingClientRect()
      const pb = (pane as HTMLElement).getBoundingClientRect()
      return { x: pb.left - cb.left, y: pb.top - cb.top, width: pb.width, height: pb.height }
    }
    const getLegend = (): LegendExportSpec | null => {
      if (!cellId) return null
      if (!(cellMap[cellId]?.showLegend ?? true)) return null // hidden on screen ⇒ hidden in export (WYSIWYG)
      const lg = legendForCell(cellId)
      if (!lg) return null
      const rng = perCellRange[cellId]
      const dom = lg.domain ?? (lg.descriptor.kind === 'continuous' ? lg.descriptor.domain : undefined)
      // `legendUseRange` ⇒ the exported visual-map uses the range AS the full domain (no sub-band); else
      // a custom range shows as a band inside the full domain.
      const useRange = (cellMap[cellId]?.legendUseRange ?? false) && !!rng
      const strictRange = !useRange && rng && dom && (rng[0] > dom[0] || rng[1] < dom[1]) ? rng : undefined
      const hiddenSet = perCellHiddenCodes[cellId]
      const hidden = hiddenSet && hiddenSet.size > 0 ? [...hiddenSet] : undefined
      // Same typography-derived legend font the on-screen InCellLegend uses → WYSIWYG export.
      const legStyle = resolveTextStyle(cellMap[cellId]?.typography, 'legend')
      const font = { titleSize: legStyle.size + 1, labelSize: legStyle.size, family: legStyle.family }
      // WYSIWYG: drop LEGEND-hidden entries from the exported legend list too (their marks still render).
      const legendHidden = cellMap[cellId]?.legendHiddenCodes
      let descriptor = lg.descriptor
      if (descriptor.kind === 'categorical' && legendHidden && legendHidden.length > 0) {
        descriptor = { ...descriptor, entries: filterLegendEntries(descriptor.entries, legendHidden) }
      } else if (descriptor.kind === 'continuous' && useRange && rng) {
        descriptor = { ...descriptor, domain: rng as [number, number] }
      }
      // Mirror the legend to the plot-facing side (label toward the plot) — same corner the on-screen
      // legend uses, so the exported legend matches (WYSIWYG).
      const swatchSide = resolveLegendCorner(cellMap[cellId]?.legendCorner ?? DEFAULT_LEGEND_CORNER).swatchSide
      // The per-cell provenance marker rides into the EXPORTED legend, which is the whole reason
      // the legend is the load-bearing leg: the chrome badge is cropped by a screenshot and the
      // legend is not, so a figure that leaves the app carries whether its colouring rested on an
      // unverified assumption.
      return {
        descriptor,
        title: cellMap[cellId]?.legendTitle ?? lg.title,
        range: strictRange,
        hidden,
        font,
        swatchSide,
        ...(cellMap[cellId]?.provenanceNote !== undefined ? { note: cellMap[cellId]?.provenanceNote } : {}),
      }
    }
    // ITEM-6: the figure PROVENANCE MANIFEST — assembled from the cell's live encoding + filter state so a
    // bundle export carries how the figure was made (dataset, colorBy, range, hidden groups, link filters,
    // RNG seed, version). Resolved at export time.
    const getManifest = (): FigureManifest | null => {
      if (!cellId) return null
      const cell = cellMap[cellId]
      if (!cell) return null
      const cb = cell.colorBy
      // M10 / ITEM-17 — carry the SELECTION PROVENANCE into the manifest so an exported figure
      // records HOW its selection was made, not just its outcome. The field existed and its output
      // branch was unreachable because this, the only call site, never populated it. Omitted
      // entirely when there is no provenance, so a figure without a selection is byte-identical.
      // CONV-7 — filter to the ops that can actually EXPLAIN this cell. `selectionProvenance` is the
      // WORKSPACE-WIDE list, but `getManifest` describes ONE exported cell, so recording the whole
      // list attaches a recipe that may belong entirely to other panes — and in a multi-dataset grid
      // to another IDENTITY SPACE, where a spaceB pane's ops demonstrably cannot re-derive this
      // cell's ids. Keep the ops for THIS cell's space (a region lives in exactly one space, DEC-2),
      // which is what a reader of the exported figure can replay against it.
      const wsProv = storesRef.current.coordination.getState().selectionProvenance
      const cellSpace = cellSelectionSpaceRef.current(cell, cellDataRef.current(cell).pointIds != null)
      const ownOps = wsProv?.ops.filter(o => o.space === cellSpace) ?? []
      const selProv = ownOps.length > 0 ? { ops: ownOps, context: wsProv?.context } : null
      return buildFigureManifest({
        cellId,
        kind: cell.kind,
        datasetId: cell.datasetId ?? null,
        colorBy: cb ? { mode: cb.mode, key: cb.key, colormap: (cb as { colormap?: string }).colormap, scale: (cb as { scale?: string }).scale } : null,
        valueRange: perCellRange[cellId] ?? null,
        hiddenGroups: cell.hiddenGroups ?? [],
        linkValueFilters: cell.linkValueFilters ?? [],
        seed: defaultCellSeed(cellId),
        toolVersion: VIZ_VERSION,
        vizVersion: VIZ_VERSION,
        ...(selProv && selProv.ops.length > 0
          ? { selection: { ops: selProv.ops, ...(selProv.context ? { context: selProv.context } : {}) } }
          : {}),
      })
    }
    // TRUE VECTOR export (fixes blurry high-DPI raster): for a SCATTER pane, describe the plot as one
    // vector circle per point — resolution-independent, so SVG/PDF/EPS/high-DPI PNG stay razor-sharp at
    // any output size (the all-GPU deck only ever renders at screen density). Mirrors the layer loop's
    // per-cell fill resolution (perCellColors + value-range visualMap alpha mask) so it's WYSIWYG.
    // Returns null (→ raster crop fallback) for whole-grid scope, a non-scatter/empty cell, or a pane
    // denser than the vector cap. Resolved at export time.
    const getVectorScene = () => {
      if (!cellId) return null // whole-grid export stays raster (v1 targets a single scatter pane)
      const cell = denseCells.find(c => c.id === cellId)
      if (!cell) {
        // CHART cell (box/bar/histogram/volcano/violin/heatmap/dotplot) → vectorize its PUBLISHED deck
        // layers (frame lines + labels + polygon/scatter marks) via the generic converter; the heatmap
        // value grid + any over-cap scatter cloud fall back to a raster tile cropped from the live deck.
        const contrib = chartContribs.get(cellId)
        const full = getPaneRect()
        if (!contrib || !full) return null
        const plotH = cellToolbarsOn ? Math.max(1, full.height - PANE_TOOLBAR_H) : full.height
        const cGutter = legendGutterFor(cellMap[cellId])
        const cgW = cGutter ? Math.min(cGutter.w, Math.max(1, full.width - 48)) : 0
        const plotW = Math.max(1, full.width - cgW)
        const cOffsetX = cGutter?.side === 'left' ? cgW : 0
        const canvas = getDeckCanvas()
        const toolbarY = cellToolbarsOn ? PANE_TOOLBAR_H : 0
        const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
        // Crop the live deck canvas at a SCENE-space rect (scene x already carries the gutter offset, so
        // canvas-x = full.x + sceneX; canvas-y = full.y + toolbar + sceneY) → a data:PNG for a raster tile.
        const rasterize = (x: number, y: number, w: number, h: number): string | null => {
          if (!canvas || w <= 1 || h <= 1) return null
          try {
            return cropCanvasToRect(canvas, { x: full.x + x, y: full.y + toolbarY + y, width: w, height: h }, dpr).toDataURL('image/png')
          } catch {
            return null
          }
        }
        return chartLayersToVectorScene({
          layers: contrib.layers,
          viewState: contrib.viewState,
          width: plotW,
          height: plotH,
          flipY: !!contrib.view.flipY,
          offsetX: cOffsetX,
          sceneWidth: full.width,
          sceneHeight: plotH,
          rasterize,
        })
      }
      const cd = cellData(cell)
      if (cd.positions.length === 0) return null // image/bitmap dense cell (no points) → raster
      const full = getPaneRect()
      if (!full) return null
      // SPLIT A: a 13th camera consumer the plan's ITEM-5 anchor list did not enumerate — it read
      // `controlledViewState` directly rather than through `viewStateRef`. It is inside the export
      // dialog's LAZY `getScene` closure, invoked when the user exports, so reading the seam ref is
      // both correct and strictly fresher than the old render-time capture. SPLIT C moved this whole
      // builder into the dock layer and it MUST stay a lazy seam read here — a render-time camera read
      // would put the camera back into a component that renders chrome (INV-1).
      const vs = viewStateRef.current[cellId]
      if (!vs) return null
      // The deck view for a cell is INSET by the toolbar strip (see `insetPane`) — project against that
      // size, or the world→screen mapping (and thus every circle) is off by the toolbar height.
      const height = cellToolbarsOn ? Math.max(1, full.height - PANE_TOOLBAR_H) : full.height
      // Mirror GridWorkspace's scatter layer-loop fill resolution: per-cell recolor buffer + the CPU
      // value-range visualMap alpha mask (out-of-range → alpha 0, skipped in the vector scene).
      const perCell = perCellColors[cellId]
      const baseColors = perCell?.colors ?? cd.colors
      let colors = baseColors
      const vmLegend = perCellLegend[cellId]
      const vmRange = perCellRange[cellId]
      if (
        vmLegend?.values &&
        vmLegend.values.length >= cd.nPoints &&
        vmLegend.domain &&
        vmRange &&
        (vmRange[0] > vmLegend.domain[0] || vmRange[1] < vmLegend.domain[1])
      ) {
        const vals = vmLegend.values
        const lo = vmRange[0]
        const hi = vmRange[1]
        const masked = baseColors.slice()
        for (let i = 0; i < cd.nPoints; i++) {
          const v = vals[i]
          if (v < lo || v > hi) masked[i * 4 + 3] = 0
        }
        colors = masked
      }
      const cellRadius = cell.style?.radius ?? radius
      // BESIDE mode: the plot shrinks by a legend gutter (same as the on-screen deck view). Project into
      // the shrunk plot region and reserve the gutter in the scene so the exported legend sits in it —
      // WYSIWYG with the on-screen layout. Overlay mode ⇒ no gutter (plot uses the full width).
      const gutter = legendGutterFor(cellMap[cellId])
      const gW = gutter ? Math.min(gutter.w, Math.max(1, full.width - 48)) : 0
      const plotWidth = Math.max(1, full.width - gW)
      const offsetX = gutter?.side === 'left' ? gW : 0
      return scatterToVectorScene({
        positions: cd.positions,
        colors,
        nPoints: cd.nPoints,
        radius: cellRadius,
        width: plotWidth,
        height,
        viewState: vs,
        offsetX,
        sceneWidth: full.width,
        sceneHeight: height,
      })
    }
    const dprN = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    // Title shown in the header + used to PREFILL the filename: the pane's plot title (fallback its id),
    // or "Whole grid". The filename is a slug of that title.
    const readerId = cellId ? paneTestId(cellMap, cellId) : 'grid'
    const title = cellId ? (cellMap[cellId]?.title || readerId) : 'Whole grid'
    return (
      <ExportDialog
        // The React key and the CROP stay on the grid key — `getPaneRect` above resolves
        // `[data-viz-cell="<cellId>"]`, the invertible channel `PaneTree` keeps the store key on for
        // exactly this consumer. Only the dialog's DOM identity is the reader's id.
        key={`export-${cellId ?? 'grid'}`}
        cellId={readerId}
        canvas={getDeckCanvas}
        vectorScene={getVectorScene}
        paneRect={getPaneRect}
        legend={getLegend}
        legendCorner={cellId ? cellMap[cellId]?.legendCorner : undefined}
        legendBeside={cellId ? cellMap[cellId]?.legendBeside : undefined}
        gridDividers={() => gridDividerMarks(containerRef.current, getDeckCanvas(), dprN)}
        manifest={getManifest}
        dpr={dprN}
        initialScope={cellId ? 'pane' : 'grid'}
        showScopeSelector={false}
        title={title}
        filename={slugifyFilename(title)}
        onClose={closeExport}
      />
    )
  }
  // Partition the open forms: those the host gives a container for are PORTALED there (one per pane, so
  // the host can show several at once); the rest stack in the grid's internal right panel.
  const openIds = [...editCellIds]
  const portaled: Array<{ id: string; host: HTMLElement; el: React.ReactElement }> = []
  const internal: React.ReactElement[] = []
  for (const id of openIds) {
    // Resolve the HOST first: a portaled surface renders HEADERLESS, because the host draws that
    // pane's title + close in its own pane header. Two headers one row apart is the duplicate the
    // host-header decision removes — and hiding one with CSS would leave it in the a11y tree, so
    // this is a prop rather than a class.
    const host = editFormContainer?.(id) ?? null
    const el = buildEditForm(id, !!host)
    if (!el) continue
    if (host) portaled.push({ id, host, el })
    else internal.push(el)
  }
  // Export dialog partition (GridWorkspace-owned): portal into the host resolver's container, else stack
  // it in the internal right panel alongside any edit forms.
  const exportEl = exportTarget ? buildExportDialog(exportTarget) : null
  const exportHost = exportTarget ? exportDialogContainer?.(exportTarget.cellId ?? '__grid__') ?? null : null
  if (exportEl && !exportHost) internal.push(exportEl)
  // Plot-data TABLE partition — DOCKED exactly like the edit form: portal into the host resolver's
  // container when provided, else stack in the internal right panel (so SEVERAL tables coexist). Each
  // table is sortable + reports its hovered row's point index into the per-cell hover-highlight channel.
  const portaledData: Array<{ id: string; host: HTMLElement; el: React.ReactElement }> = []
  for (const id of dataTableCellIds) {
    const cell = cellMap[id]
    const rect = rects.find(r => r.id === id)
    if (!cell || !rect) continue
    const table = buildPlotDataTable(cell, rect)
    // Same as the edit form: portaled ⇒ the HOST owns the title + close, so the table's own
    // title/close chrome stands down (its row-count + CSV export are affordances, and stay).
    const host = dataTableContainer?.(id) ?? null
    const el = (
      <PlotDataTable
        key={`data-${id}`}
        hosted={!!host}
        title={cell.title || cell.kind}
        columns={table.columns}
        rows={table.rows}
        pointIndices={table.pointIndices}
        fileName={slugifyFilename(cell.title || cell.kind)}
        onClose={() => closeDataTable(id)}
        onHoverRow={pi => publishChartHover(id, pi)}
      />
    )
    if (host) portaledData.push({ id, host, el })
    else internal.push(el)
  }

  // ITEM-7/9/11 (INV-12): in `annotate` mode, DOCK **each OPEN pane's own** `AnnotateControls` (tool
  // rail + class/label panel) — this is where the user picks draw / point / brush / select and manages
  // that pane's classes. Mirrors the edit-form dock model EXACTLY, per pane: iterate the open set and
  // resolve `annotateControlsContainer(paneId)` ONCE PER PANE, portaling where the host provides a
  // container and stacking the rest in the internal right panel. Several panes are open at once —
  // they are different DATASETS, which is the whole premise.
  //
  // Each panel is wrapped in its OWN `AnnotateProvider` bound to that pane's store, so its tool,
  // class vocabulary, level, hierarchy tree, geometry and undo are per-pane with zero leakage
  // (INV-11 as amended by DEC-19). The live-editor affordances (`Finish (n)`) are shown only on the
  // pane the current gesture is bound to — a draft exists in exactly one pane at a time.
  const portaledAnnotate: Array<{ id: string; host: HTMLElement; el: React.ReactElement }> = []
  const annotateDocks = resolveAnnotateDocks({
    isPrimaryContainer,
    annotateMode,
    openCellIds: annotateCellIds.filter(id => annotateOpenIds.has(id)),
    container: annotateControlsContainer,
  })
  for (const dock of annotateDocks) {
    const paneId = dock.cellId
    // The dock loop holds a grid KEY (`resolveAnnotateDocks` iterates the open set), so the reader's
    // id is resolved through the cell map exactly once, here — `paneTestId`'s whole reason to exist.
    // `paneId` keeps every store call (`annotateStoreFor` / `closeAnnotateCell` / the export-seeds
    // callback) and every React `key`; `readerId` supplies every testid and announced name.
    const readerId = paneTestId(cellMap, paneId)
    const paneStore = annotateStoreFor(paneId)
    if (!paneStore) continue
    const isBound = boundAnnotateCellId === paneId
    const paneTitle = cellMap[paneId]?.title || readerId
    const el = (
      // N docks STACK here (INV-12), so each is an `InternalDockSection`: a bounded flex column whose
      // BODY owns the scroll. Before it, the dock was a bare `overflow: visible` div and the controls'
      // `h-full` shoved the hierarchy panel outside the box, painting it over the next pane's dock.
      <InternalDockSection
        key={`annotate-${paneId}`}
        testId={`viz-annotate-panel-${readerId}`}
        titleTestId={`viz-annotate-panel-title-${readerId}`}
        closeTestId={`viz-annotate-panel-close-${readerId}`}
        title={paneTitle}
        closeLabel={`Close annotate controls for ${paneTitle}`}
        onClose={() => closeAnnotateCell(paneId)}
      >
        <AnnotateProvider store={paneStore}>
          <AnnotateControls
            // Per-pane testid: with N panels open (INV-12) a single shared default would make every
            // DOM assertion ambiguous — and an ambiguous selector silently asserts the FIRST pane,
            // which is exactly the single-pane blind spot this feature exists to remove.
            data-testid={`annotate-controls-${readerId}`}
            // Content-sized, NOT `h-full`: the dock is one of N, so a full-height stretch would push
            // the hierarchy panel below out of the dock (see `AnnotateControlsProps.fill`).
            fill={false}
            // BLIND-AUDIT H4 (DEC-16): the 1-9 class hotkeys answer document-wide for the pane the
            // user is CLICKING IN — clicking the canvas to drop a point moves focus onto that pane's
            // draw overlay, so a focus-scoped-only binding was dead in the counting loop it exists
            // for. `isBound` is the same synchronous binding that routes the gesture, so exactly one
            // open dock is armed and it is the visible one taking the points.
            hotkeyActive={isBound}
            polyDraftLength={isBound ? annotateEditor.polyDraftLength : 0}
            onFinishPolygon={annotateEditor.finishPolygon}
            onCancelPolygon={annotateEditor.cancelDraft}
            onExportSeeds={
              onAnnotateExportSeeds
                ? features => onAnnotateExportSeeds(paneId, features)
                : undefined
            }
          />
          {/* ITEM-11: this pane's OWN object-hierarchy tree/level panel — two open panes each
              describe their own tree, because each rides its own store. */}
          <AnnotateHierarchyPanel paneId={readerId} />
        </AnnotateProvider>
      </InternalDockSection>
    )
    if (dock.kind === 'portal') portaledAnnotate.push({ id: paneId, host: dock.host, el })
    else internal.push(el)
  }

  // ITEM-8/9/12 (INV-12): in `segment` mode, DOCK **each OPEN pane's own** `MaskReviewControls`
  // (hide/solo + relabel/split/merge/brush) — LIVE against that pane's in-grid mask session. Same dock
  // model as the annotate/edit-form seams, per pane: `maskControlsContainer(paneId)` is resolved ONCE
  // PER OPEN PANE, portaling where the host provides a container and stacking the rest internally, so
  // two segment panes are reviewable side by side. The "Share mask across group" + "Apply contrast +
  // palette to group" actions (ITEM-12) now live on the pane's OWN panel rather than keying off a
  // hidden focused cell.
  const portaledMask: Array<{ id: string; host: HTMLElement; el: React.ReactElement }> = []
  const maskDocks = resolveMaskDocks({
    isPrimaryContainer,
    segmentMode,
    openCellIds: segmentCellIds.filter(id => segmentOpenIds.has(id)),
    container: maskControlsContainer,
  })
  for (const maskDock of maskDocks) {
    const cellId = maskDock.cellId
    // Same two identities as the annotate dock above: `cellId` is the grid key every store call and
    // every mask session is keyed by, `readerId` is what a reader addresses this panel by.
    const readerId = paneTestId(cellMap, cellId)
    const session = ensureMaskSession(cellId)
    const segCell = cells.find(c => c.id === cellId)
    const data = segCell ? resolvedLabelMask(segCell) : null
    if (session && data) {
      const rv = maskReview[cellId] ?? emptyMaskReview()
      // SHARED-MASK (Track A): this pane's undo/redo drives the ONE shared controller when its
      // group is shared, else the per-cell controller. `MaskReviewControls` is agnostic to which.
      const shared = sharedSessionForCell(cellId)
      const controller = shared ? shared.controller : session.controller
      // "Share mask across group" is offered only when THIS pane is in a link group with ≥2 segment
      // members (the explicit opt-in, ESC-3); when already shared, offer "Unshare".
      const groupId = cellLinkGroup[cellId]
      const groupSegmentCount = groupId
        ? (linkGroups[groupId] ?? []).filter(gid => {
            const gc = cells.find(x => x.id === gid)
            return gc?.segment && !!resolvedLabelMask(gc)
          }).length
        : 0
      const cats = rv.catsRef ?? data.categoryForId
      const categories = deriveMaskCategories(data, cats)
      const selectedCategory =
        rv.selectedId != null && rv.selectedId > 0 && rv.selectedId < cats.length ? cats[rv.selectedId] : null
      const segTitle = cellMap[cellId]?.title || readerId
      const el = (
        // Per-pane header + close (ITEM-8) — several panes' panels stack, so each must say which pane
        // it belongs to and be independently dismissible. Same bounded, self-scrolling shell as the
        // annotate dock: N segment docks share the internal panel by shrinking to a floor, then the
        // panel scrolls. Never a spill onto the neighbouring dock, never a clip.
        <InternalDockSection
          key={`mask-${cellId}`}
          testId={`viz-mask-panel-${readerId}`}
          titleTestId={`viz-mask-panel-title-${readerId}`}
          closeTestId={`viz-mask-panel-close-${readerId}`}
          title={segTitle}
          closeLabel={`Close segment controls for ${segTitle}`}
          onClose={() => closeSegmentCell(cellId)}
        >
          {/* Shared-mask attach/detach (Track A, ESC-3 explicit action) — only when THIS pane is in
              a link group with ≥2 segment members. */}
          {groupId && groupSegmentCount >= 2 && (
            <div style={{ padding: '8px 12px 0', fontSize: 12 }}>
              <button
                type="button"
                data-testid={`viz-mask-share-group-${readerId}`}
                aria-pressed={!!shared}
                onClick={() => (shared ? detachSharedMask(groupId) : shareMaskAcrossGroup(groupId))}
                style={maskDockBtnStyle}
              >
                {shared ? 'Unshare mask' : 'Share mask across group'}
              </button>
              {/* Track C (ITEM-14): propagate this cell's channels + palette to the rest of the link
                  group in one action (confirm-on-overwrite handled by `applyDisplayToGroup`). */}
              <button
                type="button"
                data-testid={`viz-apply-display-group-${readerId}`}
                style={{ ...maskDockBtnStyle, marginInlineStart: 8 }}
                onClick={() => applyDisplayToGroup(cellId)}
              >
                Apply contrast + palette to group
              </button>
              {maskShareNotice && (
                <div
                  role="alert"
                  data-testid={`viz-mask-share-notice-${readerId}`}
                  style={{ marginBlockStart: 6, color: 'var(--destructive)', fontSize: 11 }}
                >
                  {maskShareNotice}
                </div>
              )}
            </div>
          )}
          {/* Paint-target class picker — an in-grid composition (keeps `MaskReviewControls` unchanged) so
              relabel/brush have a target class. Absent target ⇒ relabel is a no-op, brush extends the
              selected label. */}
          <div style={{ padding: '8px 12px 0', fontSize: 12 }} data-testid={`viz-mask-target-picker-${readerId}`}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Paint as</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {categories.map(c => (
                <button
                  key={c.code}
                  type="button"
                  data-testid={`viz-mask-target-${readerId}-${c.code}`}
                  aria-pressed={rv.target === c.code}
                  onClick={() => patchMaskReview(cellId, cur => ({ ...cur, target: cur.target === c.code ? null : c.code }))}
                  style={{ fontWeight: rv.target === c.code ? 700 : 400 }}
                >
                  {c.label ?? `Class ${c.code}`}
                </button>
              ))}
            </div>
          </div>
          <MaskReviewControls
            categories={categories}
            hiddenCategories={rv.hidden}
            soloCategory={rv.solo}
            onToggleHidden={code =>
              patchMaskReview(cellId, cur => {
                const hidden = new Set(cur.hidden)
                if (hidden.has(code)) hidden.delete(code)
                else hidden.add(code)
                return { ...cur, hidden }
              })
            }
            onSolo={code => patchMaskReview(cellId, cur => ({ ...cur, solo: code }))}
            activeTool={rv.tool}
            onSelectTool={tool => patchMaskReview(cellId, cur => ({ ...cur, tool, mergeSource: null, splitSeeds: [] }))}
            selectedId={rv.selectedId}
            selectedCategory={selectedCategory}
            canUndo={controller.canUndo}
            canRedo={controller.canRedo}
            onUndo={() => {
              controller.undo()
              bumpMask()
            }}
            onRedo={() => {
              controller.redo()
              bumpMask()
            }}
          />
        </InternalDockSection>
      )
      if (maskDock.kind === 'portal') portaledMask.push({ id: cellId, host: maskDock.host, el })
      else internal.push(el)
    }
  }

  return (
    <>
      {/* Shell redesign: the per-pane EDIT FORM(s) — each portaled into the host container the resolver
          returned for that pane (so the host can show several at once), the rest stacked in the grid's
          internal right panel (occupies space; the plot area shrinks). Only on the primary container. */}
      {isPrimaryContainer &&
        portaled.map(({ id, host, el }) => (
          <Fragment key={`portal-${id}`}>{createPortal(el, host)}</Fragment>
        ))}
      {/* Plot-data tables the host gives a container for are portaled there; the rest stack in the
          internal panel (via `internal`). Same dock model as the edit forms. */}
      {isPrimaryContainer &&
        portaledData.map(({ id, host, el }) => (
          <Fragment key={`portal-data-${id}`}>{createPortal(el, host)}</Fragment>
        ))}
      {/* The focused cell's ANNOTATION class-panel, portaled into the host resolver's container when one
          was returned (else it sits in the internal panel below via `internal`). Same dock model as the
          edit forms. */}
      {isPrimaryContainer &&
        portaledAnnotate.map(({ id, host, el }) => (
          <Fragment key={`portal-annotate-${id}`}>{createPortal(el, host)}</Fragment>
        ))}
      {/* The focused cell's MASK review/correct panel (segmentation-scale ITEM-2), portaled into the host
          resolver's container when one was returned (else it sits in the internal panel via `internal`). */}
      {isPrimaryContainer &&
        portaledMask.map(({ id, host, el }) => (
          <Fragment key={`portal-mask-${id}`}>{createPortal(el, host)}</Fragment>
        ))}
      {/* GridWorkspace-owned EXPORT dialog, portaled into the host resolver's container (else it sits in
          the internal panel below via `internal`). */}
      {isPrimaryContainer && exportEl && exportHost && createPortal(exportEl, exportHost)}
      {/* Responsive (ITEM-7/8 UI checklist): the panel prefers 300px but MAY shrink — `flex:0 1 auto`
          + `maxWidth:60%` — so a narrow viewport (390px) keeps the grid visible instead of the fixed
          300px squeezing it to zero and pushing the body into horizontal scroll. Per-pane docking
          makes this load-bearing: several panels can stack here at once.
          Each stacked dock (`InternalDockSection`) is `flex:0 1 auto` + a min-height FLOOR, so the
          column distributes its height by the flexbox shrink rule — natural size while there is room,
          proportional shrink once there is not — and only once N × floor exceeds the panel does the
          panel itself scroll.
          The panel keeps `minWidth: 0` (ROOT 3): the grid's own min-content is ~293px, so ANY width
          floor here (even the dock's 224) pushes the BODY into horizontal scroll at 390px. The panel
          therefore stays shrinkable and `overflow: auto` — the DOCK holds its readable width
          (`INTERNAL_DOCK_MIN_WIDTH`) and the panel scrolls to it, rather than squeezing the dock's
          rail + class column into an unreadable sliver. */}
      {isPrimaryContainer && internal.length > 0 && (
        <div data-testid="viz-edit-panel" style={{ width: 300, maxWidth: '60%', flex: '0 1 auto', height: '100%', minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
          {internal}
        </div>
      )}
    </>
  )
}

/** `memo` so the shell's OWN re-renders skip this subtree when its props are unchanged. It does not
 *  affect the export path — `exportTarget` is this component's own state, so opening or closing the
 *  export dialog renders this component and only it.
 *
 *  HONEST NOTE on what the `memo` is worth TODAY: `annotateEditor` is a fresh object literal from
 *  `useAnnotateEditor` on every shell render, so the shallow compare currently fails on almost every
 *  shell render and this `memo` skips almost nothing. That is fine and it is not the split's claim —
 *  after Split A the shell does not re-render on a camera move at all, so the measured budgets are
 *  unchanged either way (TEST-P1/P5/P6, verbatim). The `memo` is defence in depth for Split D/E, when
 *  the shell's remaining render triggers shrink; do NOT read it as an already-banked win. */
export const GridDockLayer = memo(GridDockLayerImpl)
GridDockLayer.displayName = 'GridDockLayer'
