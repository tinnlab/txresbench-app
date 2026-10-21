// Per-instance reactive `view_spec` store (PLAN.md ITEM-3). Holds the declared
// `state`, recomputes `derived` reactively from `state` + `data` via the
// app-owned compute primitives (ITEM-6), and JOINS the workbench instance
// directory (`instanceRegistry`) under its `view_id` on create — so
// `ctx.instance(spec.id, view_id)` resolves it and `<view>.describe` can read a
// token-stamped snapshot (research §10 — one state, two drivers: human + AI).
//
// Framework-free (no React) so the reactive core is directly unit-testable;
// `createVersioned` supplies the `_state_token` the read-before-write guard
// needs (`core/actions/versioned.ts`).

import type {
  DerivedSpec,
  ExprString,
  StateFieldSpec,
  ViewSpec,
} from '@/modules/workbench/core/manifest/viewSpec'
import { createVersioned } from '@/core/actions/versioned'
import { currentPaneScope, paneScopeStore } from './paneScope.store'
import type { PaneScopeKey } from './paneScopeKeys'
import {
  getInstanceRecord,
  registerInstance,
  unregisterInstance,
  type InstanceRecord,
} from '@/core/actions/instanceRegistry'
import { asNumsNaNMissing, asStrs, isColumn } from '@/modules/workbench/core/columns/columnCoerce'
import { evalExpr, expandForEach, expandForEachKeyed, type Scope } from './expr'
import { declaresResolvableData, type DataStatus } from './dataStatus'
import { FRAME_DEPTH_MISMATCH } from './frameDepth'
import { ORIGIN_USER, strongerOrigin, type BindingOrigin } from './bindingOrigin'
import {
  categories_by_column,
  columns_of,
  count_by,
  extent,
  filter_mask,
  gate_mask,
  keep_mask,
  pendingCriterionColumns,
  or_masks,
  range_envelope,
  unique,
  type KeepCriterion,
} from './primitives'

type State = Record<string, unknown>
type Derived = Record<string, unknown>
export type Data = Record<string, unknown> | undefined

export interface ViewStore {
  readonly viewId: string
  readonly type: string
  /** current state (reactive object; replaced wholesale on each `set`). */
  readonly state: State
  /** current reactive `derived` values. */
  readonly derived: Derived
  /** current `${viewId}@${version}` state token. */
  readonly token: string
  /** the live resolved `data` slices (whatever the spec's `data` block declared). Baked at
   *  create; replaced
   *  by `setData` when the async job-result resolver (`viewData.ts`) lands the slices. */
  readonly data: Data
  /** a monotonic re-render signal bumped on EVERY `set` AND `setData` — so a React
   *  region's `useSyncExternalStore` re-renders on a DATA arrival (which does not bump the
   *  state `token`), not only on a state mutation. */
  readonly revision: number
  /** The lifecycle of the DECLARED data slices (`loading` → `ready`/`empty`/`error`), landed
   *  by the resolver (`viewData.ts`). This is what lets a region tell "the fetch FAILED" from
   *  "there is genuinely nothing yet" — before it existed both were a silent blank region
   *  (F3). Starts `loading` only when the view declares a slice worth waiting for. */
  readonly dataStatus: DataStatus
  /** The failure message behind `dataStatus === 'error'` (surfaced in the region's Alert). */
  readonly dataError: string | undefined
  /** The SERVER's user-facing sentence for the current failure, when it wrote one
   *  (ITEM-41). Rendered INLINE by `RegionStatus`; `dataError` stays the technical string. */
  readonly dataHint: string | undefined
  /** A monotonic signal bumped ONLY by a real DATA arrival (`setData`) — never by a state
   *  `set`, and never by a bare status flip (`setDataStatus`). This is the widget error-boundary's reset key (DEC-2): the boundary must
   *  latch through slider ticks and clear when the loop hands the region corrected DATA.
   *  Keying on `revision` (which bumps on every `set`) would re-throw on every tick — the
   *  exact symptom F7 names. */
  readonly dataRevision: number
  /**
   * Write `field`. `origin` records HOW the value was chosen, in the SAME call — that is
   * the whole mechanism, and it is why this is a third argument rather than a second
   * method: a value and its origin written by two calls can be interleaved, and this repo
   * has already paid for a remembered fact that drifted from the thing it described.
   *
   * `'user'` is the DEFAULT (INV-5). Every ordinary write therefore resolves the path to
   * "a human chose this", without any of the dozens of call sites having to remember to;
   * the only way to record `'auto'` is to ask for it, so a site that forgets under-reports
   * nothing and a site that auto-binds must say so explicitly.
   *
   * `artifacts` (ITEM-35, DEC-D) is the FUSED MEMBER SET this write stands for — the whole
   * list of artifact ids a single fused pick spans, PRIMARY first, when the value is a fused
   * offer's primary id. `undefined`/absent on every ordinary (unfused) write, which is every
   * write in a single-dataset project. It is the companion fact the origin sidecar's shape is
   * mirrored for: the stored VALUE stays the one primary id (INV-4 forbids a composed one),
   * and the full set travels HERE so `resolveInputs` can record every member as its own `used`
   * edge rather than silently claiming a two-artifact colouring came from one. Written in the
   * SAME call as the value, for the same reason origin is — a set and its member list written
   * by two calls can interleave. A write with no `artifacts` CLEARS any set previously recorded
   * at this path, so re-picking a plain artifact over a fused one is honestly unfused again.
   */
  set(field: string, value: unknown, origin?: BindingOrigin, artifacts?: readonly string[]): void
  /**
   * How the value at `field` was chosen, or `undefined` when it was never written — i.e.
   * it still holds the spec's DECLARED `default:`, which is not in this vocabulary
   * (DEC-3: a declared default is the package author's consent; sole candidacy is not).
   *
   * `undefined` is a real answer and is NEVER coerced (INV-4). Nothing may refuse on it:
   * a gate that fires on the ABSENCE of a fact is indistinguishable from no gate at all,
   * which is a bug this tree has shipped twice.
   */
  originOf(field: string): BindingOrigin | undefined
  /**
   * The FUSED MEMBER SET recorded at `field` — the artifact ids a fused pick there spanned,
   * PRIMARY first — or `undefined` when the value was an ordinary (unfused) pick (ITEM-35,
   * DEC-D). The read is the SUBTREE, symmetric with {@link originOf}: a view declares its
   * input as a bare `$state.<field>` while a repeated control may write an indexed child, so
   * an exact-key-only read would answer `undefined` for the very slot the run consumes. A hit
   * on `field` itself is returned verbatim (the fused single-select case); otherwise the
   * children are concatenated in path order, first occurrence winning, so a member id is never
   * doubled. `undefined` is a real answer and is never coerced to `[]` (INV-4).
   */
  artifactsOf(field: string): readonly string[] | undefined
  /** Re-seed this view's `scope: pane` state fields from the pane scope (ITEM-11). A no-op for a
   *  view that declares none, and idempotent, so a render effect may call it unconditionally. It
   *  is what makes INV-8's binding half hold: an anchor change NULLS the pane's coordinate, and
   *  the section whose picker is bound to it sees the null rather than keeping a value that names
   *  positions in a row space nobody is looking at any more. */
  syncPaneScope(): void
  /** Replace the resolved `data` slices (the async job-result resolver's landing point):
   *  recompute `derived` against the new data + the current state, then re-render. State
   *  (user-driven sliders/gate) is untouched. `status` defaults to `ready` (data landed);
   *  pass `error` alongside `status: 'error'` for a PARTIAL failure (some slices resolved,
   *  one did not). */
  setData(data: Data, status?: DataStatus, error?: string, hint?: string): void
  /** Record a data-lifecycle transition that carries no new data — the resolver flipping to
   *  `loading` on a retry, or landing an `error` with nothing new to bake. Bumps `revision`
   *  (so subscribed regions repaint) but NOT `dataRevision` (no data arrived). */
  setDataStatus(status: DataStatus, error?: string, hint?: string): void
  /**
   * Begin a fresh INCREMENTAL landing sequence at `epoch` (incremental-landing ITEM-2). Resets the
   * per-slice chunk accumulator so the next `landChunk` starts from empty, and records `epoch` as
   * the LIVE one — a `landChunk` carrying an older epoch (a superseded resolve's late chunk) is
   * then discarded. State is untouched; nothing is painted until the first chunk lands.
   */
  beginLanding(epoch: number): void
  /**
   * Land ONE chunk of the current landing sequence (incremental-landing ITEM-2/3/5). Each chunk
   * carries the CUMULATIVE value of the columns it names (the producer accumulates the stream), so
   * a growing column REPLACES its prior value while sibling slices are carried through — earlier
   * rows survive because they are re-sent, not because the store appends. The resulting frame
   * REPLACES `liveData` as a NEW object (so the canvas identity-memo re-reads it — ITEM-5), and
   * `dataStatus` becomes `partial` (or `ready` when
   * `done`). The raw data paints immediately (revision + dataRevision bump); the `derived`
   * recompute is COALESCED via the scheduler so N chunks cost fewer than N full recomputes
   * (ITEM-3) — except the `done` chunk, which flushes synchronously so the final derived is
   * correct before the sequence ends. A chunk whose `epoch` is not the live one is DISCARDED.
   */
  landChunk(chunk: Data, opts: { done: boolean; epoch: number; error?: string; hint?: string }): void
  get(): { state: State; derived: Derived }
  /** `{ ...state, _state_token }` — what a read action / describe returns. */
  snapshot(): State & { _state_token: string }
  /** Subscribe to state/derived changes (fires after every `set`). Returns an
   *  unsubscribe. Powers a React region's `useSyncExternalStore` re-render so the
   *  scatter/violins/counts update live as sliders + gate mutate the shared store
   *  (ITEM-18). */
  subscribe(listener: () => void): () => void
  /** leave the instance directory (called on unmount). */
  dispose(): void
  /** TEST-ONLY (ITEM-3) — how many FULL `derived` recomputes this store has run. A coalesced
   *  incremental landing of N chunks must increment this by fewer than N. Not part of the runtime
   *  contract; read only in tests. */
  readonly __derivedRecomputeCount: number
}

/**
 * The scheduler the coalesced `derived` recompute defers to (incremental-landing ITEM-3 / DEC-8).
 * A CLIENT-SIDE render-scheduling detail, not an operational tunable — injectable (not hardcoded)
 * only so a test can drain it synchronously and count the coalescing. Default `queueMicrotask`, so
 * a burst of synchronous chunk lands collapses to one recompute at the microtask boundary.
 */
let recomputeScheduler: (fn: () => void) => void = fn => queueMicrotask(fn)

/** TEST-ONLY: override the coalescing scheduler (e.g. a manual queue the test drains). Returns a
 *  restore fn. */
export function __setRecomputeSchedulerForTests(fn: (run: () => void) => void): () => void {
  const prev = recomputeScheduler
  recomputeScheduler = fn
  return () => {
    recomputeScheduler = prev
  }
}

const isPlainFrame = (v: unknown): v is Record<string, unknown> =>
  v != null && typeof v === 'object' && !isColumn(v) && !ArrayBuffer.isView(v)

/**
 * Merge an arriving CUMULATIVE chunk into the landing, MIRRORING the frame shape (ITEM-2).
 *
 * ── WHY CUMULATIVE-REPLACE, NOT DELTA-APPEND (FIX-1.1) ─────────────────────────────────────────
 *
 * The ONE production producer of these chunks — the progressive columnar reader
 * (`columnarRead.ts` → `readColumnValues`) — emits each partial as the WHOLE column landed SO FAR
 * (it accumulates the stream's bytes and hands back the growing prefix). So a chunk column already
 * CONTAINS everything earlier chunks carried, and the landing must REPLACE that column, never
 * append to it — appending would double-count every row (`[1,2]`, then `[1,2,3,4]` would land as
 * `[1,2,1,2,3,4]`, and the user would watch the WRONG rows paint). The producer owns accumulation;
 * the store owns identity + status.
 *
 * A chunk has the same shape as `liveData`: a top-level `$data.<slice>` may be a COLUMN (a flat
 * streamed column) or a nested FRAME `{col: values}` (a `$data.<slice>` frame). Recurses so a growing
 * column of one slice REPLACES its prior value while a SIBLING slice/column an earlier chunk landed
 * is carried through untouched (`base`). Always returns NEW objects (never mutates `prev`) so the
 * canvas identity-memo re-reads the slice (ITEM-5).
 */
function mergeLanded(prev: unknown, next: unknown): unknown {
  // A column (or scalar) is REPLACED by the arriving cumulative value — see the block comment.
  if (isColumn(next) || !isPlainFrame(next)) return next
  const base = isPlainFrame(prev) ? prev : {}
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(next)) out[k] = mergeLanded(base[k], v)
  return out
}

// ITEM-4: `isColumn`, not `Array.isArray` — a TypedArray-backed column (`unique`'s operand under
// incremental landing) must be read as the column it is, not coerced to `[]` (which made `unique`
// return nothing over a typed column, with a clean console). `Array.from` materializes either
// backing into the `unknown[]` `unique` walks.
const asArray = (v: unknown): unknown[] => (isColumn(v) ? Array.from(v as ArrayLike<unknown>) : [])
// The NaN-for-missing coercion this module documented now lives in ONE place (ITEM-25). It is
// imported under its explicit name rather than aliased back to `asNums`, so the call sites below
// state which of the two semantics they mean — the canvas copies used `Number(x)`, i.e. 0 for a
// missing entry, and that fork is real rather than accidental duplication.
const asNums = asNumsNaNMissing

/**
 * Resolve a frame-consuming kernel's columnar operand — the `frame:` binding, DUAL-ACCEPTING the
 * pre-rename alias (declared `@deprecated` on `DerivedSpec` in `core/manifest/viewSpec.ts`).
 *
 * The three frame kernels (`keep_mask` / `columns_of` / `categories_by_column`) all take one
 * columnar `{ column: values[] }` operand. It used to be NAMED after one processor's data slice,
 * which forced every author to write that domain noun for a generic column map even when their
 * data was nothing of the kind — core privileging a domain word in the LANGUAGE, not merely in a
 * default. `frame:` is the neutral spelling; the alias stays honored so no shipping spec needs a
 * migration and no `WORKBENCH_API_VERSION` bump is required.
 *
 * REMOVE the alias arm below (and the deprecated fields on `DerivedSpec`) at the next MAJOR
 * `WORKBENCH_API_VERSION` — see `core/version.ts` (currently `1.0.0`) and the compatibility gate
 * in `core/manifest/validate.ts`.
 */
function frameOperand(
  spec: { frame?: ExprString; obs?: ExprString },
  scope: Scope,
): Record<string, readonly unknown[]> {
  const binding = spec.frame ?? spec.obs
  return (evalExpr(binding, scope) as Record<string, readonly unknown[]>) ?? {}
}

/** Evaluate one `derived` entry (a single primitive call, optionally repeated
 *  with `for_each`) against `scope`. */
function evalDerivedEntry(dspec: DerivedSpec, scope: Scope): unknown {
  if (dspec.for_each) {
    const inner = dspec.value
    const compute = (e: { item: unknown; scope: Scope }): unknown =>
      inner ? evalDerivedEntry(inner, e.scope) : e.item
    // MAP-keyed form (DRIFT-1.3): `key` present → an object keyed by that
    // per-iteration value (`$derived.ranges[$c]`); absent → the array form.
    if (dspec.key) {
      const out: Record<string, unknown> = {}
      for (const { key, entry } of expandForEachKeyed(dspec, scope, dspec.key)) {
        out[key] = compute(entry)
      }
      return out
    }
    return expandForEach(dspec, scope).map(compute)
  }
  if (dspec.extent !== undefined) return extent(asNums(evalExpr(dspec.extent, scope)))
  if (dspec.unique !== undefined) return unique(asArray(evalExpr(dspec.unique, scope)))
  if (dspec.filter_mask) {
    const fm = dspec.filter_mask
    return filter_mask({
      values: asNums(evalExpr(fm.values, scope)),
      group_of: asStrs(evalExpr(fm.group_of, scope)),
      ranges: (evalExpr(fm.ranges, scope) as Record<string, [number, number]>) ?? {},
    })
  }
  if (dspec.or_masks !== undefined) {
    return or_masks((evalExpr(dspec.or_masks, scope) as boolean[][]) ?? [])
  }
  if (dspec.gate_mask) {
    const gm = dspec.gate_mask
    return gate_mask({
      base: (evalExpr(gm.base, scope) as boolean[]) ?? [],
      gate: asNums(evalExpr(gm.gate, scope)),
    })
  }
  if (dspec.range_envelope !== undefined) {
    return range_envelope((evalExpr(dspec.range_envelope, scope) as Record<string, [number, number]>) ?? {})
  }
  if (dspec.count_by) {
    const cb = dspec.count_by
    return count_by({
      group: asStrs(evalExpr(cb.group, scope)),
      hidden: (evalExpr(cb.hidden, scope) as boolean[]) ?? [],
    })
  }
  if (dspec.keep_mask) {
    const km = dspec.keep_mask
    const criteria = (evalExpr(km.criteria, scope) as KeepCriterion[]) ?? []
    return keep_mask(Array.isArray(criteria) ? criteria : [], frameOperand(km, scope))
  }
  if (dspec.columns_of) {
    const co = dspec.columns_of
    // `as` is a DECLARED `{ <control>: <value> }` remap (C1/C2) — forwarded verbatim; the
    // primitive knows no vocabulary of its own.
    return columns_of(frameOperand(co, scope), { only: co.only, keyed: co.keyed, as: co.as })
  }
  if (dspec.categories_by_column) {
    return categories_by_column(frameOperand(dspec.categories_by_column, scope))
  }
  if (dspec.pending_criterion_columns) {
    // ITEM-34 — the loading gate. Same operand resolution as `keep_mask`, deliberately: the two
    // must be looking at the SAME frame, or the gate could report "ready" about a frame the mask
    // is evaluating as pending.
    const pc = dspec.pending_criterion_columns
    const criteria = (evalExpr(pc.criteria, scope) as KeepCriterion[]) ?? []
    return pendingCriterionColumns(Array.isArray(criteria) ? criteria : [], frameOperand(pc, scope))
  }
  return undefined
}

/** Recompute the full `derived` map. Entries compute in declaration order,
 *  accumulating so a later `derived` may reference an earlier one
 *  (`$derived.x`). */
function recomputeDerived(spec: ViewSpec, state: State, data: Data): Derived {
  const out: Derived = {}
  const scope: Scope = {
    state,
    data: data ?? {},
    const: spec.const ?? {},
    derived: out,
    params: {},
    job: (data as Record<string, unknown> | undefined)?.job,
  }
  for (const [name, dspec] of Object.entries(spec.derived ?? {})) {
    out[name] = evalDerivedEntry(dspec, scope)
  }
  return out
}

/**
 * Init a state field from its declared `default`, resolving `$`-refs ANYWHERE inside it against
 * `const`/`data`.
 *
 * A default used to be resolvable only when the WHOLE value was one ref, which meant a default
 * built out of several declared values had to restate them. That is how one set of rows came to
 * be written out three times across three files: the only way to seed "these four of those six"
 * was to copy the four. A leaf-wise walk lets a default REFERENCE a subset instead — the seed
 * and the catalog stay one source, and editing the catalog moves the seed with it.
 *
 * Only a leaf that STARTS with `$` is evaluated, exactly as before: every other string passes
 * through verbatim, so a literal that merely contains `$` (a regex, a price) is untouched and no
 * existing default resolves differently. A leaf that fails to resolve costs that leaf alone, not
 * the whole default — a seed with one hole is repairable; `undefined` for the lot is not.
 */
function initField(field: StateFieldSpec, spec: ViewSpec, data: Data): unknown {
  const scope: Scope = { const: spec.const ?? {}, data: data ?? {} }
  const resolve = (node: unknown): unknown => {
    if (typeof node === 'string') {
      if (node.trim()[0] !== '$') return node
      try {
        return evalExpr(node, scope)
      } catch {
        return undefined
      }
    }
    if (Array.isArray(node)) return node.map(resolve)
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(node)) out[k] = resolve(v)
      return out
    }
    return node
  }
  return resolve(field.default)
}

/** Immutably set a (possibly dotted) `path` on `obj`, cloning along the way. Prototype-polluting
 *  segments (`__proto__`/`constructor`/`prototype`) are rejected — the interpreter guards paths
 *  upstream, but `ViewStore.set` is public, so any other caller is defended here too. */
function setIn(obj: State, path: string, value: unknown): State {
  const parts = path.split('.')
  if (parts.some(p => p === '__proto__' || p === 'constructor' || p === 'prototype')) {
    throw new Error(`[declarative] unsafe state path (prototype pollution): ${path}`)
  }
  const root: State = { ...obj }
  let cur: Record<string, unknown> = root
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    const next = cur[k]
    // Clone the intermediate immutably, PRESERVING its kind: an ARRAY stays an array (so a
    // numeric-index path like `criteria.0.column` updates element 0 in place instead of
    // clobbering the whole list into a `{0:…}` OBJECT — which would break `for_each: $state.criteria`
    // and drop the row's sibling fields), an OBJECT stays an object, and a missing/primitive
    // segment starts a fresh object. (Array element access via the string index `"0"` works —
    // `arr["0"] === arr[0]`.)
    cur[k] = Array.isArray(next)
      ? [...next]
      : next && typeof next === 'object'
        ? { ...(next as object) }
        : {}
    cur = cur[k] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
  return root
}

/**
 * A draftable-entity binding (draftable-entity ITEM-10). A `draftable` view seeds its
 * reactive `$state` from a persisted `drafts` row's opaque `data` blob, and
 * debounce-persists every `set()` back through the draft. This is the ONLY draft-aware
 * seam in the reactive store; it is entirely INERT when absent (every non-draftable
 * view passes `undefined`), so existing views are provably unaffected. Core interprets
 * NOTHING about `data` (INV-1) — it seeds `$state` from it and hands it back verbatim.
 */
export interface DraftableBinding {
  /** The persisted `draft.data` blob to seed `$state` from — an opaque object keyed by
   *  the view's declared state-field names (a package concern; core never parses it). */
  readonly data: Record<string, unknown>
  /** Persist the current `$state` back to the draft (the ITEM-11 store debounces the
   *  actual PUT). Called on every `set()` for a draftable view. */
  persist(state: Record<string, unknown>): void
}

/**
 * Create a per-instance reactive store for `spec`, addressed by `viewId`, and
 * join the instance directory. `data` (optional) is the resolved job/artifact
 * slices the `derived` primitives read; omit it in a pure-state test. `draftable`
 * (optional) binds `$state` to a persisted draft (ITEM-10).
 */
export function createViewStore(
  spec: ViewSpec,
  viewId: string,
  data?: Data,
  draftable?: DraftableBinding,
): ViewStore {
  // ITEM-11 — the fields this view declared `scope: pane`. They are the PANE's values, not this
  // instance's: they seed from the pane scope (never from the field's own `default`, which would
  // clobber the pane's current anchor with a per-view opinion the instant a second section
  // mounted), and a `set` on one writes THROUGH. `parseViewSpec` has already refused any name
  // outside `PANE_SCOPE_KEYS`, so the cast below cannot reach a key the scope does not hold.
  const paneScoped = new Set(
    Object.entries(spec.state ?? {})
      .filter(([, f]) => (f as StateFieldSpec).scope === 'pane')
      .map(([name]) => name),
  )
  const initial: State = {}
  for (const [name, field] of Object.entries(spec.state ?? {})) {
    // draftable-entity ITEM-10 — the THIRD seed branch: a draftable view seeds each
    // (non-pane) state field from the persisted `draft.data` when that key is present,
    // else falls back to the field's declared `default`. A pane-scoped field is still
    // the pane's, never the draft's. Core reads `draft.data` opaquely (INV-1).
    if (paneScoped.has(name)) {
      initial[name] = currentPaneScope()[name as PaneScopeKey] ?? null
    } else if (draftable && Object.prototype.hasOwnProperty.call(draftable.data, name)) {
      initial[name] = draftable.data[name]
    } else {
      initial[name] = initField(field, spec, data)
    }
  }

  const versioned = createVersioned<State>(viewId, initial)
  // `data` is mutable so the async job-result resolver can land the real declared
  // slices AFTER the store is created (the store is created by the first region to mount,
  // before the fetch resolves — `setData` replaces it and recomputes `derived`).
  let liveData: Data = data
  // A re-render signal decoupled from the state `token` (which only bumps on a state
  // mutation): a `setData` bumps this so subscribed regions re-render when data arrives.
  let revision = 0
  // The DATA-only signal (DEC-2) — bumped by `setData` ONLY: never by a state `set`, and
  // never by a bare `setDataStatus` flip (see its implementation below).
  let dataRevision = 0
  // A store created WITH data (the gallery/test override) has nothing to wait for, and
  // neither does a view that declares no resolvable slice (DEC-3) — both start `ready`, so
  // a purely state-driven view is never pinned on a skeleton. Everything else starts
  // `loading` and the resolver lands a terminal status.
  let dataStatus: DataStatus = data !== undefined || !declaresResolvableData(spec) ? 'ready' : 'loading'
  let dataError: string | undefined
  let dataHint: string | undefined
  let derivedRecomputeCount = 0
  const runRecompute = (): void => {
    derived = recomputeDerived(spec, versioned.value, liveData)
    derivedRecomputeCount += 1
  }
  let derived: Derived = recomputeDerived(spec, versioned.value, liveData)
  derivedRecomputeCount += 1

  // ── Incremental landing state (ITEM-2/3) ──────────────────────────────────────────────────────
  // `landingEpoch` is the LIVE landing sequence; a `landChunk` from an older epoch is a superseded
  // resolve's straggler and is discarded. `accumulator` holds the latest per-column CUMULATIVE
  // values chunks replace. `derivedDirty`/`recomputeScheduled` drive the coalesced recompute: a
  // chunk marks derived dirty and schedules ONE flush, so N synchronous chunk lands cost one
  // recompute, not N.
  let landingEpoch = 0
  let accumulator: Record<string, unknown> | undefined
  let derivedDirty = false
  let recomputeScheduled = false
  // A recompute during INCREMENTAL landing may transiently observe two independently-landing
  // slices at different depths — a kernel then refuses (FRAME_DEPTH_MISMATCH). That is a "not ready
  // yet" for the coalesced flush, NOT a crash: keep the prior derived and wait for the next chunk to
  // even the depths (FIX-1.3). A recompute on the WHOLESALE paths (`set`/`setData`/`syncPaneScope`)
  // stays UNGUARDED — a mismatch there is over a complete frame and is a real bug worth surfacing.
  const landingRecompute = (): void => {
    try {
      runRecompute()
    } catch (e) {
      if ((e as { name?: string })?.name !== FRAME_DEPTH_MISMATCH) throw e
      // transient mixed-depth mid-landing — defer; the next chunk (or the final setData) resolves it.
    }
  }
  const flushDerived = (): void => {
    recomputeScheduled = false
    if (!derivedDirty) return
    derivedDirty = false
    landingRecompute()
    revision += 1
    emit()
  }
  const scheduleFlush = (): void => {
    derivedDirty = true
    if (recomputeScheduled) return
    recomputeScheduled = true
    recomputeScheduler(flushDerived)
  }
  // The origin SIDECAR (DEC-2) — keyed by the same dotted path `set` writes.
  //
  // Deliberately NOT a `{value, origin}` pair wrapping the stored value. That reading was
  // checked against this tree and refuted on four counts: `$state.x` is read by the
  // declarative expression language and by every `derived` primitive and `for_each`;
  // `snapshot()` is the AI-facing `<view>.describe` contract for EVERY field; a
  // `scope: pane` write coerces a non-string to `null`, so a pair would land as `null`;
  // and only artifact-ref bindings can be auto-bound, so wrapping taxes every field for a
  // property four of them have. The property the pair was WANTED for — that the value and
  // its origin cannot desynchronize — is preserved exactly, because both are written by
  // the one `set` call below and there is no other writer.
  //
  // A path absent from this map has no recorded origin. That is not "user by default"; it
  // is the declared default, still untouched.
  const origins = new Map<string, BindingOrigin>()
  // The FUSED-MEMBER-SET sidecar (ITEM-35, DEC-D) — the exact twin of `origins`, keyed by the
  // same dotted path `set` writes, and dropped by the same subtree rule. Kept as its OWN map
  // rather than widened onto the stored value for every reason the origin sidecar is: `$state.x`
  // is read by the expression language and every `derived` primitive, `snapshot()` is the
  // AI-facing describe contract, and a `scope: pane` write coerces a non-string to `null` — so
  // the value must stay the one primary id, and the set travels beside it. A path absent here
  // has no recorded member set: the pick was unfused (one artifact), which is every pick in a
  // single-dataset project.
  const artifactSets = new Map<string, readonly string[]>()
  /** Forget `field`'s origin AND member set AND every one recorded beneath it — the write-side
   *  twin of `originOf`/`artifactsOf`'s subtree fold. All must move together: a read that folds
   *  descendants and a delete that does not lets an orphan describe a value nobody holds. */
  const dropOriginSubtree = (field: string): void => {
    origins.delete(field)
    artifactSets.delete(field)
    const prefix = `${field}.`
    for (const path of [...origins.keys()]) {
      if (path.startsWith(prefix)) origins.delete(path)
    }
    for (const path of [...artifactSets.keys()]) {
      if (path.startsWith(prefix)) artifactSets.delete(path)
    }
  }

  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const l of listeners) l()
  }

  const snapshot = () => versioned.snapshot()

  // The instance-directory record for THIS store. Kept by reference so `dispose()` can
  // unregister by IDENTITY (this exact record) rather than by `type` — a same-`view_id`
  // remount registers a NEW record under the same id + type, and a type-only guard would
  // let this (older) store's dispose delete the LIVE remounted record. Object identity is
  // the store's unique token (no InstanceRecord schema change needed).
  const record: InstanceRecord = {
    type: spec.id,
    getHandlers: () => ({}),
    getSnapshot: () => snapshot(),
  }
  registerInstance(viewId, record)

  const store: ViewStore = {
    viewId,
    type: spec.id,
    get state() {
      return versioned.value
    },
    get derived() {
      return derived
    },
    get token() {
      return versioned.token
    },
    get data() {
      return liveData
    },
    get revision() {
      return revision
    },
    get dataStatus() {
      return dataStatus
    },
    get dataError() {
      return dataError
    },
    get dataHint() {
      return dataHint
    },
    get dataRevision() {
      return dataRevision
    },
    set(field, value, origin = ORIGIN_USER, artifacts) {
      // A PANE-scoped field's authority is the pane store, so the write goes there FIRST and the
      // local mirror follows. Writing only locally would leave the other sections reading the old
      // value; writing only to the pane would leave THIS view's `$state` stale until the next
      // sync. The mirror is what lets a section keep binding `$state.coordinate` — the field is
      // declared, not renamed — while `$scope.coordinate` is what every other section reads.
      //
      // Only the ROOT of a dotted path can be pane-scoped: the pane's values are scalars, so
      // `coordinate.x` is not a thing that exists, and treating a dotted write as a pane write
      // would silently drop everything after the first segment.
      const root = field.split('.')[0]
      if (paneScoped.has(root) && root === field) {
        paneScopeStore.getState().setValue(root, typeof value === 'string' ? value : null)
      }
      versioned.mutate(prev => setIn(prev, field, value))
      // Written UNCONDITIONALLY, in the same statement block as the value, so the two
      // cannot diverge. Overwriting matters as much as writing: re-picking an input that
      // was auto-bound IS the review, and the record has to say so (INV-5). A write that
      // only ever ADDED an origin would leave a reviewed input reading `auto` forever.
      //
      // A write to `field` REPLACES everything under it, so the origins under it go with the
      // values they described. Without this, an `auto` recorded at `f.0` survives a wholesale
      // `set('f', …, 'user')` and the parent read folds it back in — leaving a slot the user
      // has just answered permanently unreviewable, which is INV-5 failing in the direction
      // that cannot be cleared by any gesture.
      dropOriginSubtree(field)
      origins.set(field, origin)
      // The member set rides the SAME write. Recorded only when the pick was fused (a non-empty
      // set) — `dropOriginSubtree` above already cleared any prior one at this path, so an
      // ordinary re-pick over a fused value is honestly unfused again without a second gesture.
      // An empty array is treated as absence (INV-4): a fused offer always spans ≥2 members, so
      // an empty set is never a real fusion, only a caller's `[]` that would otherwise strand a
      // key nobody reads.
      if (artifacts && artifacts.length > 0) artifactSets.set(field, [...artifacts])
      runRecompute()
      revision += 1
      emit()
      // draftable-entity ITEM-10 — persist the new `$state` back to the draft (the
      // consumer store debounces the PUT). INERT for a non-draftable view (`draftable`
      // is undefined). Non-fatal: a persist wiring must never break a local `set`.
      //
      // PANE-SCOPED fields are EXCLUDED from the persisted blob: they belong to the pane
      // scope (they seed from it, not from `draft.data`), so writing them into
      // `draft.data` would let the persisted blob accumulate keys the seed never reads
      // back — polluting + growing the row over time (phase-6 low finding). Only the
      // fields a draftable view genuinely owns are persisted.
      if (draftable) {
        try {
          const persisted: State =
            paneScoped.size === 0
              ? versioned.value
              : Object.fromEntries(
                  Object.entries(versioned.value).filter(([name]) => !paneScoped.has(name)),
                )
          draftable.persist(persisted)
        } catch {
          // swallow — the debounced store surfaces its own persist errors.
        }
      }
    },
    originOf(field) {
      // The SUBTREE, not the exact key — folded with `auto` winning.
      //
      // A declaration and the write that satisfies it are routinely different paths. A
      // shipped view declares its input as a bare `$state.<field>` while the control that
      // fills it writes an INDEXED child, `<field>.{i}`, one entry per repeated row; an
      // exact-key lookup answers `undefined` for the very slot the run consumes, so a
      // DECLARED auto-bind could never report its own origin. Reading the exact key was wrong in both directions, and this is the
      // worse one: it under-reports, and under-reporting an unreviewed binding is the defect
      // this whole change exists to fix (over-reporting is only a false alarm).
      //
      // Folding also settles the MULTI-FIELD write. A shipped action sets two fields in
      // one body — the value the user picked, and a RESET of the dependent list beside it —
      // so the reset carries the gesture's own `user`. Each repeated control then auto-binds
      // its sole candidate into a child of that list. Without the fold the slot reports
      // `user` and the run claims a review of something nobody looked at; with it, the
      // `auto` beneath wins, which is the truth.
      //
      // `field` itself first, then every recorded path strictly BENEATH it. A separator
      // check, not a bare `startsWith`, so a sibling whose name merely begins the same is
      // not read as part of it.
      let out = origins.get(field)
      const prefix = `${field}.`
      for (const [path, origin] of origins) {
        if (path.startsWith(prefix)) out = strongerOrigin(out, origin)
      }
      return out
    },
    artifactsOf(field) {
      // Exact key first — the fused SINGLE-select case, where the widget wrote the member set
      // at the very path the input declares. Returned verbatim so its PRIMARY-first order (the
      // one `resolveInputs` and the recorder rely on) is preserved exactly.
      const exact = artifactSets.get(field)
      if (exact) return exact
      // Otherwise the SUBTREE, symmetric with `originOf`'s fold: a bare declared `$state.<field>`
      // satisfied by indexed children `<field>.{i}`. Concatenated in SORTED path order (Map
      // iteration order is insertion, not stable across re-picks) with first occurrence winning,
      // so a member id shared by two children is never doubled and the sequence is deterministic.
      const prefix = `${field}.`
      const children = [...artifactSets.keys()].filter(p => p.startsWith(prefix)).sort()
      if (children.length === 0) return undefined
      const seen = new Set<string>()
      const out: string[] = []
      for (const path of children) {
        for (const id of artifactSets.get(path) ?? []) {
          if (!seen.has(id)) {
            seen.add(id)
            out.push(id)
          }
        }
      }
      return out.length > 0 ? out : undefined
    },
    /** Re-seed the pane-scoped fields from the pane scope — called when the pane's own value
     *  changed under this view (an anchor change NULLS the coordinate, INV-8). A no-op when the
     *  view declares none, and when nothing actually differs, so it is safe from a render effect. */
    syncPaneScope() {
      if (paneScoped.size === 0) return
      const scope = currentPaneScope()
      let changed = false
      for (const name of paneScoped) {
        const next = scope[name as PaneScopeKey] ?? null
        if (versioned.value[name] !== next) {
          versioned.mutate(prev => setIn(prev, name, next))
          // The recorded origin described the value that was just replaced, so it is
          // DROPPED rather than carried. Carrying it is the stale-pair defect in
          // miniature: an anchor change NULLS the coordinate (INV-8), and an origin left
          // behind would go on describing how a value nobody holds any more was chosen.
          // Absence is the honest answer — the authority for a pane-scoped field's origin
          // is the pane store, not this mirror.
          //
          // The whole SUBTREE, symmetric with `originOf`'s fold. Deleting only the exact key
          // was the asymmetry a fix introduced: `set` explicitly anticipates a dotted write
          // under a pane-scoped root (its `root === field` guard exists for exactly that), so
          // a descendant origin can outlive the value it described and then be folded back in
          // by the parent read — which is the promise three lines up, broken.
          dropOriginSubtree(name)
          changed = true
        }
      }
      if (!changed) return
      runRecompute()
      revision += 1
      emit()
    },
    setData(next, status = 'ready', error, hint) {
      liveData = next
      dataStatus = status
      dataError = error
      dataHint = hint
      runRecompute()
      revision += 1
      dataRevision += 1
      emit()
    },
    setDataStatus(status, error, hint) {
      dataStatus = status
      dataError = error
      dataHint = hint
      // `revision` (repaint) yes; `dataRevision` NO — a status flip carries no new DATA, and
      // `dataRevision` is the widget error-boundary's reset key. Bumping it here made every
      // Try-again clear (and therefore re-throw + re-log) every latched widget error in the
      // region, which is the F7 symptom wearing a different hat (FIX-2.5).
      revision += 1
      emit()
    },
    beginLanding(epoch) {
      // Start a fresh accumulation and record the LIVE epoch. A `landChunk` carrying an older epoch
      // is a superseded resolve's straggler and will be discarded (ITEM-2). Any pending coalesced
      // flush from the previous sequence is dropped — its data is about to be replaced.
      landingEpoch = epoch
      accumulator = {}
      derivedDirty = false
      recomputeScheduled = false
    },
    landChunk(chunk, { done, epoch, error, hint }) {
      // A straggler from a SUPERSEDED landing (its epoch is no longer the live one) is DISCARDED —
      // it must not corrupt the frame the live sequence is accumulating (ITEM-2, the per-slice
      // epoch guard; the twin of viewData's generation guard, at chunk granularity).
      if (epoch !== landingEpoch) return
      // REPLACE each slice/column with this chunk's CUMULATIVE value (the producer accumulates —
      // see `mergeLanded`), while carrying sibling slices through. A fresh accumulator object AND a
      // fresh `liveData` object every chunk (never mutate in place) — the canvas slice-revision memo
      // is keyed on object IDENTITY, so a mutated slice returns a stale digest and the canvas
      // freezes (ITEM-5). Building new objects here is what keeps `rev` honest.
      const base = accumulator ?? {}
      const nextAcc = mergeLanded(base, chunk ?? {}) as Record<string, unknown>
      accumulator = nextAcc
      liveData = { ...nextAcc }
      dataStatus = done ? 'ready' : 'partial'
      dataError = error
      dataHint = hint
      // Paint the raw data NOW (progressive paint); coalesce the derived recompute (ITEM-3). The
      // FINAL chunk flushes synchronously so the sequence ends with correct derived values.
      revision += 1
      dataRevision += 1
      if (done) {
        // Final chunk: recompute synchronously so the sequence ends with correct derived values,
        // and cancel any still-pending coalesced flush (its data is now fully landed).
        derivedDirty = false
        recomputeScheduled = false
        landingRecompute()
      } else {
        scheduleFlush()
      }
      emit()
    },
    get __derivedRecomputeCount() {
      return derivedRecomputeCount
    },
    get() {
      return { state: versioned.value, derived }
    },
    snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      // Only leave if OUR record is still the registered one — an IDENTITY match, not
      // merely same-`type`. A fast remount replaces us under the same id with a new record;
      // a type-only guard would wrongly delete that live record.
      if (getInstanceRecord(viewId) === record) unregisterInstance(viewId)
    },
  }
  return store
}
