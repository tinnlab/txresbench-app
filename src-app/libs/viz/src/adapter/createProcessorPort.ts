// createProcessorPort.ts — the per-instance factory that mints a concrete `ProcessorPort`
// (ITEM-8) backing the annotation editor's EXTERNAL-processor seam. Mirrors the per-instance
// handle idiom of `adapter/coordinationHandle.ts:createCoordinationHandle` /
// `adapter/VizController.ts`: a host mints ONE port per image cell over an explicit `deps`
// set, so two cells' processors are fully independent (their commits land in different
// per-cell annotate stores, and their pending/mask sinks paint different overlays).
//
// The port is the ONLY surface an external processor (a segmentation/AI model, a WASM kernel,
// a remote service…) touches — the editor depends on NOTHING of any processor, and the
// factory imports NO AI / onnxruntime (INV-3). The two halves:
//
//   • READ (fresh snapshot per call, full-res px — INV-4): `getImageRef` / `getViewState` /
//     `getActiveGesture` forward the host-supplied getters (which read the coordination view
//     state + the annotate editor's active gesture). Stateless-per-call.
//   • WRITE: `commitPolygons` / `commitPoints` turn `GeoFeature[]` into the SAME
//     `AddAnnotationInput` a hand-drawn feature produces and route them through the per-cell
//     store's `commitResult` — so a committed result is INDISTINGUISHABLE from hand-drawn
//     (undo / reshape / export / link all apply, DEC-E). `commitLabelMask` ALSO routes through
//     the store (a placeholder footprint annotation records the mask commit in the undo stack +
//     GeoJSON export, INV-6) while the raster itself paints via the injected `onMask` sink; a
//     store subscription reconciles the sink so Undo/Redo of that entry hides/re-shows the mask.
//     `setPending` flips the display-only progress flag (the injected `onPending` sink) — it
//     NEVER runs inference (INV-3).
//
// ONE RUN = ONE UNDO ENTRY (INV-6): every commit (vector OR mask, first run OR update-by-group
// replace) lands as EXACTLY ONE undoable atom. The factory drives the store's public actions
// (`delete` + `commitResult`) and then COALESCES the patch-pairs they pushed into a single
// history entry (`coalesceHistory`), so one Undo restores the exact prior state and never leaves
// a group half-deleted. A commit's `defaultClass` is registered OUTSIDE the undo history (via
// `setState`, not `addClass`) so it never adds a second atom.
//
// UPDATE-BY-GROUP (napari's re-run contract): a commit stamped with a stable `origin`/`groupId`
// REPLACES that group's prior output on a re-run rather than appending duplicates — the factory
// tracks the ids it assigned per group and deletes the prior ones (only those still present)
// before committing the new, all in the one coalesced atom. The per-group bookkeeping maps are
// keyed by the DISTINCT `origin`/`groupId`s a processor actually uses (a processor re-runs a
// group under the SAME key, so re-runs never add keys) — realistically a small, bounded set, so
// the maps are NOT capacity-evicted: an earlier recency-eviction dropped a still-live group's
// ids, so its next re-run mis-fired as a first run and DUPLICATED the priors (NF-8). Growth is
// therefore proportional to distinct groups, documented and accepted.
//
// TEARDOWN: the factory subscribes to the store (to reconcile mask visibility across Undo/Redo).
// The returned port exposes `dispose()` — the host MUST call it on cell teardown to drop that
// subscription (else the closure, its store, and mask rasters leak past the cell's life, NF-7).

import type { AnnotateStore, AddAnnotationInput } from '../viz-core/annotate/Annotate.store'
import { MAX_HISTORY } from '../viz-core/annotate/Annotate.store'
import type { AnnotationGeometry, AnnotationId } from '../viz-core/annotate/annotateModel'
import type { CoordSpace, ImageCoordinateSystem } from '../viz-core/annotate/coords'
import type {
  CommitOpts,
  CommitResult,
  GeoFeature,
  Gesture,
  ImageRef,
  LabelMaskResult,
  PendingState,
  ProcessorPort,
  ProcessorViewState,
} from '../viz-core/annotate/processorPort'

/**
 * Everything the factory binds a port to. The store is the commit target; the three getters
 * are the READ snapshots (a host wires them to the coordination view state + the annotate
 * editor); `onMask` / `onPending` are the WRITE sinks into the cell's mask layer + pending
 * overlay. `coords` is the ITEM-14 facade, required ONLY when a commit's `opts.space` is not
 * `'fullRes'` (the editor owns all level↔physical↔world math there — INV-4).
 */
export interface ProcessorPortDeps {
  /** the per-cell annotation store — the commit target (indistinguishable from hand-drawn). */
  readonly store: AnnotateStore
  /** a fresh `ImageRef` snapshot (the host resolves it from its loader/meta). */
  readonly getImageRef: () => ImageRef
  /** a fresh camera snapshot in full-res px (the host reads it from the coordination view state). */
  readonly getViewState: () => ProcessorViewState
  /** the latest user gesture (the host reads it from the annotate editor), or `null`. */
  readonly getActiveGesture: () => Gesture | null
  /** route a committed label mask into the cell's mask layer (`null` clears it). Absent ⇒ no-op. */
  readonly onMask?: (mask: LabelMaskResult | null, meta: MaskCommitMeta) => void
  /** route the DISPLAY-ONLY pending hint into the cell's overlay (INV-3). Absent ⇒ no-op. */
  readonly onPending?: (pending: PendingState | null) => void
  /** the coordinate facade — required only for a commit whose `space` is not `'fullRes'`. */
  readonly coords?: ImageCoordinateSystem
}

/** Metadata handed to the `onMask` sink alongside the raster (the group it was recorded under). */
export interface MaskCommitMeta {
  /** the group id the mask was recorded under (echoed in the `CommitResult`). */
  readonly groupId: string
  /** the commit options as supplied by the processor. */
  readonly opts?: CommitOpts
}

/** Non-secure fallback id (only hit where WebCrypto is absent — same shape as the store's). */
function freshId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return 'g-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/** The group key a commit is recorded under, or `null` when the commit carries no group. */
function groupKeyOf(opts?: CommitOpts): string | null {
  return opts?.groupId ?? opts?.origin ?? null
}

/**
 * Build the per-coordinate mapper that carries an incoming commit's coordinates INTO the
 * canonical full-res space (INV-4). `'fullRes'` (the default) is identity; any other space
 * routes through the ITEM-14 `coords` facade (required, else a clear throw — the seam never
 * silently mis-places geometry).
 */
function fullResMapper(
  space: CommitOpts['space'],
  coords: ImageCoordinateSystem | undefined,
): ((x: number, y: number) => [number, number]) | null {
  if (space === undefined || space === 'fullRes') return null // identity
  if (!coords) {
    throw new Error(
      'createProcessorPort: a commit with a non-fullRes `space` requires a `coords` facade (INV-4)',
    )
  }
  return (x, y) => coords.map([x, y], space as CoordSpace, 'fullRes')
}

/** Map a flat interleaved `[x0,y0,…]` buffer through `m` into a fresh `Float64Array`. */
function mapFlat(xy: Float64Array | ReadonlyArray<number>, m: (x: number, y: number) => [number, number]): Float64Array {
  const out = new Float64Array(xy.length)
  for (let i = 0; i + 1 < xy.length; i += 2) {
    const [x, y] = m(xy[i], xy[i + 1])
    out[i] = x
    out[i + 1] = y
  }
  return out
}

/** Convert one `GeoFeature`'s geometry into the model's canonical full-res `AnnotationGeometry`. */
function geoFeatureGeometry(
  f: GeoFeature,
  m: ((x: number, y: number) => [number, number]) | null,
): AnnotationGeometry {
  const g = f.geometry
  if (g.kind === 'point') {
    const [x, y] = m ? m(g.xy[0], g.xy[1]) : [g.xy[0], g.xy[1]]
    return { kind: 'point', xy: [x, y] }
  }
  if (g.kind === 'path') {
    return { kind: 'path', xy: m ? mapFlat(g.xy, m) : Float64Array.from(g.xy) }
  }
  // polygon: exterior ring first, then holes.
  const rings = g.rings.map(ring => (m ? mapFlat(ring, m) : Float64Array.from(ring)))
  return { kind: 'polygon', rings }
}

/** Turn a `GeoFeature` into the SAME `AddAnnotationInput` a hand-drawn feature produces. */
function featureToInput(
  f: GeoFeature,
  m: ((x: number, y: number) => [number, number]) | null,
  defaultClassId: string | null,
): AddAnnotationInput {
  return {
    geometry: geoFeatureGeometry(f, m),
    classId: f.classId ?? defaultClassId,
    label: f.label ?? null,
    // Forward a processor-supplied stable id so identity survives an update-by-group re-run
    // (the store's `addOne` uses `input.id ?? freshId()`); absent ⇒ a fresh UUID.
    ...(f.id !== undefined ? { id: f.id } : {}),
    ...(f.properties !== undefined ? { properties: f.properties } : {}),
  }
}

/**
 * Mint a `ProcessorPort` bound to one image cell's `deps`. Every method is stateless-per-call;
 * the only state the factory itself owns is the update-by-group bookkeeping (the ids it assigned
 * per group, so a re-run with the same `origin`/`groupId` replaces its own prior output).
 */

/** One history entry's shape, read structurally off the store's state type (the store does not
 *  export the interface). Lets `coalesceHistory` merge real entries with full typing. */
type UndoEntryShape = ReturnType<AnnotateStore['getState']>['undoStack'][number]

/** The port surface plus the teardown handle the host wires to a cell's disposal (NF-7). */
export interface DisposableProcessorPort extends ProcessorPort {
  /** Drop the store subscription this port opened. Idempotent; call on cell teardown. */
  dispose(): void
}

/** What the factory tracks for one mask group: the current placeholder annotation id (its
 *  presence in the store is what Undo/Redo toggles) plus the raster + opts to re-emit. */
interface MaskGroupRec {
  currentId: AnnotationId
  raster: LabelMaskResult
  opts?: CommitOpts
}

export function createProcessorPort(deps: ProcessorPortDeps): DisposableProcessorPort {
  const { store, getImageRef, getViewState, getActiveGesture, onMask, onPending, coords } = deps

  // Update-by-group bookkeeping (per-instance): the annotation ids assigned to each vector group,
  // and the current mask placeholder + raster per mask group. Keyed by DISTINCT group id — NOT
  // capacity-evicted (see the header note on NF-8), so a still-live group's re-run always finds
  // and replaces its priors instead of duplicating them.
  const vectorGroups = new Map<string, string[]>()
  const maskGroups = new Map<string, MaskGroupRec>()
  // Per mask group: the placeholder id currently reflected in the `onMask` sink (or null when
  // hidden). Reconciliation compares this to the store's live presence and emits the delta.
  const maskShown = new Map<string, AnnotationId | null>()

  // While a multi-step commit is in flight we SUSPEND the subscription so the store's
  // intermediate states (delete → add → coalesce) don't flap the mask sink; one manual
  // `reconcileMasks()` at the end emits the correct final state.
  let reconcileSuspended = false

  /**
   * Reconcile every mask group's `onMask` sink against the store's live annotation presence:
   * a placeholder that vanished (Undo) hides its mask (`onMask(null)`); one that reappeared
   * (Redo / commit) re-shows its raster. Emits ONLY on a change (idempotent), so it is safe to
   * run on every store notification.
   */
  function reconcileMasks(): void {
    if (!onMask) return
    const byId = store.getState().byId
    for (const [group, rec] of maskGroups) {
      const desiredId = byId[rec.currentId] ? rec.currentId : null
      const shown = maskShown.get(group) ?? null
      if (shown !== desiredId) {
        onMask(desiredId ? rec.raster : null, { groupId: group, opts: rec.opts })
        maskShown.set(group, desiredId)
      }
    }
  }

  // A mask commit is undoable via the store; Undo/Redo fires this subscription, which then
  // hides/re-shows the raster so the mask visibly reverts with its history entry (INV-6). The
  // unsubscribe is captured so `dispose()` can drop it on cell teardown (NF-7: an uncaptured
  // subscription pins this closure — and the mask rasters it holds — to the store for its life).
  const unsubscribe = store.subscribe(() => {
    if (!reconcileSuspended) reconcileMasks()
  })

  /** Snapshot the undo stack's ENTRY OBJECTS at the start of a run. Identity (not an absolute
   *  index) marks the run boundary, because the store front-evicts (`shift`) at `MAX_HISTORY`:
   *  an absolute `beforeLen` no longer points at the run's first entry once eviction slides the
   *  stack (NF-6), whereas the pushed entries are always fresh objects appended at the tail. */
  function snapshotHistory(): ReadonlySet<UndoEntryShape> {
    return new Set(store.getState().undoStack)
  }

  /**
   * Coalesce every history entry the store pushed since `before` into ONE atom (so a
   * delete-priors + add-new re-run, or a mask replace, is a single undoable transaction —
   * one Undo restores the exact prior state). The run's entries are exactly the stack members
   * NOT in `before` (fresh objects, appended at the tail); the surviving prefix is those still
   * in `before` (front-eviction only removes from the head, never the tail we just wrote). So
   * this is correct even when the stack was already at `MAX_HISTORY` before the run. `patches`
   * concatenate in run order; `inverse` in REVERSE run order (undo the last op first). A run
   * that pushed ≤1 entry is already atomic (no-op here).
   */
  function coalesceHistory(before: ReadonlySet<UndoEntryShape>): void {
    const stack = store.getState().undoStack
    const pushed = stack.filter(e => !before.has(e))
    if (pushed.length <= 1) return
    const kept = stack.filter(e => before.has(e))
    const merged: UndoEntryShape = {
      patches: pushed.flatMap(e => e.patches),
      inverse: [...pushed].reverse().flatMap(e => e.inverse),
      selBefore: pushed[0].selBefore,
      selAfter: pushed[pushed.length - 1].selAfter,
    }
    const next = [...kept, merged]
    while (next.length > MAX_HISTORY) next.shift()
    store.setState({ undoStack: next, redoStack: [], canUndo: next.length > 0, canRedo: false })
  }

  /** Ensure a commit's `defaultClass` exists in the store, returning the class id to apply to
   *  features that carry no `classId` of their own (or `null` when no default is given). The
   *  class is registered OUTSIDE the undo history (via `setState`, NOT `addClass`) so it never
   *  adds a second undo atom to the run (INV-6: one run = one entry). */
  function resolveDefaultClass(opts?: CommitOpts): string | null {
    const dc = opts?.defaultClass
    if (!dc) return null
    if (!store.getState().classes.some(c => c.id === dc.id)) {
      store.setState(s => ({
        classes: [...s.classes, { id: dc.id, name: dc.name, color: [dc.color[0], dc.color[1], dc.color[2]] }],
      }))
    }
    return dc.id
  }

  /** Shared vector-commit path for polygons + points (they differ only in the geometry the
   *  processor supplies; both route through the SAME store `commitResult`). The delete-priors
   *  + add-new pair is coalesced into ONE undo atom. */
  function commitFeatures(
    features: ReadonlyArray<GeoFeature>,
    opts: CommitOpts | undefined,
  ): CommitResult {
    // Validate/derive the coordinate mapper FIRST — a non-fullRes space without `coords` throws
    // here, before any store mutation, so a bad commit never leaves partial state (INV-4).
    const m = fullResMapper(opts?.space, coords)
    const defaultClassId = resolveDefaultClass(opts)
    const key = groupKeyOf(opts)

    reconcileSuspended = true
    try {
      const before = snapshotHistory()
      // update-by-group: delete this group's STILL-PRESENT prior output before the new run.
      let replaced = 0
      if (key) {
        const prior = vectorGroups.get(key)
        if (prior) {
          for (const id of prior) {
            if (store.getState().byId[id]) {
              store.getState().delete(id)
              replaced++
            }
          }
        }
      }

      const inputs = features.map(f => featureToInput(f, m, defaultClassId))
      const ids = store.getState().commitResult(inputs)
      if (key) vectorGroups.set(key, ids)
      coalesceHistory(before) // delete(s) + add ⇒ ONE undoable atom
      return { ids, groupId: key ?? undefined, replaced }
    } finally {
      reconcileSuspended = false
    }
  }

  /** Build the placeholder annotation that records a mask commit in the store (undoable +
   *  GeoJSON-exportable, INV-6): a polygon FOOTPRINT of the mask's placement (its `bounds`
   *  mapped to full-res, or the whole image when unbounded), tagged as an external label-mask
   *  result. The raster itself lives in `maskGroups` and paints via the `onMask` sink. */
  function maskPlaceholderInput(
    result: LabelMaskResult,
    opts: CommitOpts | undefined,
    group: string,
    m: ((x: number, y: number) => [number, number]) | null,
  ): AddAnnotationInput {
    const b = result.bounds
    let ring: Float64Array
    if (b) {
      const corners: Array<[number, number]> = [
        [b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]],
      ]
      const mapped = corners.map(([x, y]) => (m ? m(x, y) : [x, y]))
      ring = Float64Array.from(mapped.flat())
    } else {
      const ref = getImageRef() // whole-image footprint, already full-res (INV-4)
      ring = Float64Array.from([0, 0, ref.width, 0, ref.width, ref.height, 0, ref.height])
    }
    return {
      geometry: { kind: 'polygon', rings: [ring] },
      classId: resolveDefaultClass(opts),
      label: opts?.origin ? `${opts.origin} mask` : 'label mask',
      properties: {
        external: 'labelMask',
        maskGroup: group,
        maskWidth: result.width,
        maskHeight: result.height,
      },
    }
  }

  return {
    // ── READ (fresh snapshots) ──────────────────────────────────────────────────────────
    getImageRef: () => getImageRef(),
    getViewState: () => getViewState(),
    getActiveGesture: () => getActiveGesture(),

    // ── WRITE ───────────────────────────────────────────────────────────────────────────
    commitPolygons: (features, opts) => commitFeatures(features, opts),
    commitPoints: (features, opts) => commitFeatures(features, opts),

    commitLabelMask: (result: LabelMaskResult, opts?: CommitOpts): CommitResult => {
      // INV-4: honor `space` consistently with the vector path — throw the SAME clear error
      // when a non-fullRes space lacks a `coords` facade, before any store mutation. When
      // present, `m` maps the mask footprint into full-res.
      const m = fullResMapper(opts?.space, coords)
      const key = groupKeyOf(opts) ?? freshId()
      const prior = maskGroups.get(key)

      let placeholderId = ''
      let replaced = 0
      reconcileSuspended = true
      try {
        const before = snapshotHistory()
        // update-by-group: drop the group's prior placeholder (if still present) then re-add.
        if (prior && store.getState().byId[prior.currentId]) {
          store.getState().delete(prior.currentId)
          replaced = 1
        }
        placeholderId = store.getState().commitResult([maskPlaceholderInput(result, opts, key, m)])[0]
        maskGroups.set(key, { currentId: placeholderId, raster: result, opts })
        coalesceHistory(before) // delete-prior + add ⇒ ONE undoable atom
      } finally {
        reconcileSuspended = false
      }
      // Emit the raster into the mask sink for this group (recorded so Undo/Redo can toggle it).
      reconcileMasks()
      return { ids: [placeholderId], groupId: key, replaced }
    },

    setPending: (pending: PendingState | null): void => {
      // DISPLAY-ONLY (INV-3): paint "working…"; never trigger inference.
      onPending?.(pending)
    },

    // ── TEARDOWN ──────────────────────────────────────────────────────────────────────────
    dispose: (): void => {
      // Drop the store subscription so this port (and the mask rasters it retains) stops being
      // pinned to the store after the cell is gone (NF-7). Idempotent — zustand's unsubscribe
      // is safe to call more than once.
      unsubscribe()
    },
  }
}
