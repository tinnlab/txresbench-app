// The `@/modules/workbench/core/registry` subpath barrel (ITEM-3/4/5/6/8).
export { Registry } from './registry.ts'
// The availability predicate + the CPU-arch lens (ITEM-26 / DEC-29). The FE
// pipeline picker consumes `computeAvailabilityWithArch` to DISABLE (+ explain)
// an analysis whose `arch` excludes the backend arch, without hiding it.
export {
  computeAvailability,
  computeAvailabilityWithArch,
  archSupportsBackend,
  archUnavailableReason,
} from './availability.ts'
export type { AvailabilityInputs, AvailabilityResult, BackendArch } from './availability.ts'
// "Does this analysis ship its own form?" — the ONE predicate the run panel, the
// `analysis.launch` routing and `fallbackParamsFor` all read, so the three surfaces cannot
// disagree about which one of them owns an analysis' inputs (INV-2/INV-3/INV-4).
export { analysisOwnsItsForm } from './ownForm.ts'
export {
  workbenchRegistry,
  resetWorkbenchRegistry,
  CONTRIBUTION_KINDS,
} from './workbenchRegistry.ts'
export type { Contributions, ContributionKind } from './workbenchRegistry.ts'
// ITEM-31 — the produced-kind → RENDERER registry. It is a CONTRIBUTION KIND (a module
// registers a compare renderer / bespoke list columns for a produced kind, exactly as it
// registers a view), so it belongs beside the other registries rather than in a `result/`
// directory. The renderers it dispatches TO live with their OWNERS: the generic fallback +
// StatCard in `core/render`, the run views in `extensions/jobs`, the lineage views in
// `extensions/provenance`.
export {
  registerArtifactCompareComponent,
  resolveArtifactCompareComponent,
  registerArtifactListRenderer,
  resolveArtifactListRenderer,
  defaultForKind,
  dispatchCompare,
  __resetArtifactRegistry,
} from './artifactRegistry.ts'
export type {
  ArtifactCompareComponent,
  ArtifactListRenderer,
  DefaultArtifactKind,
  CompareDispatch,
} from './artifactRegistry.ts'
export type {
  Contribution,
  Safety,
  AnalysisContribution,
  AnalysisCategory,
  ScheduleSpec,
  RunSpec,
  ViewContribution,
  ViewArea,
  ViewSpec,
  StatusBarSide,
  StatusBarItemContribution,
  SectionContribution,
} from './types.ts'
