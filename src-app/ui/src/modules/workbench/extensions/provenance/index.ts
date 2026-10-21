// `extensions/provenance` — a READ-ONLY VIEW over the server's provenance API.
//
// There is deliberately NO provenance logic in the workbench: provenance is RECORDED
// server-side from `job.params` when a run executes (`extensions/jobs` submits the run;
// the backend derives the graph). This extension only READS `GET /api/provenance/*` and
// draws it — the lineage DAG pane, the in-artifact lineage strip, and the methods/
// provenance renderer. `provenance.test.ts` asserts the no-write property mechanically.
//
// NOT to be confused with `@/modules/provenance`, a separate app module (out of scope).

export { ProvenancePane, LineageView, CaptureFailureBanner, type LineageViewProps } from './LineagePane.tsx'
export * from './lineageGraph.ts'
export { ArtifactLineage, type ArtifactLineageProps } from './ArtifactLineage.tsx'
export { ProvenanceView, type ProvenanceViewProps } from './ProvenanceView.tsx'
