// The ONE vocabulary for "which dataset is this artifact's?" — shared by every surface
// that groups artifacts by dataset.
//
// ## Why this is one module and not three constants
//
// Three surfaces group a project's artifacts by dataset, and each one used to declare its
// own words for the bucket that has no dataset:
//
//   · the `artifact_ref` picker's grouped Select   (`workbench/core/runtime/candidateGroups.ts`)
//   · the multi-select artifact picker             (`workbench/extensions/widgets/form/fields/artifactLabel.ts`)
//   · the project Artifacts pane                   (`workstore/project-extension/grouping.ts`)
//
// Two said "Produced in this project" and one said "No source dataset". That is ONE FACT
// described by TWO SENTENCES, and which sentence a user read depended on which picker they
// happened to open — the discrepancy carries no information, so it can only mislead.
//
// The surfaces do NOT share a grouping function, and deliberately so: the two pickers key
// on the derived LINEAGE (`source_dataset_id`) while the pane keys on the storage SCOPE
// (`dataset_id`), and they order their groups differently (arrival order vs alpha-with-
// orphans-last). Those are real, argued differences. The WORDS are not — so the words, and
// only the words, live here.
//
// ## Why not "No source dataset"
//
// It describes the absence of a field rather than the artifact. A user reading a picker is
// not looking at a null column, they are looking at a thing that exists and came from
// somewhere — and "somewhere" is: a run in this project made it. The chosen sentence says
// that. It is also the sentence two of the three surfaces already used, so unifying on it
// changed the fewest words a user reads.

/**
 * What a group of artifacts with no dataset is called.
 *
 * Named rather than left blank: both keys these surfaces group on are nullable, so an
 * unlabelled group is a state users actually meet — and an unlabelled group reads as a
 * rendering bug. It says what those artifacts ARE (a run in this project produced them),
 * not merely that a field is absent.
 */
export const PROJECT_PRODUCED_LABEL = 'Produced in this project'

/**
 * What ONE artifact's dataset is called, given whatever the row carried.
 *
 * The single derivation of that string, because a group HEADING and a SELECTED display are
 * the same fact about the same artifact seen twice: a user who picks "expression" under
 * "Batch A" must read "Batch A" back afterwards. Two copies of the rule drift the moment
 * one learns about a new fallback, and the drift is invisible — both look like a name.
 *
 * The id fallback is load-bearing, not defensive. `id` and `name` are independently
 * nullable, so an artifact WITH a dataset whose name did not travel is representable; if
 * that row fell into the no-dataset bucket it would be told {@link PROJECT_PRODUCED_LABEL},
 * which for it is not vague but FALSE — it did come from a dataset. What is known beats
 * blank, so the id titles the group.
 */
export function sourceDatasetLabel(
  datasetId: string | null | undefined,
  datasetName: string | null | undefined,
): string {
  if (datasetId) return datasetName ?? datasetId
  // A name with no id still names a dataset; only "neither" is the ungrouped bucket.
  return datasetName ?? PROJECT_PRODUCED_LABEL
}

// ---------------------------------------------------------------------------
// MULTI-SOURCE — an artifact can come from more than one dataset
// ---------------------------------------------------------------------------
//
// An artifact produced by INTEGRATING two datasets is of BOTH. The wire used to answer
// "which dataset?" with the first-declared one, so an integration of Dataset 1 and
// Dataset 2 read as "Dataset 1" — confidently, and decided by nothing but the order the
// producing run happened to record its input edges. A position is not an identity.
//
// The wire now carries the SET (`source_dataset_ids`) and keeps the singular pair
// (`source_dataset_id`/`_name`) as an exactly-one convenience that is NULL when there
// are several. So every reader here must go through the set: reading the singular field
// alone would file a two-source artifact under "no dataset", which is a different wrong
// answer, not a fix.

/** The nullable lineage fields any catalog-ish row may carry (structural, so both the
 *  workbench `ArtifactRow` and the workstore pane row satisfy it without importing a type
 *  from the other module). */
export interface SourceDatasetCarrier {
  source_dataset_ids?: readonly string[] | null
  source_dataset_names?: readonly string[] | null
  source_dataset_id?: string | null
  source_dataset_name?: string | null
}

/**
 * EVERY dataset a row derives from, in the order the server derived them.
 *
 * The singular fallback is not defensive padding: the project OVERVIEW endpoint cannot
 * carry the derived lineage at all, and older/other row sources may carry only the
 * singular pair. A row with the arrays absent but a singular id present is a genuine
 * single-source row and must read as one.
 */
export function sourceDatasetIds(row: SourceDatasetCarrier): readonly string[] {
  const ids = row.source_dataset_ids
  if (ids && ids.length > 0) return ids
  return row.source_dataset_id ? [row.source_dataset_id] : []
}

/** The display names a row carries for its sources (may be shorter than the id list — a
 *  deleted dataset contributes no name — so never index-pair the two). */
export function sourceDatasetNames(row: SourceDatasetCarrier): readonly string[] {
  const names = row.source_dataset_names
  if (names && names.length > 0) return names
  return row.source_dataset_name ? [row.source_dataset_name] : []
}

/**
 * What a row's dataset provenance is CALLED, for a heading or a selected-value caption.
 *
 * One source reads exactly as it always did ({@link sourceDatasetLabel}). Several read as
 * a statement that there are several — never as one of them. Two are both named, because
 * "Batch A + Batch B" is the whole fact and it still fits; beyond two the tail is elided
 * with a COUNT rather than dropped, so a user can always tell "one dataset" from "more
 * than I am being shown", which is the distinction the old shape destroyed.
 */
export function sourceDatasetsLabel(row: SourceDatasetCarrier): string {
  const ids = sourceDatasetIds(row)
  const names = sourceDatasetNames(row)
  if (ids.length <= 1) return sourceDatasetLabel(ids[0] ?? null, names[0] ?? null)
  // Name what is nameable; an id whose dataset was deleted still counts toward the total.
  const shown = names.length > 0 ? names : ids
  if (shown.length === 2 && shown.length === ids.length) return `${shown[0]} + ${shown[1]}`
  return `${shown[0]} + ${ids.length - 1} more`
}

/**
 * The stable grouping/uniqueness key for a row's dataset provenance.
 *
 * The SET is the key, not a member of it: an integration of A and B belongs to neither A's
 * group nor B's, and filing it under either is the collapse this module exists to refuse.
 * It gets its own group, whose heading {@link sourceDatasetsLabel} names honestly. Ids are
 * joined in derivation order — two artifacts integrating the same datasets in the same
 * order group together, which is the only equality anyone can act on.
 */
export function sourceDatasetGroupKey(row: SourceDatasetCarrier): string {
  return sourceDatasetIds(row).join(' ')
}

/**
 * Do these two rows share ANY source dataset?
 *
 * The scoping predicate, and deliberately an INTERSECTION rather than an equality. Scalar
 * equality on the old singular field silently scoped an integrated anchor to whichever
 * source was declared first: every sibling belonging to the OTHER source vanished from
 * dependent pickers with nothing to show it had happened. For a single-source row on both
 * sides this is byte-for-byte the old comparison; it only differs where the old one lied.
 * An empty set on either side shares nothing — "unknown" is not a match.
 */
export function sharesSourceDataset(a: SourceDatasetCarrier, b: SourceDatasetCarrier): boolean {
  const left = sourceDatasetIds(a)
  if (left.length === 0) return false
  const right = new Set(sourceDatasetIds(b))
  return left.some(id => right.has(id))
}
