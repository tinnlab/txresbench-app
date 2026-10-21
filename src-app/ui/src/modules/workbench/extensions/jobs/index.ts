// `extensions/jobs` — the builtin extension that PUBLISHES the `jobs` capability
// (run-a-processor-with-params + the run's progress stream), and owns every surface
// that answers **"what did this RUN produce"**.
//
// It is a RELOCATION, not a new capability: the contract is the former
// `core/api/compute.ts`, the plane the former `createHost.ts::createComputeHost`, and
// the frame mapper `./jobFrames.ts`. The run/artifact panes came from `workbench/panes`
// and `workbench/result` for the same reason — a jobs list, a launcher, a run console,
// an artifact review and a run diff are all views ON a run.
// (`workbench/result` names the pre-ITEM-25 directory, kept accurate as history.)
//
// The GENERIC half of `result/` did NOT come here: the produced-kind → renderer
// registry is a contribution kind (`core/contributions/artifactRegistry`), and the
// unknown-type fallback (`GenericResult`, `StatCard`, `useArtifact`) is core's, because
// the unknown case must ALWAYS render something.

// --- the published contract + its binds ---
export * from './contract.ts'
export { createJobsApi } from './jobsCapability.ts'
export { createJobsHost, makeFakeJobsHost } from './jobsHost.ts'
export { createJobsCapability } from './provider.ts'
export { mapSseFrame } from './jobFrames.ts'
export type { JobFrameKind, FrameMetric, FrameLog, WorkbenchJobFrame } from './jobFrames.ts'

// --- run/jobs panes ---
export { JobsPane, JobsPaneView, type JobsPaneViewProps } from './JobsPane.tsx'
export { LauncherPane } from './LauncherPane.tsx'
export { RunPane } from './RunPane.tsx'
export { ViewPane } from './ViewPane.tsx'
export { JobFlowGuidance, resolveJobAnalysisId } from './JobFlowGuidance.tsx'
export { DeleteArtifactButton } from './DeleteArtifactButton.tsx'
export * from './jobsScope.ts'
export { JobsPaneStore } from './jobsPaneStore.ts'

// --- run ARTIFACT views ---
export { ArtifactPane, runArtifactRef, parseArtifactRef, type ParsedArtifactRef } from './ArtifactPane.tsx'
export { ArtifactPanel, type ArtifactPanelProps } from './ArtifactPanel.tsx'
export { ArtifactReview, type ArtifactReviewProps } from './ArtifactReview.tsx'
export { ArtifactCompareView, type ArtifactCompareViewProps } from './ArtifactCompareView.tsx'
export { ArtifactChaining } from './ArtifactChaining.tsx'
export { ArtifactDetailRoutePage } from './ArtifactDetailRoutePage.tsx'
export { MultiRunCompareView } from './MultiRunCompareView.tsx'
export { MultiRunComparePane, compareRef } from './MultiRunComparePane.tsx'
export * from './multiRunCompare.ts'
export { RunDiffView, type RunDiffViewProps } from './RunDiffView.tsx'
export * from './runDiff.ts'
export { useRunArtifacts, useRunNode, sortRunArtifacts } from './useRunArtifacts.ts'
export type { RunArtifactsState, RunNodeState } from './useRunArtifacts.ts'
