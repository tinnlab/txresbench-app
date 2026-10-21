import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { DatasetDetail } from '@/modules/datasets/stores/DatasetDetail.store'

// The WORKBENCH / ANALYSIS / DATASET action vocabulary (PLAN.md ITEM-6). One
// definition per capability → drivable by a human (Launcher row · toolbar "+"
// · ⌘K) AND the AI agent, gated by permission AND page context. Importing this
// module for its side effect registers them — see `modules/actions/module.tsx`
// (the sole runtime import site; the compile-time collector,
// `scripts/collect-actions.mjs`, scans source directly and needs no import).
//
// INSTANCE DELEGATION (INFRA_INTEGRATION.md): `analysis.launch` opens the analysis'
// config pane on the `WorkbenchDock.store` (W2) and `pane.*` operate on it. Those `run` bodies
// delegate to the LIVE `'workbench'` instance now registered via `useAction` in
// `project-extension/WorkbenchSection.tsx` (W2 has landed) — so they are fully wired
// whenever the workbench shell is mounted, and degrade to a clean "not available yet"
// result (rather than throwing) only when NO workbench is focused. `dataset.process`
// delegates the same way to the `'dataset'` instance (the dataset detail page, which
// wraps the EXISTING `DatasetDetail`).
//
// EVERY action names an EXISTING granted permission (`projects::use` /
// `jobs::use`) — NO new permission is introduced (the collector HARD-FAILS on
// an unknown permission). The finer per-mutation viewer gate (`canEdit`, ITEM-29)
// is enforced at the store/UI, not here.

/** The instance `type` (and the context name) the workbench shell registers
 *  itself under via `useAction` + `useActiveContext` (W2). Its live handlers
 *  are what `analysis.launch`/`pane.*` resolve + delegate to. */
const WORKBENCH_STORE_KEY = 'workbench'
/** The dataset detail page's instance `type` / context name (ITEM-2). */
const DATASET_STORE_KEY = 'dataset'

/** A clean, non-throwing "not available yet" result (INFRA_INTEGRATION.md
 *  cross-round seam): returned when a `kind:'instance'` action's target
 *  instance isn't mounted (e.g. its owning store hasn't landed / the surface
 *  isn't focused). NOT an exception — the engine relays it as the result,
 *  and the palette surfaces it, rather than crashing an invoke. */
function unavailable(actionId: string, reason = 'not available yet'): {
  ok: false
  unavailable: true
  error: string
} {
  return { ok: false, unavailable: true, error: `${actionId}: ${reason}` }
}

/** Resolve + delegate to a live instance's handler for `actionId`, or return
 *  a clean `unavailable(...)` when the instance / handler isn't mounted. This
 *  is the thin, guarded store-delegating `run` shared by every instance action
 *  here (mirrors `harnessActions.ts`, but returns instead of throwing so an
 *  invoke before the owning store exists degrades cleanly). */
function delegateToInstance(
  storeKey: string,
  actionId: string,
  params: { view_id: string } & Record<string, unknown>,
  ctx: import('../ctx').ActionContext,
): unknown {
  const inst = ctx.instance(storeKey, params.view_id)
  if (!inst) return unavailable(actionId)
  const handler = inst.handlers[actionId]
  if (!handler) return unavailable(actionId)
  return handler(params, ctx)
}

// ── dataset.process — run a processor on the FOCUSED dataset detail (context
//    `'dataset'`). Fully wired this round: the dataset detail page registers a
//    `'dataset'` instance whose handler wraps `DatasetDetail.runProcessor`
//    → the EXISTING `ApiClient.Dataset.process`. `projects::use` matches the
//    backend route's `RequirePermissions<(ProjectsUse,)>` on `/datasets/{id}/process`.
defineAction({
  id: 'dataset.process',
  title: 'Process a dataset',
  kind: 'instance',
  context: DATASET_STORE_KEY,
  mutating: true,
  permission: Permissions.ProjectsUse,
  // AI-only (not in ⌘K): a processor's `spec` is a structured object the
  // palette's scalar-only param form can't compose — the human path is the
  // workbench's Analyses launcher (the dataset detail "Pipeline" tab this comment
  // used to name was removed by `e4ac4af7`). `ai:true` (default) keeps it
  // agent-invokable; `palette:false` opts it out of the command palette.
  surfaces: { palette: false },
  params: z.object({
    view_id: z.string(),
    /** The processor's compute spec (`AnalysisSpec`-shaped); passed through
     *  to `DatasetDetail.runProcessor`. */
    spec: z.unknown(),
  }),
  run: (params, ctx) => delegateToInstance(DATASET_STORE_KEY, 'dataset.process', params, ctx),
})

// ── analysis.launch — open the analysis' CONFIG SURFACE on the FOCUSED workbench
//    (context `'workbench'`). Which surface is the instance handler's call: an
//    analysis that declares `ui:` is revealed in its OWN declarative pane, one that
//    does not gets a run pane with the slot-derived fallback form (INV-3/INV-4 —
//    `WorkbenchSection.tsx`). Either way it opens a FORM and does not itself enqueue
//    anything; Run inside the form does. Delegates to the live `'workbench'` instance
//    (returns `unavailable` only when none is focused).
//
//    IT IS A READ, AND THE DECLARATION NOW SAYS SO. It used to be `mutating: true` +
//    `Permissions.JobsUse` while its own doc (the paragraph above, unchanged) said it
//    enqueues nothing — and the contradiction had a user-visible cost: the launcher
//    refused a viewer's row, INCLUDING the ⚙ button whose entire job is to open the form
//    for inspection, while `AnalysisRunPanel` carried a purpose-built viewer branch
//    ("Read-only — viewers cannot run analyses") that the launcher's refusal stood in
//    front of.
//
//    The rule this now follows is the one stated 60 lines below for `workbench.open*`:
//    "Read-only surfaces → `mutating:false`, gated by each pane's OWN read perm (never a
//    new permission)." The pane this opens is the analysis' form, and the read perm for
//    the analyses of a project is `ProjectsUse` — the same perm `workbench.openAnalyses`
//    uses to open the CATALOG those forms belong to. Opening one of them is not a
//    stronger act than opening the list.
//
//    `mutating` is not a permission flag: `pane.*` are `mutating: true` and explicitly
//    viewer-OK. What it actually selects (see `ActionMeta.stateful`) is the
//    read-before-write token path and per-instance serialization, neither of which a
//    pane-open needs. So it was never what refused the viewer — the component's own
//    `canEdit` was, and that is fixed at the same time in `LauncherPane.tsx`, because
//    fixing only the declaration would have changed nothing a user can see.
//
//    THE GATE THAT MATTERS IS UNCHANGED AND IS DOWNSTREAM: Run inside the form is
//    `canEdit`-gated in the panel, and the backend `/jobs` route is the real boundary.
defineAction({
  id: 'analysis.launch',
  title: 'Launch an analysis',
  kind: 'instance',
  context: WORKBENCH_STORE_KEY,
  mutating: false,
  permission: Permissions.ProjectsUse,
  params: z.object({
    view_id: z.string(),
    /** The registry id of the analysis to launch. */
    analysis_id: z.string(),
    /** Optional pre-seeded inputs (e.g. a chained upstream artifact ref). */
    inputs: z.unknown().optional(),
  }),
  run: (params, ctx) => delegateToInstance(WORKBENCH_STORE_KEY, 'analysis.launch', params, ctx),
})

// ── pane.* — LAYOUT operations on the FOCUSED workbench (context
//    `'workbench'`). Viewer-OK (ITEM-29: layout/pop-out per-user), so
//    `projects::use` (project access) is the coarse gate. Delegates to the
//    live `'workbench'` instance (returns `unavailable` when none is focused).
const PANE_ACTIONS: { id: string; title: string }[] = [
  { id: 'pane.split', title: 'Split the focused pane' },
  { id: 'pane.popOut', title: 'Pop the pane out to a window' },
  { id: 'pane.close', title: 'Close the pane' },
  { id: 'pane.return', title: 'Return the pane to the main window' },
]

for (const { id, title } of PANE_ACTIONS) {
  defineAction({
    id,
    title,
    kind: 'instance',
    context: WORKBENCH_STORE_KEY,
    mutating: true,
    permission: Permissions.ProjectsUse,
    params: z.object({
      view_id: z.string(),
      /** The target pane's id. */
      pane_id: z.string(),
    }),
    run: (params, ctx) => delegateToInstance(WORKBENCH_STORE_KEY, id, params, ctx),
  })
}

// ── workbench.open* — open a workbench SURFACE as a pane on the FOCUSED workbench, each
//    into its home region (left/center/right/bottom). These are the "launcher" commands the
//    workbench command palette (`WorkbenchCommandPalette`) offers: no param but `view_id`, so
//    they run with a single click / Enter (unlike `analysis.launch`/`pane.*`, which need an
//    analysis or pane id). Registered/paletted/AI-reachable; each delegates to the SAME
//    `WorkbenchDock.store.requestAddPane` (+ region focus) the human affordance drives. The
//    id↔PaneKind mapping lives in the module handler (`WorkbenchSection.useWorkbenchInstance`),
//    keeping this core file free of a feature-module `PaneKind` import. Read-only surfaces →
//    `mutating:false`, gated by each pane's OWN read perm (never a new permission).
const OPEN_PANE_ACTIONS: { id: string; title: string; permission: string }[] = [
  { id: 'workbench.openDatasets', title: 'Open the project datasets', permission: Permissions.ProjectsUse },
  { id: 'workbench.openAnalyses', title: 'Open the analyses catalog', permission: Permissions.ProjectsUse },
  { id: 'workbench.openArtifacts', title: 'Open produced artifacts', permission: Permissions.ProjectsUse },
  { id: 'workbench.openReproducibility', title: 'Open the provenance graph', permission: Permissions.ProvenanceRead },
  { id: 'workbench.openJobs', title: 'Open the project jobs monitor', permission: Permissions.JobsUse },
]

for (const { id, title, permission } of OPEN_PANE_ACTIONS) {
  defineAction({
    id,
    title,
    kind: 'instance',
    context: WORKBENCH_STORE_KEY,
    mutating: false,
    permission,
    params: z.object({ view_id: z.string() }),
    run: (params, ctx) => delegateToInstance(WORKBENCH_STORE_KEY, id, params, ctx),
  })
}
