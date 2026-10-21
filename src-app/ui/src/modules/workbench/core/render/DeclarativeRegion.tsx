// DeclarativeRegion (PLAN.md ITEM-9 / ITEM-18) — the React host for ONE declarative
// `view_spec` inside its analysis' pane. Given a `DeclarativeView` (spec + `view_id`), it
// (1) resolves the per-instance store via the mount coordinator (`declarativeMount`),
// ref-counted so a StrictMode release→retain cycle always ends with one live store;
// (2) subscribes to the store via `useSyncExternalStore` so a `set` op anywhere
// (slider / gate / AI) re-renders it live (the real-time loop); (3) renders the interpreter
// (`WidgetList`) over the spec's widgets IN DECLARATION ORDER.
//
// It used to render only the widget ids its FANNED REGION was assigned, one component
// instance per region. With `layout.regions` gone there is one instance per view file, so
// the canvas/status "which region owns this" dedup and the id→widget indirection are gone
// with it: the widgets array IS this file's contribution to the pane, in order.
//
// It renders a FRAGMENT, not the pane frame. The frame is `DeclarativeStack`'s, because the
// pane belongs to the ANALYSIS and an analysis may declare several `ui:` files (INV-3): a
// frame per file would give one pane several independently-scrolling, separately-padded
// columns instead of one form stacked top to bottom.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useStore } from 'zustand'
import type { Job } from '@/api-client/types'
import { type DeclarativeRenderSpec, type DeclarativeView } from '@/modules/workbench/core/runtime/seam'
import { evalExpr, type Scope } from '@/modules/workbench/core/runtime/expr'
import { ensureViewRegistered, retain, release, subscribeMount, peekStore } from './declarativeMount'
import { workbenchRegistry } from '@/modules/workbench/core/contributions/workbenchRegistry'
import { resolveDraftBinding } from '@/modules/workbench/core/drafts/draftBinding'
import type { DraftableBinding } from '@/modules/workbench/core/runtime/store'
import { dataArgsRequestKey, resolveAndApplyViewData, retryViewData } from '@/modules/workbench/core/runtime/viewData'
import { axisSourceRequestKey } from '@/modules/workbench/core/runtime/axisSource'
import { deriveCaps } from '@/modules/workbench/core/runtime/caps'
import { createWorkbenchInterpreterCtx } from '@/modules/workbench/core/runtime/hostCtx'
import { getDeclarativeCanvasHost } from './canvasHost'
import { useWorkbench } from '../../core/shell/WorkbenchContext'
import { useArtifactCatalog, useValuePreviewSource } from './useArtifactCatalog'
import { CATALOG_SCOPE_KEY, type CatalogScope } from '@/modules/workbench/core/artifacts/catalog'
import { VALUE_PREVIEW_SCOPE_KEY } from '@/modules/workbench/core/artifacts/valuePreview'
import { FORM_VALIDITY_SCOPE_KEY, evaluateForm } from '@/modules/workbench/core/form/validity'
import { WidgetList } from './WidgetHost'
import { runAction } from '@/core/actions/defineAction'
import { AnalysisRunList } from '@/modules/workbench/core/shell/AnalysisRunList'
import { StatusBarJobsStore } from '@/modules/workbench/core/shell/statusBarJobsStore'
import { producerTargets, type ProducerCandidate } from '@/modules/workbench/core/runtime/producerTargets'
import { RegionBody } from './RegionBody'
import { RegionStatus } from './RegionStatus'
import { PaneScroll } from '@/modules/workbench/core/shell/dock/paneModel'
import { paneScopeStore } from '@/modules/workbench/core/runtime/paneScope.store'
import { sectionBadgeStore } from '@/modules/workbench/core/render/sectionBadge.store'
import { datatypeRegistry } from '@/core/datatypes'

/** Warn ONCE per view that declared a canvas with no canvas host installed (the publish
 *  effect re-runs on every state change, so an un-deduped log would spam). */
const warnedNoHost = new Set<string>()
function warnNoCanvasHost(specId: string): void {
  if (warnedNoHost.has(specId)) return
  warnedNoHost.add(specId)
  console.error(
    `[declarative] view "${specId}" declares a canvas but no canvas host is registered — ` +
      'the center will stay empty. Import `@/modules/workbench/extensions` on this mount path.',
  )
}

/**
 * The PANE an analysis' declarative UI renders into (INV-3): ONE frame, holding each declared
 * view file top to bottom in the manifest's `ui:` order.
 *
 * The frame lives here rather than in `DeclarativeRegion` because the PANE supplies the form-level
 * affordances — the scroll track, and inside it `RegionBody`'s readable width cap. One frame per
 * file would read as several stacked cards with their own scrollbars; one per pane makes the
 * stacked files one continuous form, with `RegionBody`'s `gap-3` rhythm running across the seam
 * between them exactly as it runs between two widgets of one file. The pane's INSET is neither
 * of theirs: it comes from the pane body (`RegionShell::paneContentClass`), once, for every kind.
 *
 * ── TWO TRACKS, NOT ONE ──────────────────────────────────────────────────────────────────────
 *
 * The pane is a column of a SCROLLING form and a PINNED run band, and the split is the whole
 * point. The run list used to be the last child of the form's own scroll container, so it sat at
 * the very bottom of whatever the form happened to be — and a declarative form is not a fixed
 * height: its list is rows a user ADDS. Measured on the gallery's 50-row surface, the run list
 * landed at y≈9169 in a 718px track; measured in the app, adding ONE row to a shipped analysis'
 * form put it at y≈808 in a 720px viewport. So the feedback for pressing Run was displaced,
 * without limit, by the growth of the very form that produces it — and nothing on screen said
 * to scroll.
 *
 * Which track absorbs the overflow is decided by which content is BOUNDED. The form is
 * unbounded by construction (a user adds rows), so it is the scroller. The run band is bounded
 * by construction (`ANALYSIS_RUNS_LIMIT` rows, `analysisRuns.ts`), so it can be pinned without
 * inventing a height for it: its cardinality bound IS its height bound. A `max-h` proportion on
 * the band (see `AnalysisRunList`) covers only the degenerate case of a pane dragged shorter
 * than the band itself.
 *
 * Rejected: sticky-positioning the list inside the ONE track (it stays in the scroll flow and
 * overlays the content it is meant to sit beside); auto-scrolling to the list after a launch
 * (fixes the moment, not the layout — the list is gone again the next time the user scrolls up,
 * and it is the same workaround the e2e was carrying); a fixed `max-h` on the form (a magic
 * height that hides the user's own inputs at every pane size but one); and moving the run list
 * out of the analysis pane entirely (an IA change the run-feedback design deliberately decided
 * against — the list is per-analysis, beside the form that launches it).
 */
export function DeclarativeStack({
  render,
  data,
  runs,
}: {
  render: DeclarativeRenderSpec
  /** test/gallery override of the resolved slices — applied to EVERY stacked file, the same
   *  way the real resolver runs for each. */
  data?: Record<string, unknown>
  /** test/gallery override of the job page the run band reads, for a harness with no
   *  authenticated session (the live refetch refuses without one — `StatusBarJobsStore.load`).
   *  Same footing as `data`: the REAL `AnalysisRunList` renders it, through the real
   *  `runsOfAnalysis` selection. */
  runs?: readonly Job[]
}) {
  return (
    // The PANE column. `flex-1` is load-bearing twice over: it gives the column the pane's full
    // height, so the band is flush with the pane's BOTTOM at every form size (a feedback surface
    // that moves depending on how long your form is, is a surface you have to hunt for), and it
    // makes the column's height DEFINITE, which is what the form track's `flex-1` and the band's
    // `max-h` percentage both resolve against.
    //
    // It is `w-full` and NOT width-capped. The cap belongs on the form CONTENT (`RegionBody`), one
    // box further in: capping the column capped the scroll track with it, which is what drew the
    // form's scrollbar 512px from the left of a wider pane instead of at the pane's edge. The
    // band still lines up with the form because both now take their inset from the same place —
    // the pane body (`paneContentClass`).
    <div
      data-testid={`declarative-pane-${render.analysis_id}`}
      className="flex min-h-0 w-full flex-1 flex-col"
    >
      {/* TRACK 1 — the form. `flex-1 min-h-0` is the ONE statement that the form is the track
          which absorbs the growth: it takes the leftover space and may shrink below its content,
          and this `ScrollArea` is what it absorbs it into.
          The scroller is the FULL-WIDTH track, never the capped column inside it — a scroll
          container's bar is drawn on its own right edge, so a capped scroller is a mid-pane bar.
          It is the kit's `ScrollArea` (overlayscrollbars) rather than a native `overflow-y-auto`:
          overlay bars take no layout space, so the form column does not reflow by ~15px the
          moment the form grows past its track. */}
      <PaneScroll
        axis="y"
        className="min-h-0 flex-1"
        data-testid={`declarative-form-track-${render.analysis_id}`}
      >
        <RegionBody data-testid={`declarative-region-body-${render.analysis_id}`}>
          {render.views.map(view => (
            <DeclarativeRegion
              key={view.view_id}
              view={view}
              data={data}
              analysisId={render.analysis_id}
            />
          ))}
        </RegionBody>
      </PaneScroll>
      {/* TRACK 2 — the run band. ONCE per analysis, after its stacked view files (INV-3: a pane
          can be several files; they are one analysis with one set of runs). Core rather than
          contributed — an analysis whose author forgot to declare a run list would silently lose
          the feedback, which is the failure this exists to remove. */}
      <AnalysisRunListHost analysisId={render.analysis_id} runs={runs} />
    </div>
  )
}


/** Drives the per-analysis run list off a `StatusBarJobsStore` instance, so the list reuses that
 *  store's job-page fetch + `sync:job` liveness (updating as runs start and finish, no reload)
 *  instead of hand-rolling its own bespoke `/api/jobs` fetch loop. */
function AnalysisRunListHost({ analysisId, runs }: { analysisId: string; runs?: readonly Job[] }) {
  const { projectId } = useWorkbench()
  const store = StatusBarJobsStore.use({ projectId })
  // BIND THE STORE HERE TOO.
  //
  // `start` is what seeds the project + fetches the first page; merely reading the store does not.
  // `StatusBarJobsStore` is a `defineLocalStore`, so `.use()` mints a FRESH instance per calling
  // component (React `useRef`) — this host gets its OWN store + `sync:job` subscription, independent
  // of the status bar's. That is deliberate: this list no longer depends on the status bar being
  // mounted to stay live. `start` is idempotent (a re-bind on the same project is one deduped load)
  // and re-binds on a project switch; the duplicate fetch/toast the two instances could produce is
  // absorbed by the `wb-job-<id>` toast-id de-dup.
  //
  // NOT gated here on the jobs permission. `load()` already refuses without it, and that is the
  // single place the question is asked — a second reading is how two surfaces come to disagree
  // about the same user. It also kept this render path out of a global (`usePermission` needs an
  // auth view registered) that the bare unit tier does not set up, which turned a core render
  // into something only the full app could mount.
  // `store` is deliberately NOT a dependency — the same shape the status bar's own bind uses.
  // The hook returns a fresh handle per render, so including it re-runs this effect on EVERY
  // render: `start` → `load` → sets state → render → effect again. The page then never settles,
  // which surfaces as a list whose rows are permanently un-clickable (Playwright: "visible,
  // enabled and stable" that never resolves) and a tab burning CPU. Binding is keyed on the
  // PROJECT, which is the only thing that should re-bind the store.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (projectId) store.start(projectId)
  }, [projectId])
  // The store holds LIST ROWS (`{ job, can_stop }`) since the stop right became a
  // server-stated fact; this list renders no Stop control, so it takes the jobs alone.
  return <AnalysisRunList analysisId={analysisId} jobs={runs ?? store.jobs.map(r => r.job)} />
}

export function DeclarativeRegion({
  view,
  data,
  analysisId,
  canvasOrder,
}: {
  view: DeclarativeView
  /** Where this view's canvas contribution belongs among the others on the shared grid,
   *  ASCENDING. The HOST knows the arrangement — a stack knows the order its blocks are in,
   *  and that order is the user's to change — so it is passed in rather than derived here.
   *  Omitted ⇒ unpositioned, which is what every host that has no arrangement to state says
   *  and is byte-identical to the behaviour before the field existed. */
  canvasOrder?: number
  /** The analysis this pane belongs to. Needed to DERIVE an actionable alert's destination
   *  from that analysis' own `consumes` — the view spec's id is not the analysis id. */
  analysisId?: string
  /** the resolved `data` slices (`obs` / `vis2D` / …) the store's `derived` primitives +
   *  the viz sources read. Resolved by the host from the job result; the store bakes it at
   *  first-region creation. (The job-result → `/obs` resolver is wired at the workbench
   *  data seam — see the module report; a region with no data renders the structure.) */
  data?: Record<string, unknown>
}) {
  const { view_spec: spec, view_id: viewId } = view
  const { api, projectId, producedTypeIds, lattice, refreshCatalog, catalogEpoch } = useWorkbench()

  // The datatype registry populates ASYNCHRONOUSLY, post-auth (`populateDatatypeRegistry`,
  // fired-and-forgotten from `modules/datatypes/module.tsx`), so it lands AFTER this pane
  // mounts. A render-time consumer that reads the registry once and never subscribes would
  // serve the bootstrap skeleton forever (issue #439). `getVersion` is a stable PRIMITIVE
  // that changes only on `replaceAll` — a resolve's own `setData`/`setDataStatus` writes
  // never touch it, so this cannot loop (unlike keying on `revision`, which every resolve
  // bumps). TWO consumers below depend on it:
  //   * the `data:` slice resolve effect — a slice whose source reads the registry
  //     (`container_members` reads `datatypeRegistry.get(...)?.input_requirements`) resolves
  //     ONCE against the bootstrap skeleton and lands `empty`, and `replaceAll` bumps
  //     neither `catalogEpoch` nor the state digests, so nothing re-fires it: the picker
  //     sits empty until a remount or a `refreshCatalog`. The version dep re-resolves it.
  //   * the capability set below — derived from the registry-backed `lattice`, which is a
  //     STABLE reference, so without the version dep the `has:<capability>` predicates
  //     evaluate against the capability-less bootstrap forever.
  const registryVersion = useSyncExternalStore(datatypeRegistry.subscribe, datatypeRegistry.getVersion)

  // The dataset capability set (ITEM-10 / DEC-12) the `has:<capability>` `when` predicate reads
  // off `scope.caps` — derived GENERALLY from the produced datatypes (union of each id's
  // ancestors + declared capabilities). So `has:fragments` / `has:embedding` evaluate against
  // REAL data, not a hardcoded per-analysis vocabulary.
  //
  // `registryVersion` is a dependency even though `lattice` already is one: `lattice` is the
  // REGISTRY-BACKED adapter (`createHost.ts:50-53`), a module-level constant passed through
  // the context value (`WorkbenchContext.tsx:160`), so it is a STABLE reference that never
  // changes when the registry populates — the memo would stay computed from the BOOTSTRAP
  // lattice, which carries NO capabilities (`core/datatypes/builtin.ts:23`), and the
  // `has:<capability>` predicates would evaluate against the capability-less bootstrap
  // forever. The version dep re-derives the set when the late populate lands.
  const caps = useMemo(() => deriveCaps(producedTypeIds, lattice), [producedTypeIds, lattice, registryVersion])

  // The candidate pool every `artifact_ref` widget in this pane resolves its own `source`
  // against (ITEM-7/8). Fetched once per pane per catalog epoch and handed down the render
  // scope, so the resolution runs in each widget's OWN (possibly `for_each`-bound) scope.
  const artifacts = useArtifactCatalog(api, catalogEpoch)

  // The value-excerpt READ a control uses to show what a CHOSEN column contains. Resolved
  // once, beside the catalog, and handed down the same way — a port, not a fetch: nothing
  // is read until a user selects something (DEC-1). Deliberately NOT keyed on
  // `catalogEpoch`: an artifact is immutable and content-addressed, so a new epoch changes
  // which artifacts exist, never what one of them contains.
  const valuePreview = useValuePreviewSource(api)

  // The host ctx a dispatched declared action runs over (ITEM-10) — wires
  // `run_processor`/`wait_for`/`toast` onto the REAL run/job pipeline. A completed run
  // refreshes the catalog so the freshly-produced artifact lands in the canvas feed.
  const hostCtx = useMemo(
    () => createWorkbenchInterpreterCtx({ api, projectId, onRunComplete: refreshCatalog }),
    [api, projectId, refreshCatalog],
  )

  // Register the view's widgets + declared actions (render-safe, idempotent). Creation of
  // the shared store is DEFERRED to the retain effect (StrictMode-correct: no render-created
  // refs:0 entry to leak, and a release→retain cycle recreates a live store).
  ensureViewRegistered(spec)

  // draftable-entity ITEM-8c — is this analysis a DRAFTABLE editor? A draftable analysis
  // declares an opaque `draftable` block; when present, the view's `$state` is bound to a
  // project-scoped `drafts` row (seed from `draft.data`, debounce-persist edits). Absent for
  // every ordinary analysis, where the retain runs synchronously exactly as before.
  const draftable = useMemo(
    () => (analysisId ? workbenchRegistry.analyses.get(analysisId)?.draftable : undefined),
    [analysisId],
  )
  const [draftBinding, setDraftBinding] = useState<DraftableBinding | undefined>(undefined)
  // Ready to retain immediately for a non-draftable view (unchanged timing); a draftable view
  // holds retain until its draft is resolved so `$state` seeds from `draft.data` (not defaults).
  const [draftReady, setDraftReady] = useState<boolean>(() => !draftable)

  // Resolve (resume/create) the draft for a draftable view BEFORE the store is retained, then
  // flip `draftReady` so the retain effect below runs with the seed + persist port in hand.
  useEffect(() => {
    if (!draftable || !projectId) {
      setDraftBinding(undefined)
      setDraftReady(true)
      return
    }
    let cancelled = false
    setDraftReady(false)
    void resolveDraftBinding(viewId, draftable, projectId)
      .then(binding => {
        if (cancelled) return
        setDraftBinding(binding)
        setDraftReady(true)
      })
      .catch(() => {
        // Fail-open: mount the editor without a draft binding rather than leave a blank pane.
        if (cancelled) return
        setDraftBinding(undefined)
        setDraftReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [draftable, projectId, viewId])

  // Ref-count the mount: the retain effect CREATES + registers the store on the first retain
  // and disposes it on the last release. Under React.StrictMode this runs
  // retain→release→retain; the coordinator recreates on the trailing retain so the pane
  // always ends with a live, registered store. For a draftable view it waits for `draftReady`
  // so the store is created WITH the draft seed (the 5th `retain` arg).
  useEffect(() => {
    if (!draftReady) return
    // `analysisId` travels with the retain so a CLOSE — which knows the analysis its pane hosts
    // and nothing about the per-file ids — can reach every file this pane mounted (INV-3).
    retain(spec, viewId, data, analysisId, draftBinding)
    return () => release(viewId)
  }, [spec, viewId, data, analysisId, draftReady, draftBinding])

  // The current shared store (created by the retain effect). `undefined` on the very first
  // paint before the effect runs (or briefly during a StrictMode remount); `subscribeMount`
  // re-renders us the moment it (re)appears.
  const store = useSyncExternalStore(
    listener => subscribeMount(viewId, listener),
    () => peekStore(viewId),
    () => peekStore(viewId),
  )

  // Re-render whenever the store changes (slider / gate / AI `set`, OR a `setData` data
  // arrival — `revision` bumps on both, unlike the state `token`). Subscribes only once the
  // store exists (the first paint before the retain effect has none).
  const revision = useSyncExternalStore(
    listener => (store ? store.subscribe(listener) : () => {}),
    () => store?.revision ?? -1,
    () => store?.revision ?? -1,
  )

  // The AXIS-SOURCE half of the request key (ITEM-11). An `axis_columns` slice reads the
  // columns on an axis of the dataset ANOTHER CONTROL points at, so the catalog epoch alone
  // is not a sufficient trigger: picking a different dataset changes the answer with the
  // catalog untouched. This digests only the RESOLVED `of` values, so it is stable across
  // the slider/gate traffic that bumps `revision` many times a second — a raw `revision`
  // dep would turn every drag tick into a refetch. A spec with no axis source digests to
  // the empty string and this reduces to exactly the previous epoch-only behaviour.
  const axisKey = useMemo(
    () => axisSourceRequestKey(spec, store?.state),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `revision` is the change signal for `store.state`.
    [spec, store, revision],
  )

  // The STATE half of the same trigger. A slice may bind its args to this view's OWN state —
  // the emit model's values read (`of: "$state.plots"`) and the entry section's header
  // (`show: "$state.show"`) both do — and neither the catalog epoch nor `axisKey` moves when
  // that state changes. Without it such a slice resolves once per mount and never again: the
  // plots a user emits carry no values, and the header select changes the display to nothing.
  // Digested rather than keyed on `revision` for the reason above it: a drag must not refetch.
  const stateKey = useMemo(
    () => dataArgsRequestKey(spec, store?.state),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `revision` is the change signal for `store.state`.
    [spec, store, revision],
  )

  // `$scope` — THE PANE-LEVEL SHARED STATE (ITEM-10/ITEM-11), subscribed so a section
  // re-renders (and re-resolves) when the pane's anchor changes.
  //
  // It is a `$`-REF ROOT rather than an internal channel like `caps` or the catalog, because
  // a view has to be able to NAME it: an anchored source declares `aligned_to: "$scope.axis"`,
  // and the whole point of the seam is that the view says WHICH row space and the engine
  // decides everything else. It is READ-ONLY from here — the anchor control is the only
  // writer (§4.5), which is what keeps "one value, one owner" true.
  const paneScope = useStore(paneScopeStore, s => s.scope)

  // ITEM-11 — re-seed any `scope: pane` state field from the pane scope when the pane's own value
  // changed under this view. The write direction is the store's (`set` on a pane-scoped field
  // writes THROUGH); this is the read direction, and it is the half INV-8's binding rule needs:
  // an anchor change NULLS the pane's coordinate, and § Coordinates' picker has to SEE that null
  // rather than keep pointing at positions in a row space nobody is looking at. Idempotent and a
  // no-op for a view that declares no pane-scoped field, which is every view but one.
  useEffect(() => {
    peekStore(viewId)?.syncPaneScope()
  }, [viewId, paneScope, revision])

  // ITEM-64 / R6 — publish WHAT THIS VIEW IS HOLDING, so its host frame can mark a collapsed
  // section without reading the section's fields. The number is the view's OWN declaration
  // (`spec.badge`, an expression over its own state); a view that declares none publishes none,
  // and the frame renders none. Retracted on unmount so a closed pane leaves no stale mark.
  useEffect(() => {
    if (spec.badge === undefined) return
    const s = peekStore(viewId)
    if (!s) return
    let count: unknown
    try {
      count = evalExpr(spec.badge, { state: s.state, derived: s.derived, data: s.data ?? {}, const: spec.const ?? {} })
    } catch {
      // A badge that cannot be evaluated states nothing, rather than throwing a pane down for a
      // decoration. The declaration is the author's to fix; the section still renders.
      count = undefined
    }
    sectionBadgeStore.getState().publish(viewId, typeof count === 'number' ? count : Number(count))
  }, [viewId, spec, revision])
  useEffect(() => () => sectionBadgeStore.getState().clear(viewId), [viewId])

  // Resolve the declared `data` slices via the real host hook and land them in the store
  // (`setData`) so the pane paints from real cells (DRIFT-3.5). Since Slice 2 the resolver
  // also lands a `dataStatus`, so a FAILURE is no longer swallowed into a blank pane — it
  // becomes the `RegionStatus` alert below (F3). Skipped when the host passed explicit `data`.
  // `catalogEpoch` is the re-resolve trigger (FIX-2.4), and `registryVersion` (declared
  // above) is the second one — the late registry populate must re-resolve a slice whose
  // source reads the registry (issue #439). Without ANY trigger the resolver ran exactly
  // once per mount, so a pane that landed `empty` on a fresh project stayed pinned
  // on "No data yet" forever — even after the user ran the analysis that produces its input.
  // It is keyed on the catalog EPOCH, not on `producedTypeIds`: the latter is a SET of
  // datatypes, so RE-running an analysis that produces an already-present datatype leaves it
  // byte-identical and the pane would keep serving the previous artifact. The epoch (plus
  // `axisKey`) is also the request key, so a genuinely new catalog or a new axis anchor
  // supersedes an in-flight resolve instead of being dropped.
  useEffect(() => {
    if (data !== undefined) return
    // The PANE SCOPE is part of the request key, not just of the render scope. An anchored
    // slice (`aligned_to: "$scope.axis"`) resolves to a DIFFERENT answer under a different
    // anchor with the catalog byte-identical, so without this the sections would render the
    // first anchor's columns forever: a new key SUPERSEDES the in-flight resolve instead of
    // de-duping against it, which is the same reason `axisKey` is here.
    void resolveAndApplyViewData(
      viewId,
      spec,
      api,
      `catalog:${catalogEpoch}${axisKey}${stateKey}|registry:${registryVersion}|scope:${paneScope.axis ?? ''}/${paneScope.coordinate ?? ''}`,
    )
  }, [viewId, spec, api, data, catalogEpoch, axisKey, stateKey, paneScope, registryVersion])

  // Hand the view's declared `canvas` block to the registered canvas HOST on every data/state
  // change (`revision`). Core forwards the spec + the resolved slices + the reactive scope and
  // knows nothing else: what a canvas is, which derived value is its keep-mask, which dataset
  // base carries coordinates, and where those coordinates come from all live in the canvas
  // extension (`extensions/canvas/canvasHostProvider`). No host registered (a headless mount)
  // ⇒ a no-op.
  //
  // This used to be gated on OWNING the canvas — the first populated fanned region of the
  // view published, the others stood down — because a fan of three components all held the
  // same spec and would have published it three times. One pane per view retires the gate.
  useEffect(() => {
    const s = peekStore(viewId)
    if (!s) return
    const canvasData = (s.data ?? data ?? {}) as Record<string, unknown>
    const host = getDeclarativeCanvasHost()
    if (!host) {
      // LOUD, not silent: a view that DECLARES a canvas and finds no host would otherwise
      // paint the empty hero forever with no diagnostic — the exact silent-failure shape this
      // seam replaced a direct import to avoid. (A canvas-less view says nothing.)
      if (spec.canvas != null) warnNoCanvasHost(spec.id)
      return
    }
    host.publish({
      spec,
      viewId,
      data: canvasData,
      scope: {
        params: {},
        state: s.state,
        derived: s.derived,
        const: spec.const ?? {},
        data: canvasData,
        caps,
        // The SAME reading the render scope below carries. A canvas series' `when` is
        // evaluated by the same `evalWhen` over this scope (`canvasBinding.ts`), so leaving
        // it out would make `$dataStatus` resolve to `undefined` there — a series gated on it
        // would read correctly and silently never draw.
        dataStatus: s.dataStatus,
        // The same reading, for the same reason: a canvas `coords` binding names
        // `$scope.coordinate`, and a root absent HERE resolves to `undefined` in the canvas
        // while reading correctly in the form.
        scope: paneScope,
      },
      api,
      projectId,
      hostCtx,
      catalogEpoch,
      order: canvasOrder,
    })
  }, [viewId, spec, data, caps, revision, hostCtx, api, projectId, catalogEpoch, canvasOrder, paneScope])

  // WHICH controls the user has CHANGED this session (DEC-4).
  //
  // It lives HERE and dies with the pane, deliberately: touched-ness is UI state, not view
  // state. It is not part of what the run receives, so it must never enter the view store —
  // `store.snapshot()` feeds the instance directory and the agent-facing surface, and a
  // form's "has this been typed in yet" bookkeeping does not belong in either.
  //
  // The set is REPLACED rather than mutated so a `useSyncExternalStore`-free re-render is
  // triggered by ordinary React state, which is what makes a field redden on the next
  // keystroke rather than on the next unrelated update.
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set())
  const onTouch = useCallback((key: string) => {
    setTouched(prev => (prev.has(key) ? prev : new Set(prev).add(key)))
  }, [])

  // The render SCOPE and the form's VALIDITY, built together and memoized together.
  //
  // Together, because they must not be able to disagree: the verdict a field shows has to
  // be derived from the same binding, in the same scope, on the same render as the value it
  // is about. Building one scope and evaluating it — rather than evaluating "state" while
  // the controls render from an iteration scope — is what makes row i showing row j's error
  // structurally impossible rather than merely untested.
  //
  // `revision` is the change signal for `store.state` / `store.derived` / `store.data`
  // (a state `set` and a `setData` both bump it), so it stands in for all three.
  const scoped = useMemo(
    () => {
      if (!store) return undefined
      const resolved = (store.data ?? data ?? {}) as Record<string, unknown>
      const base: Scope = {
        params: {},
        state: store.state,
        derived: store.derived,
        const: spec.const ?? {},
        data: resolved,
        caps,
        // WHERE THIS REGION'S DECLARED DATA IS IN ITS LIFECYCLE (`loading`/`ready`/`empty`/
        // `unreadable`/`error`), readable by a `when` as `$dataStatus`.
        //
        // A `$`-REF ROOT, not an internal channel like `caps` or the catalog: those answer a
        // question the view asked (a declared `source`, a declared capability test), and a
        // view may not query them itself. This is the region's OWN state, about the very
        // slices the view declared, and a view has to be able to name it — because
        // `$data`/`$derived` alone cannot distinguish "resolved and there is nothing" from
        // "not answered yet". Both read empty, and a view that says something in the first
        // state says the same thing in the second, where it is false. A shipped view's
        // "this dataset carries no measurements" alert did exactly that, on the first mount
        // of every project holding exactly ONE candidate: `artifact_ref` pre-selects a sole
        // candidate, so the input is chosen before the frame it anchors has landed
        // (`core/render/dataStatusGate.test.tsx` holds that window open and pins it).
        //
        // It carries the STORE's `DataStatus` verbatim — the same values `RegionStatus`
        // renders and the resolver lands. There is deliberately no second vocabulary, no
        // "refreshing", no boolean `isLoading`: two spellings of one lifecycle is how the
        // region and the view come to disagree about the same fetch. The set grows only when
        // a state it genuinely lacks turns up (`unreadable`, ITEM-1), never by re-spelling
        // one it already has.
        dataStatus: store.dataStatus,
        // `$scope` — the pane-level frame (ITEM-10/ITEM-11). Exactly the design's two values
        // and no more (INV-13); a third would be a fact the pane does not have.
        scope: paneScope,
        // The project's artifact rows, for the widgets that resolve their OWN input source
        // (ITEM-7/8). An INTERNAL channel like `caps` — not a `$`-ref namespace: a view
        // declares a `source` and the engine answers it; it may not query the catalog itself.
        [CATALOG_SCOPE_KEY]: { artifacts, lattice } satisfies CatalogScope,
        // The value-preview PORT, on its own internal channel beside the catalog. Separate
        // because it is separately absent: a host with no data plane publishes rows and no
        // preview, and a control must then render exactly as it did before rather than break.
        [VALUE_PREVIEW_SCOPE_KEY]: valuePreview,
      }
      // The pre-pass, on the same internal-channel footing as the catalog: a view DECLARES
      // a constraint and the engine answers it — there is no `$validity` to read.
      return { ...base, [FORM_VALIDITY_SCOPE_KEY]: evaluateForm(spec, base) }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `revision` is the change signal for the store's state/derived/data.
    [store, revision, spec, data, caps, artifacts, lattice, valuePreview, paneScope],
  )

  // NOTHING is torn down here on unmount.
  //
  // A region unmounts whenever its pane stops being the ACTIVE tab (the shell renders
  // `{active ? <PaneBody/> : null}`), so a `clear` here treated a tab switch as a close: the user
  // switched tabs and came back to a blank canvas, having changed nothing. It is the same mistake
  // `declarativeMount.release` was fixed for one layer down — and it had to be fixed in BOTH
  // places, because the store surviving is no use if the plots built from it do not.
  //
  // The canvas contribution's lifetime is the declarative STORE's lifetime, which is the PANE's:
  // `declarativeMount.destroy` retires it, from the same three real close paths that dispose the
  // store. DEC-4 explicit removal still holds — it just happens on a close, not on a repaint.

  // First paint before the retain effect has created the store: render the pane shell so
  // there is no crash; the subscribeMount re-render swaps in the live store immediately.
  if (!store || !scoped) {
    return <div className="flex min-h-0 flex-1 flex-col" data-testid={`declarative-region-pending-${viewId}`} />
  }

  // C6 (DOMAIN_AUDIT) — the input-ready GATE that used to live here is deleted, along with
  // `core/runtime/gate.ts`. It was unreachable AND domain-coupled while dead: core hardcoded
  // that a view's `const.criteria` MEANT "the required obs metric columns", and its
  // `GateData` privileged a slice literally named `obs`. No shipping view_spec declares
  // `const.criteria` as a string array, so the gate answered "ready" for every real view.
  //
  // The need it was reaching for is now met properly and per-control: an `artifact_ref`
  // whose axis-scoped source has no anchor renders its own "choose the input above first"
  // state, and a `button` states its own `disabledWhen` — both DECLARED by the view rather
  // than inferred by core from one processor's `const` block.

  const scope: Scope = scoped
  const widgets = (
    <WidgetList
      // INV-3 — the spec's widgets ARE the pane, in DECLARATION ORDER. This used to be the
      // subset a fanned region was assigned, looked up by id through `layout.regions`; a
      // widget that declared no id was therefore unplaceable and silently never rendered.
      specs={spec.widgets ?? []}
      scope={scope}
      viewId={viewId}
      specId={spec.id}
      hostCtx={hostCtx}
      // DEC-6: the guidance TEXT is the view's, the DESTINATION is derived. Computed here
      // because the derivation needs the registry, which the render layer has no business
      // reaching into on its own.
      producerTargets={() =>
        analysisId
          ? producerTargets(
              analysisId,
              api.registry.analyses.all() as unknown as ProducerCandidate[],
            )
          : []
      }
      // DEC-8: the SAME route a launcher click takes. Poking the dock directly would fork
      // routing that was deliberately unified — and an affordance that opens a pane by a
      // second path is an affordance that behaves differently for no stated reason.
      launchAnalysis={(id: string) => {
        void runAction('analysis.launch', { view_id: viewId, analysis_id: id }).catch(
          (err: unknown) => console.error('[declarative] alert action: analysis.launch failed', err),
        )
      }}
      // F7 / DEC-2: a PRIMITIVE, data-only reset signal. This used to be the `scope` object,
      // which is rebuilt on every render — so the boundary reset every time and never latched.
      resetKey={store.dataRevision}
      touched={touched}
      onTouch={onTouch}
    />
  )

  // F3 / ITEM-5 — the failure-surface vocabulary, rendered inside the shared `RegionBody`
  // frame (which supplies padding, inter-widget rhythm, a readable width cap, and
  // content-sized action buttons instead of controls stretched edge-to-edge in a wide dock):
  //
  //   loading    → the skeleton REPLACES the widgets. Nothing below it is meaningful yet,
  //                and showing the form would have every options-bound control assert "No
  //                options yet" while a skeleton above says data is coming (FIX-2.7). It is
  //                bounded by `VIEW_DATA_TIMEOUT_MS`, so it cannot become a permanent wall.
  //                THIS IS THE ONLY ARM THAT UNMOUNTS THE FORM, and it is reserved for the
  //                one status that is in flight: a TERMINAL status that fell in here would
  //                take away the control the user just used, permanently.
  //   error      → a named, retryable `ErrorState` ABOVE the widgets.
  //   unreadable → the same, with the sentence for "the inputs are here and unreadable".
  //   empty      → an explicit no-data state ABOVE the widgets.
  //   partial    → a non-blocking "loading more" strip ABOVE the widgets (incremental-landing
  //                ITEM-1 / DEC-2). Deliberately NOT in the `loading` arm below: `partial` means
  //                rows HAVE landed and are painting, so unmounting the form would hide exactly the
  //                progressive paint this behaviour exists to show. It renders widgets, like ready.
  //   ready      → nothing at all.
  //
  // ABOVE, not INSTEAD OF, for error/empty (FIX-1.2). Replacing the form deadlocks a
  // processor whose pane holds the RUN button for the very datatype it declares — `qc.yaml`
  // declares `report/qc`, which that Run produces — so a fresh project would show "No data
  // yet. Run the analysis that produces its input" with the Run button hidden behind the
  // message telling the user to run it. Rendering above also keeps the slices that DID
  // resolve visible on a partial failure.
  //
  // This is a DELIBERATE deviation from the kit `ErrorState`'s "replace, don't stack"
  // placement rule. That rule assumes the section's content is nothing but a view OF the
  // failed resource; here the section is a CONTROL FORM whose primary action is what
  // produces the resource. Stacking is the lesser evil, and the alternative was a measured
  // deadlock. Recorded in DESIGN_FIDELITY rather than silently taken.
  //
  // There is no longer an OWNING region to elect: one view file is one interpreter, so the
  // status is rendered once by construction rather than by a first-populated-region tiebreak.
  // It is PER FILE, not per pane: each declares its own `data` slices and can fail on its own,
  // and a pane-level status could only name one of them.
  const status = (
    <RegionStatus
      status={store.dataStatus}
      error={store.dataError}
      hint={store.dataHint}
      resource={spec.title}
      viewId={viewId}
      onRetry={() => {
        void retryViewData(viewId, spec, api)
      }}
    />
  )

  // A FRAGMENT: `DeclarativeStack`'s `RegionBody` is the pane's FORM TRACK (and carries the
  // `declarative-region-body-<analysisId>` testid), and these become its DIRECT children — so
  // its `gap-3` rhythm runs across stacked files exactly as it runs between two widgets of one
  // file, and adding a second `ui:` file changes the DOM by appending widgets, not by nesting
  // a second scroll container.
  return (
    <>
      {status}
      {/* ONLY `loading` unmounts the form. `partial` (data still arriving) renders the widgets so
          the landed rows paint progressively — see the status table above (ITEM-1 / DEC-2). */}
      {store.dataStatus === 'loading' ? null : widgets}
    </>
  )
}
