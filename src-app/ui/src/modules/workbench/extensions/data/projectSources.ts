// projectSources — the ONE `(pull, streaming)` pair per project data plane (ITEM-8, moved here
// by ITEM-42).
//
// ── WHY IT LIVES IN `extensions/data` AND NOT IN `extensions/canvas` ─────────────────────────
//
// It used to be memoized in `extensions/canvas/canvasDataSource.ts`, because the canvas was its
// only consumer. ITEM-42 gives it a second one: the `data` capability's columnar read, which the
// declarative `column_values` slice reaches through the broker (core may not import an
// extension — `lint-layer-boundary` R2 — so the capability is the only conforming seam).
//
// A memo that stayed in the canvas extension would have meant the capability building its OWN
// source: two instances, two multicasts, two decodes — precisely the "second byte path" DEC-20
// was resolved to avoid, arriving through the fix instead of through the defect. So the memo
// moves to the extension that PUBLISHES the plane, and the canvas obtains it from here.
//
// ── THE KEY IS THE BROKER, NOT THE HANDLE ───────────────────────────────────────────────────
//
// `createWorkbenchApi(host, extensionId)` mints a NEW `WorkbenchAPI` object per extension while
// `capabilitiesFor(host)` memoizes ONE broker per host. So two consumers of the same project can
// legitimately hold two different `api` objects and one broker — and keying the memo on the
// handle would hand them two sources, which is the split this move exists to remove. The key is
// therefore `api.capabilities` when there is one, falling back to the handle itself when there
// is not (a bare handle carries no broker to share, so it can only be its own key; that is also
// what keeps ITEM-8's memoization test — which passes identity-only handles — meaningful).
//
// The memoization is the LOAD-BEARING half, not an optimisation. The source's cache and in-flight
// multicast are per-INSTANCE, so a factory that minted a fresh one per call would give every
// caller its own read and INV-6 ("panes on one coordinate artifact fold onto ONE base … and one
// copy of the positions") would hold only by accident of the artifact-keyed dedup one layer up.
// With one instance, a second pane opening WHILE the first is still streaming joins the running
// read — which the dedup map cannot do, because it only remembers reads that already finished.
//
// Keyed then on the project id. A project switch therefore gets a cold source, which is correct:
// the catalog and every artifact id change with it.

import { asDataSource, type DataSource } from '@ziee/viz'
import { resolveOrThrow, type WorkbenchAPI } from '@/modules/workbench/core'
import {
  DATA_CAPABILITY_ID,
  DATA_CAPABILITY_RANGE,
  type ArtifactRow,
  type DataApi,
} from './contract.ts'
import { WorkbenchDataSource, type DataPlaneArtifact } from './workbenchDataSource.ts'
import { WorkbenchStreamingSource } from './workbenchStreamingSource.ts'

/** The minimum a source needs from its caller: somewhere to resolve the `data` capability. Narrow
 *  on purpose — a `WorkbenchAPI` satisfies it, and so does the bare `{ capabilities }` the
 *  capability provider holds, without either side pretending to be the other. */
export interface CapabilityHandle {
  capabilities: WorkbenchAPI['capabilities']
}

/**
 * The WIRE-ROW → DATA-PLANE projection, exported because it is a SEAM worth pinning — the same
 * reason `dataHost.ts::toArtifactRow` is exported, and for the same failure it has already
 * suffered once.
 *
 * This is the ONE hop every production read of the project catalog crosses. It used to be
 * inline inside `getCatalog` below, which meant the only way to test it was to stand up a
 * broker; every unit fixture hand-built its own `DataPlaneArtifact` instead and therefore could
 * not see a dropped field. Naming it costs nothing and makes "does this field survive?" a
 * question a test can ask directly.
 */
export function toDataPlaneArtifact(a: ArtifactRow): DataPlaneArtifact {
  return {
    id: a.id,
    datatype: a.datatype,
    // ITEM-25: every byte read dispatches on the producer's declaration, so it
    // must survive the control-plane hop. Dropping it here would make each read
    // re-fetch the artifact row — or, worse, guess.
    structure: a.structure,
    // ── ITEM-13: `meta` AND `dataset_id`, AND WHAT THEIR ABSENCE ALREADY COST ──
    //
    // This mapper is the ONE seam every production read of the project catalog
    // crosses, and it used to emit three fields. That was not merely incomplete: it
    // silently disabled shipped behaviour. `DataPlaneArtifact.meta`'s own
    // doc-comment says `meta.name` is "the key `columnLabel` is looked up by", and
    // `annotationsForAxis`/`columns()` consult that override for every
    // whole-artifact column — but the field never arrived, so `declaredColumnName`
    // answered `undefined` for every column in every real project and the override
    // could not fire once. Every unit fixture hand-built its own
    // `DataPlaneArtifact` and therefore could not see it; only a test that drives
    // THIS mapper can, which is what `projectSources.test.ts` now does.
    //
    // ITEM-13 needs both fields for the same reason and would have been inert in
    // exactly the same way: `meta.component_columns` is the producer's declaration
    // that a layout's positions are two named sibling columns (the only channel
    // that survives a narrowing — `virtual_dataset.rs:1688-1705` re-mints
    // `structure` and copies `meta` verbatim at `:1714`), and `dataset_id` is the
    // scope that declaration is resolved in. A layout whose components cannot be
    // resolved is offered and then blank, which is the failure the whole settlement
    // is designed to make unreachable — so shipping this mapper unchanged would
    // have delivered the defect through the fix.
    //
    // Carried VERBATIM, uninterpreted. `meta` is producer-written and the server
    // never reads it; every consumer here narrows it defensively at its own point
    // of use.
    meta: a.meta,
    dataset_id: a.dataset_id,
    // #159 — the object's LENGTH, for the same "a field dropped here is silently
    // `undefined` at every consumer" reason the block above records at length. A
    // pyramidal raster is opened over byte RANGES, and a range reader has to know
    // where the object ends before it can address the last block; without it the
    // read is either unclamped (a 416 the rendered output cannot show) or the
    // reader refuses. It is the storage size, never a display size.
    stored_bytes: a.stored_bytes,
  }
}

/** A `DataSource` whose control-plane reads (catalog / artifact metadata) come from
 *  the `data` capability; byte reads use the default workstore deps. */
export function buildProjectDataSource(
  handle: CapabilityHandle,
  projectId: string,
): WorkbenchDataSource {
  return new WorkbenchDataSource(projectId, {
    getCatalog: async () => {
      // Resolved LAZILY, at read time rather than at build time: a caller may hold a handle whose
      // broker is still being stocked (the capability provider itself is one), and every existing
      // caller relies on this being deferred.
      const data = resolveOrThrow<DataApi>(
        handle.capabilities,
        DATA_CAPABILITY_ID,
        DATA_CAPABILITY_RANGE,
      )
      const c = await data.catalog()
      return {
        // The open axis set, carried through verbatim — the canvas never names an axis.
        axes: c.axes,
        artifacts: c.artifacts.map(toDataPlaneArtifact),
      }
    },
    // Capability-driven catalog classification (DEC-7) — no hardcoded domain datatype id
    // — is NOT overridden here: `WorkbenchDataSource`'s own `defaultDeps()` already binds
    // `hasCapability` to `datatypeRegistry.matches(id, { capabilities: [c] })`, which is the
    // identical read. This file used to re-supply it via core's `workbenchLattice` (a 1:1
    // adapter over the SAME registry), and that one import was the edge that closed a module
    // cycle: extensions/index → canvas/canvasHostProvider → canvas/canvasDataSource →
    // core/host/createHost → extensions/index. Entering that cycle at `canvasHostProvider`
    // left `canvasHost` in its temporal dead zone when `extensions/index` ran
    // `registerDeclarativeCanvasHost(canvasHost)`, crashing the page. Do not re-add the
    // override: an extension has no reason to reach into core's host wiring for a registry
    // lookup its own data plane already performs.
    // Adopted from `feat/artifact-model` `3f345cc4`, which cut the same edge independently.
  })
}

/** Both views of ONE project data plane. `streaming` is the data-input seam viz consumes
 *  (`VizController.resolveSource`); `pull` is `asDataSource(streaming)` — the same bytes through
 *  the same multicast, for the call sites that still want a whole column. */
export interface ProjectSources {
  readonly streaming: WorkbenchStreamingSource
  readonly pull: DataSource
}

const PROJECT_SOURCES = new WeakMap<object, Map<string, ProjectSources>>()

/** The memo key — see the header. `capabilities` when the handle carries a broker, else the
 *  handle itself. */
function keyOf(handle: CapabilityHandle): object {
  // Read defensively rather than by type: `WorkbenchAPI.capabilities` is declared non-optional,
  // but an identity-only handle (ITEM-8's memoization test constructs one, legitimately — its
  // subject is which INSTANCE comes back, not what it reads) carries none at runtime. Such a
  // handle has no broker to share with anyone, so it can only be its own key.
  const broker = (handle as { capabilities?: object }).capabilities
  return broker ?? (handle as object)
}

/** ONE `(pull, streaming)` pair per `(broker, project)`, memoized. */
export function buildProjectSources(handle: CapabilityHandle, projectId: string): ProjectSources {
  const key = keyOf(handle)
  let byProject = PROJECT_SOURCES.get(key)
  if (!byProject) {
    byProject = new Map()
    PROJECT_SOURCES.set(key, byProject)
  }
  const hit = byProject.get(projectId)
  if (hit) return hit
  // The pull source carries the control-plane binding (the `data` capability → the project
  // catalog); the streaming source COMPOSES with it rather than re-deriving it, so both planes
  // read one catalog and cannot disagree about which artifacts exist.
  const streaming = new WorkbenchStreamingSource(projectId, {
    pull: buildProjectDataSource(handle, projectId),
  })
  recordProgressForTestSeam(streaming)
  const built: ProjectSources = { streaming, pull: asDataSource(streaming) }
  byProject.set(projectId, built)
  publishSourcesForTestSeam(projectId, built)
  return built
}

/** Test-only: drop the memoized sources for ONE handle, so a case starts from a cold cache rather
 *  than inheriting the previous case's decoded chunks. Scoped to the handle the caller already
 *  holds — a `WeakMap` has no `clear()`, and giving it one would mean holding every key alive. */
export function __resetProjectSourcesForTests(handle: CapabilityHandle): void {
  PROJECT_SOURCES.delete(keyOf(handle))
  // The dev seam mirrors this memo by PROJECT ONLY — it has no handle to key on — so it cannot
  // be reset per-handle without also dropping sources that are still live under a DIFFERENT
  // handle, which would make the accessor return `null` for a project the app is rendering.
  // Since the mirror is repopulated on the next `buildProjectSources` for whatever handle asks,
  // and this function is test-only, the honest thing is to leave the mirror alone and say so:
  // a reader that wants the CURRENT pair should call `buildProjectSources` rather than trusting
  // a mirror across a reset. An earlier cut cleared it globally, which traded a stale object for
  // a missing one — the same defect pointing the other way.
}

// ── read-only e2e seam: the stream PROGRESS log (mirrors `window.__cyto_read` / `__canvasPanes`) ──
//
// `WorkbenchStreamingSource.onProgress` is the app's own per-chunk arrival channel (ITEM-19) and
// the thing `CanvasCoverage` renders. It is NOT observable from the DOM alone: the indicator is
// deliberately absent below two arrived chunks and removed on completion, so by the time a spec
// can query the page the affordance is gone and the only trace of what arrived is the numbers that
// drove it.
//
// So the log is attached HERE — at source CONSTRUCTION, before any read can start — rather than in
// the component. A recorder that subscribed on mount would be racing the first read, and a spec
// built on it would be measuring when the recorder attached rather than what arrived.
//
// Gated exactly like `window.__cyto_read`: present under the Vite dev server and under the e2e's
// production PREVIEW build (`VITE_ENABLE_TEST_SEAMS=1`), absent from a real release bundle.
// Read-only, append-only, and CAPPED — a long session must not grow an unbounded array.

/** One `StreamProgress`, plus the wall-clock at which it was observed. */
interface RecordedProgress {
  readonly key: string
  readonly done: boolean
  readonly chunks: number
  readonly rowsSeen: number | null
  readonly totalRows: number | null
  readonly t: number
}

const PROGRESS_LOG_CAP = 2000
const PROGRESS_LOG: RecordedProgress[] = []

function recordProgressForTestSeam(source: WorkbenchStreamingSource): void {
  if (!(import.meta.env.DEV || import.meta.env.VITE_ENABLE_TEST_SEAMS)) return
  if (typeof window === 'undefined') return
  source.onProgress(p => {
    if (PROGRESS_LOG.length >= PROGRESS_LOG_CAP) return
    PROGRESS_LOG.push({
      key: p.key,
      done: p.done,
      chunks: p.chunks,
      rowsSeen: p.rowsSeen,
      totalRows: p.totalRows,
      t: performance.now(),
    })
  })
}

/**
 * The PRODUCTION source pair, by project — the object the grid is actually handed.
 *
 * ── WHY THIS EXISTS, AND WHY `__cyto_ds` IS NOT A SUBSTITUTE ────────────────────────────────
 * `__cyto_ds` mints a BARE `WorkbenchDataSource`. That is deliberately not what production
 * renders against: the app builds `asDataSource(WorkbenchStreamingSource)` and hands the grid
 * THAT, so a claim about "the production data source" proven through `__cyto_ds` is a claim
 * about a different object — and the specific defect #159 exists to close was a seam that
 * worked on the class and was dropped by the adapter. A spec that cannot reach the adapted
 * object cannot tell those two states apart.
 *
 * Read-only and by-project, gated exactly like its two siblings, so a shipped release has
 * neither the map nor the accessor.
 */
const SOURCES_BY_PROJECT = new Map<string, ProjectSources>()

function publishSourcesForTestSeam(projectId: string, built: ProjectSources): void {
  if (!(import.meta.env.DEV || import.meta.env.VITE_ENABLE_TEST_SEAMS)) return
  if (typeof window === 'undefined') return
  SOURCES_BY_PROJECT.set(projectId, built)
  installStreamSeam()
}

/**
 * Install the seam object, ONCE.
 *
 * Idempotent by an explicit check rather than by being called from one place: it has two
 * callers, both of which run on every `buildProjectSources`, and an earlier attempt at this
 * guard sat in the SECOND of them — where the object it was checking for had been installed by
 * the first a few lines earlier, so it never fired and `window.__cyto_stream` was still replaced
 * on every build. The guard belongs in the function that does the installing, where both callers
 * reach it.
 *
 * It matters because both accessors close over module state, so a spec that captured the seam
 * before a second project opened would otherwise be holding a discarded object.
 */
function installStreamSeam(): void {
  const w = window as unknown as { __cyto_stream?: unknown }
  if (w.__cyto_stream) return
  w.__cyto_stream = {
    /** Every progress event this page has observed, oldest first. A COPY — a spec must not be
     *  able to mutate the app's record of what happened. */
    progress: () => PROGRESS_LOG.map(e => ({ ...e })),
    reset: () => {
      PROGRESS_LOG.length = 0
    },
    /** The `DataSource` the grid holds for `projectId` — the adapted one, not the pull class. */
    source: (projectId: string) => SOURCES_BY_PROJECT.get(projectId)?.pull ?? null,
  }
}
