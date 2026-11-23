/**
 * txrmodels — screen J's model-sets read (`GET /api/txr/model-sets`,
 * PROV-MS-4): the section headers of the grouped inventory (the J page
 * groups the models by set and spells each section's facts line from the
 * `SetSummary` — model_count, source_label, created_at,
 * keep_training_files). One read per mount, epoch-guarded (a stale
 * resolve is discarded; unmount drops in-flight writes), `refresh()` as
 * the post-mutation re-read — the page refreshes the sets together with
 * the model list after import / rename / delete (a renamed model or an
 * import can grow a set).
 *
 * The J page's two reads race on mount (models + sets); the grouping
 * builder degrades to the rows' own facts while this response is `null`
 * (see `buildModelSetSections`), so a slow sets read never flashes the
 * inventory into "Not in a set". `error` is the transport message (the
 * page keeps the degraded grouping — the models list is the honest truth;
 * a failed secondary read is not worth an error line over live rows).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiClient } from '@/api-client'
import type { ModelSetListResponse } from '@/api-client/types'

/** The one failure line (the transport's message, else this constant). */
const SETS_FAILED_LINE = 'The model sets could not be loaded.'

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (
    err !== null &&
    typeof err === 'object' &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message
  }
  return SETS_FAILED_LINE
}

export interface UseModelSetsResult {
  /** The provider's set list payload; `null` until the first response. */
  response: ModelSetListResponse | null
  /** True while a read is in flight. */
  loading: boolean
  /** The read failure line; `null` when healthy. */
  error: string | null
  /** Re-issue the read (the post-mutation refresh with the model list). */
  refresh: () => void
}

export function useModelSets(): UseModelSetsResult {
  const [response, setResponse] = useState<ModelSetListResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const epoch = useRef(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    const requestEpoch = (epoch.current += 1)
    setLoading(true)
    setError(null)
    ApiClient.ModelSets.listSets()
      .then((res: ModelSetListResponse) => {
        if (!alive.current || epoch.current !== requestEpoch) return
        setResponse(res)
        setLoading(false)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!alive.current || epoch.current !== requestEpoch) return
        // The last response stays (the section facts never blink away;
        // a failed first read keeps the rows' own-facts grouping).
        setLoading(false)
        setError(errorMessage(err))
      })
  }, [tick])

  /** Re-issue the read; a stable identity (the post-mutation refresh with
   *  the model list — the page's refresh useCallback depends on it). */
  const refresh = useCallback((): void => {
    setTick(t => t + 1)
  }, [])

  return {
    response,
    loading,
    error,
    refresh,
  }
}
