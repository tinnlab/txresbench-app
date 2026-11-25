/**
 * txrintake — the screen-A predict-model counts (`usePredictModelCounts`),
 * the ONE counts source of the two Start cards (round 1 of the
 * predict-card merge).
 *
 * The two cards decide their state ("some model exists" vs "no model
 * anywhere") from three counts:
 *
 * - `lab` — the ready-made catalogue size (`GET /api/txr/pretrained`;
 *   `useReadyMadeModelCount`'s fetch);
 * - `saved` — store models with `provenance: 'run'` (`GET /api/txr/models`;
 *   `useSavedModelCount`'s fetch);
 * - `imported` — store models with `provenance: 'imported'` (same response).
 *
 * The bug fixed here: `useSavedModelCount` counts EVERY store row, so a
 * downloaded lab model (`provenance: 'pretrained'`) counted as "saved".
 * The counts hook filters by provenance: `pretrained` is NOT saved.
 *
 * Fetch semantics are the two hooks' (both are still the implementations
 * of the wire reads — the same `fetchCached` keys, so the Start page's
 * hooks and any other reader of the two keys share one request): every
 * mount asks again, the last settled cached value renders on the first
 * frame of a revisiting mount, and two mounts that arrive together share
 * one request.
 *
 * Failure is graceful on purpose: a failed fetch yields `null` for that
 * count and `failed: true` — the cards must never show the "no model
 * anywhere" state over a failed read (`null` is never displayed as zero).
 */
import { useEffect, useState } from 'react'
import { ApiClient } from '@/api-client'
import type { ModelListResponse, PretrainedListResponse } from '@/api-client/types'
import { dropCached, fetchCached, readCached } from './fetchCache'
import { READY_MADE_COUNT_KEY } from './useReadyMadeModelCount'
import { SAVED_COUNT_KEY } from './useSavedModelCount'

export interface UsePredictModelCountsResult {
  /** How many ready-made models the lab catalogue has; `null` while loading or after a failure. */
  lab: number | null
  /** How many models saved from this device's runs; `null` while loading or after a failure. */
  saved: number | null
  /** How many models opened from a `.txr` file; `null` while loading or after a failure. */
  imported: number | null
  /** True once EITHER fetch has failed — a failed count is never shown as zero. */
  failed: boolean
  /** True once THIS mount's own fetches have settled (round-1 audit item
   *  6): the first frame of a revisit is seeded from the cache, so a
   *  cached 0 must not flash the "no model anywhere" state before the
   *  mount's own answers land. */
  settled: boolean
}

/** The `provenance === 'run'` count of the store's list response. */
function countOf(provenance: ModelListResponse['models'][number]['provenance'], models: ModelListResponse['models']): number {
  return models.filter(model => model.provenance === provenance).length
}

export function usePredictModelCounts(): UsePredictModelCountsResult {
  // The settled caches render on the first frame of a revisiting mount (the
  // two existing hooks' rule); each count starts null when there is none.
  const cachedPretrained = readCached<PretrainedListResponse>(READY_MADE_COUNT_KEY)
  const cachedModels = readCached<ModelListResponse>(SAVED_COUNT_KEY)
  const [lab, setLab] = useState<number | null>(cachedPretrained?.models.length ?? null)
  const [saved, setSaved] = useState<number | null>(
    cachedModels === undefined ? null : countOf('run', cachedModels.models),
  )
  const [imported, setImported] = useState<number | null>(
    cachedModels === undefined ? null : countOf('imported', cachedModels.models),
  )
  const [labFailed, setLabFailed] = useState(false)
  const [modelsFailed, setModelsFailed] = useState(false)
  const [labSettled, setLabSettled] = useState(false)
  const [modelsSettled, setModelsSettled] = useState(false)

  useEffect(() => {
    let cancelled = false
    // Ask again on every mount: a settled value is only the first frame's.
    if (readCached<PretrainedListResponse>(READY_MADE_COUNT_KEY) !== undefined) {
      dropCached(READY_MADE_COUNT_KEY)
    }
    if (readCached<ModelListResponse>(SAVED_COUNT_KEY) !== undefined) {
      dropCached(SAVED_COUNT_KEY)
    }
    void fetchCached(READY_MADE_COUNT_KEY, async () => ApiClient.Pretrained.listModels())
      .then(response => {
        if (!cancelled) setLab(response.models.length)
      })
      .catch(() => {
        if (!cancelled) {
          setLab(null)
          setLabFailed(true)
        }
      })
      .finally(() => {
        if (!cancelled) setLabSettled(true)
      })
    void fetchCached(SAVED_COUNT_KEY, async () => ApiClient.Models.listModels({}))
      .then(response => {
        if (cancelled) return
        setSaved(countOf('run', response.models))
        setImported(countOf('imported', response.models))
      })
      .catch(() => {
        if (!cancelled) {
          setSaved(null)
          setImported(null)
          setModelsFailed(true)
        }
      })
      .finally(() => {
        if (!cancelled) setModelsSettled(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { lab, saved, imported, failed: labFailed || modelsFailed, settled: labSettled && modelsSettled }
}
