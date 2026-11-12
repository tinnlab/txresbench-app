// The project "Workspace" detail-panel body (ITEM-14). A zero-prop project-extension
// panel: it reads the loaded project from `ProjectDetail`, the role (`canEdit`)
// from the surrounding `ProjectScopeProvider` (a Viewer gets a read-only shell —
// writes are gated on `canEdit` inside the shell), builds ONE per-project
// `WorkbenchAPI` via `useWorkbenchApi`, and mounts the P6 `WorkbenchShell` inside
// a `WorkbenchProvider`. Mirrors how `provenance/.../ProvenancePanel` reads
// `ProjectDetail` + scope. The page gives this panel full-bleed height (the
// contribution sets `fullBleed`), so the shell fills the viewport region.

import { useState } from 'react'
import { ProjectDetail } from '@/modules/project/stores/ProjectDetail.store'
import { Spinner } from '@txresbench/kit'
import { useProjectScope } from '@/modules/project/context/ProjectScope'
import { useActiveContext } from '@/core/actions/activeContext'
import { useAction } from '@/core/actions/useAction'
import { useWorkbenchApi } from '../core/host/createHost'
import { WorkbenchProvider } from '../core/shell/WorkbenchContext'
import { WorkbenchShell } from '../core/shell/WorkbenchShell'
// Through the core BARREL (never a deep path): the layer-boundary ratchet only shrinks, so a
// new `core/**` reach-through would be a fresh violation even though this file already carries
// several grandfathered ones.
import { analysisOwnsItsForm, workbenchRegistry } from '../core'
import { workbenchDockStore } from '../core/shell/dock/WorkbenchDock.store'
import { popOutPane } from '../core/shell/dock/popout'
import { setPaneState } from '../core/shell/dock/paneState'
import type { PaneKind } from '../core/shell/dock/paneModel'
import { type Region, regionOfKind } from '../core/shell/regions/regionModel'
import { workbenchRegionsStore } from '../core/shell/regions/WorkbenchRegions.store'

/** The workbench.open* action id → the PaneKind it opens. The action VOCABULARY (ids/titles/
 *  perms) lives in `core/actions/builtin/workbenchActions.ts`; this map is the module-side
 *  half (kept here so core stays free of a `PaneKind` import). Each id must exist in both. */
const OPEN_PANE_KIND: Record<string, PaneKind> = {
  'workbench.openDatasets': 'datasets',
  'workbench.openAnalyses': 'launcher',
  'workbench.openArtifacts': 'artifacts',
  'workbench.openReproducibility': 'reproducibility',
  'workbench.openJobs': 'jobs',
}

/** W2 wiring — the LIVE `'workbench'` instance the guarded-inert W1 actions
 *  (`analysis.launch` / `pane.*`, registered in `builtin/workbenchActions.ts`)
 *  resolve + delegate to. Each handler is a thin call into `WorkbenchDock.store`;
 *  the SAME handlers the human affordances (Launcher / toolbar "+") drive, so one
 *  execution path serves the human button, ⌘K, and the AI agent. */
function useWorkbenchInstance(viewId: string, projectId: string, canEdit: boolean): void {
  // Bring `paneId` to the front of its home region (expanding a collapsed side/bottom region), so a
  // freshly-opened/launched surface is focused rather than hidden behind another tab.
  const focusPaneRegion = (paneId: string, kind: PaneKind) => {
    const rs = workbenchRegionsStore.getState()
    // Focus the pane's EFFECTIVE region (its drag override, else its kind-home) so re-opening a
    // pane the user dragged elsewhere reveals it WHERE IT ACTUALLY IS — not its empty home region.
    const region = rs.regionOverride[paneId] ?? regionOfKind(kind)
    rs.setActive(region, paneId)
    if (region !== 'center' && rs.collapsed[region]) rs.toggleCollapse(region)
  }
  /** The region a currently-open pane of `kind` lives in (its drag override, else its
   *  home) — used to open a RELATED pane in the same place. `undefined` if none open. */
  const regionOfOpenKind = (kind: PaneKind, excludeId?: string): Region | undefined => {
    const pane = Object.values(workbenchDockStore.getState().cells).find(
      c => c.kind === kind && c.id !== excludeId,
    )
    if (!pane) return undefined
    return workbenchRegionsStore.getState().regionOverride[pane.id] ?? regionOfKind(kind)
  }
  /** Move `paneId` INTO `region` (override) + focus + expand — for placing a new pane
   *  where a related one already is. */
  const placePaneInRegion = (paneId: string, region: Region) => {
    const rs = workbenchRegionsStore.getState()
    rs.moveToRegion(paneId, region)
    if (region !== 'center' && rs.collapsed[region]) rs.toggleCollapse(region)
  }
  // Idempotent open: focus an existing pane of `kind`, else add one; then focus its home region.
  // Returns the pane id. This is the region-aware "+" the command palette, the human affordance,
  // and the AI agent all share.
  const openPaneOnce = (kind: PaneKind): string => {
    const state = workbenchDockStore.getState()
    const existing = Object.values(state.cells).find(c => c.kind === kind)
    const id = existing ? existing.id : state.requestAddPane(kind)
    if (id) focusPaneRegion(id, kind)
    return id
  }
  // The workbench.open* launcher handlers (id → PaneKind), delegated to by the same-named
  // instance actions in `builtin/workbenchActions.ts`.
  const openPaneHandlers = Object.fromEntries(
    Object.entries(OPEN_PANE_KIND).map(([actionId, kind]) => [
      actionId,
      () => ({ ok: true, pane_id: openPaneOnce(kind) }),
    ]),
  )
  useAction(viewId, {
    type: 'workbench',
    handlers: {
      'analysis.launch': params => {
        const p = params as { analysis_id: string; inputs?: unknown }
        // ── An analysis that OWNS its form is launched INTO that form (INV-3/INV-4) ──────
        //
        // "One analysis renders into ONE pane" — and for a `ui:`-declaring analysis that pane
        // is its own, already mounted by the view reconcile. Opening a run pane beside it put
        // the SAME analysis on screen twice, under two titles and the same primary-button
        // label (the design doc's own opening symptom), with the second copy carrying a form
        // built from `appliesTo` alone: it omits every input the view adds, so Run there
        // dispatched a different job than the one the user was looking at. The panel refuses
        // to render that form now (`AnalysisRunPanel`); this makes the launcher click land on
        // the working form in ONE step instead of on the refusal.
        //
        // The reveal is the same idempotent open every other affordance performs: focus the
        // pane where it actually LIVES (its drag override, via `focusPaneRegion`), and add one
        // only if the user had dismissed it. It is spelled out here rather than delegated to
        // `regions/openPane` because that module is not on the core barrel and reaching past
        // the barrel is a layer-boundary violation this file may not add.
        //
        // NOTE the `inputs` pre-seed (a chained launch) is NOT carried across: it is stashed in
        // the RUN pane's `paneState`, which a declarative view does not read — the view seeds
        // its own inputs at mount and shows what it seeded. Rather than inventing a second
        // seeding channel here, the chained artifact is simply not pre-selected; INV-4 is what
        // matters (whatever the view shows is what runs), and this is recorded as a known
        // affordance loss, not a silent one.
        //
        // ONE snapshot of the open panes, read before either branch: both need it, the store is
        // not mutated in between, and this file's reads of that store field are counted by a
        // ratcheted lint (its name is a term in the forbidden vocabulary) that a second read
        // would trip.
        const openPanes = Object.values(workbenchDockStore.getState().cells)
        const contribution = workbenchRegistry.analyses.get(p.analysis_id)
        if (contribution && analysisOwnsItsForm(contribution)) {
          const own = openPanes.find(c => c.kind === 'view' && c.ref === p.analysis_id)
          const ownPaneId = own
            ? own.id
            : workbenchDockStore.getState().requestAddPane('view', p.analysis_id)
          if (ownPaneId) focusPaneRegion(ownPaneId, 'view')
          return { ok: ownPaneId !== '', pane_id: ownPaneId }
        }
        // `openRunPane` dedups by (kind 'run', ref=analysisId): a re-launch of the SAME analysis
        // FOCUSES its already-open run pane rather than adding one. Detect that BEFORE opening so we
        // don't re-home an existing pane the user has deliberately dragged elsewhere.
        const wasOpen = openPanes.some(c => c.kind === 'run' && c.ref === p.analysis_id)
        const paneId = workbenchDockStore.getState().openRunPane(p.analysis_id)
        if (p.inputs && typeof p.inputs === 'object') {
          setPaneState(paneId, { inputs: p.inputs as Record<string, unknown> })
        }
        if (paneId) {
          if (wasOpen) {
            // Re-launch: REVEAL the existing run pane where it already lives (respect the user's
            // drag placement) — its effective region, not a forced move to the launcher's region.
            focusPaneRegion(paneId, 'run')
          } else {
            // New run pane → open it WHERE the analyses (launcher) pane is (no eye-jump across
            // regions), else next to an existing run pane, else the run kind's home region.
            const target =
              regionOfOpenKind('launcher') ?? regionOfOpenKind('run', paneId) ?? regionOfKind('run')
            placePaneInRegion(paneId, target)
          }
        }
        return { ok: true, pane_id: paneId }
      },
      'pane.split': params => {
        const paneId = (params as { pane_id: string }).pane_id
        const newId = workbenchDockStore.getState().splitPane(paneId, 'col')
        return { ok: newId !== '', pane_id: newId }
      },
      'pane.popOut': params => {
        const paneId = (params as { pane_id: string }).pane_id
        const r = popOutPane(paneId, workbenchDockStore)
        return { ok: r.ok, blocked: r.blocked ?? false, container_id: r.containerId ?? null }
      },
      'pane.close': params => {
        workbenchDockStore.getState().removePane((params as { pane_id: string }).pane_id)
        return { ok: true }
      },
      'pane.return': params => {
        workbenchDockStore.getState().returnPaneToMain((params as { pane_id: string }).pane_id)
        return { ok: true }
      },
      // workbench.open* — open each project surface as a pane in its home region (idempotent:
      // focus an existing pane of the kind, else add one). The command palette + AI drive these.
      ...openPaneHandlers,
    },
    getSnapshot: () => ({ projectId, canEdit }),
  })
}

export function WorkbenchSection() {
  const { project, loading } = ProjectDetail
  const { canEdit } = useProjectScope()
  // `useWorkbenchApi` memoizes per project id; call it unconditionally (hooks rule)
  // with a stable empty key while the project is still loading, then render the
  // shell only once a real project id is present.
  const projectId = project?.id ?? ''
  const api = useWorkbenchApi(projectId)
  // A stable `view_id` for this workbench as an AI-drivable instance (never reused
  // across mounts — PLAN.md ITEM-6 / ARCHITECTURE.md Layer 4).
  const [workbenchViewId] = useState(() => crypto.randomUUID())

  // PLAN.md ITEM-2/6: declare the `'workbench'` context ACTIVE while this section
  // is mounted (keyed by the project) AND register this shell as the live `'workbench'`
  // instance — together they make `analysis.launch`/`pane.*` offerable in ⌘K + invokable
  // by the AI HERE, delegating to `WorkbenchDock.store`. Both hooks run unconditionally
  // (hooks rule), BEFORE the early returns below.
  useActiveContext('workbench', { entityId: projectId || undefined })
  useWorkbenchInstance(workbenchViewId, projectId, canEdit)

  if (!project || !projectId) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center py-16">
        <Spinner label={loading ? 'Loading workspace' : 'No project loaded'} />
      </div>
    )
  }

  return (
    <WorkbenchProvider api={api} projectId={projectId} viewId={workbenchViewId} canEdit={canEdit}>
      <WorkbenchShell />
    </WorkbenchProvider>
  )
}
