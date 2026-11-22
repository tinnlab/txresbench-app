import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { ApiClient } from '@/api-client'
import type { FilterOptions } from '@/api-client/types'
import { defineAction } from '../defineAction'
import { TxrIntake, useTxrIntakeStore } from '@/modules/txrintake/stores/TxrIntake.store'
import {
  FILTER_OPTIONS_CACHE_KEY,
  filterOptionsDiseaseIds,
  filterOptionsTreatmentIds,
} from '@/modules/txrintake/lib/filters'
import { fetchCached } from '@/modules/txrintake/data/fetchCache'

// The screen-B answers, as the AI sees them (step2-filters): the disease
// node, the ticked treatment classes and the outcome pill are the method
// filters the server applies, so the action that sets them validates the ids
// against the SAME vocabulary the human pickers read before writing the
// store — an unknown id is refused plainly (the server would refuse it with
// a 422 `UNKNOWN_DISEASE_GROUP` / `UNKNOWN_TREATMENT_CLASS`, never a silent
// "any").
//
// `intake.setStudyAnswers` is a GLOBAL action (the answers live in the ONE
// global intake store — there is no per-instance target), `mutating: true`,
// and delegates to the store's `patchStudy` — the same mutation a human
// click performs, so the palette and the AI drive exactly the
// person's affordance (no second implementation).
//
// Only the fields PRESENT in the call are written (a nullable
// `disease_group` / `outcome` writes unanswered, an absent field leaves the
// answer untouched — the caller composes a partial patch); the result
// reports the STORE's fields after the patch (an omitted field is returned
// as it stands, never as a guessed default). Treatment ids are
// de-duplicated (first-seen order) before they are written and checked.
// The vocabulary is loaded and consulted ONLY when `disease_group` or
// `treatment_classes` is in the call: an outcome-only patch must not be
// blocked by a filter-options fetch failure (5a3).
//
// Sole runtime import site: `src/modules/txrintake/module.tsx`.

/** The refusal when the vocabulary cannot be reached (the ids must be
 *  checked against the real catalogue before they are written). */
export const FILTER_OPTIONS_UNREACHABLE =
  'The method list could not be checked. Try again when it has loaded.'

/** ONE unknown-id refusal, naming the id. */
function unknownDiseaseError(id: string): Error {
  return new Error(`"${id}" is not a disease of the method list.`)
}

function unknownTreatmentError(id: string): Error {
  return new Error(`"${id}" is not a treatment of the method list.`)
}

/** The loaded filter options (the cache when a screen already fetched them,
 *  the wire otherwise — one request per catalogue per session). */
function loadFilterOptions(): Promise<FilterOptions> {
  return fetchCached(FILTER_OPTIONS_CACHE_KEY, () => ApiClient.MethodCatalogue.filterOptions())
}

defineAction({
  id: 'intake.setStudyAnswers',
  title: 'Set the study answers',
  permission: Permissions.McpUse,
  mutating: true,
  group: 'Analysis',
  description:
    "Set the answers of the questions step of a new analysis: the disease, the treatments and what to predict. They are the method filters — an answered disease or treatment tick excludes methods not made for it. An id the method list does not know is refused. Omit a field to leave it as it is; send null (or an empty list) to clear it.",
  aliases: ['set the disease', 'set the treatment', 'set what to predict', 'answer the questions'],
  keywords: ['filters', 'disease', 'treatment', 'outcome'],
  params: z.object({
    disease_group: z
      .string()
      .min(1)
      .nullish()
      .describe('A disease id of the method list (a category, a disease or a sub-group), or null to clear it.'),
    treatment_classes: z
      .array(z.string())
      .optional()
      .describe('The ticked treatment-class ids of the method list (an empty list clears the tick).'),
    outcome: z
      .enum(['binary-response', 'response-probability', 'progression-by-day', 'dynamic-risk'])
      .nullish()
      .describe('The outcome pill: binary-response, response-probability, progression-by-day or dynamic-risk; null clears it.'),
  }),
  run: async ({ disease_group, treatment_classes, outcome }) => {
    // The id validation needs the vocabulary; an outcome-only patch does not
    // (5a3): a failed filter-options fetch must not block the outcome pills,
    // so the vocabulary is loaded and checked only when a disease or
    // treatment answer is being written.
    const idNeedsVocabulary = disease_group !== undefined || treatment_classes !== undefined
    if (idNeedsVocabulary) {
      const vocabulary = await loadFilterOptions().catch(() => {
        throw new Error(FILTER_OPTIONS_UNREACHABLE)
      })
      const diseaseIds = filterOptionsDiseaseIds(vocabulary)
      const treatmentIds = filterOptionsTreatmentIds(vocabulary)
      if (disease_group !== undefined && disease_group !== null && !diseaseIds.has(disease_group)) {
        throw unknownDiseaseError(disease_group)
      }
      if (treatment_classes !== undefined) {
        const unknown = treatment_classes.find(id => !treatmentIds.has(id))
        if (unknown !== undefined) throw unknownTreatmentError(unknown)
      }
    }
    const patch: {
      disease?: string | null
      treatments?: string[] | null
      outcome?: 'binary-response' | 'response-probability' | 'progression-by-day' | 'dynamic-risk' | null
    } = {}
    if (disease_group !== undefined) patch.disease = disease_group === null ? null : disease_group
    if (treatment_classes !== undefined) {
      // De-duplicate the ids, keep the first-seen order (a repeated id in the
      // call writes it once — the server's set is the same either way).
      const seen = new Set<string>()
      const unique: string[] = []
      for (const id of treatment_classes) {
        if (!seen.has(id)) {
          seen.add(id)
          unique.push(id)
        }
      }
      patch.treatments = unique.length > 0 ? unique : null
    }
    if (outcome !== undefined) patch.outcome = outcome === null ? null : outcome
    TxrIntake.patchStudy(patch)
    // The return is the store's state AFTER the patch (5a3): a field that
    // was omitted is reported as it stands, never as a guessed default.
    const after = useTxrIntakeStore.getState().study
    return {
      disease_group: after.disease,
      treatment_classes: after.treatments ?? [],
      outcome: after.outcome,
    }
  },
})
