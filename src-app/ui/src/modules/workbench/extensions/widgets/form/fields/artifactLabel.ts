// ITEM-35 — the artifact-ref picker's option label + its dataset GROUPING (pure, so both are
// unit-testable without React — TEST-404).
//
// ── THE LABEL ITSELF NO LONGER LIVES HERE ───────────────────────────────────────────────────
//
// It used to, alongside a rival in `extensions/provenance/lineageGraph.ts` that answered the
// same question differently (`datatype · id8`), so one artifact read one way as a DAG node and
// another way as a picker option. The derivation moved to `@/core/workstore/artifactLabel` —
// next door to `sourceDatasetLabel`, which ended exactly this drift for the artifact-GROUPING
// vocabulary and for the same reason: a user who picks a thing under one name has to read that
// name back afterwards. Both surfaces now call the shared one, and a THIRD (the workbench
// `artifact` pane's tab) joined them rather than growing a fourth spelling.
//
// `formatDims` / `formatRelativeTime` are RE-EXPORTED, not re-declared: the picker's own tests
// and any future call site keep their import path, and there is still one implementation.
//
// What stays here is the part that is genuinely this picker's: prefixing the shared label with
// the candidate's source DATASET, and partitioning candidates into groups.

import {
  artifactLabel,
  PROJECT_PRODUCED_LABEL,
  sourceDatasetGroupKey,
  sourceDatasetIds,
  sourceDatasetNames,
  sourceDatasetsLabel,
} from '@/core/workstore'
import type { ArtifactRow } from '@/modules/workbench/extensions/data'

export { formatDims, formatRelativeTime } from '@/core/workstore'

/**
 * The picker option label for one artifact — the SHARED derivation
 * (`@/core/workstore/artifactLabel`): `datatype · dimensions · relative-date`, each enriching
 * segment omitted when unavailable, with the short id as the last resort when nothing else
 * distinguishes the row. `now` is injectable for deterministic tests.
 */
export function formatArtifactOption(row: ArtifactRow, now?: number): string {
  return artifactLabel(row, now)
}

// ITEM-22 — group/label picker candidates by their DERIVED source dataset (from
// provenance, carried on the `ArtifactRow` since the catalog list now returns
// `ListedArtifact`). Pure so the grouping is unit-testable without React.

/**
 * The fallback group label for candidates whose lineage resolves to no source dataset
 * (a bare project-scoped artifact) — re-exported, NOT re-declared.
 *
 * It used to say "No source dataset" while the two other artifact-grouping surfaces said
 * "Produced in this project": one fact, two sentences, and which one a user read depended on
 * which picker they opened. The words now live once, in `@/core/workstore`.
 */
export const NO_SOURCE_DATASET_GROUP = PROJECT_PRODUCED_LABEL

export interface ArtifactDatasetGroup {
  /** The group's source dataset ids — TWO for a group of artifacts that integrated two
   *  datasets, empty for the ungrouped/no-lineage bucket. Such artifacts form their OWN
   *  group: they belong to both sources, so filing them under either picks a winner by
   *  declaration order, which is the bug this shape removes. */
  datasetIds: readonly string[]
  /** The single source dataset id when the group has exactly one, else null (both "none"
   *  and "several" — a caller wanting to act on one dataset has no answer in either case). */
  datasetId: string | null
  /** The group label shown in the picker (dataset name, or the no-source fallback). */
  label: string
  rows: ArtifactRow[]
}

/** Does this row HAVE a source dataset at all? Every lineage field is independently
 *  nullable, so "has one" is "carries anything" — a dataset whose name did not travel is
 *  still a dataset, and a MULTI-source row carries only the plural fields (the singular
 *  pair is null by the wire's exactly-one rule), so reading the singular alone would file
 *  an integration under "no dataset". */
function hasSourceDataset(r: ArtifactRow): boolean {
  return sourceDatasetIds(r).length > 0 || sourceDatasetNames(r).length > 0
}

/** True when grouping ADDS signal: ≥1 candidate carries a source dataset (so a
 *  user with several datasets attached can tell candidates apart). When false the
 *  picker stays FLAT (back-compat: no visual change for a single-dataset project). */
export function shouldGroupByDataset(rows: ArtifactRow[]): boolean {
  return rows.some(hasSourceDataset)
}

/** Partition candidates by source dataset, named groups first (alpha by label, stable),
 *  then a trailing no-source group (only when non-empty). Pure + deterministic.
 *
 *  A row carrying an id but no NAME forms its own group titled by the id, exactly as the
 *  other two artifact-grouping surfaces do. It used to land in the no-source group, which
 *  the old vague wording ("No source dataset") merely blurred and the shared wording would
 *  state falsely — that row DID come from a dataset. */
export function groupRowsByDataset(rows: ArtifactRow[]): ArtifactDatasetGroup[] {
  const named = new Map<string, ArtifactDatasetGroup>()
  const orphans: ArtifactRow[] = []
  for (const r of rows) {
    if (hasSourceDataset(r)) {
      const label = sourceDatasetsLabel(r)
      const ids = sourceDatasetIds(r)
      // Keyed on the SET of ids when there is one, so two datasets that share a name stay
      // apart AND an integration of two datasets forms its own group; a name-only row can
      // only be keyed by its name.
      const key = ids.length > 0 ? sourceDatasetGroupKey(r) : label
      const g = named.get(key) ?? {
        datasetIds: ids,
        datasetId: ids.length === 1 ? ids[0] : null,
        label,
        rows: [],
      }
      g.rows.push(r)
      named.set(key, g)
    } else {
      orphans.push(r)
    }
  }
  const groups = [...named.values()].sort((a, b) => a.label.localeCompare(b.label))
  if (orphans.length > 0) {
    groups.push({ datasetIds: [], datasetId: null, label: NO_SOURCE_DATASET_GROUP, rows: orphans })
  }
  return groups
}

/** The flat-picker (MultiSelect, which has no group affordance) option label — prefix
 *  the enriched label with the source dataset so the candidate is still LABELED by it.
 *  Degrades to the plain label when there is no source dataset. Uses the same
 *  name-then-id rule as the group heading, so the two never disagree about one row. */
export function formatArtifactOptionWithDataset(row: ArtifactRow, now?: number): string {
  const base = formatArtifactOption(row, now)
  if (!hasSourceDataset(row)) return base
  return `${sourceDatasetsLabel(row)} · ${base}`
}
