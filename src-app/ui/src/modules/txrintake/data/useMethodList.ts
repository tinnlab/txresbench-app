/**
 * txrintake — the runnable method summaries for screen B's single-marker
 * facts (single-marker-choice round 2): `GET /api/methods?runnable=true` →
 * the catalogue rows the preview's verdicts came from (the preview serves
 * only runnable methods), joined by id with the panel's verdicts to find the
 * methods that fit with no fixed marker list.
 *
 * Same fetch semantics as `useRunnableMethodCount` — the SAME stable cache
 * key, so the two reads share one request per catalogue (the count reads
 * `total`, this hook reads `methods`); a failed fetch is never cached and
 * degrades to `methods: []` (the step-3 group then simply does not show —
 * the honest no-answer state, never a crash or a guessed kind).
 */
import { useEffect, useState } from 'react'
import { ApiClient } from '@/api-client'
import type { MethodListResponse, MethodSummary } from '@/api-client/types'
import { useMethodListRevision } from '@/lib/txr-method-list/revision'
import { RUNNABLE_COUNT_KEY } from './useRunnableMethodCount'
import { fetchCached, readCached } from './fetchCache'

export interface UseMethodListResult {
  /** The runnable catalogue rows (empty while loading or after a failure). */
  methods: MethodSummary[]
  /** True from the first mount until the list lands. */
  loading: boolean
  /** The fetch failure message, `null` when healthy. */
  error: string | null
}

export function useMethodList(): UseMethodListResult {
  const cached = readCached<MethodListResponse>(RUNNABLE_COUNT_KEY)
  const [methods, setMethods] = useState<MethodSummary[]>(cached?.methods ?? [])
  const [loading, setLoading] = useState(cached === undefined)
  const [error, setError] = useState<string | null>(null)
  // A new method list drops the cached rows and moves the revision: the
  // summaries are fetched again (the same drop the count hook reads).
  const revision = useMethodListRevision()

  useEffect(() => {
    let cancelled = false
    // The request runs inside a promise tick: a missing/broken client method
    // (the page tests mock only the routes they use) rejects like a fetch
    // failure instead of throwing synchronously through the effect.
    const request = (): Promise<MethodListResponse> =>
      Promise.resolve().then(() => ApiClient.MethodCatalogue.list({ runnable: true }))
    void fetchCached(RUNNABLE_COUNT_KEY, request)
      .then(response => {
        if (cancelled) return
        setMethods(response.methods)
        setLoading(false)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setMethods([])
        setLoading(false)
        setError(err instanceof Error ? err.message : 'Failed to load the method list')
      })
    return () => {
      cancelled = true
    }
  }, [revision])

  return { methods, loading, error }
}
