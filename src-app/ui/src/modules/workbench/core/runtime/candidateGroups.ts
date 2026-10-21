// candidateGroups — an artifact picker offers a TREE, so it should render one.
//
// The data has always been a tree: a dataset holds artifacts. The picker flattened it into a
// list of strings and, when two happened to collide, appended the dataset name to the label —
// which said nothing in the common case and, in the collision case, put the distinguishing
// substring exactly where tail-truncation removes it.
//
// Grouping IS the disambiguation. It is applied ALWAYS, not on collision: a user with several
// datasets attached to a project needs to know which one an option came from whether or not
// another artifact happens to share its name, and a discriminator that appears only when the
// system notices a clash is one the user cannot rely on.

import { PROJECT_PRODUCED_LABEL, sourceDatasetsLabel } from '@/core/workstore'
import type { ArtifactRefCandidate } from './axisSource'

/**
 * What a group of artifacts with no source dataset is called — re-exported, NOT re-declared.
 *
 * Three surfaces group artifacts by dataset and a user must read one sentence for the bucket
 * with no dataset, so the words live once, in `@/core/workstore`. This alias keeps the name
 * this module's own readers and tests already use.
 */
export const UNGROUPED_LABEL = PROJECT_PRODUCED_LABEL

export interface CandidateGroup {
  /** The group's source datasets. Empty for the ungrouped bucket — the renderer decides how
   *  to title that. TWO entries for a group of artifacts that integrated two datasets: such
   *  a group is its OWN group, not a member of either source's, because the artifacts in it
   *  belong to both and filing them under one would pick a winner by declaration order. */
  datasetIds: readonly string[]
  /** The single source dataset, present only when the group has exactly one — kept so the
   *  existing renderers that key on a scalar id keep working for the unambiguous case. */
  datasetId?: string
  label: string
  candidates: ArtifactRefCandidate[]
}

/**
 * What ONE candidate's dataset is called.
 *
 * Exported, and the single derivation of that string: the group HEADING and the SELECTED
 * display are the same fact about the same artifact seen in two places, so a user who picks
 * "expression" under "Batch A" must read "Batch A" back afterwards. Two copies of this rule
 * drift the moment one of them learns about a new fallback, and the drift is invisible —
 * both look like a dataset name.
 *
 * The rule ITSELF is `sourceDatasetLabel` in `@/core/workstore`, shared with the other two
 * artifact-grouping surfaces; this only adapts a candidate to it. Falls back to the dataset
 * ID when the name is absent (what is known beats blank), and to {@link UNGROUPED_LABEL}
 * when there is no dataset at all.
 */
export function candidateDatasetLabel(c: ArtifactRefCandidate): string {
  return sourceDatasetsLabel({
    source_dataset_ids: c.datasetIds,
    source_dataset_names: c.datasetNames,
    source_dataset_id: c.datasetId,
    source_dataset_name: c.datasetName,
  })
}

/**
 * Group candidates by their source dataset, preserving the order candidates arrived in — both
 * the order of first appearance for the groups themselves and the order within each group.
 *
 * Deliberately NOT sorted: the resolver upstream already decided what order to offer things in
 * (recency, declaration order), and re-sorting here would silently override a decision made
 * with more context than this function has.
 *
 * A dataset with no NAME but a real id still forms its own group, titled by what is known. Two
 * datasets that share a name stay separate groups, because they are separate datasets — merging
 * them on a display string is the same class of error as telling two artifacts apart by one.
 */
export function groupCandidates(candidates: readonly ArtifactRefCandidate[]): CandidateGroup[] {
  const groups: CandidateGroup[] = []
  const byKey = new Map<string, CandidateGroup>()
  for (const c of candidates) {
    // The KEY is the whole source set. Two artifacts group together only if they came from
    // the SAME datasets — an integration of A+B is not an A artifact and not a B artifact.
    const ids = c.datasetIds ?? (c.datasetId ? [c.datasetId] : [])
    const key = ids.join(' ')
    let group = byKey.get(key)
    if (!group) {
      group = {
        datasetIds: ids,
        datasetId: ids.length === 1 ? ids[0] : undefined,
        label: candidateDatasetLabel(c),
        candidates: [],
      }
      byKey.set(key, group)
      groups.push(group)
    }
    group.candidates.push(c)
  }
  return groups
}

/**
 * Is grouping worth SHOWING? YES, wherever there is a group at all.
 *
 * ── This used to answer `groups.length > 1`, and that was an assistant's addition ────────
 *
 * The argument for it reads well: with every candidate under one heading the heading repeats a
 * constant, costs a line, and buries the choice. It is the same "print what distinguishes,
 * suppress what is constant" rule the rest of this pane applies — which is exactly why it
 * survived review.
 *
 * It is still wrong, twice over, and the owner said so twice (ledger #8: *"why there are no
 * header for Datasets?"*; #16: *"group them by datasets"* / *"didn't I tell you to group by
 * dataset?"*). A heading here is not a discriminator competing with the option labels — it is
 * the ANSWER TO "WHOSE DATA IS THIS", which a reader needs on a one-dataset project as much as
 * on a five-dataset one, and which is the only thing on the screen naming the population the
 * pane is about. And a discriminator that appears only when the system happens to notice a
 * clash is one the reader cannot rely on being there — the paragraph at the top of this file
 * already says grouping is applied ALWAYS, not on collision, and the suppression contradicted
 * its own module.
 *
 * `groups.length > 0` rather than a bare `true` so an EMPTY offer still draws nothing: a
 * heading over no options would be a claim about a dataset that contributed none.
 */
export function shouldShowGroups(groups: readonly CandidateGroup[]): boolean {
  return groups.length > 0
}
