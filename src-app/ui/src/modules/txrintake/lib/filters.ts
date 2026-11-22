/**
 * txrintake study-answer → method-filter builder (step2-filters).
 *
 * The server's eligibility endpoints read the three answered study facts as
 * METHOD FILTERS (`MethodFilters`, the wire spelling — every field optional,
 * an absent answer means "any"):
 *
 * - the preview body carries them flattened at the top level
 *   (`PreviewEligibilityRequest.disease_group` / `treatment_classes` /
 *   `method_group`);
 * - the inventory body carries them as one `filters` block
 *   (`InventoryEligibilityRequest.filters`).
 *
 * ONE builder produces the SAME three fields for both (and one
 * `outcomeToMethodGroup` mapping keeps the board's outcome pills ↔ the
 * method rows' `group` enum in one place):
 *
 * - `binary-response`     → `response-call`
 * - `response-probability`→ `response-probability`
 * - `progression-by-day`  → `static-risk`
 * - `dynamic-risk`        → `dynamic-risk`
 *
 * Rule (shared by both request shapes): an unanswered field is OMITTED —
 * never `null`, never an empty list, never the board's first option. The
 * store's "no filter" spellings (`disease: null`, `treatments: null`/`[]`)
 * are exactly the omission cases.
 */
import type { FilterOptions, MethodFilters, MethodGroup } from '@/api-client/types'
import type { OutcomeId, StudyAnswers } from '../types'

/** The module-level fetch-cache key of the ONE filter-options response
 *  (`data/fetchCache.ts` — shared by `data/useFilterOptions.ts` and the
 *  `intake.setStudyAnswers` action, so a human-cached vocabulary and the
 *  AI path read the same bytes). */
export const FILTER_OPTIONS_CACHE_KEY = 'filter-options:all'

/** The outcome pill → the method rows' `group` enum (one mapping, both
 *  request shapes read it). */
export function outcomeToMethodGroup(outcome: OutcomeId): MethodGroup {
  switch (outcome) {
    case 'binary-response':
      return 'response-call'
    case 'response-probability':
      return 'response-probability'
    case 'progression-by-day':
      return 'static-risk'
    case 'dynamic-risk':
      return 'dynamic-risk'
  }
}

/**
 * The ONE builder: the study answers' three filter facts, answered fields
 * only. `{}` when nothing is answered — a host then omits the whole block
 * (a request without it is exactly the "no filter" verdicts).
 *
 * The vocabulary (step2-filters, 5a3): the answers' ids are only valid
 * against the CURRENT `filter_options` vocabulary — a stale persisted id
 * would 422 the server (`UNKNOWN_DISEASE_GROUP` / `UNKNOWN_TREATMENT_CLASS`),
 * so the builder keeps only the ids that ARE in it (the disease node and
 * each treatment class). While the vocabulary is NOT loaded (`null`), the
 * disease and treatment fields are OMITTED too — the server reads an
 * absent field as "any", and an unvalidatable answer is never sent as a
 * guess; the outcome is independent of the vocabulary and is still sent.
 */
export function buildMethodFilters(
  answers: StudyAnswers,
  vocabulary: FilterOptions | null,
): MethodFilters {
  const filters: MethodFilters = {}
  if (vocabulary !== null) {
    const diseaseIds = filterOptionsDiseaseIds(vocabulary)
    if (answers.disease !== null && diseaseIds.has(answers.disease)) {
      filters.disease_group = answers.disease
    }
    const treatmentIds = filterOptionsTreatmentIds(vocabulary)
    const treatments = (answers.treatments ?? []).filter(id => treatmentIds.has(id))
    if (treatments.length > 0) filters.treatment_classes = treatments
  }
  if (answers.outcome !== null) filters.method_group = outcomeToMethodGroup(answers.outcome)
  return filters
}

/** Whether the builder produced any filter fact (the host's omission gate:
 *  `{}` means "no filter" and the block itself is left off the request). */
export function hasMethodFilters(filters: MethodFilters): boolean {
  return Object.keys(filters).length > 0
}

/** Every disease node id of the vocabulary (the category ids, the disease
 *  ids and each disease's child sub-group ids) — the set a `disease_group`
 *  answer must belong to (`UNKNOWN_DISEASE_GROUP` otherwise). */
export function filterOptionsDiseaseIds(vocab: Pick<FilterOptions, 'disease_categories'>): Set<string> {
  const ids = new Set<string>()
  for (const category of vocab.disease_categories) {
    ids.add(category.id)
    for (const disease of category.diseases) {
      ids.add(disease.id)
      for (const child of disease.children) ids.add(child)
    }
  }
  return ids
}

/** Every base treatment-class id of the vocabulary — the set a
 *  `treatment_classes` answer must belong to (`UNKNOWN_TREATMENT_CLASS`
 *  otherwise). */
export function filterOptionsTreatmentIds(vocab: Pick<FilterOptions, 'treatment_classes'>): Set<string> {
  return new Set(vocab.treatment_classes.map(treatment => treatment.id))
}
