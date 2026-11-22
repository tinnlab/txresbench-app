/**
 * txrintake — the method filter-options vocabulary for screen B
 * (step2-filters): `GET /api/methods/filter-options` → `FilterOptions`
 * (`disease_categories[{ id, diseases[{ id, children[] }] }]`,
 * `treatment_classes[{ id, label }]`) — the node ids the disease/treatment
 * answers are picked from, and the label table for the treatment classes.
 *
 * The hook follows the `useMarkers` / `fetchCache.ts` pattern exactly (the
 * module's stable-key catalogue cache, ITEM-10): ONE static response per
 * catalogue, so a settled entry serves later mounts on the FIRST frame, two
 * concurrent mounts share one request, a rejection is never cached (the
 * next mount retries), `refetch()` drops the key and re-issues, and a new
 * method list drops the whole cache (fetchCache's `onMethodListChange`).
 *
 * The vocabulary is also the study answers' validity gate: the store's
 * `reconcileStudyWithVocabulary` drops an answer id the current vocabulary
 * does not know (the server would refuse it with a 422), so this hook calls
 * it on EVERY path that produces the vocabulary — the fetch-success branch
 * AND the settled-cache branch (a later mount of the same catalogue takes
 * the cache path, and a persisted id the catalogue meanwhile dropped must
 * be reconciled just the same). The loaded vocabulary object is exposed as
 * `vocabulary` (the study-answer filter builder reads it).
 */
import { useCallback, useEffect, useState } from 'react'
import { ApiClient } from '@/api-client'
import type { DiseaseCategory, FilterOptions, TreatmentClass } from '@/api-client/types'
import { useMethodListRevision } from '@/lib/txr-method-list/revision'
import { dropCached, fetchCached, readCached } from './fetchCache'
import { FILTER_OPTIONS_CACHE_KEY } from '../lib/filters'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'

export interface UseFilterOptionsResult {
  /** The loaded vocabulary's disease categories (each with its diseases +
   *  child sub-groups). */
  categories: DiseaseCategory[]
  /** The loaded vocabulary's base treatment classes (id + display label). */
  treatmentClasses: TreatmentClass[]
  /** The vocabulary object itself, `null` until it has loaded (or after a
   *  failed fetch — a failure is never cached, the next mount retries).
   *  The study-answer → filter-fact builder reads this: before it loads,
   *  the disease/treatment fields are OMITTED from requests (an
   *  unvalidatable answer is never sent as a guess), the outcome still is. */
  vocabulary: FilterOptions | null
  /** The display label of a treatment-class id (`undefined` before the
   *  vocabulary loads, or for an unknown id — the caller falls back to the
   *  id itself). */
  treatmentClassLabel: (id: string) => string | undefined
  /** True from the first mount until the vocabulary lands. */
  loading: boolean
  /** The fetch failure message, `null` when healthy. */
  error: string | null
  /** Re-fetch the vocabulary. */
  refetch: () => void
}

/** The error line for the fetch (the Datasets-store idiom). */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Failed to load the filter options'
}

export function useFilterOptions(): UseFilterOptionsResult {
  const cached = readCached<FilterOptions>(FILTER_OPTIONS_CACHE_KEY)
  const [vocabulary, setVocabulary] = useState<FilterOptions | null>(cached ?? null)
  const [loading, setLoading] = useState(cached === undefined)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  // A new method list drops the cache (fetchCache) and moves the revision:
  // the vocabulary is fetched again.
  const revision = useMethodListRevision()

  useEffect(() => {
    let cancelled = false
    const cached = readCached<FilterOptions>(FILTER_OPTIONS_CACHE_KEY)
    if (cached !== undefined) {
      setVocabulary(cached)
      setLoading(false)
      setError(null)
      // The cached branch is a vocabulary path too: a persisted answer id a
      // NEWER vocabulary no longer knows must be reconciled just the same
      // (the effect's fetch-success branch calls it; the cached branch is
      // what a later mount of the same catalogue takes, and 5a3's review
      // found it silently skipping the reconcile — a stale persisted id
      // then reached the server and 422'd).
      useTxrIntakeStore.getState().reconcileStudyWithVocabulary(cached)
      return
    }
    setVocabulary(null)
    setLoading(true)
    setError(null)
    void fetchCached(FILTER_OPTIONS_CACHE_KEY, () => ApiClient.MethodCatalogue.filterOptions())
      .then(response => {
        if (cancelled) return
        setVocabulary(response)
        setLoading(false)
        // The answers are only valid against the CURRENT vocabulary: an id
        // the catalogue dropped (or a stale persisted one) would 422, so it
        // is dropped to unanswered here. Idempotent.
        useTxrIntakeStore.getState().reconcileStudyWithVocabulary(response)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(errorMessage(err))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [refresh, revision])

  const refetch = useCallback(() => {
    dropCached(FILTER_OPTIONS_CACHE_KEY)
    setRefresh(count => count + 1)
  }, [])

  const treatmentClassLabel = useCallback(
    (id: string): string | undefined => vocabulary?.treatment_classes.find(treatment => treatment.id === id)?.label,
    [vocabulary],
  )

  return {
    categories: vocabulary?.disease_categories ?? [],
    treatmentClasses: vocabulary?.treatment_classes ?? [],
    vocabulary,
    treatmentClassLabel,
    loading,
    error,
    refetch,
  }
}
