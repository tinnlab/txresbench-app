/**
 * txrintake — the screen-A saved model count: `GET /api/txr/models` (the
 * model store's list, `ModelListResponse`, the same request the saved-models
 * screen makes), the "Use a model I saved" card reads how many there are.
 *
 * With none saved, the card says so and points at "Learn from my data"
 * (its button stays enabled: the saved-models step explains the empty list
 * too). Fetch semantics are the ready-made count's (`useReadyMadeModelCount`):
 * every mount asks again, the last settled count renders on the first frame
 * of a revisiting mount, and two mounts that arrive together share one
 * request. `count: null` (loading or failed) shows no note.
 */
import { useEffect, useState } from 'react'
import { ApiClient } from '@/api-client'
import type { ModelListResponse } from '@/api-client/types'
import { dropCached, fetchCached, readCached } from './fetchCache'

export interface UseSavedModelCountResult {
  /** How many models the user has saved; `null` while loading or after a failure. */
  count: number | null
}

/** The fetch-cache key of the saved-models list (the count's source). */
export const SAVED_COUNT_KEY = 'models:list'

export function useSavedModelCount(): UseSavedModelCountResult {
  const cached = readCached<ModelListResponse>(SAVED_COUNT_KEY)
  const [count, setCount] = useState<number | null>(cached?.models.length ?? null)

  useEffect(() => {
    let cancelled = false
    // Ask again on every mount: a settled value is only the first frame's.
    if (readCached<ModelListResponse>(SAVED_COUNT_KEY) !== undefined) {
      dropCached(SAVED_COUNT_KEY)
    }
    // `async`: a request that throws before it starts is a failure too (count: null).
    void fetchCached(SAVED_COUNT_KEY, async () => ApiClient.Models.listModels({}))
      .then(response => {
        if (!cancelled) setCount(response.models.length)
      })
      .catch(() => {
        if (!cancelled) setCount(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { count }
}
