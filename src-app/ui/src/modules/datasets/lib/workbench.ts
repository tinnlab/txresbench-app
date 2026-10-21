// Datasets ↔ workbench bridge (READ-ONLY consumption of the P5 registry). The
// dataset-detail Pipeline enumerates the applicable processors for a dataset's
// datatype and gates them by CPU-arch (DEC-29), then builds the `AnalysisSpec`-
// shaped compute spec the dataset-scoped `POST /datasets/{id}/process` endpoint
// (ITEM-23) consumes. We construct our OWN `DatatypeLattice` adapter over the
// shared `@/core/datatypes` registry (exactly as the workbench's own
// `discover.ts` / `createHost.ts` / `seam.ts` each do) rather than importing a
// feature-module internal — keeping this a clean, coupling-free read.

import { datatypeRegistry } from '@/core/datatypes'
import {
  type AnalysisContribution,
  type AvailabilityResult,
  type DatatypeLattice,
  type WhenContext,
  computeAvailabilityWithArch,
  workbenchRegistry,
} from '@/modules/workbench/core'

/**
 * The backend CPU arch the pipeline gates against (DEC-29). v1 builds + ships the
 * x86_64 rootfs only (DEC-30 — "machinery now, ship x86 only"); no typed endpoint
 * exposes the running backend's arch yet, so this is the documented single-source
 * constant. When a real arch probe lands, wire it here (one line) — the arch lens
 * below already DISABLES + explains an arch-incompatible processor, never hides it.
 */
export const BACKEND_ARCH = 'x86_64'

/** The P2 lattice adapter — mirrors the workbench's inline adapters. */
const lattice: DatatypeLattice = {
  isA: (sub, sup) => datatypeRegistry.isA(sub, sup),
  matches: (id, sel) =>
    datatypeRegistry.matches(id, sel as Parameters<typeof datatypeRegistry.matches>[1]),
  get: id => datatypeRegistry.get(id) as ReturnType<DatatypeLattice['get']>,
}

/** One processor offered on the pipeline, with its arch-lens verdict. */
export interface ProcessorOption {
  contribution: AnalysisContribution
  availability: AvailabilityResult
}

/**
 * The processors APPLICABLE to a dataset of `datatype` (accepts + `when` match),
 * each carrying its arch-runnability verdict (via the package's shared
 * `computeAvailabilityWithArch` lens — the single source, so the pipeline picker
 * never drifts from the project workbench's applicability logic). An arch-incompatible
 * processor is STILL returned (with `availability.runnable === false` + a `reason`)
 * so the UI disables + explains it (DEC-29); an inapplicable processor is omitted.
 *
 * Only `sandbox`-run processors are offered: the owner-scoped dataset pipeline
 * dispatches a sandbox job (`buildProcessSpec`), so a `builtin`-kind analysis (which
 * has no sandbox entry) is excluded here rather than shown and then failing to build
 * a valid spec. A null/untyped dataset yields no applicable processors.
 */
export function applicableProcessors(datatype: string | undefined): ProcessorOption[] {
  const ctx: WhenContext = { producedTypeIds: datatype ? [datatype] : [] }
  const out: ProcessorOption[] = []
  for (const contribution of workbenchRegistry.analyses.all()) {
    // Only sandbox-run processors are dataset-processable (see `buildProcessSpec`).
    if (contribution.run.kind !== 'sandbox') continue
    const availability = computeAvailabilityWithArch(contribution, ctx, lattice, BACKEND_ARCH)
    if (!availability.available) continue
    out.push({ contribution, availability })
  }
  return out
}

/**
 * Build the `AnalysisSpec`-shaped `spec` object for `POST /datasets/{id}/process`
 * from a processor contribution + its filled params. The dataset's file(s) are
 * appended server-side as inputs at `dataset_slot` (we send none here).
 *
 * The processor's `run.entry` is a content-addressed code reference the host/
 * backend resolves to the actual entry script at dispatch (ITEM-18 wiring) — we
 * pass it through as `code_ref` (the spec's content-addressed code field), map the
 * runtime → the sandbox `language`, and forward the declared `schedule.class` +
 * `arch`. `builtin`-kind runs have no sandbox entry and can't be dataset-processed.
 */
export function buildProcessSpec(
  contribution: AnalysisContribution,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const run = contribution.run
  const spec: Record<string, unknown> = { params }
  if (run.kind === 'sandbox') {
    spec.language = run.runtime
    spec.code_ref = run.entry
    // M3: thread the owning package so a bare `code_ref` (e.g. `compute/foo.py`) resolves
    // in the CORRECT package even when two separate-repo packages ship the same path.
    if (contribution.extensionId) spec.package = contribution.extensionId
    if (run.timeout != null) spec.timeout_secs = run.timeout
  }
  if (contribution.schedule?.class) spec.schedule = { class: contribution.schedule.class }
  if (contribution.arch && contribution.arch.length > 0) spec.arch = contribution.arch
  return spec
}
