/**
 * txrintake — the screen-A ready-made model count: `GET /api/txr/pretrained`
 * (the pretrained catalogue's list, `PretrainedListResponse`), the card
 * reads how many models it has.
 *
 * The Start page's first card ("Predict with a ready-made model") is the
 * recommended way in only when the TxResBench team has released at least
 * one ready-made model. While the catalogue is empty the card drops its
 * "Recommended to start" badge and says that none are released yet; the
 * badge comes back by itself once the catalogue has a model.
 *
 * Fetch semantics: the catalogue can change while the app runs (the boot
 * refresh may replace the embedded copy with a live one), so every mount
 * asks again; the last settled count (the module's fetch cache) renders on
 * the first frame of a revisiting mount, so A → N → A does not flash the
 * badge away and back. Two mounts that arrive together share one request.
 *
 * Failure is graceful on purpose: `count: null` (loading or failed) shows
 * neither the badge nor the "none released" note.
 */
import { useEffect, useState } from 'react'
import { ApiClient } from '@/api-client'
import type { PretrainedListResponse } from '@/api-client/types'
import { dropCached, fetchCached, readCached } from './fetchCache'

export interface UseReadyMadeModelCountResult {
  /** How many ready-made models the catalogue has; `null` while loading or after a failure. */
  count: number | null
}

/** The fetch-cache key of the catalogue list (the count's source). */
export const READY_MADE_COUNT_KEY = 'pretrained:list'

export function useReadyMadeModelCount(): UseReadyMadeModelCountResult {
  const cached = readCached<PretrainedListResponse>(READY_MADE_COUNT_KEY)
  const [count, setCount] = useState<number | null>(cached?.models.length ?? null)

  useEffect(() => {
    let cancelled = false
    // Ask again on every mount: a settled value is only the first frame's.
    if (readCached<PretrainedListResponse>(READY_MADE_COUNT_KEY) !== undefined) {
      dropCached(READY_MADE_COUNT_KEY)
    }
    // `async`: a request that throws before it starts is a failure too (count: null).
    void fetchCached(READY_MADE_COUNT_KEY, async () => ApiClient.Pretrained.listModels())
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
