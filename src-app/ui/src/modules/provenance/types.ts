// Provenance module view types.
//
// The wire DTOs (RunNodeDto, GraphDto, ReadinessDto, RunsPageDto,
// ProvenanceSettings, …) are generated in `@/api-client/types`; re-export the
// ones this module's components/stores consume so callers import from one place.

export type {
  ArtifactNodeDto,
  ExportRequest,
  ExportResponse,
  GraphDto,
  ProvenanceSettings,
  ReadinessDto,
  RecordSelectionRequest,
  RunNodeDto,
  RunsPageDto,
  UpdateProvenanceSettings,
  UsedEdgeDto,
} from '@/api-client/types'

/** The user-facing export scope picker: this run, or the whole project. */
export type ExportScope = 'run' | 'project'

/** Maps the user-facing scope to the backend `ExportRequest.scope` vocabulary. */
export function exportScopeToWire(scope: ExportScope): string {
  return scope === 'run' ? 'single' : 'project'
}

/**
 * The default export scope for a given walk-back target (ITEM-62). A concrete
 * run/artifact node ("Export from here") defaults to the tightest `run` scope —
 * this run and its lineage; a null target (the whole-project export affordance)
 * defaults to `project`. Single source for the per-node vs project-wide rule so
 * every caller (`ProvenanceExport.openFor`, the DAG node action) agrees.
 */
export function defaultExportScope(target: string | null | undefined): ExportScope {
  return target ? 'run' : 'project'
}
