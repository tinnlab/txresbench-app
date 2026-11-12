// DatasetStore.ts — the per-dataset OWNED-DATA store (MULTI-DATASOURCE / ITEM-7 / DEC-4).
//
// Multi-datasource generalizes GridWorkspace's single data-ownership-inversion pull to a MAP of
// datasets keyed by id. Each entry owns one dataset's resolved `DataSource` + `catalog` +
// (lazily-pulled, per-layout) positions + a base default-color buffer + its canonical `pointIds`
// namespace (DEC-M6, for cross-dataset auto-link). Datasets are REF-COUNTED by the cells that
// reference them (DEC-5): `acquire` resolves-or-reuses (refCount++), `release` decrements and
// EVICTS the entry at 0 (dropping the source + GPU-bound buffers — no LRU keep-warm).
//
// A dataset id resolves through the injected `resolveDataset` (set once by the controller / `<Viz>`),
// so GridWorkspace's progressive-add can `acquire` a new id without knowing the app's resolver.
// Plain-zustand (no immer), matching the other four viz stores.

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { DataSource, DatasetCatalog } from '../viz-core/data/wire'
import { computeColoring, DEFAULT_COLOR_BY } from '../viz-core/data/engine'
import type { StreamingSource, StreamingResolver } from '../viz-core/data/streamingSource'
import { asDataSource } from '../viz-core/data/streamingAdapter'
import { reframeBytes, asFloat32 } from '../viz-core/data/fetchStream'

/** How a dataset id → `DataSource` (the app owns the concrete impl); mirrors `VizController`'s resolver. */
export type DatasetResolver = (id: string) => DataSource | Promise<DataSource>

export type DatasetStatus = 'loading' | 'ready' | 'error'

/** The neutral gray a dataset falls back to when its default color-by column is absent (shared with
 *  GridWorkspace's identical synthesis; RGBA per point). */
export const NEUTRAL_GRAY: readonly [number, number, number, number] = [160, 160, 160, 255]

/** Bytes per positions row on the `f32` wire — interleaved xy, 2 × Float32 (`LayoutEncoding.stride`). */
const POSITIONS_BYTES_PER_ROW = 8
/**
 * Rows per published positions PREFIX (ITEM-9). Stated EXPLICITLY rather than left to
 * `reframeBytes`' 65536-row default, which is the trap DRIFT-1.33 records: at the default, any
 * layout below 65536 rows coalesces into ONE batch and paints in a single step while LOOKING like a
 * working progressive path. 8192 matches the producer's `EMBEDDING_INNER_CHUNK`
 * (`src-app/packages/_lib/txr_columns.py:75`), so one published prefix ≙ one arrived inner chunk
 * and no batch waits on bytes from the next one.
 */
const POSITIONS_ROWS_PER_BATCH = 8192

/** One dataset's owned data + lifecycle. `positionsByLayout` is pulled lazily per layout id. */
export interface DatasetEntry {
  readonly id: string
  status: DatasetStatus
  source: DataSource | null
  catalog: DatasetCatalog | null
  /** canonical id namespace (DEC-M6); null ⇒ the dataset is an isolated identity space. */
  pointIds: Uint32Array | null
  /** interleaved xy per layout id (lazy). */
  positionsByLayout: Record<string, Float32Array>
  /** base default coloring (RGBA); a per-cell colorBy overrides it downstream. */
  colors: Uint8Array | null
  /** bumps when `colors`/positions content changes so deck re-uploads. */
  epoch: number
  /** number of referencing cells; entry is evicted at 0. */
  refCount: number
  error?: unknown
  /** monotonic generation stamped at (re-)creation — a stale in-flight resolve whose gen no longer
   *  matches the live entry MUST NOT clobber it (evict→re-acquire race guard). */
  gen: number
  /** the `VizDataset.rev` CONTENT token this entry was last resolved under (DEC-4), or `undefined`
   *  when every acquire so far expressed no opinion. An acquire naming a DIFFERENT rev supersedes
   *  the entry (re-resolve in place); the same rev — or none — is cheap identity reuse. */
  rev?: string | number
  /** the in-flight resolve promise (present while `status === 'loading'`), so a REUSE acquire can
   *  await the first acquisition reaching a terminal status instead of returning early. */
  loading?: Promise<void>
}

export interface DatasetStoreState {
  /** dataset id → entry. */
  datasets: Record<string, DatasetEntry>
  /** the injected resolver (set once by the controller / `<Viz>`). */
  resolver: DatasetResolver | null
}

export interface DatasetStoreActions {
  /** Install the id→source resolver (the controller / `<Viz>` sets this before any acquire). */
  setResolver: (resolve: DatasetResolver | null) => void
  /**
   * Install the id→`StreamingSource` resolver — the ONE data-input seam (ITEM-12 / DEC-2). Each resolved
   * `StreamingSource` is wrapped with `asDataSource` at the store boundary, so all downstream store logic
   * (positionsByLayout / catalog / pointIds / colors) is byte-identical to the legacy `DataSource` path.
   * Setting this REPLACES the installed `resolver` (they share the one `resolver` slot); pass `null` to clear.
   */
  setStreamingResolver: (resolve: StreamingResolver | null) => void
  /** Register an inline `DataSource` for `id` WITHOUT taking a ref — a later `acquire(id)` (e.g. from
   *  GridWorkspace's render-ref reconcile) resolves it from this override instead of the resolver. Used
   *  by progressive-add-with-source so the render owner, not the caller, holds the ref. */
  provideSource: (id: string, source: DataSource) => void
  /** `provideSource` for a `StreamingSource` — wraps it with `asDataSource` (ITEM-12), so the streaming
   *  source flows the identical override path. Used by progressive-add with a streaming source. */
  provideStreamingSource: (id: string, source: StreamingSource) => void
  /**
   * Reference a dataset: reuse if already present (refCount++), else resolve it (via an inline
   * `source` or the installed resolver) into a fresh entry, then pull its catalog + `pointIds`.
   * Returns when the entry reaches a terminal status (ready/error). Idempotent per id.
   *
   * `rev` is the declaration's CONTENT-invalidation token (`VizDataset.rev`, DEC-4). Acquiring an
   * id ALREADY held under a DIFFERENT rev SUPERSEDES it — the entry is re-resolved IN PLACE (same
   * id, same identity space, existing refs kept, stale buffers dropped) so a host whose content
   * changed under a stable id gets the new content. The same rev — or no rev at all — is the
   * unchanged, cheap identity reuse.
   */
  acquire: (id: string, source?: DataSource, rev?: string | number) => Promise<void>
  /** Drop one reference; EVICT the entry (source + buffers) when refCount hits 0. */
  release: (id: string) => void
  /** Lazily pull a dataset's positions for `layoutId` (+ the base default colors once). */
  ensureBuffers: (id: string, layoutId: string) => Promise<void>
  getEntry: (id: string) => DatasetEntry | null
  /** The RAW `StreamingSource` for `id` (from `provideStreamingSource`/the streaming resolver), if the
   *  dataset was supplied as a stream — the seam the GRID progressive-domain path (ITEM-11) taps to
   *  read a continuous column chunk-by-chunk. `null` for a legacy `DataSource`-backed dataset. */
  getStreamingSource: (id: string) => StreamingSource | null
  reset: () => void
}

function emptyEntry(id: string, gen: number): DatasetEntry {
  return {
    id,
    status: 'loading',
    source: null,
    catalog: null,
    pointIds: null,
    positionsByLayout: {},
    colors: null,
    epoch: 0,
    refCount: 0,
    gen,
  }
}

export function createDatasetStore() {
  // Non-reactive per-store scratch: a monotonic generation (evict-race guard), inline source overrides
  // (provideSource), and in-flight `ensureBuffers` promises (dedupe concurrent per-cell pulls).
  let genCounter = 0
  const overrides = new Map<string, DataSource>()
  // The RAW StreamingSource per id (ITEM-11) — kept ALONGSIDE the asDataSource wrapper so the grid
  // progressive-domain path can read a column chunk-by-chunk. Populated by provideStreamingSource +
  // the streaming resolver; cleared on evict/reset with `overrides`.
  const streamingSources = new Map<string, StreamingSource>()
  const bufferPulls = new Map<string, Promise<void>>()

  return create<DatasetStoreState & DatasetStoreActions>()(
    subscribeWithSelector((set, get) => {
      /**
       * Resolve `id` (inline override → installed resolver) into the entry stamped with `gen`, then
       * flip it to a terminal status. ONE resolution body shared by the FRESH acquire and the `rev`
       * SUPERSEDE, so the two paths cannot drift. A resolve whose entry was evicted OR re-created
       * under a NEWER generation while we awaited bails without clobbering the live entry.
       */
      const resolveInto = (id: string, gen: number): Promise<void> =>
        (async () => {
          try {
            const override = overrides.get(id)
            const resolve = override ? () => override : get().resolver
            if (!resolve) throw new Error(`[viz] DatasetStore: no resolver installed for dataset "${id}"`)
            const src = await resolve(id)
            const catalog = await src.catalog()
            // Canonical id namespace is OPTIONAL — absent ⇒ isolated identity space (null).
            let pointIds: Uint32Array | null = null
            if (src.pointIds) {
              try {
                pointIds = await src.pointIds()
              } catch {
                pointIds = null // a failed namespace pull ⇒ treat as isolated, never crash the dataset
              }
            }
            // Bail if the entry was evicted OR re-created (a newer generation) while we awaited.
            const cur = get().datasets[id]
            if (!cur || cur.gen !== gen) return
            set(prev => ({
              datasets: {
                ...prev.datasets,
                [id]: { ...prev.datasets[id], status: 'ready', source: src, catalog, pointIds, loading: undefined },
              },
            }))
          } catch (err) {
            const cur = get().datasets[id]
            if (!cur || cur.gen !== gen) return
            set(prev => ({
              datasets: { ...prev.datasets, [id]: { ...prev.datasets[id], status: 'error', error: err, loading: undefined } },
            }))
          }
        })()

      /**
       * Await `id` until it holds NO in-flight load — i.e. until the entry it names has reached a
       * terminal status (or is gone). NOT a single `await entry.loading`: a concurrent acquire at a
       * NEWER `rev` replaces the in-flight load mid-await, and a caller that stopped at the first
       * promise would return while the entry is loading again and read a null catalog. Terminates:
       * each turn awaits a promise it has not already awaited, and only re-loops if a NEW one appeared.
       */
      const settle = async (id: string): Promise<void> => {
        let awaited: Promise<void> | undefined
        for (;;) {
          const inflight = get().datasets[id]?.loading
          if (!inflight || inflight === awaited) return
          awaited = inflight
          await inflight
        }
      }

      return {
        datasets: {},
        resolver: null,

        setResolver: resolve => set(() => ({ resolver: resolve })),
        setStreamingResolver: resolve =>
          set(() => ({
            // Wrap each resolved StreamingSource with `asDataSource` at the boundary — everything below is
            // the unchanged DataSource path (DEC-2 forcing function; the bridge is the ONLY difference).
            // ALSO stash the RAW source (ITEM-11) so the grid progressive-domain path can read chunks.
            resolver: resolve
              ? async (id: string) => {
                  const s = await resolve(id)
                  streamingSources.set(id, s)
                  return asDataSource(s)
                }
              : null,
          })),
        provideSource: (id, source) => {
          overrides.set(id, source)
        },
        provideStreamingSource: (id, source) => {
          overrides.set(id, asDataSource(source))
          streamingSources.set(id, source) // keep the raw source for the grid progressive path (ITEM-11)
        },

        acquire: async (id, source, rev) => {
          if (source) overrides.set(id, source)
          const existing = get().datasets[id]
          // SUPERSEDE (DEC-4 `rev`): the id is already held, but the caller declared a DIFFERENT content
          // revision — the entry's data is stale, so re-resolve it. IN PLACE, deliberately:
          //  • ONE entry per id, so revisions can never accumulate (an evict+re-create keyed per rev
          //    would grow the store by one entry per keystroke of a live-editing host);
          //  • the existing holders' refCount is CARRIED, so a pane that is still rendering this id
          //    keeps its reference — and its identity space, which an id change would silently reset;
          //  • the generation bump is what invalidates the work in flight: the old resolve and any old
          //    `ensureBuffers` pull already bail on a gen mismatch, so neither can clobber the new one.
          // The buffers are cleared (not kept for a flash-free swap) because `ensureBuffers` early-returns
          // on a present `positionsByLayout[layout]` — keeping them would pin the OLD content forever,
          // which is the exact defect `rev` exists to fix.
          if (existing && rev !== undefined && existing.rev !== rev) {
            const gen = ++genCounter
            const load = resolveInto(id, gen)
            set(prev => {
              // `cur` is normally the entry read above; it is absent only if a `release` evicted it in
              // between, in which case this acquire is simply the FIRST holder again — never a lost ref.
              const cur = prev.datasets[id]
              return {
                datasets: {
                  ...prev.datasets,
                  [id]: {
                    ...emptyEntry(id, gen),
                    rev,
                    refCount: (cur?.refCount ?? 0) + 1, // every existing holder, plus THIS acquire
                    epoch: (cur?.epoch ?? 0) + 1, // monotonic per id ⇒ deck re-uploads over the dropped buffers
                    loading: load,
                  },
                },
              }
            })
            await settle(id)
            return
          }
          if (existing) {
            // Reuse: bump the ref count, then AWAIT the in-flight load so a rapid re-acquire of a
            // still-loading id sees a terminal status (a ready catalog) rather than returning early.
            // A rev equal to the recorded one (or none at all) lands here — the cheap identity reuse
            // this store exists for. A no-opinion acquire never CLEARS the recorded rev: forgetting it
            // would make the next re-publish of the same rev a spurious re-resolve.
            set(prev => ({
              datasets: {
                ...prev.datasets,
                [id]: { ...prev.datasets[id], refCount: prev.datasets[id].refCount + 1 },
              },
            }))
            await settle(id)
            return
          }
          // Fresh entry (refCount 1, loading). Stamp a generation so a stale resolve (after an
          // evict→re-acquire) can't clobber the live entry.
          const gen = ++genCounter
          const load = resolveInto(id, gen)
          set(prev => ({ datasets: { ...prev.datasets, [id]: { ...emptyEntry(id, gen), rev, refCount: 1, loading: load } } }))
          await settle(id)
        },

        release: id => {
          set(prev => {
            const entry = prev.datasets[id]
            if (!entry) return {}
            const refCount = entry.refCount - 1
            if (refCount > 0) {
              return { datasets: { ...prev.datasets, [id]: { ...entry, refCount } } }
            }
            // Evict at 0: drop the source + buffers.
            const next = { ...prev.datasets }
            delete next[id]
            return { datasets: next }
          })
          // On eviction, also clear the module-closure scratch for this id (a provideSource'd source and
          // any in-flight buffer pulls) so add→remove of many distinct datasets can't grow it unboundedly.
          if (!get().datasets[id]) {
            overrides.delete(id)
            streamingSources.delete(id)
            // The separator is part of the match, not decoration: a pull key is
            // `<datasetId>::<layoutId>::<gen>`, so a bare `startsWith(id)` would evict `ds10`'s
            // in-flight pulls when `ds1` is dropped. (A DIFFERENT vocabulary from the layer ids in
            // `layers/layerIds.ts` — same separator, same trap, resolved the same way.)
            for (const k of bufferPulls.keys()) if (k.startsWith(`${id}::`)) bufferPulls.delete(k)
          }
        },

        ensureBuffers: async (id, layoutId) => {
          const entry = get().datasets[id]
          if (!entry || entry.status !== 'ready' || !entry.source) return
          if (entry.positionsByLayout[layoutId]) return // already pulled
          // Dedupe concurrent pulls: N cells sharing a (dataset, layout) trigger ONE fetch.
          const pullKey = `${id}::${layoutId}::${entry.gen}`
          const inflight = bufferPulls.get(pullKey)
          if (inflight) return inflight
          const src = entry.source
          const gen = entry.gen
          const pull = (async () => {
            try {
              // ── THE DEFAULT COLORING ASKS THE CATALOG, IT DOES NOT GUESS A COLUMN NAME ──────────
              //
              // This call used to be `computeColoring(src, DEFAULT_COLOR_BY)` guarded ONLY by the
              // `catch` below — the unguarded sibling of the identical call in
              // `useGridData.pullOwnedData`, which was fixed and this one was not. `DEFAULT_COLOR_BY`
              // names the literal column `'group'`, which is what the in-package fixtures call their
              // grouping while a real host source addresses columns by artifact id. A source that does
              // NOT publish that column answers in one of two ways, and the `catch` only ever covered
              // one of them:
              //
              //   • it THROWS (a host source rejecting a key it cannot address) → caught → neutral. Fine.
              //   • it returns ONE SYNTHETIC UNGROUPED CATEGORY — the frame-backed canvas source does
              //     this deliberately, because "group these rows by nothing" is a real answer. That one
              //     category then took palette slot 0, and slot 0 of Okabe-Ito is [0,0,0]: the WHOLE
              //     dataset painted BLACK, under a legend claiming a category called "All". No throw,
              //     so no catch, so silent — and invisible against a dark theme.
              //
              // So the key is checked against the CATALOG first, exactly as `pullOwnedData` does. A
              // dataset that genuinely publishes the default column is coloured by it as before; one
              // that does not is never asked, and gets the neutral buffer this store already defines.
              // Neutral is the honest answer for "nobody chose a colour-by and the data cannot serve the
              // default one": legible on either theme, not a palette slot (so it cannot collide with a
              // real category 0), and it claims no category that does not exist.
              //
              // The catalog read stays INSIDE the coloring try (and prefers the one the entry already
              // resolved at acquire) so a catalog failure degrades to neutral too, rather than rejecting
              // a pull whose positions read fine.
              const neutral = (n: number) => {
                const buf = new Uint8Array(n * 4)
                for (let i = 0; i < n; i++) {
                  buf[i * 4] = NEUTRAL_GRAY[0]
                  buf[i * 4 + 1] = NEUTRAL_GRAY[1]
                  buf[i * 4 + 2] = NEUTRAL_GRAY[2]
                  buf[i * 4 + 3] = NEUTRAL_GRAY[3]
                }
                return buf
              }
              const synthesizeColors = async (n: number): Promise<Uint8Array> => {
                try {
                  const catalog = entry.catalog ?? (await src.catalog())
                  const catalogServesDefault = catalog.categoricalColumns.some(
                    c => c.id === DEFAULT_COLOR_BY.key,
                  )
                  // Still best-effort even when the catalog DOES advertise the column: an advertised
                  // column can still fail to read, and that must not block a render whose cells may need
                  // no colors at all.
                  return catalogServesDefault
                    ? (await computeColoring(src, DEFAULT_COLOR_BY)).colors
                    : neutral(n)
                } catch {
                  return neutral(n)
                }
              }

              // ── ITEM-9 (RESTATED) + ITEM-10: the PROGRESSIVE positions fill ─────────────────────
              //
              // The plan routed progressive paint through `CpuRasterView` via
              // `spatial/CategoricalPointsView.tsx`. That component has NO production consumer — it is
              // exported from neither `index.ts` nor `core.ts`, the app never imports it, and the grid
              // draws dense cells in the SHARED deck (`useGridDeckInputs` → `SelectableScatterLayer`,
              // reading `cellData(cell).positions`). Threading a batch stream to it would have been a
              // capability with no consumer — the rule that has twice stopped this merge. DRIFT-1.44.
              //
              // The grid's REAL positions input is this store field, and the deck memo already re-reads
              // it on every `set`. So progressive paint is delivered by PUBLISHING PREFIXES of the
              // positions buffer as chunks land, each with an `epoch` bump: deck's `data.length` is
              // `nPoints = positions.length / 2`, so a prefix draws exactly the rows that have arrived,
              // and the final publish is byte-identical to the whole-read path.
              //
              // ITEM-10 is what makes those prefixes RENDERABLE rather than colourless, and it is why
              // the two land as a pair: the colour buffer is synthesized from `catalog.pointCount` and
              // published BEFORE the first positions batch, instead of being sized from the materialized
              // positions. Without it every intermediate frame would paint against `EMPTY_COLORS`.
              //
              // ALIGNMENT (INV-3 / INV-10): each batch is written at its GLOBAL row offset into a buffer
              // sized from `catalog.pointCount`, and the colour buffer is sized from the SAME count — so
              // row *i* means the same cell in both, the colour buffer merely being LONGER than the
              // positions prefix while the fill is in flight. Deck reads only its first `nPoints`
              // entries, so the excess is inert.
              const streaming = streamingSources.get(id)
              const catalogForStream = streaming ? (entry.catalog ?? (await src.catalog())) : null
              const layoutEncoding = catalogForStream?.layouts.find(l => l.id === layoutId)?.encoding
              const totalRows = catalogForStream?.pointCount ?? 0
              // f32 ONLY. `packed-u16` carries a per-layout `packMeta` affine that belongs to
              // `streamDecode.decodePositionsStream`, and re-deriving it here would be a second copy of
              // a decode rule; that encoding takes the unchanged whole-read path below.
              const canStreamPositions =
                streaming != null &&
                totalRows > 0 &&
                layoutEncoding != null &&
                layoutEncoding.kind === 'f32'

              if (canStreamPositions && streaming) {
                // Colours FIRST and independent of the positions materialization (ITEM-10).
                const colors = await synthesizeColors(totalRows)
                {
                  const cur = get().datasets[id]
                  if (!cur || cur.gen !== gen) return // evicted / re-created mid-pull
                  set(prev => ({
                    datasets: {
                      ...prev.datasets,
                      [id]: {
                        ...prev.datasets[id],
                        colors: prev.datasets[id].colors ?? colors,
                        epoch: prev.datasets[id].epoch + 1,
                      },
                    },
                  }))
                }
                const full = new Float32Array(totalRows * 2)
                let filled = 0
                for await (const batch of reframeBytes(
                  streaming.stream({ kind: 'positions', layout: layoutId }),
                  { bytesPerRow: POSITIONS_BYTES_PER_ROW, rowsPerBatch: POSITIONS_ROWS_PER_BATCH },
                )) {
                  const cur = get().datasets[id]
                  if (!cur || cur.gen !== gen) return // evicted mid-stream: stop reading
                  const rows = asFloat32(batch)
                  // A batch beyond the declared row count is a producer/catalog disagreement; clamp
                  // rather than write out of bounds, and never publish a prefix longer than declared.
                  const writeAt = batch.offset * 2
                  if (writeAt >= full.length) break
                  const take = Math.min(rows.length, full.length - writeAt)
                  full.set(take === rows.length ? rows : rows.subarray(0, take), writeAt)
                  filled = Math.max(filled, (writeAt + take) / 2)
                  if (filled >= totalRows) break
                  // Publish the arrived PREFIX. `subarray(0, …)` keeps `byteOffset === 0`, so every
                  // consumer that builds a typed view over it stays legal.
                  const prefix = full.subarray(0, filled * 2)
                  set(prev => ({
                    datasets: {
                      ...prev.datasets,
                      [id]: {
                        ...prev.datasets[id],
                        positionsByLayout: { ...prev.datasets[id].positionsByLayout, [layoutId]: prefix },
                        epoch: prev.datasets[id].epoch + 1,
                      },
                    },
                  }))
                }
                const cur = get().datasets[id]
                if (!cur || cur.gen !== gen) return
                // The ARRIVED prefix, never the whole allocation.
                //
                // `full` is sized from `catalog.pointCount`; the stream is the artifact. When they
                // disagree — a catalog written before rows were dropped, a truncated member, an
                // empty stream — publishing `full` publishes ZERO PADDING AS DATA: the shortfall
                // renders as points stacked at the origin, `nPoints` reports the padded count, the
                // colour buffer is sized from the same count so nothing reads as undefined, and a
                // lasso selects the phantoms. An empty stream painted `pointCount` points at (0,0)
                // where the whole-read path below paints none.
                //
                // `filled` was already tracked for the in-loop prefixes and then dropped here. On a
                // complete read `filled === totalRows`, so this is byte-identical to the old
                // terminal publish; it differs only in the case that was wrong.
                const arrived = full.subarray(0, filled * 2)
                set(prev => ({
                  datasets: {
                    ...prev.datasets,
                    [id]: {
                      ...prev.datasets[id],
                      positionsByLayout: {
                        ...prev.datasets[id].positionsByLayout,
                        [layoutId]: arrived,
                      },
                      epoch: prev.datasets[id].epoch + 1,
                    },
                  },
                }))
                return
              }

              // ── the unchanged whole-read path (no streaming source, or a non-f32 encoding) ───────
              const pos = await src.positions(layoutId)
              const colors = await synthesizeColors(pos.positions.length / 2)
              const cur = get().datasets[id]
              if (!cur || cur.gen !== gen) return // evicted / re-created mid-pull
              set(prev => ({
                datasets: {
                  ...prev.datasets,
                  [id]: {
                    ...prev.datasets[id],
                    positionsByLayout: { ...prev.datasets[id].positionsByLayout, [layoutId]: pos.positions },
                    colors: prev.datasets[id].colors ?? colors,
                    epoch: prev.datasets[id].epoch + 1,
                  },
                },
              }))
            } catch {
              const cur = get().datasets[id]
              if (!cur || cur.gen !== gen) return
              set(prev => ({ datasets: { ...prev.datasets, [id]: { ...prev.datasets[id], status: 'error' } } }))
            } finally {
              bufferPulls.delete(pullKey)
            }
          })()
          bufferPulls.set(pullKey, pull)
          return pull
        },

        getEntry: id => get().datasets[id] ?? null,
        getStreamingSource: id => streamingSources.get(id) ?? null,

        reset: () => {
          overrides.clear()
          streamingSources.clear()
          bufferPulls.clear()
          set(() => ({ datasets: {}, resolver: get().resolver }))
        },
      }
    }),
  )
}

export type DatasetStore = ReturnType<typeof createDatasetStore>
export const useDatasetStore: DatasetStore = createDatasetStore()
