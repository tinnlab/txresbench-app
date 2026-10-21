// Workstore JSON control-plane helpers (P1 · ITEM-11).
//
// The control plane is typed JSON, so it rides the generated `ApiClient`
// (DEC-11). These thin wrappers give the workstore surfaces a stable, typed
// entry point without each caller reaching into the generated namespace.

import { ApiClient } from '@/api-client'
import type { Artifact, ListedArtifact } from '@/api-client/types'
import { rememberArtifacts } from './artifactNames'

/**
 * List a project's cataloged artifacts (optionally filtered) — the project's OWN
 * project-scoped rows PLUS the rows scoped to every dataset attached to it
 * (`list_for_project_scope`), newest first.
 *
 * The rows are `ListedArtifact`, which is what the endpoint has always returned: a
 * plain `Artifact` plus the three facts a client cannot reconstruct from the row —
 * `source_dataset_id`, `source_dataset_name` and `generator_id`, all PROVENANCE-DERIVED
 * server-side. This wrapper used to cast that down to `Artifact[]`, which compiled
 * (the extra fields are optional) and silently hid all three from every caller that
 * came through here; the artifacts pane needs the dataset name to head a group with,
 * and had no type-level way to know it was already on the wire.
 */
export async function listArtifacts(
  projectId: string,
  filter?: { datatype?: string; run_id?: string; output_id?: string },
): Promise<ListedArtifact[]> {
  const rows = await ApiClient.Workstore.listArtifacts({ project_id: projectId, ...filter })
  // Every artifact fetch feeds the ambient name lookup (`artifactNames`), so a surface that
  // holds an artifact ID but no artifact ROW — a workbench `artifact` tab, which is opened by
  // ref and may never be the active tab — can name it without standing up a fetch of its own.
  rememberArtifacts(rows)
  return rows
}

/** A project's catalog overview (PER-AXIS entry counts + artifact list). The wire
 *  type `ProjectCatalog` is axis-OPEN (`axes: AxisSummary[]`); this comment used to
 *  name two fixed biological axes instead — a leftover from the closed two-axis model
 *  that misdescribed the very contract it sits on. */
export async function getCatalog(projectId: string) {
  const catalog = await ApiClient.Workstore.getCatalog({ project_id: projectId })
  rememberArtifacts(catalog?.artifacts)
  return catalog
}

/** One artifact's typed metadata. */
export async function getArtifact(id: string): Promise<Artifact> {
  const artifact = (await ApiClient.Workstore.getArtifact({ id })) as Artifact
  // The single-row load is the OTHER place a description arrives, and the only one that
  // reaches an artifact which is not in any list the session has fetched.
  rememberArtifacts([artifact])
  return artifact
}
