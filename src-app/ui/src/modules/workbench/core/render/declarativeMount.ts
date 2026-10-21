// Declarative-view MOUNT coordinator (PLAN.md ITEM-9 / ITEM-15 / ITEM-18). A single
// `view_spec` fans into several region-scoped `ViewContribution`s (`seam.ts`) that ALL
// bind ONE per-instance `view_id` → ONE reactive store (the cross-region wire). So the
// store must be created ONCE and SHARED across every region that mounts it, and disposed
// only when the LAST region unmounts. This module owns that.
//
// StrictMode-correctness (the load-bearing invariant): React.StrictMode double-invokes
// mount effects as retain → release → retain. The store's create + register + refcount
// therefore ALL live in the effect path (`retain`/`release`), NOT in render — a
// render-created `refs:0` entry would (a) leak if the render never commits and (b) get
// disposed by the StrictMode release with no live store recreated. `retain` creates +
// registers on the first retain AND RE-creates if a prior `release` disposed the store,
// so a release→retain cycle always leaves exactly ONE live, registered store. The React
// region reads the current store via `subscribeMount`/`peekStore` (a `useSyncExternalStore`
// source) so a recreation re-renders it — it never caches a disposed store.
//
// Split from the React component so the ref-count + registration logic is unit-testable
// and import-light.

import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import {
  createViewStore,
  type DraftableBinding,
  type ViewStore,
} from '@/modules/workbench/core/runtime/store'
import { registerViewStore, unregisterViewStore } from '@/modules/workbench/core/runtime/viewStores'
import { registerViewSpecActions } from '@/modules/workbench/core/runtime/interpreter'
import { getDeclarativeCanvasHost } from './canvasHost'
import { installBuiltinWidgets } from '@/modules/workbench/extensions'

interface MountEntry {
  store: ViewStore
  refs: number
  spec: ViewSpec
  data?: Record<string, unknown>
  /** The ANALYSIS whose pane rendered this file, when the caller knew it. A pane is one analysis
   *  and an analysis may declare several view files (INV-3), so closing the pane has to reach all
   *  of them — and the closing code knows the analysis, never the per-file ids. */
  analysisId?: string
}

const mounts = new Map<string, MountEntry>()
const mountListeners = new Map<string, Set<() => void>>()

function emit(viewId: string): void {
  const set = mountListeners.get(viewId)
  if (set) for (const l of set) l()
}

/**
 * Register the view's widget renderers + declared actions (both idempotent, render-safe).
 * This does NOT create the store or a `mounts` entry — creation is deferred to `retain`
 * so there is no `refs:0`-in-render entry to leak on an aborted render, and the
 * StrictMode release→retain cycle can recreate a disposed store.
 */
export function ensureViewRegistered(spec: ViewSpec): void {
  installBuiltinWidgets()
  registerViewSpecActions(spec)
}

/**
 * Subscribe to (re)creation / disposal of the shared store for `viewId`. The React region
 * drives a `useSyncExternalStore` off this so a StrictMode release→retain recreation (or
 * the first creation in the retain effect) re-renders it with the live store.
 */
export function subscribeMount(viewId: string, listener: () => void): () => void {
  let set = mountListeners.get(viewId)
  if (!set) {
    set = new Set()
    mountListeners.set(viewId, set)
  }
  set.add(listener)
  return () => {
    const s = mountListeners.get(viewId)
    if (!s) return
    s.delete(listener)
    if (s.size === 0) mountListeners.delete(viewId)
  }
}

/** The currently-live shared store for `viewId`, or `undefined` before the first `retain`
 *  (or after the last `release`). The `getSnapshot` for `subscribeMount`. */
export function peekStore(viewId: string): ViewStore | undefined {
  return mounts.get(viewId)?.store
}

/**
 * Retain a mount reference (called from a region's mount EFFECT). On the first retain (or
 * the first retain after a `release` disposed the store) it creates + registers the shared
 * store bound to `data`; subsequent retains just bump the refcount and return the SAME
 * live store. Returns the live store. `data` is honored only on the (re)creating call —
 * the store's `data` slices are baked at creation (the async resolver lands the real
 * slices via `store.setData` afterwards).
 */
export function retain(
  spec: ViewSpec,
  viewId: string,
  data?: Record<string, unknown>,
  analysisId?: string,
  draftable?: DraftableBinding,
): ViewStore {
  // Widgets + actions must be registered before any dispatch; idempotent.
  installBuiltinWidgets()
  registerViewSpecActions(spec)
  const existing = mounts.get(viewId)
  if (existing) {
    existing.refs += 1
    if (analysisId !== undefined) existing.analysisId = analysisId
    return existing.store
  }
  // draftable-entity ITEM-10 — the draft binding is honored only on the (re)creating
  // call (like `data`); a draftable view seeds `$state` from `draft.data` and
  // debounce-persists every `set` back. Absent for every non-draftable view.
  const store = createViewStore(spec, viewId, data, draftable)
  registerViewStore(viewId, store)
  mounts.set(viewId, { store, refs: 1, spec, data, analysisId })
  emit(viewId)
  return store
}

/** Release a mount reference (called on a region's unmount). Disposes + unregisters the
 *  store when the LAST region releases it. */
export function release(viewId: string): void {
  const entry = mounts.get(viewId)
  if (!entry) return
  entry.refs -= 1
  // DELIBERATELY does not dispose at zero.
  //
  // A region unmounts whenever its pane stops being the ACTIVE tab — the region renders
  // `{active ? <PaneBody/> : null}` — so "no React mount" means "not currently on screen", not
  // "no longer wanted". Disposing here destroyed the view's whole store on a tab switch: the
  // user came back to a form reset to defaults and a canvas with no plots, having changed
  // nothing. The state a user built is not scratch space for the renderer.
  //
  // The store's lifetime belongs to the PANE, which survives tab switches, so disposal moved to
  // `destroy()` on the pane-close path. A store therefore outlives its mount by design; the set
  // is bounded by the number of OPEN panes, and every close path already runs `clearPaneState`
  // beside it.
}

/**
 * Dispose everything a GONE pane mounted — closed by the user, retired by reconciliation, or
 * removed with its project. This is the counterpart to `retain`, and the only place a declarative
 * store is destroyed.
 *
 * Separate from `release` because the two answer different questions: `release` says "this region
 * stopped rendering it", `destroy` says "this pane no longer exists". Conflating them is what made
 * a tab switch look like a data loss.
 *
 * It also retires the pane's CANVAS contribution. The plots a view publishes are derived from this
 * store, so they have exactly its lifetime — and putting the retirement here rather than in the
 * region's unmount is what lets the canvas survive a tab switch without accumulating for the life
 * of the page: the same close paths that dispose a store now clear its canvas too, with no fourth
 * place to remember.
 *
 * `id` is what the CLOSING code holds — a contributed `view` pane's `ref`, i.e. the ANALYSIS id.
 * That is not a view id: a view file's store is keyed by its OWN spec id, and one analysis may
 * declare several files (INV-3). So both are honoured — the mount named `id`, plus every mount
 * that analysis retained. (Passing a pane's `id` here matched neither and disposed nothing, which
 * is why the store this was added to release outlived every close.)
 */
export function destroy(id: string): void {
  const ids = new Set<string>([id])
  for (const [viewId, entry] of mounts) if (entry.analysisId === id) ids.add(viewId)
  for (const viewId of ids) {
    // The canvas contribution is retired even for a view with no live mount: a backgrounded pane
    // has released its region, and its plots are exactly what must not survive the close.
    getDeclarativeCanvasHost()?.clear(viewId)
    const entry = mounts.get(viewId)
    if (!entry) continue
    entry.store.dispose()
    unregisterViewStore(viewId)
    mounts.delete(viewId)
    emit(viewId)
  }
}

/** Test-only reset. */
export function __resetDeclarativeMountsForTests(): void {
  for (const entry of mounts.values()) entry.store.dispose()
  mounts.clear()
  mountListeners.clear()
}

// ── read-only e2e seam (mirrors `window.__workbench` / `__workbenchRegistry`) ────────────────────
// The app ships as a preview build with no `/src` imports + no vitest in the browser, so an e2e
// reads the REAL reactive store state (a declarative view's `state`/`derived`) through this seam —
// the app's established pattern for asserting pure logic that has no DOM surface. Here it lets the
// cell-filter scatter spec assert the DATA-PLANE fact that a keep-set/threshold edit re-derives the
// `keptMask` (the surviving-cell count) that feeds the `obs.kept` scatter — proving the filter
// wiring independently of headless-GL pixels. Read-only.
//
// GATED like every sibling seam (`__cyto_read`/`__cyto_count_decodes`/`__cyto_stream`/
// `__vizPaneColors`/the chunk-delay seam): present in a dev server and in the e2e preview build
// (`VITE_ENABLE_TEST_SEAMS=1`), and folded away at build time in a release bundle — so a shipped
// app has no `__declarativeStores` at all.
//
// The gate, not a copy, is the guarantee. `data` is handed out BY REFERENCE: it is the live `$data`
// frame (whose columns `canvasBinding` also aliases into the render path and the keep-mask
// derivation), and this seam is POLLED, so deep-copying N-row columns on every tick would cost more
// than the assertions behind it are worth. That exposure is acceptable only because the seam does
// not exist outside dev/test; do not relax the gate and keep the reference.
if ((import.meta.env.DEV || import.meta.env.VITE_ENABLE_TEST_SEAMS) && typeof window !== 'undefined') {
  ;(window as unknown as { __declarativeStores?: unknown }).__declarativeStores = () =>
    Array.from(mounts.entries()).map(([viewId, entry]) => {
      const derived = entry.store.derived as { keptMask?: readonly boolean[] }
      const mask = Array.isArray(derived?.keptMask) ? derived.keptMask : undefined
      return {
        viewId,
        type: entry.store.type,
        state: entry.store.state,
        // incremental-landing (#29): the DATA-STATUS, so an e2e can observe an emit-plot colour
        // column pass through `partial` while it arrives progressively (the wholesale path never
        // emits `partial`), then reach `ready`. Read-only, and a scalar — no per-tick copy cost.
        dataStatus: entry.store.dataStatus,
        keptTotal: mask?.length ?? 0,
        keptCount: mask ? mask.filter(k => k !== false).length : 0,
        // ── the kept SET, not just its size (TEST-42) ──────────────────────────────────────
        //
        // A COUNT cannot distinguish a correct mask from a wrong one of the same size, and the
        // two are exactly what a coercion or bound change produces: an off-by-one bound and an
        // inverted comparison can agree on the total and disagree on every row. So the seam
        // exposes the surviving INDICES, which is the only form in which "which rows survived"
        // is assertable at all — there is no DOM surface for it and headless GL paints nothing.
        keptIndices: mask ? mask.map((k, i) => (k !== false ? i : -1)).filter(i => i >= 0) : [],
        // The resolved `$data` the mask was derived FROM, so a spec can compute its own oracle
        // over the same values rather than re-reading the store's conclusion. That independence
        // is what makes the assertion evidence instead of a tautology.
        // ── ITEM-34: what the picker OFFERS, and what it is still WAITING for ─────────────
        //
        // Under lazy column bodies a spec can no longer find a column by inspecting `data` —
        // that holds only the bodies already fetched, which before the first criterion is
        // NOTHING. The offered set is the view's own answer (`columns_of` over the producer's
        // declarations), so a spec picks from what the user can actually pick from, and a
        // spec that needs a NUMERIC column reads the control rather than sampling a value.
        //
        // Narrow on purpose: `derived` as a whole carries the full keep-mask, and this seam is
        // POLLED — copying an N-row boolean array across the bridge on every tick is a cost
        // with no assertion behind it.
        offeredColumns: Array.isArray((entry.store.derived as { columns?: unknown }).columns)
          ? ((entry.store.derived as { columns: Array<{ value?: unknown; control?: unknown }> }).columns.map(
              c => ({ value: String(c?.value ?? ''), control: String(c?.control ?? '') }),
            ))
          : [],
        pendingColumns: Array.isArray((entry.store.derived as { pendingColumns?: unknown }).pendingColumns)
          ? ((entry.store.derived as { pendingColumns: unknown[] }).pendingColumns.map(String))
          : [],
        data: entry.store.data,
      }
    })
}
