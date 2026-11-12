// VisualizationPage.tsx — the real app page (adapter layer: binds viz-core to the
// txresbench app shell). A full-height workspace: a fixture-seeded resizable grid of scatter
// views with a color-by control.
//
// Consumes the consolidated `@txresbench/viz` public API (viz-api-consolidation ITEM-17): the
// grid is mounted via `<Viz source option onChange onController>` (superseding the raw
// `<GridWorkspace>` mount). `onChange` streams the strict-JSON `VizOption` to the autosave
// hook; `onController` binds the `VizController` so restore drives `setOption(saved,
// { replace })`. The fixture `FixtureSource` is still a legacy pull `DataSource` here — the
// `<Viz source>` prop accepts it and routes the byte-identical legacy resolve path (a
// streaming source drops in behind the same seam later).

import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Select, Text, type SelectOption, type SelectOptionGroup } from '@txresbench/kit'
import {
  Viz,
  FixtureSource,
  computeColoring,
  densify,
  ExportDialog,
  gridDividerMarks,
  type VizController,
  type ColorBy,
  type DatasetCatalog,
  type GraphData,
  type TooltipCatalogLabels,
  type TooltipContext,
  type Rect,
  type LegendExportSpec,
} from '@txresbench/viz'
import { useWorkspaceAutosave } from './autosave'

/** The color-by control's value ⇄ `ColorBy` mapping, in ONE place. `mode:key` (the key itself
 *  may contain no `:` — catalog ids are column names), so the pair round-trips through the
 *  single string the picker holds. */
const colorByValue = (mode: ColorBy['mode'], key: string): string => `${mode}:${key}`
function parseColorByValue(v: string): { mode: ColorBy['mode']; key: string } | null {
  const at = v.indexOf(':')
  if (at <= 0) return null
  return { mode: v.slice(0, at) as ColorBy['mode'], key: v.slice(at + 1) }
}

export function VisualizationPage() {
  const autosave = useWorkspaceAutosave()
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: 250_000 }), [])
  const [catalog, setCatalog] = useState<DatasetCatalog | null>(null)
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)
  // Graph-overlay inputs (Phase C3c): the group codes + node-link graph + category
  // labels a dense cell's graph toggle draws from. Loaded once alongside the catalog.
  const [codes, setCodes] = useState<Uint16Array | null>(null)
  const [graph, setGraph] = useState<GraphData | null>(null)
  const [categories, setCategories] = useState<readonly string[] | null>(null)
  // The active color-by RAW value column + (categorical) its labels — the tooltip's
  // "active color-by value" row (ITEM-5). Reloaded once per color-by change (an effect),
  // NEVER on hover: the tooltip reads this resident column by O(1) index.
  const [colorValue, setColorValue] = useState<Float32Array | null>(null)
  const [colorCategories, setColorCategories] = useState<readonly string[] | undefined>(undefined)
  const [colorBy, setColorBy] = useState<ColorBy>({
    mode: 'categorical',
    key: 'group',
    colormap: 'viridis',
    scale: 'linear',
    hidden: new Set(),
  })
  // Export (ITEM-47): the product page mounts the ExportDialog. The workspace wrapper
  // ref lets us resolve, at export time, (a) the shared deck canvas — the FIRST
  // <canvas> in the workspace (GridWorkspace keeps it first in DOM) — and (b) the
  // focused pane's on-screen rect relative to that canvas, so a "This pane" PNG crops
  // to just that pane's pixels (the crop itself lives in cropCanvas.ts).
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  // The `<Viz>` controller (bound once via `onController`). Owns the per-instance store set —
  // read the live selection origin through it for per-pane export targeting, and hand it to the
  // autosave hook so restore can drive `setOption(saved, { replace })`.
  const controllerRef = useRef<VizController | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  // The pane the export dialog is currently scoped to. Set when a cell's ⤓ export button
  // is clicked (per-cell export); `null` for the toolbar "Export…" button (which then
  // falls back to the selection-origin pane). `getPaneRect()` prefers this explicit id, so
  // a per-cell export targets the CLICKED pane regardless of the current selection.
  const [exportCellId, setExportCellId] = useState<string | null>(null)
  // Shell redesign: 'pane' = a cell's ⤓ (crop to that pane); 'grid' = the tool rail's ⤓ (whole canvas).
  const [exportScope, setExportScope] = useState<'pane' | 'grid'>('pane')

  /** The shared deck.gl canvas (first canvas in the workspace), or null before mount. */
  const getDeckCanvas = (): HTMLCanvasElement | null =>
    workspaceRef.current?.querySelector('canvas') ?? null

  /**
   * The CURRENT pane's CSS rect relative to the exported deck canvas (ITEM-47). The
   * "current" pane is the cell that originated the active selection (`selectionOrigin`);
   * with no selection we fall back to the first rendered pane. Returns null when the
   * canvas/pane can't be resolved, in which case ExportDialog exports the whole canvas.
   * A getter (not a value) so a resize/selection change between opening the dialog and
   * clicking Export is reflected.
   */
  const getPaneRect = (): Rect | null => {
    if (exportScope === 'grid') return null // shell redesign: whole-grid export → full canvas, no crop
    const root = workspaceRef.current
    const canvas = getDeckCanvas()
    if (!root || !canvas) return null
    // Prefer the explicit per-cell export target (the clicked ⤓ pane); else fall back to
    // the selection-origin pane, else the first rendered pane. The selection lives in the
    // `<Viz>` instance's OWN (isolated) coordination store, so it is read through the bound
    // controller — NOT the module-singleton store, which this `<Viz>` no longer drives.
    const originId =
      exportCellId ?? controllerRef.current?.getStores().coordination.getState().selectionOrigin
    const pane =
      (originId &&
        root.querySelector(
          `[data-viz-cell="${typeof CSS !== 'undefined' ? CSS.escape(originId) : originId}"]`,
        )) ||
      root.querySelector('[data-viz-cell]')
    if (!pane) return null
    const cb = canvas.getBoundingClientRect()
    const pb = (pane as HTMLElement).getBoundingClientRect()
    return { x: pb.left - cb.left, y: pb.top - cb.top, width: pb.width, height: pb.height }
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      const cat = await source.catalog()
      const pos = await source.positions('primary')
      const grp = await source.categorical('group')
      const g = await source.graph('primary')
      if (!alive) return
      setCatalog(cat)
      setPositions(pos.positions)
      setCodes(grp.codes)
      setCategories(grp.categories)
      setGraph(g)
    })()
    return () => {
      alive = false
    }
  }, [source])

  // The active color-by's legend, so an export carries it (viz-legend-export). Resolved from the
  // SAME `computeColoring` that colors the plot — `.legend` / `.colorbar` / `.blend.legend2d`.
  const [legendSpec, setLegendSpec] = useState<LegendExportSpec | null>(null)
  // The exported cell's LIVE in-cell visual-map state (range window / hidden), folded into the legend
  // getter so the export mirrors the on-screen cell (WYSIWYG).
  const [exportVisualMap, setExportVisualMap] = useState<{ range?: [number, number]; hidden?: number[] } | undefined>(undefined)
  useEffect(() => {
    let alive = true
    void (async () => {
      const c = await computeColoring(source, colorBy)
      if (!alive) return
      setColors(c.colors)
      setColorEpoch(e => e + 1)
      setLegendSpec(
        c.blend?.legend2d
          ? { descriptor: c.blend.legend2d, title: colorBy.key }
          : c.colorbar
            ? { descriptor: c.colorbar, title: colorBy.key }
            : c.legend
              ? { descriptor: c.legend, title: colorBy.key }
              : null,
      )
    })()
    return () => {
      alive = false
    }
  }, [source, colorBy])

  // Load the RAW value column for the active color-by (for the hover tooltip). Runs
  // once per color-by change — never on hover. Categorical → codes-as-float + labels;
  // continuous → the dense value column; value → the densified sparse column.
  useEffect(() => {
    let alive = true
    void (async () => {
      if (colorBy.mode === 'categorical') {
        const col = await source.categorical(colorBy.key)
        if (!alive) return
        setColorValue(Float32Array.from(col.codes))
        setColorCategories(col.categories)
      } else if (colorBy.mode === 'continuous') {
        const col = await source.continuous(colorBy.key)
        if (!alive) return
        setColorValue(col.value)
        setColorCategories(undefined)
      } else {
        const col = await source.valueColumn(colorBy.key)
        if (!alive) return
        setColorValue(densify(col))
        setColorCategories(undefined)
      }
    })()
    return () => {
      alive = false
    }
  }, [source, colorBy])

  // The resident columns bundle the grid tooltip reads by O(1) index (ITEM-5). Rebuilt
  // only when a resident column reference changes — the accessors themselves never scan.
  const tooltipContext = useMemo<TooltipContext | undefined>(() => {
    if (!positions) return undefined
    return {
      positions,
      codes: codes ?? undefined,
      categories: categories ?? undefined,
      colorValue: colorValue ?? undefined,
      colorCategories,
    }
  }, [positions, codes, categories, colorValue, colorCategories])

  // Every colorable column the catalog offers, as kit `<Select>` options GROUPED BY KIND.
  // The list is unbounded — a real source can offer thousands of value columns — so it is handed
  // to the kit control whole and the control's own search (auto-on past
  // `SELECT_SEARCH_THRESHOLD`; this catalog is well past it) is what makes it navigable. The
  // group heading carries the kind, so the per-row "(categorical)" suffix the raw <select>
  // needed is gone; the kit's filter matches a heading as well as a row, so typing a kind
  // still narrows to it.
  const colorByOptions = useMemo<(SelectOption | SelectOptionGroup)[]>(() => {
    if (!catalog) return []
    const groups: SelectOptionGroup[] = []
    if (catalog.categoricalColumns.length > 0) {
      groups.push({
        label: 'Categorical',
        options: catalog.categoricalColumns.map(c => ({
          value: colorByValue('categorical', c.id),
          label: c.label,
        })),
      })
    }
    if (catalog.continuousColumns.length > 0) {
      groups.push({
        label: 'Continuous',
        options: catalog.continuousColumns.map(c => ({
          value: colorByValue('continuous', c.id),
          label: c.label,
        })),
      })
    }
    if (catalog.valueColumns.length > 0) {
      groups.push({
        label: 'Value',
        options: catalog.valueColumns.map(v => ({ value: colorByValue('value', v), label: v })),
      })
    }
    return groups
  }, [catalog])
  /** The catalog has landed and the picker has something to offer. */
  const columnsReady = colorByOptions.length > 0

  // Display labels for the tooltip's default fields (group / active color-by / x / y).
  const tooltipLabels = useMemo<TooltipCatalogLabels>(() => {
    const colorLabel =
      catalog?.categoricalColumns.find(c => c.id === colorBy.key)?.label ??
      catalog?.continuousColumns.find(c => c.id === colorBy.key)?.label ??
      colorBy.key
    const groupLabel = catalog?.categoricalColumns.find(c => c.id === 'group')?.label ?? 'Group'
    return { group: groupLabel, color: colorLabel }
  }, [catalog, colorBy.key])

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="visualization-page">
      {autosave.hasSaved && (
        <div
          data-testid="viz-restore-banner"
          role="status"
          className="flex shrink-0 items-center gap-2 border-b border-border bg-muted px-3 py-1.5 text-sm"
        >
          <Text>Restore last workspace?</Text>
          <Button data-testid="viz-restore-accept" onClick={autosave.restore}>
            Restore
          </Button>
          <Button data-testid="viz-restore-dismiss" variant="ghost" onClick={autosave.dismiss}>
            Dismiss
          </Button>
        </div>
      )}
      <div className="relative flex shrink-0 items-center gap-2 p-2">
        <Text strong>Visualization</Text>
        <Text tone="muted" className="text-sm">
          Color by
        </Text>
        <div className="w-64 min-w-0">
          <Select
            data-testid="viz-page-colorby"
            options={colorByOptions}
            // Held EMPTY until the catalog lands. A `Select` given a value that names no option
            // it was handed has nothing to label the trigger with and falls back to printing
            // the raw value — so the control would read "categorical:group" (an internal
            // encoding) for as long as the fixture took to load. Empty ⇒ the placeholder, which
            // is what that moment actually is.
            value={columnsReady ? colorByValue(colorBy.mode, colorBy.key) : ''}
            onChange={v => {
              const next = parseColorByValue(v)
              if (!next) return
              setColorBy(cb => ({ ...cb, mode: next.mode, key: next.key }))
            }}
            aria-label="Color by"
            placeholder="Loading columns…"
            searchPlaceholder="Search columns…"
            emptyText="No column matches that name"
            disabled={!columnsReady}
          />
        </div>
        <Text tone="muted" className="text-sm">
          {catalog ? `${catalog.pointCount.toLocaleString()} points` : 'loading…'}
        </Text>
        <Button
          data-testid="viz-page-export-open"
          variant="outline"
          aria-expanded={exportOpen}
          onClick={() => {
            // Toolbar export: no explicit pane target → fall back to selection-origin pane.
            setExportCellId(null)
            setExportOpen(o => !o)
          }}
          className="ms-auto"
        >
          Export…
        </Button>
        {exportOpen && (
          <div
            data-testid="viz-page-export-popover"
            className="absolute end-2 top-full z-10 rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
          >
            {/* Remount (key) when the target pane changes so a per-cell export opens
                with the default scope='pane' — the clicked pane, not a stale 'grid' scope. */}
            <ExportDialog
              key={exportCellId ?? 'toolbar'}
              canvas={getDeckCanvas}
              paneRect={getPaneRect}
              legend={() => (legendSpec ? { ...legendSpec, range: exportVisualMap?.range, hidden: exportVisualMap?.hidden } : null)}
              gridDividers={() => gridDividerMarks(workspaceRef.current, getDeckCanvas(), typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)}
              dpr={typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1}
              filename="visualization"
            />
          </div>
        )}
      </div>
      <div ref={workspaceRef} className="min-h-0 flex-1">
        {positions && colors && catalog ? (
          <Viz
            source={source}
            onController={c => {
              // Bind the controller for BOTH consumers: the page (per-pane export targeting via
              // its store set) and the autosave hook (restore → `setOption(saved, { replace })`).
              // `<Viz>` reads `onController` through a ref and fires it once on mount, so a fresh
              // inline identity each render is harmless.
              controllerRef.current = c
              autosave.bindController(c)
            }}
            onChange={autosave.persist}
            positions={positions}
            colors={colors}
            colorEpoch={colorEpoch}
            catalog={catalog}
            codes={codes ?? undefined}
            graph={graph ?? undefined}
            categories={categories ?? undefined}
            tooltipContext={tooltipContext}
            tooltipLabels={tooltipLabels}
            onRequestExportCell={(cellId, _colorBy, visualMap) => {
              // Scope the export to THAT pane + open it, capturing the cell's live in-cell
              // visual-map state so the export snapshots what's on screen (WYSIWYG).
              setExportScope('pane')
              setExportCellId(cellId)
              setExportVisualMap(visualMap)
              setExportOpen(true)
            }}
            onRequestExportGrid={() => {
              // Shell redesign: the tool rail's ⤓ exports the WHOLE grid (full canvas, no crop).
              setExportScope('grid')
              setExportCellId(null)
              setExportVisualMap(undefined)
              setExportOpen(true)
            }}
          />
        ) : (
          <div className="p-4">
            <Text tone="muted">Loading dataset…</Text>
          </div>
        )}
      </div>
    </div>
  )
}
