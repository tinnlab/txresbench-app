/**
 * txrlist bottom-bar estimate hook — PROV-UI-LIST-3.
 *
 * `useListEstimate(ids, opts)` drives the bottom-bar total: the selection
 * changes are DEBOUNCED 250 ms, then ONE `POST /api/methods/estimate`
 * (`ApiClient.MethodCatalogue.estimate` — the generated client only, so the
 * network-allowlist guard stays green, INV-4) asks for the LPT-packed
 * schedule total (`schedule_seconds`; the row-level times come from the
 * eligibility verdicts, DEC-6 — no per-row estimate calls).
 *
 * Hook semantics:
 *
 * - Keyed on the SELECTED SET (sorted ids + patients/cpus/at_atime — the
 *   estimate is a function of all four): a re-render with the same set does
 *   not re-issue the request, and re-selecting a set whose estimate is
 *   cached restores it with no request at all (the "estimate cache" the
 *   selection contract names — NOT cleared by an empty selection).
 * - `setTimeout` 250 ms per key change; the pending timer is cleared when
 *   the key changes again or the host unmounts, so a burst of selection
 *   changes costs one request.
 * - Stale-response guard: requests carry an epoch; only the newest epoch may
 *   write state — an older response resolving after a newer one is
 *   discarded (and cannot write after unmount).
 * - An empty selection or a failed call yields `null` totals (no request
 *   for an empty selection).
 */
import { useEffect, useRef, useState } from 'react'
import { ApiClient } from '@/api-client'
import type { EstimateResponse } from '@/api-client/types'

export interface UseListEstimateOptions {
  /** The inventory's patient count (the estimate's scale factor). */
  patients: number
  /** The lane count the run will use; defaults to 4 (PROV-MC-6 / DEC-7). */
  cpus?: number
  /** The run-N-at-a-time lanes the schedule is packed onto. */
  atATime: number
}

export interface UseListEstimateResult {
  /** The plain-sum total, `null` while loading / on error / for no selection. */
  totalSeconds: number | null
  /** The LPT schedule total (the bottom-bar "about X minutes"), `null` likewise. */
  scheduleSeconds: number | null
  /** True while an estimate request is in flight (the "…" slot). */
  loading: boolean
  /** The estimate failure message, `null` when healthy. */
  error: string | null
}

/** The per-set estimate cache entry (cached successes only). */
type EstimateCacheEntry = Pick<UseListEstimateResult, 'totalSeconds' | 'scheduleSeconds'>

const DEBOUNCE_MS = 250

/** The selection's set-key: ids sorted, so selection order never refetches. */
function selectionKey(ids: string[]): string {
  return [...ids].sort().join('\u0000')
}

/** The cache key: the selection set + the estimate's own arguments. */
function cacheKey(ids: string[], patients: number, cpus: number, atATime: number): string {
  return `${selectionKey(ids)}\u0000${patients}\u0000${cpus}\u0000${atATime}`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Failed to estimate methods'
}

export function useListEstimate(
  ids: string[],
  options: UseListEstimateOptions,
): UseListEstimateResult {
  const { patients, cpus = 4, atATime } = options
  const key = selectionKey(ids)
  const [state, setState] = useState<UseListEstimateResult>({
    totalSeconds: null,
    scheduleSeconds: null,
    loading: false,
    error: null,
  })
  const epoch = useRef(0)
  const cache = useRef(new Map<string, EstimateCacheEntry>())

  useEffect(() => {
    // Empty selection: null totals, no request, and the in-flight request's
    // epoch is invalidated (the "unchecking the last row" case — the cache
    // itself survives, so re-selecting the same set is served from it).
    if (ids.length === 0) {
      epoch.current += 1
      setState({ totalSeconds: null, scheduleSeconds: null, loading: false, error: null })
      return
    }

    const keyForArgs = cacheKey(ids, patients, cpus, atATime)
    const cached = cache.current.get(keyForArgs)
    if (cached !== undefined) {
      epoch.current += 1
      setState({ ...cached, loading: false, error: null })
      return
    }

    const requestEpoch = (epoch.current += 1)
    setState(prev => ({ ...prev, loading: true, error: null }))
    const timer = setTimeout(() => {
      void ApiClient.MethodCatalogue.estimate({
        method_ids: ids,
        patients,
        cpus,
        at_a_time: atATime,
      })
        .then((response: EstimateResponse) => {
          if (epoch.current !== requestEpoch) return
          cache.current.set(keyForArgs, {
            totalSeconds: response.total_seconds,
            scheduleSeconds: response.schedule_seconds,
          })
          setState({
            totalSeconds: response.total_seconds,
            scheduleSeconds: response.schedule_seconds,
            loading: false,
            error: null,
          })
        })
        .catch((err: unknown) => {
          if (epoch.current !== requestEpoch) return
          setState({
            totalSeconds: null,
            scheduleSeconds: null,
            loading: false,
            error: errorMessage(err),
          })
        })
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [key, patients, cpus, atATime])

  return state
}
