// panes (ITEM-7 wiring) — binds each `PaneKind` to its real content renderer in the
// `paneModel` registry (which is seeded with the visible fallback for every kind). Imported for
// its side effect at boot (from `WorkbenchDockHost`) so the dock renders real content; kept SEPARATE
// from `paneModel.tsx` so the model + registry stay import-light (unit-safe) — the heavy content
// graph (canvas / plot / analysis / lineage-DAG) loads only when this module is imported.

import { lazy, Suspense, type ComponentType } from 'react'
import { useProjectDetailPanels } from '@/modules/project/core/extensions'
import { registerPaneRenderer, isPaneFullBleed, isPaneHostedSurface, PANE_KINDS, artifactPaneEntity, runPaneEntity, viewPaneSubject, authoredRefSubject, exportPaneSubject, notifyPaneSubjectsChanged, parseArtifactRef, parseCompareRef, type PaneKind, type PaneRenderer, type PaneSubjectResolver, type WorkbenchPane, PaneScroll } from './paneModel'
import { jobDisplayName, subscribeJobNames } from '@/modules/jobs/jobNames'
// The leaf modules, not the `@/core/workstore` barrel: this file is on the boot path (the shell
// imports it for its registration side effect) and the barrel pulls the whole Zarr read stack.
import { artifactDisplayName, subscribeArtifactNames } from '@/core/workstore/artifactNames'
import { usePaneScroll } from './paneScroll'
import { workbenchDockStore } from './WorkbenchDock.store'
import { PlacedArea } from '../PlacedArea'
import { SectionStack } from '../SectionStack'
import { installShellSurfacePaneLifecycle } from '../regions/paneSurfaceLifecycle'
import { surfacePaneRenderer } from '../regions/paneSurfaceHostPane'
import { registerViewComponent } from '../ViewHost'
import { registerBuiltinShellViews, SHELL_VIEW_COMPONENTS } from '../builtinViews'
import { registerBuiltinStatusItems } from '../statusBarItems'
import { ProjectDetail } from '@/modules/project/stores/ProjectDetail.store'
import { Provenance } from '@/modules/provenance/stores/Provenance.store'
/**
 * Every pane's content component, loaded on DEMAND.
 *
 * ── WHY (measured) ────────────────────────────────────────────────────────────────────
 * The header above states this module's whole purpose: "the heavy content graph (canvas /
 * plot / analysis / lineage-DAG) loads only when this module is imported". But this module
 * IS imported at boot — it is statically reachable from `project/module.tsx` through the
 * project extensions -> `WorkbenchSection` -> `WorkbenchShell` -> `WorkbenchDockHost` — so
 * "only when imported" bought nothing, and every pane's dependency tree sat on the login
 * screen's critical path. Static imports here were pulling, among others:
 *   · `ProvenancePane`  -> `@xyflow/react` + `dagre` + `graphlib` + `lodash` (the lineage DAG)
 *   · `JobsPane`        -> `TimeSeriesChart` -> `@observablehq/plot` + a dozen `d3-*` packages
 *
 * A pane renderer is a REGISTRATION — the registry only needs to know that `kind` has a
 * renderer; the component is needed the first time a pane of that kind is actually opened.
 * `lazyPane` keeps the registration eager and defers only the component.
 */
type PaneProps = Parameters<PaneRenderer>[0]

const lazyPane = (load: () => Promise<{ default: ComponentType<PaneProps> }>): PaneRenderer => {
  const Lazy = lazy(load)
  return props => (
    <Suspense fallback={<div data-testid="workbench-pane-loading" className="min-h-0 flex-1" />}>
      <Lazy {...props} />
    </Suspense>
  )
}

const LauncherPane = lazyPane(() =>
  import('../../../extensions/jobs/LauncherPane').then(m => ({ default: m.LauncherPane })),
)
const RunPane = lazyPane(() => import('../../../extensions/jobs/RunPane').then(m => ({ default: m.RunPane })))
const ArtifactPane = lazyPane(() =>
  import('../../../extensions/jobs/ArtifactPane').then(m => ({ default: m.ArtifactPane })),
)
const ViewPane = lazyPane(() => import('../../../extensions/jobs/ViewPane').then(m => ({ default: m.ViewPane })))
const JobsPane = lazyPane(() => import('../../../extensions/jobs/JobsPane').then(m => ({ default: m.JobsPane })))
const ProvenancePane = lazyPane(() =>
  import('../../../extensions/provenance/LineagePane').then(m => ({ default: m.ProvenancePane })),
)
const RerunPane = lazyPane(() =>
  import('../../../extensions/analysis/RerunPane').then(m => ({ default: m.RerunPane })),
)
const MultiRunComparePane = lazyPane(() =>
  import('../../../extensions/jobs/MultiRunComparePane').then(m => ({ default: m.MultiRunComparePane })),
)

/**
 * Render a project-detail SECTION panel (datasets / artifacts) as a workbench PANE. The project
 * detail page is now the full-bleed workbench, so these former standalone sections live as panes.
 * The panel COMPONENT is looked up from the project-extension `detail_panels` registry by its
 * `section` id — so a pane reuses the EXACT same panel the section rendered AND inherits the
 * registry's permission filtering (an unpermitted panel is simply not in the list → the lookup
 * misses → the honest fallback). The panel reads the global `ProjectDetail` +
 * `useProjectScope`, both live inside the workbench tree. Content scrolls via the overlay
 * ScrollArea (item ②) since a pane body is `overflow-hidden`.
 *
 * ── R4C-05: this comment used to claim it covered REPRODUCIBILITY too. It does not. ──
 * The `reproducibility` pane does NOT go through `SectionPane`: the provenance module
 * retired its `detail_panels` contribution and the pane registers `ProvenancePane`
 * DIRECTLY (below), so it inherits none of this registry filtering. That mismatch is
 * exactly how the `provenance::read` gate got lost when the section nav was retired
 * (6d231748) — a user without it was offered the pane in the "+" menu and, since
 * `Provenance` self-gates its fetch, was shown "No provenance yet" rather than a
 * permission surface (the backend still answered 403, so no data leaked — the defect was
 * a false claim, not a leak). The gate now lives in the two places that actually govern
 * this pane: `PANE_KIND_PERMISSION` (the "+" menu / centre picker filter, regionModel.ts)
 * and `ProvenancePane` itself (every other way a pane can be opened).
 */
function SectionPane({ section, pane }: { section: string; pane: WorkbenchPane }) {
  const panels = useProjectDetailPanels()
  // Where the user had scrolled to, kept against the PANE. A region renders only its active tab, so
  // this list is rebuilt from nothing on every switch; `usePaneScroll` re-applies the offset as the
  // panel's own fetch fills the container, rather than writing it into an empty one (which the
  // browser clamps to 0 — a reset wearing a restore's clothes). See `paneScroll.ts`.
  const scroll = usePaneScroll(pane.id)
  const panel = panels.find(p => p.section === section)
  if (!panel) {
    return (
      <div
        role="note"
        data-testid={`workbench-section-pane-unavailable-${section}`}
        className="flex min-h-0 flex-1 items-center justify-center text-center text-sm text-muted-foreground"
      >
        Not available.
      </div>
    )
  }
  const Panel = panel.component
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid={`workbench-section-pane-${section}`}>
      <PaneScroll axis="y" className="min-h-0 flex-1" events={scroll}>
        <div className="flex flex-col gap-4">
          <Panel />
        </div>
      </PaneScroll>
    </div>
  )
}

/**
 * The deck.gl canvas hero, loaded on DEMAND.
 *
 * ── WHY (measured) ────────────────────────────────────────────────────────────────────
 * `registerPanes()` below already intended this: "the named-component refs are registered
 * HERE (shell-mount-lazy) so the deck.gl canvas isn't pulled into the app-boot path". But
 * registering a ref is only lazy if the ref itself is — and a STATIC `import { CanvasView }`
 * is resolved by the bundler regardless of when the registration runs. This module is
 * statically reachable from boot (`project/module.tsx` -> project extensions ->
 * `WorkbenchSection` -> `WorkbenchShell` -> `WorkbenchDockHost` -> here), so `CanvasView` —
 * and `GridWorkspace`, and deck.gl — were on the login screen's critical path. The intent
 * was right; only the import kind defeated it.
 *
 * `lazy` makes the ref genuinely deferred: the canvas chunk is fetched the first time a
 * canvas view is actually rendered.
 *
 * Measured by ablation (restore the static import, rebuild, diff the modulepreload set in
 * `dist/index.html`): this deferral is worth **571.7 kB gzip** off the preloaded critical path.
 */
const CanvasView = lazy(() =>
  import('@/modules/workbench/extensions/canvas/CanvasView').then(m => ({ default: m.CanvasView })),
)

// ── THE TWO SUBJECTS `27b19e86` REPORTED RATHER THAN GUESSED ────────────────────────────────
//
// Inverting the subject default stopped `artifact` and `compare` printing raw uuids and left
// them reading their kind title alone — no longer wrong, still uninformative. Both name RUNS,
// and a compute run's id IS its job's id (`job.run_id.unwrap_or(job.id)`, `jobs/scheduler.rs`),
// so both read through the SAME ambient lookup a `jobs`/`rerun` tab already does. No new fetch.
//
// A run recorded by the in-app INTERACTION path (`provenance/interaction.rs`) mints its own run
// id and has no job at all, so it resolves to nothing and the tab keeps its title. That is the
// honest answer, and it is the same one every not-yet-fetched subject gives.

/**
 * An `artifact` pane's subject.
 *
 * Its ref has two forms and they name two different things, so the resolver dispatches on the
 * grammar rather than on the string:
 *   · `run::<runId>`             — the review of ONE RUN's whole output. Named by that run.
 *   · `<datatype>::<artifactId>` — ONE artifact. Named by the shared artifact label, so the
 *                                  tab reads what the picker that offered it read.
 *
 * The single-artifact form's ref already carries the datatype, but this deliberately does NOT
 * fall back to printing it: `<datatype>` alone is what the ref happens to encode, not what the
 * artifact IS, and the shared label's own last-resort segment is what distinguishes two
 * artifacts of one datatype. Until a fetch has described it, "Artifact" is the honest answer.
 */
export const artifactPaneSubject: PaneSubjectResolver = pane => {
  const parsed = parseArtifactRef(pane.ref)
  if (!parsed) return null
  return parsed.mode === 'run' ? jobDisplayName(parsed.runId) : artifactDisplayName(parsed.artifactId)
}

/**
 * A `compare` pane's subject — the runs it compares.
 *
 * NAME them, do not count them, once they are all named: that is how the `jobs` subject reads
 * (it says the job's NAME, never "1 job"), two compare panes over different run sets would
 * otherwise carry identical tabs, and a set is what the pane is ABOUT.
 *
 * A PARTIALLY-known set falls back to the count rather than naming the half that has arrived:
 * `Compare · Nightly filter` for a three-run compare states the wrong set size, and a wrong
 * label is worse than a coarse one. The count is exact — it is read off the ref, not off the
 * fetches — so it is something that can be said honestly at any moment, which makes it the
 * right "honest words before the name lands" for a kind whose subject is plural.
 */
export const comparePaneSubject: PaneSubjectResolver = pane => {
  const ids = parseCompareRef(pane.ref)
  if (ids.length === 0) return null
  const names = ids.map(id => jobDisplayName(id))
  if (names.every((n): n is string => !!n)) return names.join(' vs ')
  return ids.length === 1 ? '1 run' : `${ids.length} runs`
}

let registered = false

/** Register every pane kind's real renderer (idempotent). ITEM-55/56: the canvas / visualize
 *  panes render `placeViews(area)` (via `PlacedArea`) instead of a hardcoded component — the
 *  built-in shell surfaces are registered as `center`/`left` views. The named-component refs are
 *  registered HERE (shell-mount-lazy) so the deck.gl canvas isn't pulled into the app-boot path.
 *
 *  There was a third `PlacedArea` pane, the `selection` "Inspector" (`area="right"`). It is
 *  deleted: nothing contributed it, and being a second host for the right AREA it rendered every
 *  right-docked analysis a second time. The right AREA itself is unchanged — its views reconcile
 *  into the right REGION as `view` panes, exactly as before. */
export function registerPanes(): void {
  if (registered) return
  registered = true
  // The built-in shell views (descriptors) + their named components (lazy at shell mount).
  registerBuiltinShellViews()
  registerBuiltinStatusItems()
  registerViewComponent(SHELL_VIEW_COMPONENTS.canvas, () => (
    <Suspense fallback={<div data-testid="workbench-canvas-loading" className="min-h-0 flex-1" />}>
      <CanvasView />
    </Suspense>
  ))
  // `canvas` is the ONE full-bleed kind: it is the deck.gl `GridWorkspace` hero — a viewport,
  // not a document — and an inset around it would be a frame around the plot. `visualize` takes
  // the shell's inset like every other content pane; a contributed full-bleed surface is a
  // reason to add a kind, not to widen this opt-out.
  registerPaneRenderer('canvas', () => <PlacedArea area="center" />, { fullBleed: true })
  // `visualize` is the ONE pane that is a SECTION STACK rather than a placed AREA
  // (visualize-pane ITEM-5). It used to render `PlacedArea area="left"` — whatever views were
  // docked left, as tabs. It now renders `registry.sections` for this pane kind: N stacked
  // blocks in one scroll track, no tab strip, no docking.
  //
  // The distinction is this round's whole structural claim, so it is worth stating at the
  // one line that makes it: a `PlacedArea` pane hosts VIEWS, which are placed, reconciled,
  // automounted and area-checked — and `assertContributableArea` exists because a view can
  // TRY to claim the centre. A section has no area to claim. `deletionClauses.test.ts` pins
  // both halves (exactly one pane kind routes through `PlacedArea`; `visualize` routes
  // through `SectionStack`) so a future contribution cannot quietly re-acquire a pane.
  registerPaneRenderer('visualize', () => <SectionStack pane="visualize" />)
  registerPaneRenderer('launcher', LauncherPane)
  // `entity` (ITEM-19): which artifact's deletion must close this pane. Declared HERE, at the
  // registration, rather than from inside each pane's component — the shell reconciles every pane
  // in the STORE, and a pane that is not its region's active tab is not rendered at all, so a
  // component-registered binding did not exist for exactly the panes that needed it (see
  // `extensions/jobs/paneEntity.ts`). That module is import-light, so this costs the boot path
  // nothing and leaves the renderers themselves lazily loaded.
  //
  // `subject` (see `paneModel`'s "A PANE'S SUBJECT IS DECLARED") is the other per-kind
  // registration: how this kind turns its `ref` into words for the tab. A kind that declares
  // none shows its title alone rather than a raw id, so the claim "this kind's ref is readable"
  // is made HERE, once, per kind — never assumed for all of them.
  //   · `run` names an ANALYSIS by its authored id (a dotted slug), so the ref is the subject.
  //   · `jobs`/`rerun` name a JOB by uuid — resolved to the job's name through `jobNames`,
  //     the ambient lookup every jobs fetch already feeds.
  //   · `artifact`/`compare` name RUNS and ARTIFACTS by uuid — resolved through the same
  //     `jobNames` lookup and its artifact twin `artifactNames` (fed by `core/workstore`'s
  //     catalog fetches). See `artifactPaneSubject` / `comparePaneSubject` above.
  registerPaneRenderer('run', RunPane, { entity: runPaneEntity, subject: authoredRefSubject })
  registerPaneRenderer('artifact', ArtifactPane, { entity: artifactPaneEntity, subject: artifactPaneSubject })
  registerPaneRenderer('view', ViewPane, { subject: viewPaneSubject })
  registerPaneRenderer('jobs', JobsPane, { subject: pane => jobDisplayName(pane.ref) })
  // W8 iteration loop (ITEM-63/65): re-run-with-diff + compare-N-runs panes.
  // A `rerun` pane's ref is the SOURCE RUN's id — a job — so it names itself the same way.
  registerPaneRenderer('rerun', RerunPane, { subject: pane => jobDisplayName(pane.ref) })
  registerPaneRenderer('compare', MultiRunComparePane, { subject: comparePaneSubject })
  // Project-detail surfaces as panes (the detail page is now the full-bleed workbench). `datasets`/
  // `artifacts` reuse their registered `detail_panels` component via `SectionPane` (permission-filtered);
  // `reproducibility` renders the consolidated ProvenancePane (graph) DIRECTLY — not a `section` panel.
  registerPaneRenderer('datasets', ({ pane }) => <SectionPane section="datasets" pane={pane} />)
  registerPaneRenderer('artifacts', ({ pane }) => <SectionPane section="artifacts" pane={pane} />)
  // Provenance: one pane consolidating the former History/Reproducibility/Lineage
  // (all views of `Provenance`) — the lineage graph + a readiness badge + export.
  registerPaneRenderer('reproducibility', ProvenancePane)
  // The centre canvas's per-plot editing surfaces, one pane per OPEN surface
  // (`regions/paneSurfaceHost.tsx`). `fullBleed` because the surface arrives with its own
  // padding — the pane must not frame it a second time; `hostedSurface` because it arrives
  // with its own header and its own close, and the workbench does not own its lifetime.
  // The renderers and the OPEN/CLOSE lifecycle they need must be installed together — a kind
  // registered without it would mount a pane body with no way to be opened or retired.
  installShellSurfacePaneLifecycle()
  // Their `ref` is a GRID PANE id, which a declaration's author writes (`emb-before`), so it is
  // the subject: N open editors are told apart by the plot they edit.
  registerPaneRenderer('edit-plot', surfacePaneRenderer('edit-plot'), {
    fullBleed: true,
    hostedSurface: true,
    subject: authoredRefSubject,
  })
  registerPaneRenderer('data-table', surfacePaneRenderer('data-table'), {
    fullBleed: true,
    hostedSurface: true,
    subject: authoredRefSubject,
  })
  // The canvas EXPORT dialog. Same hosted-surface registration as its two siblings — it is the
  // same seam with a wider subject (one plot, or the whole grid; see `paneSurfaceHost.ts`).
  registerPaneRenderer('export', surfacePaneRenderer('export'), {
    fullBleed: true,
    hostedSurface: true,
    subject: exportPaneSubject,
  })
  // A job name ARRIVES (the next list poll / detail load), so a tab that could only say "Jobs"
  // when it was drawn has to be told when it can say more. One subscription for every pane
  // strip in the app; `usePaneSubjectEpoch` is the render side of it.
  subscribeJobNames(notifyPaneSubjectsChanged)
  // …and an artifact DESCRIPTION arrives the same way, on whatever catalog fetch happens to
  // reach it. Same announcement, same render side.
  subscribeArtifactNames(notifyPaneSubjectsChanged)
}

/**
 * The programmatic pane-open seam (`window.__workbenchPanes.open(kind, ref?)`) — mirrors
 * the read-only `window.__workbench` (shell/seam.ts) + `window.__workbenchRegistry`
 * (discover.ts) seams. It opens a pane by kind on the currently-mounted dock, so the
 * project Jobs (ITEM-67) + Lineage (ITEM-61) panes are reachable without a bespoke
 * toolbar button (the shell's pane action row is owned separately), and the e2e specs can
 * open them on the real project workspace. Harmless in production — it only performs the
 * same `addPane` a toolbar affordance would.
 */
function installPaneOpenSeam(): void {
  if (typeof window === 'undefined') return
  ;(window as unknown as { __workbenchPanes?: unknown }).__workbenchPanes = {
    open: (kind: PaneKind, ref?: string) => workbenchDockStore.getState().requestAddPane(kind, ref),
    close: (paneId: string) => workbenchDockStore.getState().removePane(paneId),
    panes: () => Object.keys(workbenchDockStore.getState().cells),
    // The pane-kind VOCABULARY + the content-inset opt-out, read straight off the registry.
    // The Layer-A pane-inset spec derives its coverage from these rather than a hand-written
    // list, so a pane kind added tomorrow is measured tomorrow.
    kinds: () => [...PANE_KINDS],
    fullBleed: (kind: string) => isPaneFullBleed(kind),
    // …and the HOSTED-SURFACE declaration, for the same reason: a hosted pane's close is
    // DELEGATED to the surface rather than removing the pane, and a spec that hard-coded which
    // kinds those are would stop covering the next one.
    hostedSurface: (kind: string) => isPaneHostedSurface(kind),
  }
}

registerPanes()
installPaneOpenSeam()
