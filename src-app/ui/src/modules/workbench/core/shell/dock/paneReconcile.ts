// paneReconcile (ITEM-12) — reconcile contributed VIEWS into dock panes. A `ViewContribution`
// becomes a `view` pane (its `ref` = the view id) when it's available for the project, and its
// pane self-closes (removes + reflows) when availability is lost — WITHOUT disturbing unrelated
// panes. The AVAILABILITY set comes from `placeViews` (already area-general); this module is the
// pure diff (add / close) + a hook that applies it over the dock store.
//
// ── WHAT "AVAILABLE" ACTUALLY MEANS FOR A CONTRIBUTED VIEW (read this before trusting it) ────
//
// It means REGISTERED. Nothing narrower. `placeViews` filters on `Registry.availability`, which
// is `computeAvailability`, which reads `appliesTo` — and a `ViewContribution` never carries one
// (`seam.viewSpecsToContribution` sets `id`/`area`/`title`/`when`/`render`, and the `when` field
// is read by NOTHING since `computeAvailability` dropped that arm). `[].every(…)` is `true`, so
// every registered contributed view is available on every project, including an empty one, and
// the self-close arm above can only ever fire for a view that was UNREGISTERED or whose pane
// carries a stale `ref`. THAT IS STILL TRUE, and it is deliberately still true: it is the
// RETAINED set, and a pane the user opened on purpose has to survive.
//
// What is no longer true is that everything available also gets MOUNTED. `viewAutomountGate.ts`
// narrows the AUTO-MOUNT set to views whose owning ANALYSIS' `appliesTo` the project satisfies —
// unconditionally, no flag (it shipped behind one for a screenshot comparison; the gated side was
// adopted and the switch was deleted). It narrows the auto-mount set ONLY; see `reconcileViews`.
//
// The header used to assert a datatype gate that did not exist — as did
// `placement.isViewAvailable` and the e2e surface-wait helper in
// `tests/e2e/14-declarative-qc/_seed.ts`. That disagreement cost real diagnosis time: two e2e
// assertions were written expecting a launch to ADD a pane, which the product could not do
// because the pane was already mounted on every project.

import { useEffect } from 'react'
import { useStore } from 'zustand'
import type { Contributions, DatatypeLattice, ViewArea, WhenContext } from '@/modules/workbench/core'
import { placeViews } from '../placement'
import { SHELL_DEFAULT_PANE_VIEW_IDS } from '../builtinViews'
import { isViewAutoMountable } from './viewAutomountGate'
import { workbenchDockStore } from './WorkbenchDock.store'
import { workbenchRegionsStore } from '@/modules/workbench/core/shell/regions/WorkbenchRegions.store'
import { regionOfKind, type Region } from '@/modules/workbench/core/shell/regions/regionModel'
import type { WorkbenchPane } from './paneModel'
import { clearPaneState } from './paneState'
import { destroy as destroyDeclarativeMount } from '@/modules/workbench/core/render/declarativeMount'

// User-DISMISSED views (view ids the user explicitly closed). The reconcile auto-mounts every
// AVAILABLE view, so without this a manual close would be undone on the very next pass (the view is
// still available → re-added → "reopens immediately"). A dismissal suppresses re-mount until the
// view becomes UNavailable and later returns (or the project resets) — matching the intuition that
// closing a still-valid output hides it for this session, not forever.
const dismissedViewIds = new Set<string>()

/** Record that the user closed a contributed-view pane, so reconcile won't immediately re-add it. */
export function dismissView(viewId: string): void {
  dismissedViewIds.add(viewId)
}

/** Clear all dismissals (project switch / workspace reset — a fresh IA re-offers every view). */
export function resetDismissedViews(): void {
  dismissedViewIds.clear()
}

/** An existing `view` pane (its pane id + the view id it hosts). */
export interface ExistingViewPane {
  paneId: string
  viewId: string
}

/** The reconcile plan: view ids to ADD as panes, pane ids to CLOSE (view no longer available). */
export interface ReconcilePlan {
  toAdd: string[]
  toClose: string[]
}

/**
 * Pure reconcile: given the AVAILABLE view ids and the EXISTING view panes, compute what to add /
 * close. A newly-available view → add; a view pane whose view is no longer available → close.
 * Panes NOT in `existing` (other kinds) are never touched.
 *
 * `autoMountViewIds` is the subset that may be mounted WITHOUT being asked for. It is REQUIRED,
 * and deliberately so: it once defaulted to `availableViewIds` because the gate was a flag whose
 * OFF arm had to be byte-identical to the ungated product. There is no OFF arm any more, so that
 * default is a behaviour no caller wants — a future two-argument call would silently un-gate its
 * own call site while looking like it had said nothing.
 *
 * The two sets are separate because a view can legitimately be open without being auto-mountable:
 * the launcher's ⚙ "open the analysis form" stays enabled for an availability-gated analysis (the
 * owner's list-and-explain ruling), so it can add a pane for a view the gate refuses to mount. If
 * the CLOSE arm read the narrowed set, that pane would be removed on the very next pass and the
 * affordance would be gone rather than merely un-automatic — the gate is about the mount nobody
 * asked for, and nothing else.
 */
export function reconcileViews(
  availableViewIds: string[],
  existing: ExistingViewPane[],
  autoMountViewIds: string[],
): ReconcilePlan {
  const available = new Set(availableViewIds)
  const shown = new Set(existing.map(e => e.viewId))
  const toAdd = autoMountViewIds.filter(id => available.has(id) && !shown.has(id))
  // Close a pane whose view is gone — AND any DUPLICATE pane of a view that is still here,
  // keeping the first. Without the duplicate arm this diff is only forward-fixing: it stops
  // new double-mounts but silently accepts the ones already persisted, so every user who
  // opened the workbench while the double-add shipped keeps two identical tabs per analysis
  // forever (their layout is in `localStorage`; nothing rewrites it). A reconcile that cannot
  // repair the state it is reconciling is a reconcile in name only — verified against a
  // seeded pane-1..pane-4 layout, which stayed at four until this arm existed.
  const keptViewIds = new Set<string>()
  const toClose: string[] = []
  for (const e of existing) {
    if (!available.has(e.viewId)) {
      toClose.push(e.paneId)
      continue
    }
    if (keptViewIds.has(e.viewId)) toClose.push(e.paneId)
    else keptViewIds.add(e.viewId)
  }
  return { toAdd, toClose }
}

// Reconcile the contributable analysis areas — LEFT / RIGHT / BOTTOM — per the regionModel
// role→region contract (DEC-15: `control`/`run` → right, `output`/`report` → bottom, `inspect` →
// left; `plot` → the center canvas via the VizOption path, never a view tab). Every declarative
// processor surface fans into one of these areas and reconciles into a `view` pane there. A
// SHELL surface already has a DEDICATED default pane (`p-canvas`/`p-visualize` via
// `defaultMainSlice`), so reconciling one HERE would DUPLICATE it (the "double title /
// un-closable canvas" symptom). `SHELL_DEFAULT_PANE_VIEW_IDS` filters them out, so only
// analysis-contributed views (which have no default pane) mount + self-close.
//
// That set has shrunk to ONE (`workbench.canvas`): ITEM-9 took the right `workbench.selection`
// inspector, ITEM-33 took the left `workbench.visualize` field-provider rail. The filter is
// cardinality-agnostic, so TODAY it excludes nothing here — center is not a reconcilable area,
// and no shell view occupies left/right/bottom any more. `p-visualize` is retained as the vacant
// LEFT AREA host (DEC-H: no invented backfill), rendering `placeViews('left')`'s honest empty
// state until an extension contributes there. Its former RIGHT twin, the `p-selection`
// "Inspector" pane, is DELETED rather than retained: a second host for an area whose views
// ALREADY reconcile into `view` panes is not a vacant host but a DUPLICATE — every right-docked
// analysis rendered twice, once as its own tab and once inside the Inspector. The filter stays
// because the NEXT shell view to claim a reconcilable area needs it.
const VIEW_AREAS: readonly ViewArea[] = ['left', 'right', 'bottom'] as const

/** An available contributed view + the dock AREA (region) it declared. */
export interface AvailableView {
  id: string
  area: Region
}

/** All available analysis-contributed views across the reconcilable areas (deduped; the shell's own
 *  default-pane views are excluded). Each carries its declared `area` so reconcile docks the mounted
 *  pane into the matching region (right for control/run, bottom for output, left for inspect). */
export function availableViews(
  registry: Contributions,
  ctx: WhenContext,
  lattice: DatatypeLattice,
): AvailableView[] {
  const out: AvailableView[] = []
  const seen = new Set<string>()
  for (const area of VIEW_AREAS) {
    for (const v of placeViews(registry, area, ctx, lattice)) {
      if (SHELL_DEFAULT_PANE_VIEW_IDS.has(v.id) || seen.has(v.id)) continue
      seen.add(v.id)
      out.push({ id: v.id, area: area as Region })
    }
  }
  return out
}

/** All available contributed view ids across every reconcilable area (deduped). */
export function availableViewIds(
  registry: Contributions,
  ctx: WhenContext,
  lattice: DatatypeLattice,
): string[] {
  return availableViews(registry, ctx, lattice).map(v => v.id)
}

/** The `view` panes currently in the workspace (from the store's cells). */
function existingViewPanes(cells: Record<string, WorkbenchPane>): ExistingViewPane[] {
  const out: ExistingViewPane[] = []
  for (const p of Object.values(cells)) {
    if (p.kind === 'view' && p.ref) out.push({ paneId: p.id, viewId: p.ref })
  }
  return out
}

/**
 * Apply view reconciliation over the dock store (mount newly-available views as panes; self-close
 * panes whose view is gone). Runs whenever the availability inputs change. Unrelated panes are
 * never disturbed.
 */
export function useViewReconciliation(
  registry: Contributions,
  ctx: WhenContext,
  lattice: DatatypeLattice,
): void {
  const panes = useStore(workbenchDockStore, s => s.cells)
  // The REGIONS store's binding is a re-run trigger, not just the dock's. Child effects run
  // before parent effects, so this hook (in `WorkbenchDockHost`) docks its panes BEFORE
  // `WorkbenchShell`'s `ensureProject` runs — and that call "resets, then loads", discarding
  // the `regionOverride`s just written. The panes then fall to the default region instead of
  // the one their view DECLARED. Depending on the binding makes this run again afterwards, so
  // the placement is re-asserted against a regions slice that is done resetting.
  const regionsProject = useStore(workbenchRegionsStore, s => s.activeProjectId)
  useEffect(() => {
    const views = availableViews(registry, ctx, lattice)
    const ids = views.map(v => v.id)
    // The declared region for each available view id → reconcile docks the mounted pane there
    // (right for control/run surfaces, bottom for output, left for inspect — DEC-15).
    const areaOf = new Map(views.map(v => [v.id, v.area]))
    // Drop dismissals for views that are no longer available — so a view that legitimately leaves
    // and later returns re-mounts (a dismissal only suppresses the immediate re-add, not forever).
    const availableSet = new Set(ids)
    for (const dismissed of [...dismissedViewIds]) {
      if (!availableSet.has(dismissed)) dismissedViewIds.delete(dismissed)
    }
    // Diff against the store's CURRENT pane map, never the `cells` captured in this render's
    // closure. Adding a pane is a read-modify-write, and the closure is a snapshot the store
    // may already have moved past: `React.StrictMode` (on in `main.tsx`) double-invokes an
    // effect with the SAME closure, so both invocations read zero existing view panes and
    // both call `addPane`. That shipped as FOUR panes for TWO views — each declared view
    // mounted twice, and since only the second pair got its `moveToRegion`, the first pair
    // fell into the bottom region and read as a duplicate "view" tab with an identical
    // title.
    //
    // The subscribed pane map stays in the dep list — it is the right RE-RUN trigger — it is
    // just not the right thing to DECIDE from. The store is the only thing that knows what has
    // actually been added.
    const livePanes = workbenchDockStore.getState().cells
    // The AUTO-MOUNT set: every view whose owning analysis' declared input types the project has
    // actually produced. The RETAINED set stays `ids` — a pane the user opened for a gated
    // analysis is kept, only the unasked-for mount is withheld.
    const mountIds = ids.filter(id => isViewAutoMountable(id, registry, ctx, lattice))
    const { toAdd, toClose } = reconcileViews(ids, existingViewPanes(livePanes), mountIds)
    for (const paneId of toClose) {
      // The ANALYSIS the pane hosts — what a declarative store (and the canvas plots it publishes)
      // is keyed by. Read before the removal; the pane id itself names no mount.
      const ref = livePanes[paneId]?.ref
      // Only clear state when the pane was ACTUALLY removed (`removePane` no-ops on the last
      // surviving pane — keep-≥1 — so an unconditional clear would wipe that pane's state).
      if (workbenchDockStore.getState().removePane(paneId)) {
        clearPaneState(paneId)
        if (ref) destroyDeclarativeMount(ref)
      }
    }
    for (const viewId of toAdd) {
      // Honor a user dismissal — don't resurrect a view the user just closed.
      if (dismissedViewIds.has(viewId)) continue
      // ADDED ONLY — NOT PLACED HERE, and not focused here either.
      //
      // A `view` pane defaults to the CENTER region (canvas), which would pile it onto the canvas
      // ("canvas inside canvas"), so it has to end up in the region the view DECLARED. This line
      // used to do that with `moveToRegion`, and `moveToRegion` FOCUSES what it moves — which is
      // the defect: the auto-mount gate opens the instant the project produces the datatype an
      // analysis declared, i.e. the instant a run finishes, so a user reading the analysis
      // launcher had it replaced, mid-interaction, by a surface they never asked for. The pane
      // they were using stayed open; it just stopped being on screen.
      //
      // Focusing is a USER intent (a drag, a "+" menu pick, `revealPane` from an affordance the
      // user clicked). Placing is a RECONCILIATION. The store separates them into two verbs, and
      // the RE-ASSERTION LOOP BELOW is the one that performs the placing — for EVERY mounted view
      // pane including this one, on this same pass, with `dockToRegion`. So a placement here as
      // well is redundant: a mutation deleting it was killed by NOTHING, because the loop below
      // had already put the pane where it belongs. It is gone rather than kept as belt-and-braces
      // that hides which mechanism is load-bearing (the `axis`-prop and `shrink-0`/`w-full`
      // precedents). `paneAutoMountFocus.test.tsx` asserts the OUTCOME — mounted, docked into the
      // declared area, and NOT holding the region's active slot — so the loop cannot quietly stop
      // placing without something going red.
      //
      // The pane is not HIDDEN by any of this: a region with nothing selected falls through to
      // its first tab (`RegionShell.activeIn`), so an auto-mount into an empty region still shows
      // itself. It only stops overriding a selection the user made.
      void workbenchDockStore.getState().addPane('view', viewId)
    }
    // Re-assert the region for EVERY mounted view pane, not only the ones just added. The add
    // above is a one-shot, and the regions slice can be reset out from under it (see the
    // `regionsProject` note on the binding order) — leaving a pane docked wherever the default
    // put it, which is how BOTH analysis views ended up in the bottom strip while declaring
    // `right`. `moveToRegion` is idempotent, so re-asserting costs a map write and makes the
    // declared region the steady state rather than a one-time hope.
    for (const { paneId, viewId } of existingViewPanes(workbenchDockStore.getState().cells)) {
      const declared = areaOf.get(viewId)
      if (!declared) continue
      // `dockToRegion`, NOT `moveToRegion`: this re-assertion says WHERE a view pane belongs, and
      // must not also say which pane the user is looking at. `moveToRegion` focuses what it moves,
      // so running it over every view pane on every re-run handed the region's active slot to
      // whichever view came last — and this effect re-runs whenever the pane map changes, i.e.
      // every time any pane is opened.
      //
      // WITH ONE EXCEPTION: a pane that is actually BEING RELOCATED and currently holds its old
      // region's active slot carries that focus with it. Otherwise the relocation silently
      // CANCELS whatever revealed it — the pane lands in the declared region as an unselected tab
      // while the old region's `active` points at a pane that is no longer in it.
      //
      // This is not hypothetical and it is not the auto-mount path: a pane this pass just ADDED
      // holds no region's active slot at all (nothing activated it), so `carriesFocus` is false
      // for it and it takes the `dockToRegion` arm — which is exactly how an auto-mounted view
      // reaches its declared region without taking that region away from anyone.
      // It is the LAUNCH path this branch exists for: `analysis.launch` adds a pane for an analysis
      // the gate withheld and focuses `regionOverride[id] ?? regionOfKind('view')` — and a
      // brand-new pane has no override, so that is the `view` fallback `bottom`, not the area the
      // view declared. Before the gate this branch was unreachable because every declarative pane
      // was already mounted with its override.
      //
      // The no-steal property is intact: in the steady state `current === declared` for every
      // view pane, so this walk is the same no-op it was.
      const regions = workbenchRegionsStore.getState()
      const current = regions.regionOverride[paneId]
      const carriesFocus = current !== declared && regions.active[current ?? regionOfKind('view')] === paneId
      if (carriesFocus) regions.moveToRegion(paneId, declared)
      else regions.dockToRegion(paneId, declared)
    }
    // `panes` in deps re-checks after each add/close settles (idempotent — the diff is empty once
    // stable). `regionsProject` re-runs this after the shell binds/resets the regions slice, so the
    // docking survives that reset. `registry`/`lattice` are stable module refs.
    //
    // `ctx` is the one that carries the auto-mount gate: it holds the project's produced type ids,
    // so it is what MOVES when a project produces the artifact a withheld analysis was waiting
    // for. Omit it and the pane never appears — `panes` does not move on its own when a run
    // finishes, so nothing else in this list would re-run the effect.
    // `paneReconcileGateDeps.test.tsx` is the fixture that can actually observe that.
  }, [registry, lattice, ctx, panes, regionsProject])
}
