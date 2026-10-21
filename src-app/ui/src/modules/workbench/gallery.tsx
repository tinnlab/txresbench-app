import { lazy, useState, type ComponentType, type LazyExoticComponent } from 'react'
import type { ModuleGallery, PageDriver } from '@ziee/gallery'
import { Dropdown, InputNumber, MultiSelect, Select, type SelectOption } from '@ziee/kit'
import type { ContainerId } from '@ziee/dock'
import { createWorkbenchApi, type ParamField } from '@/modules/workbench/core'
import type { ArtifactRow } from '@/modules/workbench/extensions/data'
import { FixtureSource } from '@ziee/viz'
import { makeFakeHost, type FakeHostSeed } from './core/host/createHost'
import {
  declarativeFixtureSurfaces,
  entryListCollapseSurface,
} from '@/modules/workbench/core/gallery/DeclarativeFixtureStories'
import { paneInsetSurfaces } from '@/modules/workbench/core/gallery/PaneInsetStory'
import { WorkbenchProvider } from './core/shell/WorkbenchContext'
import { WorkbenchShell } from './core/shell/WorkbenchShell'
import { CanvasView } from '@/modules/workbench/extensions/canvas/CanvasView'
import { seedGalleryDatatypes } from './fixtures/galleryDatatypeSeed'
import { discoverBuiltins } from './discover'
import { loadDiscoveredProcessors } from '@/modules/workbench/core/runtime/loadProcessors'
import { registerBuiltinShellViews } from './core/shell/builtinViews'
import { registerBuiltinStatusItems } from './core/shell/statusBarItems'
import { useWorkbenchLayoutStore } from './core/shell/stores/WorkbenchLayout.store'
import { LauncherPane } from './extensions/jobs/LauncherPane'
import { JobsPaneView } from './extensions/jobs/JobsPane'
import { LineageView } from './extensions/provenance/LineagePane'
import { buildLineageModel } from './extensions/provenance/lineageGraph'
import './core/shell/dock/panes' // register the real pane-kind renderers for the bare-frame cells (side-effect)
import { RunProgressConsole } from './extensions/analysis/RunProgressConsole'
import { AnalysisFlowGuidance } from './extensions/analysis/AnalysisFlowGuidance'
import { ParamOutcomePreview } from './extensions/analysis/ParamOutcomePreview'
import { RunDiffView } from './extensions/jobs/RunDiffView'
import { MultiRunCompareView } from './extensions/jobs/MultiRunCompareView'
import type { RunObservablesEntry } from './extensions/jobs/runDiff'
import type { GraphDto, Job, JobDetail, JobListItem } from '@/api-client/types'

// Ensure the host-owned registrations run when the gallery mounts a workbench surface in
// isolation (module.tsx runs these at app boot; the gallery imports this module directly).
// `discoverBuiltins` registers the glob extensions (demo views + the annotate panel);
// `registerBuiltinShellViews` registers the center shell surface so `placeViews('center')`
// resolves it in the isolated gallery shell (left/right are vacant — see builtinViews.ts).
registerBuiltinShellViews()
registerBuiltinStatusItems()
discoverBuiltins()
// dimension-primitives ITEM-9: seed the datatype registry with the selection stories'
// declared axis-annotation schema (single-cell/expression + the non-single-cell image
// fixture), so the general primitives render their declared pickers in the backend-free
// gallery (the `annotationsForAxis` DATA path).
seedGalleryDatatypes()
// Generic processor-package loader (ITEM-3/23) — additive alongside `discoverBuiltins` (Slice 1).
loadDiscoveredProcessors()

/**
 * Gallery seed for the P6 workbench SHELL (ITEM-17). Each surface mounts the REAL
 * `WorkbenchShell` inside a `WorkbenchProvider` bound to a seeded FAKE host
 * (`makeFakeHost` — no backend), across states: empty (no artifacts) / results
 * (populated docks) / collapsed (a dock collapsed) / narrow (~390px). Every entry
 * uses a DISTINCT project id so their per-project persisted layouts never bleed across
 * cells. The shell already stamps stable testids (`workbench-shell`, per-area
 * `data-workbench-area`); the gallery only mounts it in a fixed-height frame so
 * `gallery-page-workbench-*` surfaces are discoverable by the runtime + visual
 * gates.
 */

const GALLERY_EXTENSION_ID = 'cyto.workbench.gallery'

function artifact(id: string, projectId: string, datatype: string, structure: unknown): ArtifactRow {
  return {
    id,
    project_id: projectId,
    datatype,
    // ITEM-7 folded the gallery's `shape` into the ONE declaration the app now reads.
    // These stay honest about the backend-free gallery — nothing fetches these bytes —
    // but they are no longer uniformly `opaque`: an `opaque` blob declares no extent, so
    // seeding one would make every gallery picker label and stat card render a
    // dimension-less degrade the real app never shows. Each row declares the shape its
    // real producer declares.
    structure,
    created_at: '2026-07-15T12:00:00Z',
  }
}

/** The `zarr_v3` sparse matrix `cyto_csc.write_csc_zarr` declares (its own default axis
 *  labels are `rows`/`columns` — a label, never a key: INV-3). */
function cscStructure(rows: number, cols: number): unknown {
  return {
    encoding: 'zarr_v3',
    kind: 'sparse_csc',
    axes: ['rows', 'columns'],
    shape: [rows, cols],
    indptr: { path: 'indptr' },
    indices: { path: 'indices' },
    data: { path: 'data' },
  }
}

/** A single-member `(n × dims)` table — the form a 2-D layout artifact declares. */
function layoutStructure(n: number, dims: number): unknown {
  return {
    encoding: 'zarr_v3',
    kind: 'table',
    axis: 'rows',
    n,
    arrays: [{ path: 'coords', name: 'coords', kind: 'numeric', shape: [n, dims] }],
  }
}

/** The single-member categorical table `cyto_columns.write_metadata_column` declares. */
function categoricalStructure(n: number): unknown {
  return {
    encoding: 'zarr_v3',
    kind: 'table',
    axis: 'rows',
    n,
    columns: [
      { path: 'values', name: 'values', kind: 'categorical', shape: [n], levels: ['0', '1', '2'] },
    ],
  }
}

// A project that has produced an embedding + a clustering — enough for the docks to
// show populated availability (the demo `clustering` view is `when: has:clustering`).
function producedArtifacts(projectId: string): ArtifactRow[] {
  return [
    artifact('00000000-0000-4000-8000-0000000000e1', projectId, 'anndata', cscStructure(5000, 20000)),
    artifact('00000000-0000-4000-8000-0000000000e2', projectId, 'embedding', layoutStructure(5000, 2)),
    artifact('00000000-0000-4000-8000-0000000000e3', projectId, 'clustering', categoricalStructure(5000)),
  ]
}

/** A zero-prop lazy frame mounting the shell against a seeded fake host. */
function shellFrame(opts: {
  projectId: string
  seed?: Omit<FakeHostSeed, 'projectId'>
  canEdit?: boolean
  widthClass?: string
}): LazyExoticComponent<ComponentType> {
  return lazy(async () => {
    const api = createWorkbenchApi(
      makeFakeHost({ projectId: opts.projectId, ...opts.seed }),
      GALLERY_EXTENSION_ID,
    )
    const Frame: ComponentType = () => (
      <div
        className={`h-[720px] overflow-hidden rounded-md border border-border ${opts.widthClass ?? 'w-full'}`}
        data-testid="workbench-gallery-frame"
      >
        <WorkbenchProvider api={api} projectId={opts.projectId} viewId={`gallery-${opts.projectId}`} canEdit={opts.canEdit ?? true}>
          <WorkbenchShell />
        </WorkbenchProvider>
      </div>
    )
    return { default: Frame }
  })
}

const EMPTY_ID = 'wb-gallery-empty'
const ARTIFACTS_ID = 'wb-gallery-artifacts'
const COLLAPSED_ID = 'wb-gallery-collapsed'
const NARROW_ID = 'wb-gallery-narrow'
const VIEWER_ID = 'wb-gallery-viewer'

const WorkbenchEmpty = shellFrame({ projectId: EMPTY_ID })
const WorkbenchArtifacts = shellFrame({ projectId: ARTIFACTS_ID, seed: { artifacts: producedArtifacts(ARTIFACTS_ID) } })
const WorkbenchCollapsed = shellFrame({ projectId: COLLAPSED_ID, seed: { artifacts: producedArtifacts(COLLAPSED_ID) } })
const WorkbenchNarrow = shellFrame({
  projectId: NARROW_ID,
  seed: { artifacts: producedArtifacts(NARROW_ID) },
  widthClass: 'w-[390px]',
})
// The full VIEWER shell (ITEM-29): a populated read-only IDE — the tiled docks/canvas
// render, but the toolbar Run/Export are absent and the launcher pane is read-only. The
// desktop viewer populated-render review (proves the gate on real data, not an empty state).
const WorkbenchViewer = shellFrame({
  projectId: VIEWER_ID,
  seed: { artifacts: producedArtifacts(VIEWER_ID) },
  canEdit: false,
})


const CANVAS_ID = 'wb-gallery-canvas'

// The FLAGSHIP center canvas (ITEM-56): the real viz `GridWorkspace` bound to a
// `FixtureSource` so the deck grid has data to paint (no backend). HONEST LIMIT: in a
// headless capture box WebGL2 is unavailable, so `GridWorkspace` shows its own fallback;
// this cassette proves the canvas STRUCTURE (host + color-by chip) is wired. A real GPU
// render is a manual/CI concern.
const CanvasStory = lazy(async () => {
  const api = createWorkbenchApi(
    makeFakeHost({ projectId: CANVAS_ID, artifacts: producedArtifacts(CANVAS_ID) }),
    GALLERY_EXTENSION_ID,
  )
  const source = new FixtureSource({ seed: 7, pointCount: 20_000 })
  const Frame: ComponentType = () => (
    <div className="h-[520px] w-full overflow-hidden rounded-md border border-border" data-testid="workbench-gallery-frame">
      <WorkbenchProvider api={api} projectId={CANVAS_ID} viewId={`gallery-${CANVAS_ID}`} canEdit>
        <CanvasView source={source} />
      </WorkbenchProvider>
    </div>
  )
  return { default: Frame }
})

// The DATA-driven self-explaining DONE-state flow guidance (declarative-processor-ui Slice 7 /
// declarative-canvas-plots ITEM-35): a POPULATED guidance surface — what QC produced (plain
// language, `producedSummary`) + the DERIVED next-step ("Open Cell filter"), computed from the
// produce→accept type graph (`deriveNextSteps`), NOT processor-specific code. Rendered inside a
// real `WorkbenchProvider` (registry.analyses carries the DATA-registered qc.10x + cell.filter) so
// `deriveNextSteps(qc.10x)` yields the cell.filter next step for real. Populated (not empty) state.
const FLOWGUIDANCE_ID = 'wb-gallery-flow-guidance'
const FlowGuidanceStory = lazy(async () => {
  const api = createWorkbenchApi(
    makeFakeHost({ projectId: FLOWGUIDANCE_ID, artifacts: producedArtifacts(FLOWGUIDANCE_ID) }),
    GALLERY_EXTENSION_ID,
  )
  const Frame: ComponentType = () => (
    <div className="w-full max-w-md overflow-hidden rounded-md border border-border p-4" data-testid="workbench-gallery-frame">
      <WorkbenchProvider api={api} projectId={FLOWGUIDANCE_ID} viewId={`gallery-${FLOWGUIDANCE_ID}`} canEdit>
        <AnalysisFlowGuidance analysisId="qc.10x" />
      </WorkbenchProvider>
    </div>
  )
  return { default: Frame }
})

// ── W3 analysis-experience surfaces (backend-free) ───────────────────────────

const LAUNCHER_ID = 'wb-gallery-launcher'

// The rich Launcher pane (ITEM-20/28) — grouped + searchable + availability-gated —
// against a seeded fake host (the demo `clustering` analysis lists here). The
// `demo-analysis` built-in requires an `embedding`, which this project HAS, so its row
// is available; a no-embedding project shows it needs-<type>. Registry-only (no
// backend), so it's safe under the runtime + visual gates.
function launcherStory(projectId: string, canEdit: boolean): LazyExoticComponent<ComponentType> {
  return lazy(async () => {
    const api = createWorkbenchApi(
      makeFakeHost({ projectId, artifacts: producedArtifacts(projectId) }),
      GALLERY_EXTENSION_ID,
    )
    const Frame: ComponentType = () => (
      <div className="h-[520px] w-full max-w-md overflow-hidden rounded-md border border-border" data-testid="workbench-gallery-frame">
        <WorkbenchProvider api={api} projectId={projectId} viewId={`gallery-${projectId}`} canEdit={canEdit}>
          <LauncherPane pane={{ id: 'gallery-launcher', kind: 'launcher' }} />
        </WorkbenchProvider>
      </div>
    )
    return { default: Frame }
  })
}

const LauncherStory = launcherStory(LAUNCHER_ID, true)
// The VIEWER launcher (ITEM-29): the SAME rows browsable, but every row DISABLED with a
// read-only reason + a read-only banner — the launch-gate proof (a viewer never launches).
const LauncherViewerStory = launcherStory('wb-gallery-launcher-viewer', false)

// The live run console (ITEM-22/23) — a real phase timeline + streamed logs + a
// resource line + Stop — rendered PRESENTATIONALLY from seeded frames (no backend),
// so the core run-progress surface is discoverable + visually gated.
const RunConsoleStory = lazy(async () => {
  const Frame: ComponentType = () => (
    <div className="w-full max-w-lg p-4" data-testid="workbench-gallery-frame">
      <RunProgressConsole
        analysisId="demo.leiden"
        status="running"
        phases={[
          { name: 'loading', pct: 100, state: 'done' },
          { name: 'neighbors', pct: 100, state: 'done' },
          { name: 'clustering', pct: 60, state: 'active' },
        ]}
        logs={[
          { seq: 1, stream: 'stdout', content: 'Reading embedding (5000 × 2)…' },
          { seq: 2, stream: 'stdout', content: 'Building kNN graph (k=15)…' },
          { seq: 3, stream: 'stdout', content: 'Running Leiden (resolution=0.6)…' },
        ]}
        metric={{ cpuPct: 182, memBytes: 734003200, memPeakBytes: 812000000, pidsCurrent: 4 }}
        canStop
        onStop={() => {}}
      />
    </div>
  )
  return { default: Frame }
})

// The run console in the FAILED state (ITEM-22/23/33): a partial phase timeline, the
// streamed logs up to the failure, and the itemized error Alert — the "run-failed"
// surface (no Stop, since the run already ended). Presentational.
const RunConsoleFailedStory = lazy(async () => {
  const Frame: ComponentType = () => (
    <div className="w-full max-w-lg p-4" data-testid="workbench-gallery-frame">
      <RunProgressConsole
        analysisId="demo.leiden"
        status="error"
        phases={[
          { name: 'loading', pct: 100, state: 'done' },
          { name: 'neighbors', pct: 100, state: 'done' },
          { name: 'clustering', pct: 40, state: 'active' },
        ]}
        logs={[
          { seq: 1, stream: 'stdout', content: 'Reading embedding (5000 × 2)…' },
          { seq: 2, stream: 'stdout', content: 'Building kNN graph (k=15)…' },
          { seq: 3, stream: 'stderr', content: 'error: leiden failed to converge (resolution=2.0)' },
        ]}
        metric={{ cpuPct: 92, memBytes: 512000000, memPeakBytes: 640000000, pidsCurrent: 3 }}
        error="Analysis exited with code 1: leiden failed to converge (resolution=2.0)"
        canStop={false}
      />
    </div>
  )
  return { default: Frame }
})

// ── W8 project Jobs pane (ITEM-67) — the operational monitor, presentational ──────

const JOBS_ID = 'wb-gallery-jobs'

function seedJob(id: string, name: string, jobType: string, status: string, error?: string): Job {
  return {
    id,
    name,
    job_type: jobType,
    status,
    owner_id: '00000000-0000-4000-8000-000000000001',
    created_at: '2026-07-19T12:00:00Z',
    params: null,
    priority_class: 'normal',
    resource_class: 'cpu-sandbox',
    ...(error ? { error } : {}),
  }
}

/** A list ROW: the job plus the server's answer to "may THIS caller stop it". */
function seedRow(job: Job, canStop: boolean): JobListItem {
  return { job, can_stop: canStop }
}

const JOBS_SEED: Job[] = [
  seedJob('00000000-0000-4000-8000-0000000000a1', 'Leiden clustering', 'analysis', 'running'),
  seedJob('00000000-0000-4000-8000-0000000000a2', 'QC filter', 'analysis', 'queued'),
  seedJob('00000000-0000-4000-8000-0000000000a3', 'UMAP embedding', 'analysis', 'completed'),
  seedJob('00000000-0000-4000-8000-0000000000a4', 'DE test', 'analysis', 'failed', 'exit code 1'),
  seedJob('00000000-0000-4000-8000-0000000000a5', 'Normalize', 'analysis', 'stopped'),
]

/**
 * The Jobs pane in LIST mode, seeded across every lifecycle state, at a given STOP RIGHT.
 *
 * The right is the server's per-row `can_stop` (the run's creator / the owner of the scope it
 * runs on / an admin), NOT the per-project edit role — see `modules/jobs/stopAuthority`. The
 * refused story is therefore not "Stop is absent" but "Stop is present and refuses, saying
 * why", which is the whole point of the change and the thing worth looking at.
 */
function jobsListStory(canStop: boolean): LazyExoticComponent<ComponentType> {
  return lazy(async () => {
    const Frame: ComponentType = () => (
      <div className="h-[520px] w-full max-w-md overflow-hidden rounded-md border border-border" data-testid="workbench-gallery-frame">
        <JobsPaneView
          paneId="gallery-jobs"
          jobs={JOBS_SEED.map(j => seedRow(j, canStop))}
          total={JOBS_SEED.length}
          page={1}
          perPage={10}
          loading={false}
          error={null}
          selectedId={null}
          detail={null}
          detailLoading={false}
          streaming={false}
          onSelect={() => {}}
          onStop={() => {}}
          onBack={() => {}}
          onPage={() => {}}
          onRetry={() => {}}
        />
      </div>
    )
    return { default: Frame }
  })
}

// May stop (Stop fires on active rows) + MAY NOT (Stop is shown and refuses, with its reason).
const JobsPaneStory = jobsListStory(true)
const JobsPaneNoStopStory = jobsListStory(false)

// The Jobs pane in DETAIL mode (ITEM-67): a followed RUNNING job's live logs + CPU/memory
// charts + Stop — the "run-running-with-logs" operational surface, presentational.
const JobsDetailStory = lazy(async () => {
  const runningJob: Job = {
    ...seedJob('00000000-0000-4000-8000-0000000000a1', 'Leiden clustering', 'analysis', 'running'),
    // Dynamic start so the timing meta reads a sensible live "Running <n>s" rather than
    // a duration measured from a fixed past seed date.
    started_at: new Date(Date.now() - 42_000).toISOString(),
  }
  const detail: JobDetail = {
    job: runningJob,
    logs: [
      { id: 'l1', job_id: runningJob.id, seq: 1, stream: 'stdout', content: 'Reading embedding (5000 × 2)…', created_at: '2026-07-19T12:00:01Z' },
      { id: 'l2', job_id: runningJob.id, seq: 2, stream: 'stdout', content: 'Building kNN graph (k=15)…', created_at: '2026-07-19T12:00:03Z' },
      { id: 'l3', job_id: runningJob.id, seq: 3, stream: 'stderr', content: 'warning: resolution is high', created_at: '2026-07-19T12:00:05Z' },
    ],
    metrics: [
      { id: 'm1', job_id: runningJob.id, cpu_pct: 120, mem_bytes: 512_000_000, sampled_at: '2026-07-19T12:00:02Z' },
      { id: 'm2', job_id: runningJob.id, cpu_pct: 185, mem_bytes: 734_000_000, sampled_at: '2026-07-19T12:00:04Z' },
    ],
    milestones: [
      { id: 'ms1', job_id: runningJob.id, milestone_id: 'read', status: 'done', detail: { count: 5000 }, created_at: '2026-07-19T12:00:01Z' },
      { id: 'ms2', job_id: runningJob.id, milestone_id: 'build_graph', status: 'done', detail: { note: 'k=15' }, created_at: '2026-07-19T12:00:03Z' },
      { id: 'ms3', job_id: runningJob.id, milestone_id: 'detect_clusters', status: 'started', detail: {}, created_at: '2026-07-19T12:00:05Z' },
    ],
    can_stop: true,
  }
  const Frame: ComponentType = () => (
    <div className="h-[560px] w-full max-w-md overflow-hidden rounded-md border border-border" data-testid="workbench-gallery-frame">
      <JobsPaneView
        paneId="gallery-jobs-detail"
        jobs={JOBS_SEED.map(j => seedRow(j, true))}
        total={JOBS_SEED.length}
        page={1}
        perPage={10}
        loading={false}
        error={null}
        selectedId={runningJob.id}
        detail={detail}
        detailLoading={false}
        streaming
        onSelect={() => {}}
        onStop={() => {}}
        onBack={() => {}}
        onPage={() => {}}
        onRetry={() => {}}
      />
    </div>
  )
  return { default: Frame }
})

// ── W3 interactive lineage DAG (ITEM-61) — presentational, seeded model ───────────

const LINEAGE_ID = 'wb-gallery-lineage'

// A seeded provenance closure: an anndata source → a QC run → a filtered anndata → a
// clustering run → an embedding + a clustering. The DAG renders nodes + produced/consumed
// edges from the SAME `buildLineageModel` transform the pane uses (no backend fetch).
const LINEAGE_GRAPH = {
  roots: [
    { id: 'art-raw', datatype: 'anndata', output_id: 'o0', content_hash: 'h0' },
    { id: 'art-qc', datatype: 'anndata', output_id: 'o1', content_hash: 'h1', run_id: 'run-qc' },
    { id: 'art-emb', datatype: 'embedding', output_id: 'o2', content_hash: 'h2', run_id: 'run-cluster' },
    { id: 'art-clu', datatype: 'clustering', output_id: 'o3', content_hash: 'h3', run_id: 'run-cluster' },
  ],
  runs: [
    {
      run_id: 'run-qc',
      kind: 'analysis',
      generator_id: 'qc.filter',
      generator_version: '1',
      status: 'completed',
      params: {},
      project_id: LINEAGE_ID,
      captured_at: '2026-07-19T12:00:00Z',
      inputs: [{ content_hash: 'h0', kind: 'artifact', ref_id: 'art-raw', slot: 'input' }],
    },
    {
      run_id: 'run-cluster',
      kind: 'analysis',
      generator_id: 'demo.leiden',
      generator_version: '1',
      status: 'completed',
      params: {},
      project_id: LINEAGE_ID,
      captured_at: '2026-07-19T12:05:00Z',
      inputs: [{ content_hash: 'h1', kind: 'artifact', ref_id: 'art-qc', slot: 'input' }],
    },
  ],
} as unknown as GraphDto

// A FLEX COLUMN, not a plain block, and that is load-bearing rather than cosmetic.
//
// `LineageView`'s root is `flex min-h-0 flex-1 flex-col`, so it takes its height from
// a flex PARENT. Inside a `display:block` frame `flex-1` does nothing, and because the
// DAG's own height comes only from that (unlike the compact list, whose rows size it
// intrinsically) the whole view resolved to ZERO height inside a 520px box. ReactFlow's
// wrapper is `overflow:hidden`, so a 0-height wrapper clipped the entire graph away:
// this surface rendered an EMPTY BOX, while the nodes kept layout rects and reported as
// present in the DOM.
//
// Nothing said so. Runtime health looks for console errors, failed requests and
// contrast — a surface that renders nothing at all trips none of them. The signal came
// from `icon-button-tooltips`, which reported all six `workbench-lineage-export-*` as
// UNREACHABLE; hand-probed, `elementFromPoint` at a node's centre returned this frame
// and a real click fired no handler. In production the pane sits in a real flex chain
// (RegionShell → `Tabs fill` → `flex flex-1 min-h-0 flex-col`), which is exactly what
// the frame has to reproduce for the story to be about the component.
//
// That guard now drives `workbench-lineage`, so a frame that collapses again fails a
// test instead of printing a line.
const LineageStory = lazy(async () => {
  const model = buildLineageModel(LINEAGE_GRAPH)
  const Frame: ComponentType = () => (
    <div
      className="flex h-[520px] w-full flex-col overflow-hidden rounded-md border border-border"
      data-testid="workbench-gallery-frame"
    >
      <LineageView paneId="gallery-lineage" model={model} onOpenNode={() => {}} onExportNode={() => {}} />
    </div>
  )
  return { default: Frame }
})

// The narrow (~390px) lineage fallback — a large/narrow graph renders as the compact list.
const LineageNarrowStory = lazy(async () => {
  const model = buildLineageModel(LINEAGE_GRAPH)
  const Frame: ComponentType = () => (
    <div
      className="flex h-[520px] w-[390px] flex-col overflow-hidden rounded-md border border-border"
      data-testid="workbench-gallery-frame"
    >
      <LineageView paneId="gallery-lineage-narrow" model={model} narrow onOpenNode={() => {}} onExportNode={() => {}} />
    </div>
  )
  return { default: Frame }
})

// ── W8 iteration loop (ITEM-63 / ITEM-65) — presentational, seeded ───────────────

// The before/after run diff (ITEM-63): a re-run at resolution 0.8 vs the previous 0.4 —
// cells kept fell + clusters rose. Presentational (seeded observables, no backend), so
// it's discoverable + visually gated. The diff math is `buildRunDiff` (TEST-532).
const RunDiffStory = lazy(async () => {
  const before: RunObservablesEntry = {
    runId: 'r-before',
    label: 'res 0.4',
    params: { resolution: 0.4 },
    observables: { outputs: 2, 'anndata · cells': 5000, 'anndata · features': 20000, 'clustering · outputs': 6, 'clustering · cells': 5000 },
  }
  const after: RunObservablesEntry = {
    runId: 'r-after',
    label: 'res 0.8',
    params: { resolution: 0.8 },
    observables: { outputs: 2, 'anndata · cells': 4200, 'anndata · features': 20000, 'clustering · outputs': 11, 'clustering · cells': 4200 },
  }
  const Frame: ComponentType = () => (
    <div className="w-full max-w-xl p-4" data-testid="workbench-gallery-frame">
      <RunDiffView before={before} after={after} />
    </div>
  )
  return { default: Frame }
})

// The compare-N-runs view (ITEM-65): a multi-resolution sweep (0.4 / 0.6 / 0.8) aligned
// into a metric×run table with a shared run→color legend + varies flags. Table-only
// (the plot side needs artifact reads); alignment is `buildMultiRunCompare` (TEST-536).
const MultiRunCompareStory = lazy(async () => {
  const entries: RunObservablesEntry[] = [
    { runId: 'r1', label: 'res 0.4', params: { resolution: 0.4, method: 'leiden' }, observables: { outputs: 1, 'clustering · outputs': 6, 'clustering · cells': 5000 } },
    { runId: 'r2', label: 'res 0.6', params: { resolution: 0.6, method: 'leiden' }, observables: { outputs: 1, 'clustering · outputs': 9, 'clustering · cells': 5000 } },
    { runId: 'r3', label: 'res 0.8', params: { resolution: 0.8, method: 'leiden' }, observables: { outputs: 1, 'clustering · outputs': 14, 'clustering · cells': 5000 } },
  ]
  const Frame: ComponentType = () => (
    <div className="w-full p-4" data-testid="workbench-gallery-frame">
      <MultiRunCompareView entries={entries} />
    </div>
  )
  return { default: Frame }
})

// The honest param→outcome LIVE preview (ITEM-65): a cap-style `max_cells` estimates a
// REAL kept count (min(cap, 5000 resident)) that tracks the input, while `resolution`
// DEFERS ("computes on run" ↑). Interactive — changing the input re-estimates live.
const ParamPreviewStory = lazy(async () => {
  const fields: ParamField[] = [
    { id: 'max_cells', type: 'number', min: 0, max: 10000, capsAxis: 'cells', doc: 'cap on cells kept' },
    { id: 'resolution', type: 'number', min: 0.1, max: 2, doc: 'higher = finer clusters' },
  ] as ParamField[]
  const Frame: ComponentType = () => {
    const [maxCells, setMaxCells] = useState<number>(3000)
    return (
      <div className="flex w-full max-w-md flex-col gap-3 p-4" data-testid="workbench-gallery-frame">
        <InputNumber
          value={maxCells}
          min={0}
          max={10000}
          onChange={v => setMaxCells(v ?? 0)}
          aria-label="Max cells"
          data-testid="param-preview-max-cells"
        />
        <ParamOutcomePreview
          fields={fields}
          params={{ max_cells: maxCells, resolution: 0.8 }}
          resident={{ cells: 5000, features: 20000 }}
        />
      </div>
    )
  }
  return { default: Frame }
})

// ── option-list popup WIDTH (the kit contract, measured) ─────────────────────────
//
// The reported defect: "the container/popup that renders the options to choose from
// select/combo does not have to have the same width with the selection itself, it can be
// bigger if needed". Every option-list popup in the kit was pinned to the trigger's width, so
// a trigger in a narrow form column or a docked toolbar clipped the very option text the user
// opened the list to read.
//
// It is measured HERE, in a browser, and nowhere else, because the contract is a LAYOUT one:
// Tailwind is not compiled under jsdom and jsdom performs no layout, so a unit test could only
// re-read the class string the component wrote — which passes whatever the class means. This
// repo has rejected source-text guards twice for that reason.
// `tests/visual/picker-popup-width.spec.ts` opens each control below and measures real boxes.
//
// Defined inline like every other seeded story in this file, NOT as a `core/gallery/*` module:
// a new module there would need a new `gallery.tsx -> core/…` edge, and
// `scripts/layer-boundary-baseline.json` is a shrink-only ratchet ("adding an entry means the
// boundary got worse").

/** The narrow column every "the popup must outgrow its trigger" control sits in — narrower
 *  than any of its own options, which is the situation the defect was reported from. */
const PW_NARROW_PX = 180
/** A trigger WIDER than anything it offers. The popup must not shrink to its content here:
 *  a list narrower than the control it drops out of reads as a rendering fault. */
const PW_WIDE_PX = 520

/** ~40 characters — longer than {@link PW_NARROW_PX} can show, and comfortably inside the
 *  readable cap the popup is bounded by, so these must render in FULL. */
const PW_LONG_LABEL = 'Third quarter, restated after review'
const PW_LONGER_LABEL = 'Second quarter, provisional and unreviewed'

/** A deliberately pathological label. No popup should size itself to this; it is the reason
 *  the growth is bounded rather than free, and the reason the row still gives at the cap. */
const PW_RUNAWAY_LABEL = `An option label nobody would write on purpose, ${'repeated beyond all reason, '.repeat(12)}and still going.`

const PW_SHORT_OPTIONS: SelectOption[] = [
  { value: 'a', label: 'One' },
  { value: 'b', label: 'Two' },
  { value: 'c', label: 'Three' },
]

const PW_LONG_OPTIONS: SelectOption[] = [
  { value: 'a', label: 'First quarter' },
  { value: 'b', label: PW_LONGER_LABEL },
  { value: 'c', label: PW_LONG_LABEL },
  { value: 'd', label: 'Fourth quarter' },
]

/** Filler that pushes a set past `SELECT_SEARCH_THRESHOLD`, so `Select` takes its
 *  SEARCHABLE arm — a different popup component with its own width rule, and therefore its own
 *  measurement. The two arms are supposed to be indistinguishable to a reader; a claim proved
 *  on only one of them is exactly how they stop being. */
const pwFiller = (): SelectOption[] =>
  Array.from({ length: 10 }, (_, i) => ({ value: `x${i}`, label: `Filler entry ${i + 1}` }))

const PW_MANY_OPTIONS: SelectOption[] = [...PW_LONG_OPTIONS, ...pwFiller()]

const PW_RUNAWAY_OPTIONS: SelectOption[] = [
  { value: 'a', label: 'Short' },
  { value: 'b', label: PW_RUNAWAY_LABEL },
]
const PW_RUNAWAY_MANY: SelectOption[] = [...PW_RUNAWAY_OPTIONS, ...pwFiller()]

const PW_MULTI_OPTIONS = [
  { value: 'a', label: 'First quarter', group: 'Reported' },
  { value: 'b', label: PW_LONGER_LABEL, group: 'Reported' },
  { value: 'c', label: PW_LONG_LABEL, group: 'Draft' },
  { value: 'd', label: 'Fourth quarter', group: 'Draft' },
]

const PW_MENU_ITEMS = [
  { key: 'a', label: 'Duplicate' },
  { key: 'b', label: PW_LONGER_LABEL },
  { key: 'c', label: PW_LONG_LABEL },
]

/** A caller that truncates its OWN row — the way both of the app's real pickers render theirs.
 *  The kit imposes no truncation, so this is what proves a caller's `truncate` is ALLOWED to
 *  engage; it could not while the row's text node refused to shrink. */
const pwTruncatingRow = (o: SelectOption) => (
  <span className="truncate" title={typeof o.label === 'string' ? o.label : undefined}>
    {o.label}
  </span>
)

function PwFrame({
  id,
  width,
  title,
  children,
}: {
  id: string
  width: number
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1" data-testid={`picker-width-frame-${id}`}>
      <span className="text-xs text-muted-foreground">{title}</span>
      <div style={{ width }} data-testid={`picker-width-slot-${id}`}>
        {children}
      </div>
    </div>
  )
}

/** ONE page holding every option-list popup the kit ships, each in a frame whose width is the
 *  point. One surface rather than nine: the runtime gate enumerates surfaces, and nine of them
 *  would ask it the same question nine times. */
const PickerWidthStory = lazy(async () => {
  const Frame = () => {
    const [one, setOne] = useState('')
    const [two, setTwo] = useState('')
    const [three, setThree] = useState('')
    const [four, setFour] = useState('')
    const [five, setFive] = useState('')
    const [six, setSix] = useState('')
    const [seven, setSeven] = useState('')
    const [eight, setEight] = useState('')
    const [many, setMany] = useState<string[]>([])
    return (
      <div className="flex flex-col items-start gap-6 p-6" data-testid="picker-width-page">
        <PwFrame id="short-narrow" width={PW_NARROW_PX} title="Select — every option fits the trigger">
          <Select
            data-testid="pw-short-narrow"
            aria-label="Short options in a narrow control"
            options={PW_SHORT_OPTIONS}
            value={one}
            onChange={setOne}
            placeholder="Choose…"
            className="w-full"
          />
        </PwFrame>

        <PwFrame id="long-narrow" width={PW_NARROW_PX} title="Select — an option longer than the trigger">
          <Select
            data-testid="pw-long-narrow"
            aria-label="Long options in a narrow control"
            options={PW_LONG_OPTIONS}
            value={two}
            onChange={setTwo}
            placeholder="Choose…"
            className="w-full"
          />
        </PwFrame>

        <PwFrame id="long-search" width={PW_NARROW_PX} title="Select (searchable arm) — long options">
          <Select
            data-testid="pw-long-search"
            aria-label="Long options in a searchable narrow control"
            options={PW_MANY_OPTIONS}
            value={three}
            onChange={setThree}
            placeholder="Choose…"
            searchPlaceholder="Search options"
            emptyText="No match"
            className="w-full"
          />
        </PwFrame>

        <PwFrame id="long-multi" width={PW_NARROW_PX} title="MultiSelect — long options under headings">
          <MultiSelect
            data-testid="pw-long-multi"
            aria-label="Long options in a narrow multiple control"
            options={PW_MULTI_OPTIONS}
            value={many}
            onChange={setMany}
            placeholder="Choose…"
            searchPlaceholder="Search options"
            emptyText="No match"
            removeLabel={l => `Remove ${l}`}
          />
        </PwFrame>

        <PwFrame id="long-menu" width={PW_NARROW_PX} title="Dropdown menu — long items">
          <Dropdown data-testid="pw-long-menu" items={PW_MENU_ITEMS} align="start">
            <button
              type="button"
              data-testid="pw-long-menu-trigger"
              className="rounded-md border border-input px-2 py-1 text-sm"
            >
              Menu
            </button>
          </Dropdown>
        </PwFrame>

        <PwFrame id="wide-trigger" width={PW_WIDE_PX} title="Select — a trigger wider than every option">
          <Select
            data-testid="pw-wide-trigger"
            aria-label="Short options in a wide control"
            options={PW_SHORT_OPTIONS}
            value={four}
            onChange={setFour}
            placeholder="Choose…"
            className="w-full"
          />
        </PwFrame>

        <PwFrame id="runaway" width={PW_NARROW_PX} title="Select — a runaway option label">
          <Select
            data-testid="pw-runaway"
            aria-label="A runaway option label"
            options={PW_RUNAWAY_OPTIONS}
            value={five}
            onChange={setFive}
            placeholder="Choose…"
            className="w-full"
          />
        </PwFrame>

        <PwFrame
          id="runaway-search"
          width={PW_NARROW_PX}
          title="Select (searchable arm) — a runaway option label"
        >
          <Select
            data-testid="pw-runaway-search"
            aria-label="A runaway option label in a searchable control"
            options={PW_RUNAWAY_MANY}
            value={seven}
            onChange={setSeven}
            placeholder="Choose…"
            searchPlaceholder="Search options"
            emptyText="No match"
            className="w-full"
          />
        </PwFrame>

        <PwFrame
          id="runaway-truncating"
          width={PW_NARROW_PX}
          title="Select — a caller that truncates its own row"
        >
          <Select
            data-testid="pw-runaway-truncating"
            aria-label="A runaway option label the caller truncates"
            options={PW_RUNAWAY_OPTIONS}
            value={six}
            onChange={setSix}
            placeholder="Choose…"
            className="w-full"
            optionRender={pwTruncatingRow}
          />
        </PwFrame>

        <PwFrame
          id="runaway-truncating-search"
          width={PW_NARROW_PX}
          title="Select (searchable arm) — a caller that truncates its own row"
        >
          <Select
            data-testid="pw-runaway-truncating-search"
            aria-label="A runaway option label the caller truncates, in a searchable control"
            options={PW_RUNAWAY_MANY}
            value={eight}
            onChange={setEight}
            placeholder="Choose…"
            searchPlaceholder="Search options"
            emptyText="No match"
            className="w-full"
            optionRender={pwTruncatingRow}
          />
        </PwFrame>
      </div>
    )
  }
  return { default: Frame }
})

export const gallery: ModuleGallery = {
  seeded: [
    {
      slug: 'workbench-launcher',
      title: 'Workbench — analysis launcher',
      note: 'Grouped, searchable, availability-gated launcher rows (needs-<type> / arch-disabled).',
      path: '/dev/workbench-launcher',
      initialPath: '/dev/workbench-launcher',
      component: LauncherStory,
    },
    {
      slug: 'workbench-run-console',
      title: 'Workbench — live run console',
      note: 'Phase timeline + streamed log console + resource line + Stop (seeded frames).',
      path: '/dev/workbench-run-console',
      initialPath: '/dev/workbench-run-console',
      component: RunConsoleStory,
    },
    {
      slug: 'workbench-run-failed',
      title: 'Workbench — run console (failed)',
      note: 'The run console in the failed state (ITEM-33): partial timeline + logs + itemized error, no Stop.',
      path: '/dev/workbench-run-failed',
      initialPath: '/dev/workbench-run-failed',
      component: RunConsoleFailedStory,
    },
    {
      slug: 'workbench-jobs',
      title: 'Workbench — project jobs pane',
      note: 'The operational job monitor (ITEM-67): all statuses, status badges, Stop on active rows.',
      path: '/dev/workbench-jobs',
      initialPath: '/dev/workbench-jobs',
      component: JobsPaneStory,
    },
    {
      slug: 'workbench-jobs-viewer',
      title: 'Workbench — project jobs pane (no stop right)',
      note: 'The SAME jobs list for a caller the server would refuse (`can_stop: false` — not the run\'s creator, not the owner of its scope). Stop|Cancel is PRESENT on active rows and unavailable, stating who may stop the run; it is never hidden.',
      path: '/dev/workbench-jobs-viewer',
      initialPath: '/dev/workbench-jobs-viewer',
      component: JobsPaneNoStopStory,
    },
    {
      slug: 'workbench-jobs-detail',
      title: 'Workbench — job detail (live logs + charts)',
      note: 'A followed running job (ITEM-67): live logs, CPU/memory time-series, and Stop — the run-running-with-logs surface.',
      path: '/dev/workbench-jobs-detail',
      initialPath: '/dev/workbench-jobs-detail',
      component: JobsDetailStory,
    },
    {
      slug: 'workbench-flow-guidance',
      title: 'Workbench — analysis completion flow guidance (populated)',
      note: 'The DATA-driven self-explaining DONE state (declarative-processor-ui Slice 7): what QC produced + the DERIVED next-step ("Open Cell filter") from the produce→accept type graph — general, not processor-specific. Populated guidance (not an empty state).',
      path: '/dev/workbench-flow-guidance',
      initialPath: '/dev/workbench-flow-guidance',
      component: FlowGuidanceStory,
    },
    {
      slug: 'workbench-launcher-viewer',
      title: 'Workbench — analysis launcher (viewer, read-only)',
      note: 'ITEM-29: the launcher for a VIEWER — rows browsable but DISABLED with a read-only reason + a read-only banner.',
      path: '/dev/workbench-launcher-viewer',
      initialPath: '/dev/workbench-launcher-viewer',
      component: LauncherViewerStory,
    },
    {
      slug: 'workbench-lineage',
      title: 'Workbench — artifact-lineage DAG',
      note: 'The interactive provenance DAG (ITEM-61): artifact + run nodes, produced/consumed edges, export-from-node.',
      path: '/dev/workbench-lineage',
      initialPath: '/dev/workbench-lineage',
      component: LineageStory,
    },
    {
      slug: 'workbench-lineage-narrow',
      title: 'Workbench — lineage compact fallback (~390px)',
      note: 'The ≤440px / large-graph fallback (ITEM-61): the DAG collapses to a scrollable node list.',
      path: '/dev/workbench-lineage-narrow',
      initialPath: '/dev/workbench-lineage-narrow',
      component: LineageNarrowStory,
    },
    {
      slug: 'workbench-run-diff',
      title: 'Workbench — before/after run diff',
      note: 'The iteration loop (ITEM-63): a re-run’s key observables vs its predecessor, deltas highlighted.',
      path: '/dev/workbench-run-diff',
      initialPath: '/dev/workbench-run-diff',
      component: RunDiffStory,
    },
    {
      slug: 'workbench-multi-run-compare',
      title: 'Workbench — compare N runs',
      note: 'The multi-resolution / clustree-style compare (ITEM-65): params→outcomes aligned per run, shared color + varies flags.',
      path: '/dev/workbench-multi-run-compare',
      initialPath: '/dev/workbench-multi-run-compare',
      component: MultiRunCompareStory,
    },
    {
      slug: 'workbench-param-preview',
      title: 'Workbench — param→outcome live preview',
      note: 'The honest live preview (ITEM-65): a cap estimates a real kept count; other params defer to “computes on run”.',
      path: '/dev/workbench-param-preview',
      initialPath: '/dev/workbench-param-preview',
      component: ParamPreviewStory,
      // Both preview chips render under gate:ui capture: the cap ESTIMATE (a real kept
      // count) + the DEFERRED "computes on run" chip. The live re-estimate on input change
      // is driven by the Playwright e2e (`preview-compare.spec.ts`).
      interactions: [
        {
          name: 'preview-chips',
          note: 'The estimate chip + the deferred chip both render.',
          steps: async d => {
            await d.waitFor('workbench-param-preview-estimate-max_cells')
            await d.waitFor('workbench-param-preview-deferred-resolution')
          },
        },
      ],
    },
    {
      slug: 'workbench-canvas',
      title: 'Workbench — center canvas (viz GridWorkspace)',
      note: 'The flagship deck.gl canvas (ITEM-56) bound to a FixtureSource. Headless boxes show the WebGL fallback; a real GPU render is a manual/CI concern.',
      path: '/dev/workbench-canvas',
      initialPath: '/dev/workbench-canvas',
      component: CanvasStory,
    },
    // Every pane kind's real `PaneBody` — the shell-chrome (inset + scroll track) gate.
    ...paneInsetSurfaces,
    {
      slug: 'workbench-empty',
      title: 'Workbench — empty project',
      note: 'The IDE shell for a project with no artifacts yet (the common first render).',
      path: '/projects/:id/:section',
      initialPath: `/projects/${EMPTY_ID}/workspace`,
      component: WorkbenchEmpty,
    },
    {
      slug: 'workbench-artifacts',
      title: 'Workbench — populated docks',
      note: 'Seeded with an embedding + a produced clustering — the docks show availability.',
      path: '/projects/:id/:section',
      initialPath: `/projects/${ARTIFACTS_ID}/workspace`,
      component: WorkbenchArtifacts,
    },
    {
      slug: 'workbench-collapsed',
      title: 'Workbench — dock collapsed',
      note: 'The bottom "Analysis + data" dock collapsed to its labeled stripe.',
      path: '/projects/:id/:section',
      initialPath: `/projects/${COLLAPSED_ID}/workspace`,
      component: WorkbenchCollapsed,
      // Seed the per-project layout so the bottom dock renders collapsed. Order-safe:
      // the shell's own `ensureProject` never overwrites an existing slice, and the
      // store is reactive, so collapsing before OR after mount lands the same frame.
      setup: () => {
        const s = useWorkbenchLayoutStore.getState()
        s.ensureProject(COLLAPSED_ID)
        s.setCollapsed('bottom', true)
      },
    },
    {
      slug: 'workbench-narrow',
      title: 'Workbench — narrow (~390px)',
      note: 'The shell constrained to a 390px width — responsive coverage (no page x-scroll).',
      path: '/projects/:id/:section',
      initialPath: `/projects/${NARROW_ID}/workspace`,
      component: WorkbenchNarrow,
    },
    {
      slug: 'workbench-viewer',
      title: 'Workbench — viewer (read-only, populated)',
      note: 'ITEM-29: a populated read-only IDE for a project VIEWER — docks/canvas render, but the toolbar Run/Export are absent and the launcher is read-only.',
      path: '/projects/:id/:section',
      initialPath: `/projects/${VIEWER_ID}/workspace`,
      component: WorkbenchViewer,
    },
    // declarative-rendering-hardening Slice 3 (F4) — the 12 declarative-engine surfaces
    // (6 fixtures × narrow/wide). EVERY processor UI renders through that engine, so before
    // these there was ZERO gallery / `gate:ui` coverage of ANY processor surface at ANY
    // width. Generated from the fixture registry, so a fixture cannot be silently
    // unregistered here while still existing there.
    ...declarativeFixtureSurfaces,
    entryListCollapseSurface,
    {
      slug: 'picker-popup-width',
      title: 'Option-list popups — width against their trigger',
      note: 'Every kit option list (Select, its searchable arm, MultiSelect, Dropdown) in a trigger narrower than its own options, plus a trigger wider than all of them and a runaway label. The popup must grow to its content, never be narrower than the trigger, and never exceed the space available.',
      path: '/dev/picker-popup-width',
      initialPath: '/dev/picker-popup-width',
      component: PickerWidthStory,
    },
  ],
}
