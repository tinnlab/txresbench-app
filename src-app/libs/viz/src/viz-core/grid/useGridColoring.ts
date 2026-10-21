// useGridColoring.ts — SPLIT F (ITEM-22): the grid's COLORING / LEGEND data plane.
//
// Four effects and the two signatures that trigger them, moved verbatim out of `GridWorkspace`:
// the per-cell recolor (`computeColoring` → `cellDisplay.replaceColors`/`replaceColorData`), the
// dense WYSIWYG legend, and the grouped-chart GROUP legend. They are a DATA plane, not a render
// plane: every output lands in the per-workspace `CellDisplay` store that the pane + deck layers
// already read, so the shell neither declares nor brokers a single one of them. That is why this
// is a hook and not a sixth LAYER — it renders nothing, and INV-10 (a) names exactly five layers.
//
// DEC-20 is unaffected: nothing here enters the ITEM-14 seam, and the store is the PER-WORKSPACE
// instance handed in (a popped-out container's second workspace writes its own, per DRIFT-5).
//
// The whole moved set is a lexical binding of the component it was cut from and has NO writer
// outside these four effects — the outputs are store calls, so `tsc` is a complete backstop for
// the move (verified per-symbol in the split's drift record).
import { useEffect, useMemo, useRef, type RefObject } from 'react'
import type { ContinuousColumn, DataSource, DatasetCatalog } from '../data/wire'
import { densify } from '../data/wire'
import { streamColumnDomain } from '../data/progressiveDomain'
import { categoricalColors, continuousColors, legendDescriptor } from '../data/color'
import { computeColoring, type ColorBy } from '../data/engine'
import { getChartType } from '../registry/registry'
import { makeChartModel, bindingValue } from '../registry/model'
import { overridesForColumn, type ColumnColorOverride } from '../../adapter/colorOverride.store'
import type { VizStores } from '../../adapter/vizStores'
import type { CellLegend, PlotColorData, createCellDisplayStore } from '../../adapter/CellDisplay.store'
import {
  datasetLinkKey,
  resolveLinkedCellDomains,
  sourceForCell,
  type GridCell,
} from './gridModel'

/** The DEBUG-seam gate, resolved once at module load. `import.meta.env.DEV` is the viz idiom
 *  (`GridWorkspace.tsx:963`, `Viz.tsx:529`); `VITE_ENABLE_TEST_SEAMS` is the app's e2e PREVIEW
 *  build's flag, and the preview build is production (`DEV === false`), so a DEV-only gate would
 *  make the seam absent in exactly the run that needs it. Both fold to constants at build time, so
 *  a release bundle drops the guarded block entirely. Cast rather than declared: viz's own
 *  `vite-env.d.ts` describes viz's env, and this reads the CONSUMING app's flag. */
const DEBUG_SEAMS_ENABLED = Boolean(
  import.meta.env.DEV ||
    (import.meta.env as unknown as { VITE_ENABLE_TEST_SEAMS?: string }).VITE_ENABLE_TEST_SEAMS,
)

/** Cache key for ONE column read in a pass (ITEM-12) — the dataset (or the default workspace source)
 *  plus the channel kind plus the column key. Two cells on the same dataset+column share one read;
 *  two cells on DIFFERENT datasets never collide. NUL-delimited so no key/kind pair can spell
 *  another (the same trap `DatasetStore`'s pull keys and `layers/layerIds.ts` already resolve). */
function readKey(
  datasetId: string | null | undefined,
  kind: 'continuous' | 'categorical' | 'value',
  key: string,
): string {
  return `${datasetId ?? '@default'}\u0000${kind}\u0000${key}`
}

/**
 * Present `src` with its three COLUMN reads memoized into the pass cache (ITEM-12). Everything else
 * — catalog, positions, tables, graph, pointIds — passes straight through; only the bulk column
 * reads were being duplicated. `computeColoring` is handed THIS wrapper, so its internal reads join
 * the same cache as the progressive domain's and the legend's, which is what collapses a colour
 * change from 2-3 reads of a column to one.
 *
 * A REJECTED read stays cached for the rest of the pass: within one pass a failing column fails
 * once, rather than being retried by each of the three consumers.
 */
function withPassCache(
  src: DataSource,
  datasetId: string | null | undefined,
  cache: Map<string, Promise<unknown>>,
  signal: AbortSignal,
): DataSource {
  const memo = <T,>(k: string, run: () => Promise<T>): Promise<T> => {
    const hit = cache.get(k) as Promise<T> | undefined
    if (hit) return hit
    const p = run()
    void p.catch(() => {}) // a cached rejection must not surface as an unhandled rejection
    cache.set(k, p)
    return p
  }
  // ITEM-15 leg (b): the pass's signal rides EVERY read — `asDataSource` now forwards it into
  // `source.stream(channel, opts)`. A JOINING caller inherits the signal of whoever created the
  // entry, which is correct here rather than merely tolerable: the recolor and legend effects share
  // ONE dep set, so their controllers are constructed and aborted together and both fire at the
  // same moment.
  return {
    ...src,
    continuous: key =>
      memo(readKey(datasetId, 'continuous', key), () => src.continuous(key, { signal })),
    categorical: key =>
      memo(readKey(datasetId, 'categorical', key), () => src.categorical(key, { signal })),
    valueColumn: (key, layer) =>
      memo(readKey(datasetId, 'value', layer ? `${key}\u0000${layer}` : key), () =>
        src.valueColumn(key, layer, { signal }),
      ),
  }
}

type DatasetEntries = ReturnType<VizStores['datasetStore']['getState']>['datasets']
type ColorOverrides = ReturnType<VizStores['colorOverride']['getState']>['overrides']
type LinkGroups = ReturnType<VizStores['gridWorkspace']['getState']>['linkGroups']
type CellDisplayStore = ReturnType<typeof createCellDisplayStore>

/** Everything the coloring plane reads. Values the effects key on are passed BY VALUE; the three
 *  live maps they read inside an async pass without re-triggering are passed as the SHELL's refs
 *  (they have readers outside this plane — the raster/mask fetches and the selection plane — so
 *  the refs stay owned by the shell and are borrowed here). */
export interface GridColoringInputs {
  readonly stores: VizStores
  readonly cellDisplay: CellDisplayStore
  readonly source: DataSource
  readonly catalog: DatasetCatalog | null
  readonly cells: readonly GridCell[]
  readonly denseCells: readonly GridCell[]
  readonly denseIds: ReadonlySet<string>
  readonly datasetEntries: DatasetEntries
  readonly denseCellsRef: RefObject<readonly GridCell[]>
  readonly datasetEntriesRef: RefObject<DatasetEntries>
  readonly cellMapRef: RefObject<Record<string, GridCell>>
  readonly colorOverrides: ColorOverrides
  readonly linkedHiddenFor: (cellId: string) => Set<number> | undefined
  readonly linkColumnFilterFor: (
    cellId: string,
  ) => { hiddenCols: Record<string, Set<number>>; valueCols: Record<string, [number, number]> } | null
  readonly perCellRange: Record<string, readonly [number, number]>
  readonly linkGroups: LinkGroups
}

/** Plot-editing (ITEM-2/7/8): fold the per-column DISPLAY overrides (by-NAME color + label, from
 *  `colorOverride.store`) onto a cell's `colorBy` so `computeColoring`/`categoricalColors` render the
 *  edited swatch colors + labels — the same by-name bundle the (declarative) `colorBy.categoryColors`
 *  already accepts. Store overrides WIN over any option-carried ones (the live edit is authoritative);
 *  the merge is keyed on the color-by column (`cb.key`). No override for the column ⇒ the SAME `cb`
 *  reference (byte-identical, no needless recolor). */
function withColorOverrides(
  cb: ColorBy,
  overrides: Record<string, ColumnColorOverride>,
): ColorBy {
  const ov = overridesForColumn(overrides, cb.key)
  if (!ov || (!ov.categoryColors && !ov.categoryLabels && !ov.palette)) return cb
  return {
    ...cb,
    ...(ov.palette ? { palette: ov.palette } : {}),
    ...(ov.categoryColors ? { categoryColors: { ...cb.categoryColors, ...ov.categoryColors } } : {}),
    ...(ov.categoryLabels ? { categoryLabels: { ...cb.categoryLabels, ...ov.categoryLabels } } : {}),
  }
}

/** The coloring plane. Returns nothing — every output is a `cellDisplay` store write. */
export function useGridColoring({
  stores,
  cellDisplay,
  source,
  catalog,
  cells,
  denseCells,
  denseIds,
  datasetEntries,
  denseCellsRef,
  datasetEntriesRef,
  cellMapRef,
  colorOverrides,
  linkedHiddenFor,
  linkColumnFilterFor,
  perCellRange,
  linkGroups,
}: GridColoringInputs): void {
  /** Monotonic per-cell color epoch — the deck layers' `updateTriggers` key. Moved with the recolor
   *  that is its only writer. */
  const epochRef = useRef(0)
  const colorOverridesRef = useRef(colorOverrides)
  colorOverridesRef.current = colorOverrides
  // LINK FILTERING: read the live linked-hidden fn inside the recolor effect (via ref, not a dep).
  const linkedHiddenForRef = useRef(linkedHiddenFor)
  linkedHiddenForRef.current = linkedHiddenFor
  const colorDatasetSig = useMemo(
    () =>
      denseCells
        .filter(c => c.colorBy && c.datasetId)
        .map(c => {
          const e = datasetEntries[c.datasetId as string]
          return `${c.id}:${e?.status === 'ready' ? e.gen : 'x'}`
        })
        .join('|'),
    [denseCells, datasetEntries],
  )
  const colorSig = useMemo(
    () =>
      JSON.stringify(
        denseCells.map(c =>
          c.colorBy
            ? [
                c.id,
                c.colorBy.mode,
                c.colorBy.key,
                c.colorBy.colormap,
                c.colorBy.scale,
                [...c.colorBy.hidden],
                !!c.linkColorScale,
                // blend-discriminating fields (undefined for single-channel modes) — so switching
                // a blend's category/value/channel/aggregate re-triggers the recolor effect.
                c.colorBy.categoryKey,
                c.colorBy.valueKey,
                c.colorBy.channel,
                c.colorBy.alphaFloor,
                c.colorBy.perGroupDomain,
                c.colorBy.aggregate,
                c.colorBy.categoricalColumns,
                c.colorBy.continuousColumns,
                c.colorBy.continuousWeights,
                // Plot-editing: fold this column's live DISPLAY override (by-name color+label) into the
                // signature so an in-cell legend recolor/rename re-triggers the recolor + legend effects.
                overridesForColumn(colorOverrides, c.colorBy.key),
                // LINK FILTERING: fold the cell's LINK-GROUP shared filter (hidden category codes AND
                // continuous value ranges) into the signature so a category hide OR a visual-map range
                // change on ANY linked plot re-triggers this cell's recolor (its points drop here too).
                [...(linkedHiddenFor(c.id) ?? [])],
                JSON.stringify(linkColumnFilterFor(c.id)?.valueCols ?? {}),
              ]
            : [c.id, null],
        ),
      ),
    // perCellRange + linkGroups drive the value-range part of the link filter above (read via refs).
    [denseCells, colorOverrides, linkedHiddenFor, linkColumnFilterFor, perCellRange, linkGroups],
  )

  // ── ITEM-12: ONE read per column per PASS, shared by the domain, the coloring and the legend ─────
  //
  // A single continuous colour change used to cost 2-3 full reads of the SAME column: the recolor
  // effect streamed it for the domain (`streamColumnDomain`, below), and the legend effect then
  // called `computeColoring` (which reads it again) AND `src.continuous(cb.key)` (a third). The
  // comment that used to sit beside the legend's read claimed "the source caches this fetch … it's
  // ~free"; `asDataSource` memoizes only the CATALOG (`streamingAdapter.ts:37-41`), so on the
  // streaming path that was simply false, and the false comment is why the defect survived review.
  //
  // This map IS that cache, and it is deliberately scoped to ONE PASS — its identity is keyed on the
  // very deps both effects run on, so a colour change to a DIFFERENT column starts from empty and
  // can never be served stale bytes. It holds PROMISES, so a second caller joins an in-flight read
  // rather than starting one.
  const readCache = useMemo(
    () => new Map<string, Promise<unknown>>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [colorSig, source, colorDatasetSig],
  )

  useEffect(() => {
    let alive = true
    // ITEM-15: a REAL cancellation handle for the pass. `alive` only ever discarded results AFTER a
    // read ran to completion, so three rapid colour switches left three full column reads in flight.
    // The controller is threaded into `streamColumnDomain` → `source.stream(channel, opts)`, which
    // honours it, and is aborted by this effect's cleanup.
    const ac = new AbortController()
    // MD-9: per-cell colorBy fetches from the cell's OWN source — the workspace (default) `source` for a
    // default cell, or its dataset's resolved source (from the DatasetStore) for a multi-dataset cell. A
    // datasetId cell whose source isn't ready yet is skipped here (it recolors when `colorDatasetSig`
    // fires on the ready transition); until then it shows its dataset's base colors.
    const srcFor = (cell: (typeof denseCellsRef.current)[number]): DataSource | null =>
      sourceForCell(cell.datasetId, source, id => datasetEntriesRef.current[id]?.source ?? null)
    const cellsNow = denseCellsRef.current.filter(c => c.colorBy && (!c.datasetId || srcFor(c)))
    if (cellsNow.length === 0) {
      cellDisplay.getState().replaceColors({})
      return
    }
    void (async () => {
      // ITEM-12 — CLAIM the cache slot for every column this pass is about to STREAM, and do it in
      // this IIFE's SYNCHRONOUS head, before the first `await`. React runs this effect before the
      // legend effect below, so by the time the legend asks for the column the slot already holds an
      // unresolved promise and the legend JOINS the streamed read. Registering lazily inside the
      // per-cell loop would race — the legend reaches the column first often enough to keep the
      // second read, which is the defect.
      const streamedSlots = new Map<
        string,
        { resolve: (c: ContinuousColumn) => void; reject: (e: unknown) => void }
      >()
      for (const cell of cellsNow) {
        const cb0 = cell.colorBy as ColorBy | undefined
        if (!cb0 || cb0.mode !== 'continuous' || !cell.datasetId) continue
        if (!stores.datasetStore.getState().getStreamingSource(cell.datasetId)) continue
        const k = readKey(cell.datasetId, 'continuous', cb0.key)
        if (readCache.has(k)) continue
        let resolve!: (c: ContinuousColumn) => void
        let reject!: (e: unknown) => void
        const p = new Promise<ContinuousColumn>((a, b) => {
          resolve = a
          reject = b
        })
        void p.catch(() => {})
        readCache.set(k, p)
        streamedSlots.set(k, { resolve, reject })
      }
      try {
      // 1. Fetch + natural-color each dense cell that declares a colorBy.
      type Natural = {
        id: string
        datasetId: string | null
        colorBy: ColorBy
        colors: Uint8Array
        values: Float32Array | null // continuous/value dense values (null: categorical)
        domain: [number, number] | null
        linked: boolean
      }
      const naturals: Natural[] = []
      // Plot-data table: capture each dense cell's colorBy column data (category codes+names / values).
      const colorData: Record<string, PlotColorData> = {}
      for (const cell of cellsNow) {
        // Plot-editing: fold the live per-column DISPLAY overrides onto the colorBy so an in-cell
        // legend recolor/rename repaints the dense scatter (WYSIWYG). No override ⇒ same ref.
        const cbBase = withColorOverrides(cell.colorBy as ColorBy, colorOverridesRef.current)
        // LINK FILTERING: merge this cell's link-group shared hidden set into its colorBy.hidden so a
        // category hidden on ANY linked plot drops those points here too. No link ⇒ same ref.
        const linkHidden = linkedHiddenForRef.current(cell.id)
        const cb = linkHidden
          ? { ...cbBase, hidden: new Set([...cbBase.hidden, ...linkHidden]) }
          : cbBase
        const cellSrcRaw = srcFor(cell)
        if (!cellSrcRaw) continue // dataset source not ready — recolors on the ready transition
        // ITEM-12: every column read below (incl. the ones `computeColoring` makes internally) goes
        // through the pass cache, so this cell's column is read ONCE for the domain, the coloring and
        // the legend together.
        const cellSrc = withPassCache(cellSrcRaw, cell.datasetId, readCache, ac.signal)
        if (cb.mode === 'blend') {
          // BLEND (categorical hue × continuous value, incl. Phase-2 multi-column reduce): the engine
          // computes both per-point attributes + a CPU-blended RGBA fallback — we consume that RGBA
          // (the SAME buffer the standalone DeckScatterCanvas shows). Blend owns its per-group value
          // domain internally, so it does NOT participate in the linked-domain union (values/domain null).
          const coloring = await computeColoring(cellSrc, cb)
          if (!alive) return
          naturals.push({
            id: cell.id,
            datasetId: cell.datasetId ?? null,
            colorBy: cb,
            colors: coloring.colors,
            values: null,
            domain: null,
            linked: false,
          })
        } else if (cb.mode === 'categorical') {
          const col = await cellSrc.categorical(cb.key)
          if (!alive) return
          colorData[cell.id] = { column: cb.key, categorical: true, codes: col.codes, categories: col.categories }
          // Pass the category NAMES + the additive override bundle so a custom / by-name /
          // auto-extended palette drives the dense scatter. No overrides + ≤20 groups ⇒
          // byte-identical to the built-in palette buffer.
          naturals.push({
            id: cell.id,
            datasetId: cell.datasetId ?? null,
            colorBy: cb,
            colors: categoricalColors(col.codes, {
              hidden: cb.hidden,
              categories: col.categories,
              ...(cb.palette ? { palette: cb.palette } : {}),
              ...(cb.categoryColors ? { categoryColors: cb.categoryColors } : {}),
            }),
            values: null,
            domain: null,
            linked: !!cell.linkColorScale,
          })
        } else {
          // ITEM-11: a CONTINUOUS cell whose dataset was supplied as a raw StreamingSource streams its
          // column CHUNK-BY-CHUNK, PROGRESSIVELY re-coloring with an evolving KLL p1/p99 domain that
          // CONVERGES to the full-array domain (the raster path's model). A legacy DataSource cell (no
          // raw stream — the gallery/tests) has `getStreamingSource` = null and falls through to the
          // whole-column min/max path below, byte-identical. (Sparse `value` columns densify upstream,
          // so only `continuous` takes the progressive path.)
          const streamingSrc =
            cb.mode === 'continuous' && cell.datasetId
              ? stores.datasetStore.getState().getStreamingSource(cell.datasetId)
              : null
          if (streamingSrc) {
            let finalNatural: Natural | null = null
            try {
            // ITEM-15: the pass's `AbortSignal`, threaded through `streamColumnDomain` into
            // `source.stream(channel, opts)`. Before this the call took NO signal, so a rapid
            // colour-by switch left N full column reads running to completion with only `alive`
            // discarding their results afterwards.
            for await (const frame of streamColumnDomain(
              streamingSrc,
              { kind: 'continuous', key: cb.key },
              { signal: ac.signal },
            )) {
              if (!alive) return
              const shaded = continuousColors(frame.values, {
                colormap: cb.colormap,
                scale: cb.scale,
                zeroTransparent: false,
                domain: [frame.domain[0], frame.domain[1]],
              })
              if (frame.final) {
                // The converged natural (KLL p1/p99 domain) feeds the linked-union + final batched set.
                finalNatural = {
                  id: cell.id,
                  datasetId: cell.datasetId ?? null,
                  colorBy: cb,
                  colors: shaded.colors,
                  values: frame.values.slice(),
                  domain: [frame.domain[0], frame.domain[1]],
                  linked: !!cell.linkColorScale,
                }
              } else {
                // Progressive intermediate frame: re-color JUST this cell as chunks arrive (the final
                // batched `setPerCellColors(next)` below lands the converged colors + the linked union).
                cellDisplay.getState().updateColors(prev => ({ ...prev, [cell.id]: { colors: shaded.colors, epoch: (epochRef.current += 1) } }))
              }
            }
            } catch (err) {
              // ITEM-15 made cancellation ROUTINE, so an aborted stream is the EXPECTED end of a
              // superseded pass, not a failure: swallow it (the `finally` above still settles the
              // claimed cache slot, and this pass's results are discarded anyway). Anything else is a
              // genuine read failure and still propagates — a blanket catch here would turn every
              // unreadable column into a silently uncoloured cell.
              if (!ac.signal.aborted) throw err
              return
            }
            if (finalNatural) {
              naturals.push(finalNatural)
              // ITEM-12: settle the slot claimed for this column so the legend effect's
              // `computeColoring` + `src.continuous` are served from the bytes ALREADY streamed here,
              // instead of issuing the second and third reads this item exists to remove.
              const k = readKey(cell.datasetId, 'continuous', cb.key)
              const slot = streamedSlots.get(k)
              if (slot && finalNatural.values) {
                streamedSlots.delete(k)
                slot.resolve({ value: finalNatural.values, length: finalNatural.values.length })
              }
            }
            continue
          }
          const dense =
            cb.mode === 'value'
              ? densify(await cellSrc.valueColumn(cb.key))
              : (await cellSrc.continuous(cb.key)).value
          if (!alive) return
          colorData[cell.id] = { column: cb.key, categorical: false, values: dense }
          const { colors, domain } = continuousColors(dense, {
            colormap: cb.colormap,
            scale: cb.scale,
            zeroTransparent: cb.mode === 'value',
          })
          naturals.push({
            id: cell.id,
            datasetId: cell.datasetId ?? null,
            colorBy: cb,
            colors,
            values: dense,
            domain: [domain[0], domain[1]],
            linked: !!cell.linkColorScale,
          })
        }
      }
      // 2. Union the domains of LINKED cells sharing a key (ITEM-64). MD-9: the link key is scoped by
      //    dataset so two cells coloring by the same column NAME over DIFFERENT datasets don't union
      //    (they're unrelated series); same-dataset (incl. all-default) cells link exactly as before.
      const effective = resolveLinkedCellDomains(
        naturals
          .filter(n => n.domain)
          .map(n => ({
            id: n.id,
            key: datasetLinkKey(n.datasetId, n.colorBy.key),
            domain: n.domain!,
            linked: n.linked,
          })),
      )
      // 3. Recolor a linked cell ONLY when its union domain differs from its own
      //    (a cell that already owns the widest domain reuses its natural colors).
      const next: Record<string, { colors: Uint8Array; epoch: number }> = {}
      for (const n of naturals) {
        let colors = n.colors
        const eff = n.domain ? effective[n.id] : undefined
        if (
          n.values &&
          n.domain &&
          eff &&
          (eff[0] !== n.domain[0] || eff[1] !== n.domain[1])
        ) {
          colors = continuousColors(n.values, {
            colormap: n.colorBy.colormap,
            scale: n.colorBy.scale,
            zeroTransparent: n.colorBy.mode === 'value',
            domain: eff,
          }).colors
        }
        // LINK FILTERING: mask points whose value in a FILTER COLUMN is a hidden code — cross-column, so a
        // linked plot coloring by a DIFFERENT column (e.g. a QC-metric scatter) still drops the points a
        // linked plot hid on the GROUP column. Clone before masking so the natural buffer isn't mutated.
        const gf = linkColumnFilterFor(n.id)
        if (gf) {
          const cellSrc = srcFor(cellMapRef.current[n.id] as (typeof denseCellsRef.current)[number])
          if (cellSrc) {
            let masked: Uint8Array | null = null
            // Category hides: fetch the categorical column, zero the alpha of hidden-code points.
            for (const [column, codes] of Object.entries(gf.hiddenCols)) {
              if (codes.size === 0) continue
              const col = await cellSrc.categorical(column)
              if (!alive) return
              if (!masked) masked = colors.slice()
              const nPts = Math.min(col.codes.length, masked.length / 4)
              for (let i = 0; i < nPts; i++) if (codes.has(col.codes[i])) masked[i * 4 + 3] = 0
            }
            // Value windows: fetch the continuous column, zero the alpha of out-of-range points.
            for (const [column, [lo, hi]] of Object.entries(gf.valueCols)) {
              const vals = (await cellSrc.continuous(column)).value
              if (!alive) return
              if (!masked) masked = colors.slice()
              const nPts = Math.min(vals.length, masked.length / 4)
              for (let i = 0; i < nPts; i++) if (vals[i] < lo || vals[i] > hi) masked[i * 4 + 3] = 0
            }
            if (masked) colors = masked
          }
        }
        next[n.id] = { colors, epoch: (epochRef.current += 1) }
      }
      if (!alive) return
      cellDisplay.getState().replaceColors(next)
      cellDisplay.getState().replaceColorData(colorData)
      } finally {
        // ITEM-12 — never leave a claimed slot unresolved. A pass that returned early (cancelled, or
        // a cell that errored before its stream converged) would otherwise leave the legend awaiting
        // a promise nothing settles. Reject and drop the slot; the legend's own `catch` renders that
        // cell without a legend, which is the pre-existing behaviour for an unreadable column.
        for (const [k, slot] of streamedSlots) {
          readCache.delete(k)
          slot.reject(new Error('useGridColoring: colour pass ended before the streamed column landed'))
        }
      }
    })().catch(err => {
      // ITEM-15 leg (b) made the DATA-SOURCE-shaped reads abortable too (`cellSrc.categorical` /
      // `.continuous` / `.valueColumn` now carry the pass signal), so a superseded pass ends by
      // REJECTION where it previously ran to completion. That is the expected end of a cancelled
      // pass, not a failure — swallow it. Anything else is a genuine read failure and still
      // surfaces exactly as it did before this item, rather than being hidden by a blanket catch.
      if (!ac.signal.aborted) throw err
    })
    return () => {
      alive = false
      // ITEM-15: cancel for real, rather than discarding a completed read's result.
      ac.abort()
    }
    // `colorSig` + `source` + `colorDatasetSig` (dataset-ready transitions) are the real inputs;
    // `denseCells`/`datasetEntries` are read via ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorSig, source, colorDatasetSig])

  // WYSIWYG (ITEM-10/11): resolve each dense colorBy cell's legend descriptor (+ continuous values for
  // the value-range filter) from the SAME `computeColoring` the export uses — additive, no coloring-
  // pipeline change. Runs on the same `colorSig` trigger as `perCellColors`.
  useEffect(() => {
    let alive = true
    // ITEM-15 leg (b): the legend plane cancels its OWN reads too. Its first read of a column is the
    // uncached one whenever the recolor effect did not stream it — a categorical or `value` colour-by,
    // or a continuous cell on a legacy non-streaming source — which is precisely the case the pass
    // cache alone could not cancel.
    const ac = new AbortController()
    const srcFor = (cell: (typeof denseCellsRef.current)[number]): DataSource | null =>
      sourceForCell(cell.datasetId, source, id => datasetEntriesRef.current[id]?.source ?? null)
    const cells = denseCellsRef.current.filter(c => c.colorBy && (!c.datasetId || srcFor(c)))
    void (async () => {
      const next: Record<string, CellLegend> = {}
      for (const cell of cells) {
        // Plot-editing: the WYSIWYG legend descriptor must reflect the live edits too, so its swatches
        // + labels match the recolored plot. Merge the same override bundle onto the colorBy.
        const cb = withColorOverrides(cell.colorBy as ColorBy, colorOverridesRef.current)
        const srcRaw = srcFor(cell)
        if (!srcRaw) continue
        // ITEM-12: the SAME pass cache the recolor effect above populated. On the streaming path the
        // recolor effect has already claimed this column's slot (synchronously, before this effect
        // ran), so `computeColoring` and the `continuous`/`categorical` reads below JOIN that one
        // read instead of issuing a second and a third.
        const src = withPassCache(srcRaw, cell.datasetId, readCache, ac.signal)
        try {
          const coloring = await computeColoring(src, cb)
          if (!alive) return
          const descriptor = coloring.blend?.legend2d ?? coloring.colorbar ?? coloring.legend
          if (!descriptor) continue
          const entry: CellLegend = { descriptor, title: cell.legendTitle ?? cb.key }
          if (coloring.colorbar) {
            const col = await src.continuous(cb.key)
            if (!alive) return
            entry.values = col.value
            entry.domain = [coloring.colorbar.domain[0], coloring.colorbar.domain[1]]
            entry.colormap = coloring.colorbar.colormap
          } else if (coloring.legend && (cell.colorBy as ColorBy).mode === 'categorical') {
            // Plot-editing (ITEM-2): a SINGLE-column categorical legend — capture the RAW category
            // names (source-truth, override-independent) + the column id for the editable in-cell
            // legend, whose by-name overrides key on the RAW name. (A composite/blend legend's codes
            // index a cross-product domain, so it stays read-only — no rawLabels captured.)
            //
            // ITEM-12 corrects what this comment used to claim: *"the source caches this fetch
            // (computeColoring already read it), so it's ~free."* It was FALSE on the streaming path
            // — `asDataSource` memoizes the CATALOG only (`streamingAdapter.ts:37-41`) — and a
            // comment asserting a cache that does not exist is what let the extra reads survive
            // review. The cache is now real, and it is the `withPassCache` wrapper above.
            const cat = await src.categorical((cell.colorBy as ColorBy).key)
            if (!alive) return
            entry.rawLabels = cat.categories
            entry.columnId = (cell.colorBy as ColorBy).key
          }
          next[cell.id] = entry
        } catch {
          // a cell whose source/column isn't ready yet simply gets no legend this pass
        }
      }
      if (alive) cellDisplay.getState().replaceLegend(next)
    })()
    return () => {
      alive = false
      ac.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorSig, source, colorDatasetSig])

  // GROUP legends for grouped charts (box/violin/bar/dotplot/heatmap): resolve each cell's GROUP column,
  // fetch its categories, and build a categorical legend folding in the colorOverride store (so the form's
  // swatches show the effective per-group colors + display labels). Depends on `colorOverrides` so a
  // recolor/rename updates the form's swatches live; the categorical fetch is source-cached, so re-runs
  // are cheap. Skips dense cells (no group channel) + cells whose source/column isn't ready.
  useEffect(() => {
    if (!catalog) return
    let alive = true
    void (async () => {
      const next: Record<string, CellLegend> = {}
      for (const cell of cells) {
        if (denseIds.has(cell.id)) continue
        const desc = getChartType(cell.kind)
        if (!desc?.bindingSchema?.some(ch => ch.id === 'group')) continue
        const src = sourceForCell(cell.datasetId, source, id => datasetEntriesRef.current[id]?.source ?? null)
        if (!src) continue
        try {
          const model = makeChartModel(cell, desc.bindingSchema ?? [], catalog, cell.bindings)
          const groupCol = bindingValue(model.bindings, 'group')
          if (!groupCol) continue
          const cat = await src.categorical(groupCol)
          if (!alive) return
          const ov = overridesForColumn(colorOverridesRef.current, groupCol)
          next[cell.id] = {
            descriptor: legendDescriptor(cat.categories, ov),
            rawLabels: cat.categories,
            columnId: groupCol,
            title: cell.legendTitle ?? groupCol,
          }
        } catch {
          // a grouped cell whose source/group column isn't ready yet gets no legend this pass
        }
      }
      if (alive) cellDisplay.getState().replaceGroupLegend(next)
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, source, colorOverrides, colorDatasetSig, catalog, denseIds])

  // ── read-only DEBUG seam: the per-cell COLOUR BUFFER (owner-granted 2026-08-16) ───────────────
  //
  // WHY IT IS HERE AND NOT APP-SIDE. The owner's grant says prefer an app-side seam and reach into
  // viz only if the colour buffer genuinely cannot be observed from `src-app/ui`. It cannot, and
  // the obstacle was re-checked rather than inherited: the buffer lives in the per-workspace
  // `CellDisplay` store, minted by `GridWorkspace.tsx`'s `useState(createCellDisplayStore)` and
  // handed down by context. It is NOT one of `VizStores`' five members, so `defaultVizStores` —
  // the only viz state `window.__canvasPanes` can reach — does not contain it and cannot be made
  // to. `__canvasPanes` reports identity / space / row count precisely because that is all the
  // DatasetStore entry holds.
  //
  // This module is the buffer's WRITER (`replaceColors` above), so the seam sits with the state it
  // publishes — the same rule `useGridDevSeams`' header states for `__vizAnnotateStores`. It costs
  // ZERO new viz files: this is granted file #3.
  //
  // READ-ONLY and DEBUG-ONLY. It exposes a COPY (`Array.from`) so a spec cannot mutate the buffer
  // the deck uploads, and it is gated exactly like the app's `__cyto_read` / `__cyto_count_decodes`
  // — the Vite dev server, or the e2e preview build's `VITE_ENABLE_TEST_SEAMS=1`. A release bundle
  // sets neither, so `import.meta.env.DEV` folds to `false` and the whole block is dropped.
  //
  // WHAT IT IS FOR. TEST-53 asserts that the settled raster shades the RIGHT points with the RIGHT
  // colours, and TEST-28 that an emitted colour-by plot keeps its category set. Neither is
  // expressible against a point COUNT: a buffer with every point shaded identically has the right
  // count and the right length, which is the exact defect TEST-53 exists to catch. Only the
  // per-row bytes discriminate it, so the per-row bytes are what this returns.
  // A REGISTRY, not a single handle, and that is a correction made on measurement rather than a
  // precaution. The first shape assigned `window.__vizPaneColors` from this effect and cleared it
  // on cleanup — so ANY second `GridWorkspace` (a popout, a recursive child, a workspace that
  // mounts and unmounts) either shadowed the primary's store or wiped the handle entirely. That is
  // the same hazard `useGridDevSeams` answers with an `isPrimaryWorkspace` gate, which this plane
  // cannot use because it never receives a `containerId`. Registering the STORE and reading the
  // union answers it without a new input, and a workspace that unmounts removes only its own.
  useEffect(() => {
    if (!DEBUG_SEAMS_ENABLED) return
    LIVE_COLOR_STORES.add(cellDisplay)
    return () => {
      LIVE_COLOR_STORES.delete(cellDisplay)
    }
  }, [cellDisplay])
}

/** Every live workspace's `CellDisplay` store. Module-level so the window handle is installed ONCE,
 *  at module load, and never races a mount. */
const LIVE_COLOR_STORES = new Set<CellDisplayStore>()

if (DEBUG_SEAMS_ENABLED && typeof window !== 'undefined') {
  ;(window as unknown as { __vizPaneColors?: unknown }).__vizPaneColors = (): Record<string, CellColorSeam> => {
    const out: Record<string, CellColorSeam> = {}
    for (const store of LIVE_COLOR_STORES) {
      const s = store.getState()
      for (const [cellId, cc] of Object.entries(s.colors)) {
        const legend = s.legend[cellId]
        const cd = s.colorData[cellId]
        out[cellId] = {
          epoch: cc.epoch,
          points: Math.floor(cc.colors.length / 4),
          // A COPY. The live buffer is the one the deck layer uploads.
          rgba: Array.from(cc.colors),
          legend: legend
            ? {
                title: legend.title,
                columnId: legend.columnId ?? null,
                rawLabels: legend.rawLabels ? [...legend.rawLabels] : null,
              }
            : null,
          colorData: cd ? { column: cd.column, categorical: cd.categorical } : null,
        }
      }
    }
    return out
  }
}

/** What `window.__vizPaneColors()` reports for ONE grid cell. Named so the e2e's own reader type
 *  and this producer cannot drift apart silently. */
export interface CellColorSeam {
  /** The colour epoch — the deck layer's `updateTriggers` key. Bumps when the buffer moves. */
  epoch: number
  /** Rows in the buffer (`rgba.length / 4`). */
  points: number
  /** The per-row RGBA bytes, flat and row-major. A COPY of the live buffer. */
  rgba: number[]
  /** The cell's categorical legend, when it has one: the RAW category names indexed by code. */
  legend: { title: string; columnId: string | null; rawLabels: string[] | null } | null
  /** Which column the cell is coloured BY, and whether that column is categorical. */
  colorData: { column: string; categorical: boolean } | null
}
