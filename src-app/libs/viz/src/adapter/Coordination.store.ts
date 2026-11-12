// Coordination.store.ts — the Vitessce-style COORDINATION store (ITEM-12). Panels
// are decoupled from each other via named coordination scopes: panels sharing a
// scope share view state (synced zoom/pan), and point/selection/highlight fan out
// to every subscriber. This replaces the legacy per-panel dataZoom-index
// bookkeeping with declarative shared state.

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import { castDraft } from 'immer'
import {
  type ColorScaleScope,
  resolveSharedDomain,
} from '../viz-core/coordination/colorScale'
import type { VizSelectionContext, VizSelectionOp } from '../viz-core/option/types'

/** 2D orthographic view state (maps to deck.gl `{target:[x,y,0], zoom}`). */
export interface VizViewState {
  target: [number, number]
  zoom: number
}

/** The base Coordination-scope PREFIX for the grid's linked view state (DEC-37).
 *  The shared state is SHARDED BY COORDINATE SPACE (the embedding-blind-zoom fix):
 *  each space key gets its own scope id `grid:<spaceKey>` via `gridScopeId`, so cells
 *  in different coordinate spaces (a UMAP scatter vs a tissue-coords image) never share
 *  one `{target, zoom}`. Only cells returning the same `cellSpaceKey` sync. */
export const GRID_SCOPE = 'grid'

/** The per-coordinate-space grid scope id: `grid:<spaceKey>`. All linked dense cells
 *  in the SAME space share this scope's view state; cells in other spaces read their
 *  own space's scope (independent zoom/pan). */
export function gridScopeId(spaceKey: string): string {
  return `${GRID_SCOPE}:${spaceKey}`
}

/** The DEFAULT identity-space id (ITEM-14 / ITEM-16). The selection is SHARDED BY IDENTITY
 *  SPACE — canonical point ids only compare within one space, so a selection made against one
 *  datasource's id space must never bleed into another's. The legacy single-space selection API
 *  (`pointSelection`/`setSelection`/`clearSelection`) operates on THIS space; `pointSelection` is
 *  a derived view of `selectionBySpace[DEFAULT_SELECTION_SPACE]?.ids ?? null`. A multi-datasource
 *  caller passes an explicit space id to the `*InSpace` methods instead. */
export const DEFAULT_SELECTION_SPACE = 'default'

/** One identity space's live selection: a set of CANONICAL point ids + the origin view id that
 *  produced it (or `null` when unknown). Present in `selectionBySpace` only while non-empty. */
export interface SpaceSelection {
  ids: Uint32Array
  origin: string | null
}

export interface CoordinationState {
  /** Shared view state per coordination scope id (panels in a scope sync zoom). */
  viewStates: Record<string, VizViewState>
  /** The shared point selection: a set of CANONICAL POINT IDs (NOT array indices) —
   *  each view maps its own rows ↔ ids, so the selection stays correct across views that
   *  don't share one point array (two embeddings, a subset, two datasets). Default
   *  identity (`pointIds[i]=i`) makes an id equal a row for single-source views. A
   *  selection made in ANY grid pane lands here and fans out — every other pane renders
   *  it in its own idiom (scatter emphasis, heatmap group-row band, …) (DEC-25 / ITEM-25). */
  pointSelection: Uint32Array | null
  /** The ORIGIN view id (a string panel id) that produced the current `pointSelection`,
   *  or `null` when unknown / empty. Lets a read-site skip a self-write feedback loop; the
   *  fan-out itself highlights every view (the origin included). */
  selectionOrigin: string | null
  /** The point selection SHARDED BY IDENTITY SPACE (ITEM-14 / ITEM-16), keyed by an
   *  identity-space id. Each entry holds that space's canonical point ids + origin; an entry
   *  exists only while its space holds a live (non-empty) selection. The `DEFAULT_SELECTION_SPACE`
   *  entry is the source the legacy top-level `pointSelection`/`selectionOrigin` fields mirror, so
   *  single-space callers see byte-identical behavior; a selection in space A is invisible to a
   *  read of space B. Mirrors the per-scope `viewStates` sharding. */
  selectionBySpace: Record<string, SpaceSelection>
  /** DEFAULT-space per-origin selection contributions (ITEM: multi-plot union). Each producer view
   *  keeps its own entry; `pointSelection` is their union. Present only for the default identity
   *  space (single-dataset workspaces + the common case); non-default spaces stay single-selection.
   *  Internal — NOT serialized (the union round-trips via `pointSelection`). */
  selectionByOrigin: Record<string, Uint32Array>
  /** EXCLUSIVE-selection reconciliation (cross-cell lifecycle parity). A single-mode selection (or a
   *  Clear) is EXCLUSIVE: only one origin may own a committed outline. `exclusiveSelectionOrigin` names
   *  the sole owner (`null` after a Clear), and `exclusiveSelectionEpoch` bumps on every exclusive
   *  change so EVERY producer surface (grid scatter cells + violin) can drop the committed outline it
   *  no longer owns — the mechanism that makes a violin↔scatter Clear / single-replace behave exactly
   *  like scatter↔scatter. Multi-mode (additive) selections DON'T bump it. Internal, not serialized. */
  exclusiveSelectionOrigin: string | null
  exclusiveSelectionEpoch: number
  /** PROVENANCE (ITEM-7): the ordered gesture list that produced the CURRENT selection, or `null`
   *  when the selection has none (a pre-provenance restore, or a producer that records none).
   *
   *  Held at the STORE level rather than per space because one gesture list can contribute ids to
   *  several identity spaces and its ORDER is load-bearing — a recipe, not a set. Splitting it per
   *  space would make the order unreconstructible.
   *
   *  LIFECYCLE: written beside the ids by every producer, and CLEARED by `clearSelection` /
   *  `clearSelectionInSpace` / an empty `setSelection` — provenance that outlived its ids would be a
   *  lie about the current selection, which is the failure mode DEC-5 (merge-patch drops base ops
   *  when incoming ids arrive without them) guards at the option boundary. */
  selectionProvenance: { ops: VizSelectionOp[]; context?: VizSelectionContext } | null
  /** The hovered cell index (linked highlight). */
  highlight: number | null
  /** When true, the grid's cells share the `GRID_SCOPE` view state (zoom/pan in
   *  lockstep); when false each cell zooms/pans independently (DEC-37). */
  gridLinked: boolean
  /** The workspace-shared "color by" VALUE COLUMN (a generic column name, or `null`
   *  for none). Domain-neutral: it names whatever value column the cells color by; it
   *  carries no chart-kind/domain meaning. Persisted by the app's autosave so a restored
   *  workspace reopens with the same shared color-by. */
  colorBySelection: string | null
  /** Registered per-panel color-by scopes, keyed by a stable per-registration
   *  id (NOT the value column — many panels may color by the same column). Every
   *  scope's `key` names the value column it colors by; linked panels union the
   *  domains of all scopes sharing a `key` so identical values map to identical
   *  colors (DEC-25 / ITEM-64). */
  colorScales: Record<string, ColorScaleScope>
}

export interface CoordinationActions {
  /** Update a scope's view state (all panels in that scope re-read it). */
  setViewState: (scope: string, viewState: VizViewState) => void
  /** Write the shared point selection (canonical point IDs) with NO origin attribution.
   *  The origin-tagged `setSelection` is preferred; this stays for callers that don't
   *  track a source view. */
  setPointSelection: (pointIds: Uint32Array | null) => void
  /** Write a point selection (canonical point IDs) ORIGINATING from a specific view
   *  (DEC-25 / ITEM-25): sets `pointSelection` + tags `selectionOrigin` with `originId`
   *  (cleared when the selection is empty/null). The origin-less `setPointSelection`
   *  remains for callers that don't track a source view.
   *
   *  `accumulate` (default false = REPLACE, byte-identical to the legacy single-selection
   *  behavior) ⇒ the origin's ids are UNIONED with every OTHER origin's live selection: this
   *  is how a MULTI-region select fans a combined highlight across ALL plots (each producer —
   *  scatter cell, violin — publishes under its own origin; `pointSelection` becomes the union
   *  so every consumer emphasizes the whole set). An empty `pointIds` drops just that origin's
   *  contribution. In REPLACE mode a new selection clears all other origins (one region total). */
  setSelection: (originId: string | null, pointIds: Uint32Array | null, accumulate?: boolean) => void
  /** Clear the shared point selection + its origin. */
  clearSelection: () => void
  /** Write ONE identity space's selection (ITEM-14 / ITEM-16): sets `selectionBySpace[spaceId]`
   *  to `ids` tagged with `originId`. A `null`/empty `ids` clears that space (removing its entry
   *  and thus nulling its origin), mirroring how `setSelection` drops the origin on an empty
   *  selection. Writing `DEFAULT_SELECTION_SPACE` keeps the top-level `pointSelection`/
   *  `selectionOrigin` fields in lockstep. */
  setSelectionInSpace: (
    spaceId: string,
    originId: string | null,
    ids: Uint32Array | null,
  ) => void
  /** Read ONE identity space's canonical point ids, or `null` when that space has no live
   *  selection. A selection in space A never surfaces on a read of space B. */
  pointSelectionInSpace: (spaceId: string) => Uint32Array | null
  /** Read ONE identity space's origin view id, or `null` when unknown / empty. */
  selectionOriginInSpace: (spaceId: string) => string | null
  /** Clear ONE identity space's selection + its origin (leaves other spaces untouched). */
  clearSelectionInSpace: (spaceId: string) => void
  /** Record the PROVENANCE of the selection just published (ITEM-7). `null` clears it.
   *
   *  Deliberately a SEPARATE call rather than an extra `setSelection` argument: the seven non-area
   *  producers (ITEM-8) publish ids through several different entry points, and threading an
   *  optional parameter through all of them is exactly how one gets silently omitted. A separate
   *  setter makes an un-provenanced producer VISIBLE (it simply never calls this) instead of
   *  hiding behind a defaulted argument — which is what TEST-9's per-producer enumeration and
   *  TEST-23's registry conformance battery both check for. */
  setSelectionProvenance: (
    provenance: { ops: VizSelectionOp[]; context?: VizSelectionContext } | null,
  ) => void
  setHighlight: (index: number | null) => void
  /** Reset a scope to a default view. */
  resetView: (scope: string, viewState: VizViewState) => void
  /** Write the SHARED grid view state FOR ONE COORDINATE SPACE (every linked cell in
   *  that space re-reads it; cells in other spaces are untouched — the embedding-blind
   *  fix). Keyed by `spaceKey` (a cell's `cellSpaceKey`); stored under `gridScopeId`. */
  setGridViewState: (spaceKey: string, viewState: VizViewState) => void
  /** Toggle whether the grid's cells zoom/pan in lockstep (DEC-37). */
  setGridLinked: (linked: boolean) => void
  /** Set the workspace-shared color-by value column (or `null`). */
  setColorBySelection: (column: string | null) => void
  /** Register (or replace) a panel's color-by scope under `id` (a stable
   *  per-registration key). */
  setColorScale: (id: string, scope: ColorScaleScope) => void
  /** Unregister a panel's color-by scope (on unmount / color-by change). */
  clearColorScale: (id: string) => void
  /** Read the serializable coordination slice — the single serialize source for
   *  `sessionState.ts`. The `pointSelection` Uint32Array is projected to a plain `number[]` of
   *  CANONICAL point ids (data-independent — never array indices), so the snapshot survives a
   *  re-fetch whose row order differs. */
  serialize: () => CoordinationSlice
  /** REPLACE the coordination state from a hydrated slice. The selection `ids` re-inflate to a
   *  `Uint32Array`; an empty selection nulls the origin (the store invariant). No side-effect
   *  fetches. */
  hydrate: (slice: CoordinationSlice) => void
}

/** The serializable point selection: CANONICAL point ids + the origin view id (or null). */
export interface SelectionSlice {
  ids: number[]
  origin: string | null
}

/** The serializable Coordination slice — the runtime interaction state `setOption` alone does not
 *  carry (view states, selection, link-zoom, shared color domains, shared color-by). */
export interface CoordinationSlice {
  viewStates: Record<string, VizViewState>
  selection: SelectionSlice
  /** PROVENANCE (ITEM-7, optional + additive): the ordered op list that produced the CURRENT
   *  selection, plus the display state that explains it. Carried on the slice — not on
   *  `SelectionSlice` — because it spans the whole selection, not one space: a single gesture list
   *  can contribute ids to several identity spaces, and splitting it per space would make the ORDER
   *  (which is load-bearing — it is a recipe, not a set) unreconstructible.
   *
   *  OMITTED entirely when a selection carries no provenance, so a pre-provenance workspace's
   *  serialized shape stays byte-identical (the same back-compat posture as `spaces`). */
  provenance?: { ops: VizSelectionOp[]; context?: VizSelectionContext }
  /** The MULTI-DATASET selection round-trip (ITEM-21 / DEC-16): every NON-DEFAULT identity space's
   *  canonical point ids + origin, keyed by space id. Maps 1:1 to `VizOption.selection.spaces`.
   *  The DEFAULT space is NOT duplicated here — it round-trips via `selection` — so a single-dataset
   *  workspace omits this key entirely and its serialized shape stays BYTE-IDENTICAL to the pre-ITEM-21
   *  slice (optional + back-compat, mirroring how the grid slice omits its docking keys when nothing is
   *  docked). Present only when ≥1 non-default space holds a live selection. */
  spaces?: Record<string, SelectionSlice>
  gridLinked: boolean
  colorScales: Record<string, ColorScaleScope>
  colorBySelection: string | null
}

const DEFAULT_VIEW: VizViewState = { target: [0, 0], zoom: 0 }

// Plain-zustand store (no @txresbench SDK): `create()(subscribeWithSelector(immer(...)))`
// reproduces exactly what `defineStore({ immer: true })` composed — state fields and
// actions spread into one flat state object, immer draft setters innermost, and
// subscribeWithSelector outermost so the 2-arg `store.subscribe(selector, cb)` overload
// (used by autosave) type-checks. Consumers read it through the bound `useCoordinationStore`
// hook (selector reads, `.getState()`, `.subscribe(...)`, actions) exactly as before.
//
// PER-INSTANCE ISOLATION (VIZ_ISOLATION W1): the store DEFINITION is extracted into the
// `createCoordinationStore()` factory (returns a fresh, independent bound store) so `<Viz>`
// can mint isolated coordination state per instance. `useCoordinationStore` remains the
// DEFAULT module singleton — `createCoordinationStore()` invoked once — with a byte-identical
// public API (callable hook + `.getState()`/`.setState()`/`.subscribe()`); no existing
// consumer changes.
/** Union every origin's canonical-id selection into one sorted, de-duplicated Uint32Array (or
 *  `null` when nothing is selected). Drives the multi-plot combined highlight. The single-origin case
 *  returns that origin's array UNCHANGED (same reference, unsorted) so the common single-selection path
 *  is byte-identical to the pre-union behavior; only a genuine ≥2-origin union allocates + sorts. */
function unionOriginSelections(byOrigin: Record<string, Uint32Array>): Uint32Array | null {
  const arrays = Object.values(byOrigin)
  if (arrays.length === 0) return null
  if (arrays.length === 1) return arrays[0]
  const seen = new Set<number>()
  for (const ids of arrays) for (const id of ids) seen.add(id)
  if (seen.size === 0) return null
  return Uint32Array.from(seen).sort()
}

/** Does ANY identity space hold a live selection? The single quantity invariant A is expressed over.
 *
 *  CONV-26 — invariant A is now a TRANSITION predicate (see `assertSelectionInvariants`), so the
 *  wrappers sample this BEFORE a commit and the assertion re-reads it after. That reformulation is
 *  what allowed the per-commit exemption flag — and its save/restore/inherit machinery — to be
 *  deleted outright rather than repaired. */
function anyLiveSelection(s: CoordinationState): boolean {
  return !!(s.pointSelection?.length ?? 0) || Object.keys(s.selectionBySpace ?? {}).length > 0
}

/** Is the invariant assertion active? Dev AND test, in the browser AND in node.
 *
 *  CONV-22 — this used to be `typeof process !== 'undefined' && process.env?.NODE_ENV !== …`. Vite
 *  substitutes the `NODE_ENV` clause, but nothing defines the `process` GLOBAL for a browser bundle
 *  — no shim in `viz/vite.config.ts`, `src-app/ui/vite.config.ts` or `viz-showcase.html` — so
 *  `typeof process === 'undefined'` short-circuited to `false` and THE PROTECTION WAS INERT IN EVERY
 *  BROWSER. It was vitest-only, not dev-only: the 20-spec e2e suite, the one layer that exercises
 *  the full production path, contributed zero assertion coverage. Mirrors the house `isDevEnv()`
 *  idiom (`option/parse.ts`, `data/color.ts`, `core/contextLoss.ts`): `import.meta.env.DEV` first
 *  (true on the browser dev server AND under vitest, compiled to `false` for release), with the
 *  `process` test as the plain-node fallback. */
const DEV_ASSERT = ((): boolean => {
  try {
    const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env
    if (env && typeof env.DEV === 'boolean') return env.DEV
  } catch {
    /* import.meta unavailable (plain node) — fall through */
  }
  try {
    return typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'
  } catch {
    return false
  }
})()

/** Dev-only instrumentation: how many commits `assertSelectionInvariants` has checked.
 *
 *  CONV-23 — this exists so a test can prove the assertion is INSTALLED at the door every real
 *  action uses. The acceptance suite drives `store.setState`, which `createCoordinationStore`
 *  replaces with an OUTER wrapper; the actions closed over a SEPARATE inner wrapper
 *  (`assertingSet(rawSet, get)`). Deleting the inner one — removing the protection from 100% of
 *  production commits — left all 13 acceptance tests green, because not one of them ran an action.
 *  Counting checked commits makes that installation observable: run a real action, assert the
 *  counter moved. */
let assertionRunCount = 0
/** @internal test-only — see `assertionRunCount`. */
export function __assertionRunCount(): number {
  return assertionRunCount
}

export function createCoordinationStore() {
  const store = createCoordinationStoreInner()
  // SECOND ENTRY POINT. The `set` handed to the actions is wrapped above, but `store.setState` is a
  // separate, public door into the same state — middleware composes at creation time, so a wrapper
  // installed on the inner `set` never sees a call that comes through here. Nothing in product code
  // uses it today (convergence-4 verified that), which is exactly why an author could start and
  // meet no resistance. Wrap it too, so BOTH doors are checked.
  if (DEV_ASSERT) {
    const rawSetState = store.setState.bind(store)
    store.setState = ((...args: Parameters<typeof rawSetState>) => {
      // CONV-26 — same transition sampling as `assertingSet`; see `assertSelectionInvariants`.
      const before = store.getState()
      const hadLiveBefore = anyLiveSelection(before)
      const recipeBefore = before.selectionProvenance
      const out = rawSetState(...args)
      assertSelectionInvariants(store.getState(), hadLiveBefore, recipeBefore)
      return out
    }) as typeof store.setState
  }
  return store
}

function createCoordinationStoreInner() {
  return create<CoordinationState & CoordinationActions>()(
    subscribeWithSelector(
      immer((rawSet, get) => {
      // THE PROTECTION (CONV-19). Every action below writes through this wrapper, so the selection
      // invariants are checked after EVERY commit — regardless of how the mutation was spelled.
      // See `assertSelectionInvariants` for why a source scan cannot do this job.
      const set = assertingSet(rawSet, get)
      return ({
      // state
      viewStates: {},
      pointSelection: null,
      selectionOrigin: null,
      selectionBySpace: {},
      selectionByOrigin: {},
      exclusiveSelectionOrigin: null,
      exclusiveSelectionEpoch: 0,
      selectionProvenance: null,
      highlight: null,
      gridLinked: false,
      colorBySelection: null,
      colorScales: {},
      // actions
      setViewState: (scope, viewState) =>
        set(s => {
          s.viewStates[scope] = viewState
        }),
      // CONV-13 — this was the FIFTH site of the default-space-only class, and the one that proved a
      // shared predicate is not enough: it simply never called it. It carried no normalisation at
      // all, so an origin-less clear left `selectionProvenance` describing a set that no longer
      // existed. Now unreachable-by-construction: the recipe goes through `selectionMutation`.
      setPointSelection: pointIds =>
        set(
          selectionMutation(s => {
            // Origin-less write REPLACES the whole default-space selection (collapses per-origin map).
            s.selectionByOrigin = pointIds && pointIds.length > 0 ? { __anon__: pointIds } : {}
            s.pointSelection = pointIds && pointIds.length > 0 ? pointIds : null
            s.selectionOrigin = null
            // An origin-less REPLACE is exclusive — bump so committed outlines elsewhere reconcile away.
            s.exclusiveSelectionOrigin = null
            s.exclusiveSelectionEpoch += 1
          }),
        ),
      setSelection: (originId, pointIds, accumulate = false) =>
        set(
          selectionMutation(s => {
          const has = !!(pointIds && pointIds.length > 0)
          const key = originId ?? '__anon__'
          if (accumulate) {
            // Keep every OTHER origin's contribution; update (or drop) just this one.
            if (has) s.selectionByOrigin[key] = pointIds as Uint32Array
            else delete s.selectionByOrigin[key]
          } else {
            // REPLACE: this origin becomes the sole contribution (one region total across all plots).
            s.selectionByOrigin = has ? { [key]: pointIds as Uint32Array } : {}
            // EXCLUSIVE: name the sole owner (or null when cleared) + bump so every OTHER producer
            // surface drops its now-orphaned committed outline. Multi (accumulate) never bumps this.
            s.exclusiveSelectionOrigin = has ? originId : null
            s.exclusiveSelectionEpoch += 1
          }
          s.pointSelection = unionOriginSelections(s.selectionByOrigin)
          // Attribute to the writing origin while it holds a selection; else fall back to any remaining
          // origin (keeps a valid origin for the event bridge when one contributor is cleared).
          s.selectionOrigin = has
            ? originId
            : (Object.keys(s.selectionByOrigin)[0] ?? null) === '__anon__'
              ? null
              : (Object.keys(s.selectionByOrigin)[0] ?? null)
          // M6/CONV-1 — an EMPTY setSelection is a clear, and this store's own doc (:94-97) promises
          // provenance is cleared by one; a recipe outliving its ids is the lie DEC-5 forbids. The
          // predicate must also be SPACE-AWARE and must run AFTER the default-space sync (that sync
          // is what DELETES the now-empty entry). Both are now guaranteed by `selectionMutation`
          // rather than by this action remembering to call them — see its note for the history.
          }),
        ),
      // CONV-8 — despite the name this is NOT a full clear: it empties the DEFAULT space only, so
      // every non-default `selectionBySpace` entry survives (`GridWorkspace.clearGridSelection`
      // proves it by having to call this AND loop `clearSelectionInSpace`). Round 2's reading-based
      // sweep certified this very line as "an unconditional full clear — correct"; it was reachable
      // on the DEFAULT gesture (single-mode click-to-deselect), so a multi-dataset grid lost the
      // recipe while spaceB stayed highlighted.
      clearSelection: () =>
        set(
          selectionMutation(s => {
            s.selectionByOrigin = {}
            s.pointSelection = null
            s.selectionOrigin = null
            // A Clear is exclusive with NO owner — every committed outline reconciles away.
            s.exclusiveSelectionOrigin = null
            s.exclusiveSelectionEpoch += 1
          }),
        ),
      // CONV-8 — a null/empty `ids` IS a clear (`writeSelectionSpace` removes the entry), and this
      // path carried no predicate at all, so emptying the LAST live space left the recipe dangling.
      setSelectionInSpace: (spaceId, originId, ids) =>
        set(
          selectionMutation(s => {
            writeSelectionSpace(s, spaceId, originId, ids)
          }),
        ),
      pointSelectionInSpace: spaceId =>
        spaceId === DEFAULT_SELECTION_SPACE
          ? get().pointSelection
          : (get().selectionBySpace[spaceId]?.ids ?? null),
      selectionOriginInSpace: spaceId =>
        spaceId === DEFAULT_SELECTION_SPACE
          ? get().selectionOrigin
          : (get().selectionBySpace[spaceId]?.origin ?? null),
      clearSelectionInSpace: spaceId =>
        set(
          selectionMutation(s => {
            writeSelectionSpace(s, spaceId, null, null)
          }),
        ),
      // ESCAPE HATCH (see `selectionMutation`): this WRITES the recipe, so it must not be
      // normalised — a recipe legitimately precedes its ids in the ops-only restore (INV-7/DEC-9)
      // and while a legitimately-empty re-derive converges. Normalising here would null what the
      // caller just set.
      setSelectionProvenance: provenance =>
        set(
          rawSelectionWrite(s => {
            // castDraft: ops carry readonly tuples (`region`), whose draft slot immer types as
            // mutable. Same idiom as `colorOverride.store.ts:152-153` for readonly RGB tuples. The
            // blob is opaque to the store — it is stored and re-emitted, never mutated in place.
            s.selectionProvenance = provenance ? castDraft(provenance) : null
          }),
        ),
      setHighlight: index =>
        set(s => {
          s.highlight = index
        }),
      resetView: (scope, viewState) =>
        set(s => {
          s.viewStates[scope] = viewState
        }),
      setGridViewState: (spaceKey, viewState) =>
        set(s => {
          s.viewStates[gridScopeId(spaceKey)] = viewState
        }),
      setGridLinked: linked =>
        set(s => {
          s.gridLinked = linked
        }),
      setColorBySelection: column =>
        set(s => {
          s.colorBySelection = column
        }),
      setColorScale: (id, scope) =>
        set(s => {
          s.colorScales[id] = scope
        }),
      clearColorScale: id =>
        set(s => {
          delete s.colorScales[id]
        }),
      serialize: () => {
        const s = get()
        const slice: CoordinationSlice = {
          viewStates: structuredJson(s.viewStates),
          selection: {
            ids: s.pointSelection ? Array.from(s.pointSelection) : [],
            origin: s.selectionOrigin,
          },
          gridLinked: s.gridLinked,
          colorScales: structuredJson(s.colorScales),
          colorBySelection: s.colorBySelection,
        }
        // Round-trip the NON-DEFAULT identity spaces so a MULTI-DATASET selection survives
        // save→restore (ITEM-21). The DEFAULT space already round-trips via `selection`, so it is
        // EXCLUDED here — and the `spaces` key is OMITTED entirely when no non-default space holds a
        // selection — keeping the single-dataset serialized shape byte-identical to the pre-ITEM-21
        // slice. Each space projects its `Uint32Array` ids to a plain `number[]` (data-independent
        // canonical ids), exactly like the default `selection`.
        const spaces: Record<string, SelectionSlice> = {}
        for (const [spaceId, sel] of Object.entries(s.selectionBySpace)) {
          if (spaceId === DEFAULT_SELECTION_SPACE) continue
          spaces[spaceId] = { ids: Array.from(sel.ids), origin: sel.origin }
        }
        if (Object.keys(spaces).length > 0) slice.spaces = spaces
        // PROVENANCE (ITEM-7): emitted only when present, so a pre-provenance workspace's slice is
        // byte-identical to before. `structuredJson` enforces the strict-JSON wire discipline the
        // ops/context types promise (no Set, no typed array reaches the boundary — TEST-19).
        if (s.selectionProvenance && s.selectionProvenance.ops.length > 0) {
          slice.provenance = structuredJson(s.selectionProvenance) as CoordinationSlice['provenance']
        }
        return slice
      },
      // ESCAPE HATCH (see `selectionMutation`): `hydrate` restores a recipe that legitimately has
      // NO ids yet — the ops-only option (INV-7/DEC-9), where ops land before the pane buffers
      // exist and `revalidateSelectionIn` re-derives on a later tick. Normalising here would null
      // that recipe and silently turn an ops-only restore into an empty workspace.
      hydrate: slice =>
        set(
          rawSelectionWrite(s => {
          s.viewStates = structuredJson(slice.viewStates)
          const ids = slice.selection?.ids ?? []
          s.pointSelection = ids.length > 0 ? Uint32Array.from(ids) : null
          // Enforce the store invariant: an empty selection carries no origin.
          s.selectionOrigin = ids.length > 0 ? (slice.selection?.origin ?? null) : null
          // Restore the per-origin map as a single collapsed blob under the hydrated origin (the
          // per-origin breakdown isn't serialized — the union round-trips via `selection`).
          s.selectionByOrigin =
            ids.length > 0
              ? { [slice.selection?.origin ?? '__anon__']: Uint32Array.from(ids) }
              : {}
          // A restored selection is exclusively owned by its hydrated origin; bump the epoch so any
          // mounted producer surface reconciles to this fresh baseline.
          s.exclusiveSelectionOrigin = ids.length > 0 ? (slice.selection?.origin ?? null) : null
          s.exclusiveSelectionEpoch += 1
          // Rebuild `selectionBySpace` from the slice: drop any stale per-space entries, restore each
          // NON-DEFAULT space from `slice.spaces` (multi-dataset selection — ITEM-21), then re-mirror
          // the hydrated DEFAULT space so it stays in lockstep with the top-level fields. A slice
          // WITHOUT `spaces` (single-dataset / pre-ITEM-21) skips the loop → byte-identical behavior.
          s.selectionBySpace = {}
          if (slice.spaces) {
            for (const [spaceId, sel] of Object.entries(slice.spaces)) {
              // The default space is owned by `selection`; never let a stray `spaces` entry override it.
              if (spaceId === DEFAULT_SELECTION_SPACE) continue
              const spaceIds = sel?.ids ?? []
              if (spaceIds.length > 0) {
                s.selectionBySpace[spaceId] = {
                  ids: Uint32Array.from(spaceIds),
                  origin: sel?.origin ?? null,
                }
              }
            }
          }
          syncDefaultSelectionSpace(s)
          // PROVENANCE (ITEM-7): restored verbatim when the slice carries it, else NULLED. Nulling
          // on absence is deliberate — `hydrate` REPLACES state, so a restore of a pre-provenance
          // slice must not leave the previous workspace's op list attached to the new ids.
          s.selectionProvenance =
            slice.provenance && slice.provenance.ops.length > 0
              ? castDraft(structuredJson(slice.provenance))
              : null
          s.gridLinked = slice.gridLinked
          s.colorScales = structuredJson(slice.colorScales)
          s.colorBySelection = slice.colorBySelection ?? null
          }),
        ),
      })
      }),
    ),
  )
}

/** A bound Coordination store instance (the factory's return type). */
export type CoordinationStore = ReturnType<typeof createCoordinationStore>

/** The DEFAULT module-singleton Coordination store — byte-identical to the pre-factory
 *  export. Existing consumers importing `useCoordinationStore` are unaffected. */
export const useCoordinationStore: CoordinationStore = createCoordinationStore()

/** Detach a plain JSON-able object from the live (immer) state so a post-capture mutation can't
 *  retro-edit the snapshot. Safe for the coordination maps (all plain data). */
function structuredJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** THE selection chokepoint (CONV-13/CONV-14 — the STRUCTURAL fix).
 *
 *  Wraps a mutation recipe so the selection invariants are re-established UNCONDITIONALLY after it
 *  runs. Every action that mutates selection IDS passes its recipe through this. An action cannot
 *  opt out by forgetting a call, because the normalisation is no longer a call the action makes —
 *  it is part of the recipe the action hands to `set`.
 *
 *  WHY THIS EXISTS RATHER THAN A SHARED PREDICATE. `dropProvenanceIfNoSelection` was introduced as
 *  "the ONE predicate every selection-mutating action uses", precisely so a site could not get it
 *  wrong independently. That guarantee was false the moment a site simply did not call it:
 *  `setPointSelection` never did (CONV-13), and it sits on the exported public `CoordinationHandle`
 *  with no in-repo caller — a landmine with no local pressure to be correct. By then the class had
 *  recurred FOUR times across FIVE sites (`selectionRevalidate.liveIsEmpty`, `setSelection`,
 *  `clearSelection`, `setSelectionInSpace`, `setPointSelection`) and defeated THREE sweeps: two
 *  reading-based — one of which certified `clearSelection` as clean at the very line that was
 *  broken — and one execution-based, which found two sites and missed two more. A convention five
 *  authors must each remember will be missed a sixth time; the invariant is enforced HERE so that
 *  "forgot to normalise" is not a reachable state.
 *
 *  NOT routed through this: `setSelectionProvenance` and `hydrate`. Those WRITE the recipe, and a
 *  recipe legitimately precedes its ids in exactly the two cases this feature depends on — the
 *  ops-only restore (INV-7/DEC-9: ops hydrate before the pane buffers exist) and the convergence of
 *  a legitimately-empty re-derive (`revalidateSelectionIn`'s tail restores the recipe after the
 *  transient clear so the next tick returns `'none'` instead of re-deriving forever). Normalising
 *  them would null the very thing they were called to set. They use `rawSelectionWrite`, and are the
 *  only two names on the guard's allowlist (`Coordination.store.guard.test.ts`). */
function selectionMutation(
  recipe: (s: CoordinationState) => void,
): (s: CoordinationState) => void {
  return s => {
    recipe(s)
    // INVARIANT 1 — the derived per-space map mirrors the legacy top-level fields.
    syncDefaultSelectionSpace(s)
    // INVARIANT 2 — the recipe is dropped iff NO identity space holds a selection.
    dropProvenanceIfNoSelection(s)
  }
}

/** The deliberate escape hatch: a selection write that must NOT be normalised, because it is
 *  setting the recipe itself (see `selectionMutation`). Named loudly so both a reader and the
 *  guard's source scan can see the opt-out at a glance. Only `setSelectionProvenance` and `hydrate`
 *  may use it; the guard fails if any other action does.
 *
 *  CONV-26 — this no longer marks the commit for the assertion. It used to raise a module-scoped
 *  flag that exempted the commit from invariant A, because these two legitimately leave a recipe
 *  with no ids. Recasting A as a TRANSITION made that exemption unnecessary: neither action moves
 *  the store from "some space live" to "none", so both satisfy A outright rather than being excused
 *  from it. The flag, its save/restore and its inheritance are gone — with them the sticky-exemption
 *  and depth-≥2 defects they introduced. See `assertSelectionInvariants`. */
function rawSelectionWrite(
  recipe: (s: CoordinationState) => void,
): (s: CoordinationState) => void {
  return recipe
}

/** THE PROTECTION (CONV-19) — a RUNTIME invariant assertion, replacing a source scan.
 *
 *  WHY NOT A SOURCE SCAN. Fix round 4 guarded the chokepoint with a test that scanned
 *  `Coordination.store.ts` for actions writing a selection field. It had to anticipate SYNTAX, and
 *  it did not: of six plausible "site six" shapes, FIVE escaped it — a helper one level down
 *  (`set(s => { writeSelectionSpace(s, …) })`, a shape already used twice in this file), a renamed
 *  draft parameter, `set(` on the same line as `=>`, an async `then(() => set(…))`, and a computed
 *  field name. Worse, its predicate saw only 4 of the 7 selection-mutating actions: two of them —
 *  `setSelectionInSpace` and `clearSelectionInSpace`, sites #4 and #5 of this defect's own history —
 *  passed by being SKIPPED, not by being checked. Unwrapping an EXISTING action left it silent.
 *
 *  This assertion is shape-agnostic by construction: it does not read source and does not care how
 *  a mutation was spelled, only what the state looks like after it commits. Every one of the six
 *  shapes above trips it, because all six ultimately call `set`.
 *
 *  THE INVARIANTS (exactly what `selectionMutation` establishes):
 *    A. the recipe is dropped iff NO identity space holds a selection.
 *    B. no space entry is present-but-empty (`writeSelectionSpace` deletes instead).
 *    C. the DEFAULT entry mirrors the legacy top-level fields — present iff `pointSelection` is
 *       non-empty, same ids, same origin.
 *
 *  A IS A TRANSITION, NOT A STATE (CONV-26). It fires only when a commit takes the store FROM
 *  "some space holds a selection" TO "none does" while the recipe survives. B and C remain plain
 *  state checks, evaluated on every commit.
 *
 *  WHY A TRANSITION. Stated as a state predicate — "a recipe must never coexist with no live ids" —
 *  A is simply FALSE of a legitimate, documented, and sometimes PERMANENT product state: the INV-7
 *  ops-only restore holds a recipe whose ids do not exist yet (DEC-9: ops hydrate before the pane
 *  buffers arrive), and an `[add A, subtract A]` selection converges to exactly that state and RESTS
 *  there for good. Round 6 tried to carve those out with a per-commit exemption flag raised by
 *  `rawSelectionWrite`. That failed on its own terms and cost three findings: the flag exempts the
 *  commit that CREATES the state but not the window the state PERSISTS for, so every unrelated
 *  coordination commit made while it was open threw — `setColorScale`, which `useSharedColorDomain`
 *  calls, hard-crashed the dev app (convergence-6 HIGH). Patching that with save/restore made the
 *  flag STICKY (a throw inside zustand's synchronous notify pass disarmed A process-wide, forever),
 *  and its inheritance was not transitive, so the same false positive returned at nesting depth ≥ 2.
 *
 *  As a transition the carve-outs are unnecessary, because the legitimate state is no longer a
 *  violation to be excused — it simply satisfies A. Nothing transitions: the ops-only restore starts
 *  with no ids and ends with none; an unrelated commit while the window is open leaves both sides
 *  false; a synchronous nested commit at ANY depth sees its own before/after unchanged. So the flag,
 *  the save/restore and the inheritance are all deleted, and findings 2, 3 and 4 cease to exist
 *  rather than being fixed.
 *
 *  It loses nothing. The defect A exists to catch is "an unwrapped mutation DESTROYED live ids and
 *  left the recipe describing them" — inherently a true→false transition. All seven site-six shapes
 *  in the acceptance suite start from a live selection, and every one still trips.
 *
 *  THE RECIPE MUST ALSO BE UNTOUCHED (`recipeBefore` identity). `hydrate` legitimately REPLACES the
 *  whole selection slice, so restoring an ops-only option over a live selection genuinely does move
 *  live→empty while setting a recipe — a transition alone would flag it. But that commit WROTE the
 *  recipe: immer's structural sharing means `selectionProvenance` is a NEW object. An unwrapped
 *  mutation that merely empties the ids never touches the recipe, so it comes out reference-equal,
 *  and requiring identity keeps `hydrate` legal without reintroducing an exemption flag.
 *
 *  WHAT A ACTUALLY CHECKS, AND WHAT IT DOES NOT (CONV-29). This block used to call the identity
 *  clause "the precise statement of `the recipe outlived ids it still describes`". That was FALSE,
 *  and it is corrected here per DRIFT-1.28's own rule — describe what the code DOES, not what it is
 *  FOR. Precisely:
 *
 *      A fires when the live ids go true→false AND the recipe object is REFERENCE-UNCHANGED.
 *      A commit that empties the ids *and also rewrites the recipe object* is read as a deliberate
 *      recipe write (the `hydrate` shape) and is therefore NOT judged.
 *
 *  So A is a HEURISTIC, not a proof: it assumes a commit that destroys a selection does not
 *  simultaneously rewrite the recipe. Convergence-7 proved three shapes that slip through — a
 *  shallow clone (`d.selectionProvenance = {...d.selectionProvenance}`); an in-place CONTEXT STAMP
 *  (`d.selectionProvenance.context = {…}`, where immer marks the branch modified so the object
 *  comes out new); and the same through the outer `setState` door with a JSON-cloned recipe. Each
 *  leaves a recipe describing ids that no longer exist — the DEC-5 lie A exists to make
 *  unconstructible. The `CONV-29 — the acknowledged gap` block in the acceptance suite pins that
 *  behaviour, so the next reader is not told by this header that they are covered.
 *
 *  THE CONCRETE FORWARD HAZARD. Nothing writes ids and the recipe in one commit today. The one
 *  place that writes both in the same TICK is `revalidateSelectionIn`'s write-back
 *  (`selectionRevalidate.ts`), and it is safe ONLY because those are two SEPARATE action commits:
 *  the clearing commits transition and are judged, the recording commit sees no transition. Fusing
 *  them into one atomic commit — the obvious "keep the ids and the recorded context symmetric"
 *  refactor that CONV-14/CONV-18/CONV-21 are three consecutive fixes about — lands exactly the
 *  context-stamp shape, and A goes silent. `CONV-29 — commit separation` pins the two-commit
 *  structure mechanically, and the write-back site carries the same warning inline. */
function assertSelectionInvariants(
  s: CoordinationState,
  hadLiveBefore: boolean,
  recipeBefore: CoordinationState['selectionProvenance'],
): void {
  assertionRunCount++
  const spaceKeys = Object.keys(s.selectionBySpace ?? {})
  const anyLive = anyLiveSelection(s)

  if (hadLiveBefore && !anyLive && s.selectionProvenance != null && s.selectionProvenance === recipeBefore) {
    throw new Error(
      '[viz] selection invariant A violated: `selectionProvenance` survives a commit that emptied ' +
        'the last live selection — the recipe now describes a set that no longer exists (DEC-5). ' +
        'The mutation that just ran did not go through `selectionMutation`.',
    )
  }
  for (const k of spaceKeys) {
    if ((s.selectionBySpace[k]?.ids?.length ?? 0) === 0) {
      throw new Error(
        `[viz] selection invariant B violated: space "${k}" is present but empty — an empty space ` +
          'entry must be deleted, not stored (see `writeSelectionSpace`).',
      )
    }
  }
  const def = s.selectionBySpace?.[DEFAULT_SELECTION_SPACE]
  const liveDefault = (s.pointSelection?.length ?? 0) > 0
  if (liveDefault !== !!def) {
    throw new Error(
      '[viz] selection invariant C violated: the DEFAULT space entry and the legacy ' +
        `\`pointSelection\` field disagree (pointSelection ${liveDefault ? 'live' : 'empty'}, ` +
        `DEFAULT entry ${def ? 'present' : 'absent'}) — \`syncDefaultSelectionSpace\` did not run.`,
    )
  }
  if (def && def.ids !== s.pointSelection) {
    throw new Error(
      '[viz] selection invariant C violated: the DEFAULT space entry holds a different ids array ' +
        'than `pointSelection`.',
    )
  }
  // CONV-25 — the header and the message above both promise "same origin", and until now nothing
  // compared it: a raw commit touching only `selectionOrigin` left the mirror stale and the
  // assertion silent. `syncDefaultSelectionSpace` is exactly what this invariant backstops and it
  // DOES write the origin, so the comparison is the honest reading of the contract. Fifth instance
  // of this branch's docs-accuracy class (CONV-5/11/16/20) — see DRIFT-1.25.
  if (def && def.origin !== s.selectionOrigin) {
    throw new Error(
      '[viz] selection invariant C violated: the DEFAULT space entry holds a different origin ' +
        `(${String(def.origin)}) than \`selectionOrigin\` (${String(s.selectionOrigin)}).`,
    )
  }
}

/** Wraps zustand's `set` so every commit is checked (dev only). Shape-agnostic: an action can be
 *  written any way at all and still lands here, which is the whole point (see
 *  `assertSelectionInvariants`). */
function assertingSet<T extends (...args: never[]) => unknown>(
  rawSet: T,
  get: () => CoordinationState,
): T {
  if (!DEV_ASSERT) return rawSet
  const wrapped = (...args: Parameters<T>) => {
    // CONV-26 — sample the ONE quantity invariant A is a transition over. No flag, no save/restore,
    // no inheritance: a re-entrant commit notified synchronously inside `rawSet` samples its own
    // before-state and is judged on its own transition, at any nesting depth.
    const before = get()
    const hadLiveBefore = anyLiveSelection(before)
    const recipeBefore = before.selectionProvenance
    const out = rawSet(...(args as never[]))
    assertSelectionInvariants(get(), hadLiveBefore, recipeBefore)
    return out
  }
  return wrapped as unknown as T
}

/** Drop the recipe once NO identity space holds a selection any more — the predicate
 *  `selectionMutation` applies after every id-mutating recipe. Do NOT call this directly from an
 *  action; route the action through `selectionMutation` instead (see its note for why).
 *
 *  Scoped rather than unconditional because one op list can span several spaces (DEC-2): clearing
 *  space B must not discard the ops still explaining space A's live ids. Conversely a recipe that
 *  outlived every id would describe a set that no longer exists — the lie DEC-5 forbids at the
 *  option boundary, so it must not be constructible in the store either.
 *
 *  ORDERING: this must run AFTER `syncDefaultSelectionSpace`/`writeSelectionSpace`, because those
 *  are what delete the now-empty entry; reading `selectionBySpace` before them still sees the stale
 *  entry and never clears. `selectionMutation` guarantees that order. */
function dropProvenanceIfNoSelection(s: CoordinationState): void {
  if (!s.pointSelection && Object.keys(s.selectionBySpace).length === 0) {
    s.selectionProvenance = null
  }
}

/** Mirror the legacy top-level `pointSelection`/`selectionOrigin` fields into the
 *  `DEFAULT_SELECTION_SPACE` entry of `selectionBySpace` (ITEM-14 / ITEM-16). Keeps the entry
 *  present only while the default space holds a live (non-empty) selection, so `selectionBySpace`
 *  stays a clean per-space map (mirrors how an empty scope is dropped elsewhere). The top-level
 *  fields remain the byte-identical single-space surface; this only syncs the derived map. */
function syncDefaultSelectionSpace(s: CoordinationState): void {
  const ids = s.pointSelection
  if (ids && ids.length > 0) {
    s.selectionBySpace[DEFAULT_SELECTION_SPACE] = { ids, origin: s.selectionOrigin }
  } else {
    delete s.selectionBySpace[DEFAULT_SELECTION_SPACE]
  }
}

/** Write (or clear) ONE identity space's selection with the origin-nulling-on-empty invariant.
 *  A `null`/empty `ids` removes the space's entry entirely (nulling its origin), mirroring how
 *  `setSelection` drops the origin on an empty selection. When the space is `DEFAULT_SELECTION_SPACE`
 *  the legacy top-level `pointSelection`/`selectionOrigin` fields are kept in lockstep. */
function writeSelectionSpace(
  s: CoordinationState,
  spaceId: string,
  originId: string | null,
  ids: Uint32Array | null,
): void {
  const live = ids != null && ids.length > 0
  if (live) {
    s.selectionBySpace[spaceId] = { ids, origin: originId }
  } else {
    delete s.selectionBySpace[spaceId]
  }
  if (spaceId === DEFAULT_SELECTION_SPACE) {
    s.pointSelection = live ? ids : null
    s.selectionOrigin = live ? originId : null
    // A direct default-space write REPLACES the per-origin map (keeps the union in lockstep).
    s.selectionByOrigin = live ? { [originId ?? '__anon__']: ids as Uint32Array } : {}
  }
}

/** The view state for a scope, or a default if unset. */
export function viewStateFor(
  states: Record<string, VizViewState>,
  scope: string,
): VizViewState {
  return states[scope] ?? DEFAULT_VIEW
}

/** The SHARED (union) color domain across every registered scope coloring by
 *  `key`, or `null` when none does (DEC-25 / ITEM-64). Non-reactive snapshot
 *  read; prefer `useSharedColorDomain` in components for reactive coordination. */
export function sharedColorDomain(key: string): [number, number] | null {
  const { colorScales } = useCoordinationStore.getState()
  return resolveSharedDomain(Object.values(colorScales), key)
}
