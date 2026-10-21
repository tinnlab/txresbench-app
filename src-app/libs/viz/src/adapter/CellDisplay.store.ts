// CellDisplay.store.ts — SPLIT 0b (ITEM-21 / DEC-21): the PER-CELL DISPLAY-STATE slice.
//
// ── Why this store exists ────────────────────────────────────────────────────────────────────────
// The decomposition of `GridWorkspace.tsx` cuts the file into a deck layer, an overlay layer, a
// dock layer and a pane-chrome layer. The measured blocker (PLAN_AUDIT "Decomposition coupling
// map") is a cluster of per-cell display values WRITTEN in one candidate child's region and READ in
// the others' on every render: an in-cell legend click writes `hiddenCodes`, and the deck's recolor
// builder, the pane-chrome legend swatch AND the edit-form dock must all react to it.
//
// Prop-drilling that cluster into three children re-renders all three together — that is not a
// decomposition, it is the same component in more files. So the cluster is hoisted HERE, keyed by
// CELL ID, and every child subscribes with a selector scoped to ONE cell. A change to cell A then
// re-renders A's subscribers and nobody else's.
//
// ── The isolation contract (what makes a per-cell subscription actually work) ────────────────────
// A selector that builds a fresh object every call defeats every subscriber — `useStore` compares
// the selector's RESULT by identity, so a per-call object means "changed" on every store event
// anywhere. Two properties therefore hold and are asserted in `cellDisplayStore.test.ts`:
//   1. `selectCell(id)(state)` returns a REFERENTIALLY IDENTICAL result while cell `id`'s own keys
//      are untouched — including when ANOTHER cell is written.
//   2. An unknown cell resolves to the ONE shared `EMPTY_CELL_DISPLAY` identity, not a fresh empty
//      object per call.
// Both are implemented by a per-cell memo cache keyed on the seven source records, so the cache is
// invalidated exactly when one of that cell's values moves and never otherwise.
//
// ── What is NOT here, and why (the DEC-21 triage, resolved 2026-07-29) ───────────────────────────
// The admission rule is: (i) keyed by cell id, (ii) plain transferable data — no GPU/loader
// resource with a disposal lifecycle, (iii) DISPLAY description rather than pointer-transient or a
// global epoch.
//   * `committedByCell`  — (iii): selection GEOMETRY, whose contract lives in SelectionController
//                          and whose writers are the pointer path (INV-9). Its reader/writer pair
//                          is deck+overlay, which Splits A/B sever through their own handles.
//   * `maskReview`       — (iii): mask-AUTHORING review state owned by the mask dock.
//   * `annotateEpoch` / `maskEpoch` — (i): global scalars, not per-cell.
//   * `imageUnderlays` / `imagePyramids` / `maskData` — (ii): each holds a GPU texture or a large
//                          decoded buffer with a `'loading'` sentinel and an explicit release path.
//   * `crossHighlight` / `chartHover` — (iii): per-FRAME hover transients (and `chartHover` is not
//                          cell-keyed at all — it is a single `{cellId, index}`).
//   * `perCellRange`     — already store-backed, and it must STAY in `PlotInteraction.store` which
//                          is the SINGLE SERIALIZE SOURCE for `option.filters` (DEC-13). Its job
//                          here is not a hoist but a NARROWING: see `selectPlotRange` there.
//
// Plain-zustand (no immer), matching `PlotInteraction.store.ts` / `GridWorkspace.store.ts`:
// `create()(subscribeWithSelector(builder))`.

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { ContinuousColormap, LegendDescriptor, ColorbarDescriptor } from '../viz-core/data/color'
import type { Blend2DLegend } from '../viz-core/data/blend'

/** A cell's WYSIWYG in-cell legend / visual-map descriptor. Dense cells and grouped charts publish
 *  into SEPARATE records (`legend` vs `groupLegend`) so neither clobbers the other's overlay. */
export interface CellLegend {
  descriptor: LegendDescriptor | ColorbarDescriptor | Blend2DLegend
  values?: Float32Array
  domain?: [number, number]
  colormap?: ContinuousColormap
  title: string
  /** For a CATEGORICAL legend, the RAW category names (indexed by code) + the color-by column id, so
   *  by-name overrides key on the RAW name and the recolor/rename round-trip stays stable. */
  rawLabels?: readonly string[]
  columnId?: string
}

/** A matrix cell's continuous VALUE scale (heatmap/dotplot) — the colorbar + the edit-form picker. */
export interface CellValueLegend {
  colormap: ContinuousColormap
  domain: readonly [number, number]
}

/** A cell's own color buffer + the epoch that bumps the layer's `updateTrigger`. */
export interface CellColors {
  colors: Uint8Array
  epoch: number
}

/** The colorBy column data resident for a dense cell's data table (category names / values). */
export interface PlotColorData {
  column: string
  categorical: boolean
  codes?: Uint16Array
  categories?: readonly string[]
  values?: Float32Array
}

/** The PLOTTED rows a grouped/matrix chart View publishes for its data table. */
export interface CellPlotRows {
  columns: string[]
  rows: (string | number)[][]
  /** Per-row ORIGINAL local point index (raw-dot charts publish it → table hover-highlight works). */
  pointIndices?: number[]
}

/** The seven per-cell records. Each is its own top-level key so a selector on ONE of them is not
 *  invalidated by a write to another (a single `Record<cellId, everything>` would re-notify every
 *  subscriber on any change — the coupling this store exists to remove). */
export interface CellDisplaySlice {
  colors: Record<string, CellColors>
  legend: Record<string, CellLegend>
  groupLegend: Record<string, CellLegend>
  valueLegend: Record<string, CellValueLegend>
  hiddenCodes: Record<string, Set<number>>
  colorData: Record<string, PlotColorData>
  plotRows: Record<string, CellPlotRows>
}

/** ONE cell's resolved display state — what a per-cell subscriber actually reads. */
export interface CellDisplay {
  colors?: CellColors
  legend?: CellLegend
  groupLegend?: CellLegend
  valueLegend?: CellValueLegend
  hiddenCodes?: Set<number>
  colorData?: PlotColorData
  plotRows?: CellPlotRows
}

/** The ONE identity every cell with no display state resolves to. Shared on purpose: a fresh `{}`
 *  per call would make `useStore(store, selectCell(id))` re-render on every unrelated store event. */
export const EMPTY_CELL_DISPLAY: CellDisplay = Object.freeze({})

/** A `Record` update that returns the SAME record when nothing actually moved, so a no-op write does
 *  not invalidate any subscriber. */
function put<T>(rec: Record<string, T>, id: string, value: T | undefined): Record<string, T> {
  if (value === undefined) {
    if (!(id in rec)) return rec
    const next = { ...rec }
    delete next[id]
    return next
  }
  if (rec[id] === value) return rec
  return { ...rec, [id]: value }
}

// ── the WHOLE-RECORD write path, and why it needs an equality (FIX_ROUND-2 / the memo-boundary
//    residual) ──────────────────────────────────────────────────────────────────────────────────
// `put` above keeps identity on the SINGLE-cell path. The four `replace*` actions had no equivalent,
// and their callers (`useGridColoring`'s recolor / legend effects) are keyed on `colorSig` — a
// WHOLE-GRID signature. So one pane's in-cell legend click re-ran the recolor for EVERY dense cell
// and handed this store a FRESH `CellColors` / `PlotColorData` / `CellLegend` for each, with a fresh
// `epoch`, even where the recomputed value was byte-for-byte what was already there.
//
// MEASURED (`zzprobe`, the TEST-F5 drive, 2 panes): a legend click on pane 2 produced, for the
// UNTOUCHED pane 1, `colorBytesEqual=true (len=320000)`, `colorDataEqual=true`,
// `legendJsonEqual=true` — three identity changes carrying no information. Each woke that pane's
// `selectCell` subscription, so `memo(GridPaneCell)` was bypassed entirely (a store subscription
// re-renders a component whether or not its props moved) and the untouched pane rebuilt its chrome
// twice. The bumped `epoch` is additionally the deck layer's `updateTrigger`, so the identical color
// buffer was re-uploaded to the GPU as well.
//
// The fix is the record-level analogue of `put`: keep the PREVIOUS entry (identity AND epoch) when
// the incoming one is EQUIVALENT. Cost is a linear compare of a buffer the caller just spent a
// linear pass computing, so it is strictly cheaper than the work that produced it.

/** Content equality for typed arrays / arrays — identity first, then length, then elements. */
function sameArrayLike(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Structural equality over the plain-data shapes this store holds. Typed arrays and `Set`s compare
 *  by CONTENT (they are rebuilt fresh by every recolor pass); everything else is a plain object,
 *  array or primitive. Deliberately NOT a general deep-equal: no cycles, no class instances. */
export function sameDisplayValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return false
    if (a.constructor !== b.constructor) return false
    return sameArrayLike(a as unknown as ArrayLike<number>, b as unknown as ArrayLike<number>)
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set)) return false
    if (a.size !== b.size) return false
    for (const v of a) if (!b.has(v)) return false
    return true
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    return a.every((v, i) => sameDisplayValue(v, b[i]))
  }
  const ka = Object.keys(a as Record<string, unknown>)
  const kb = Object.keys(b as Record<string, unknown>)
  if (ka.length !== kb.length) return false
  return ka.every(
    k =>
      Object.hasOwn(b as Record<string, unknown>, k) &&
      sameDisplayValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  )
}

/** `CellColors` equality IGNORES `epoch`: the epoch's whole job is to signal "this buffer moved", so
 *  an identical buffer must keep the epoch it already had — otherwise the signal is a lie and the
 *  deck re-uploads an attribute that did not change. */
function sameCellColors(a: CellColors, b: CellColors): boolean {
  return a === b || sameArrayLike(a.colors, b.colors)
}

/** Whole-record replace that PRESERVES per-entry identity wherever the incoming entry is equivalent,
 *  and returns `prev` itself when no entry moved and no key was added or dropped. */
export function mergeRecord<T>(
  prev: Record<string, T>,
  next: Record<string, T>,
  eq: (a: T, b: T) => boolean = sameDisplayValue,
): Record<string, T> {
  const nextKeys = Object.keys(next)
  const out: Record<string, T> = {}
  let changed = nextKeys.length !== Object.keys(prev).length
  for (const id of nextKeys) {
    const p = prev[id]
    if (p !== undefined && eq(p, next[id])) out[id] = p
    else {
      out[id] = next[id]
      changed = true
    }
  }
  return changed ? out : prev
}

export interface CellDisplayActions {
  setColors: (id: string, v: CellColors | undefined) => void
  /** Bulk replace of the whole colors record (the recolor effect converges every cell at once). */
  replaceColors: (next: Record<string, CellColors>) => void
  updateColors: (fn: (prev: Record<string, CellColors>) => Record<string, CellColors>) => void
  replaceLegend: (next: Record<string, CellLegend>) => void
  replaceGroupLegend: (next: Record<string, CellLegend>) => void
  setValueLegend: (id: string, v: CellValueLegend | undefined) => void
  setHiddenCodes: (id: string, v: Set<number> | undefined) => void
  /** Functional update over the whole hidden-codes record (the prune-on-cell-removal path). */
  updateHiddenCodes: (fn: (prev: Record<string, Set<number>>) => Record<string, Set<number>>) => void
  replaceColorData: (next: Record<string, PlotColorData>) => void
  setPlotRows: (id: string, v: CellPlotRows | undefined) => void
  /** Drop every record's entry for a cell (pane closed / cell id retired). */
  removeCell: (id: string) => void
  reset: () => void
}

function emptySlice(): CellDisplaySlice {
  return { colors: {}, legend: {}, groupLegend: {}, valueLegend: {}, hiddenCodes: {}, colorData: {}, plotRows: {} }
}

export type CellDisplayState = CellDisplaySlice & CellDisplayActions

export function createCellDisplayStore() {
  return create<CellDisplayState>()(
    subscribeWithSelector(set => ({
      ...emptySlice(),
      setColors: (id, v) => set(prev => ({ colors: put(prev.colors, id, v) })),
      replaceColors: next => set(prev => ({ colors: mergeRecord(prev.colors, next, sameCellColors) })),
      updateColors: fn => set(prev => ({ colors: fn(prev.colors) })),
      replaceLegend: next => set(prev => ({ legend: mergeRecord(prev.legend, next) })),
      replaceGroupLegend: next => set(prev => ({ groupLegend: mergeRecord(prev.groupLegend, next) })),
      setValueLegend: (id, v) => set(prev => ({ valueLegend: put(prev.valueLegend, id, v) })),
      setHiddenCodes: (id, v) => set(prev => ({ hiddenCodes: put(prev.hiddenCodes, id, v) })),
      updateHiddenCodes: fn => set(prev => ({ hiddenCodes: fn(prev.hiddenCodes) })),
      replaceColorData: next => set(prev => ({ colorData: mergeRecord(prev.colorData, next) })),
      setPlotRows: (id, v) => set(prev => ({ plotRows: put(prev.plotRows, id, v) })),
      removeCell: id =>
        set(prev => ({
          colors: put(prev.colors, id, undefined),
          legend: put(prev.legend, id, undefined),
          groupLegend: put(prev.groupLegend, id, undefined),
          valueLegend: put(prev.valueLegend, id, undefined),
          hiddenCodes: put(prev.hiddenCodes, id, undefined),
          colorData: put(prev.colorData, id, undefined),
          plotRows: put(prev.plotRows, id, undefined),
        })),
      reset: () => set(() => emptySlice()),
    })),
  )
}

export type CellDisplayStore = ReturnType<typeof createCellDisplayStore>

// NO MODULE SINGLETON IS EXPORTED FROM THIS FILE, and that is the point (FIX_ROUND-1 / B2).
//
// There WAS one — `export const useCellDisplayStore = createCellDisplayStore()`, documented as "the
// DEFAULT module-singleton store, mirroring every other member of the `VizStores` family". It had
// zero importers, and its doc-comment contradicted the two places that argue at length for the
// opposite (`GridWorkspaceContext.tsx` and `GridWorkspace.tsx`'s `useState(createCellDisplayStore)`):
// this store MUST be per-workspace, because a popped-out container mounts a SECOND `<GridWorkspace>`
// inside the SAME `<Viz>` and both instances end their recolor / legend effects with a WHOLE-RECORD
// `replaceColors` / `replaceLegend` over their OWN cells. A contributor writing the idiomatic import
// would therefore have had one workspace silently wipe the other's colours — with a docstring
// blessing it. The sibling `PaneDocks.store.ts` deliberately exports no singleton for exactly this
// reason; the asymmetry was the tell. Mint one per workspace with `createCellDisplayStore()` and
// reach it through the ITEM-14 seam. Guarded by `cellDisplayStore.test.ts`.

// ── the per-cell selector ────────────────────────────────────────────────────────────────────────
// `selectCell(id)` returns a STATEFUL selector closure that memoizes its own last result against
// the seven source values it read. It cannot memoize against the state object instead: zustand
// replaces the state object on EVERY `set`, so a state-keyed cache would miss after any write —
// including a write to a DIFFERENT cell — and hand cell A's subscriber a fresh object, re-rendering
// it for B's change. That is precisely the coupling this store exists to remove, so the memo has to
// outlive the state object.
//
// CALLER CONTRACT: keep the selector instance stable for the lifetime of the subscription —
// `const sel = useMemo(() => selectCell(cellId), [cellId])`, then `useStore(store, sel)`. Minting a
// new closure per render throws away the memo and defeats the whole mechanism.
export type CellDisplaySelector = (s: CellDisplaySlice) => CellDisplay

/** Build a per-cell selector whose result identity is stable while THAT cell's values are. */
export function selectCell(id: string): CellDisplaySelector {
  let lastSrc: readonly (unknown | undefined)[] | null = null
  let lastOut: CellDisplay = EMPTY_CELL_DISPLAY
  return (s: CellDisplaySlice): CellDisplay => {
    const src = [
      s.colors[id],
      s.legend[id],
      s.groupLegend[id],
      s.valueLegend[id],
      s.hiddenCodes[id],
      s.colorData[id],
      s.plotRows[id],
    ] as const
    if (lastSrc && lastSrc.every((v, i) => v === src[i])) return lastOut
    lastSrc = src
    if (src.every(v => v === undefined)) {
      lastOut = EMPTY_CELL_DISPLAY
      return lastOut
    }
    const out: CellDisplay = {}
    if (src[0] !== undefined) out.colors = src[0]
    if (src[1] !== undefined) out.legend = src[1]
    if (src[2] !== undefined) out.groupLegend = src[2]
    if (src[3] !== undefined) out.valueLegend = src[3]
    if (src[4] !== undefined) out.hiddenCodes = src[4]
    if (src[5] !== undefined) out.colorData = src[5]
    if (src[6] !== undefined) out.plotRows = src[6]
    lastOut = out
    return out
  }
}
