/**
 * txrmodels — the I row's "Details" binding (ITEM-7; PROV-MS-2's
 * `GET /api/txr/models/{id}`, CONS-UM-4).
 *
 * `useModelDetail(id)` is the saved-model twin of `usePretrainedCard`
 * (ITEM-5): the per-id `ModelDetail` payload for the Details dialog,
 * fetched ON DEMAND — the I list is never N+1'd (an inventory row's
 * summary facts already render the row; the full record is the dialog's
 * on-demand read). One request per id, a `404` (the provider's
 * `MODEL_NOT_FOUND` — a row whose file vanished, or one the store no
 * longer serves) maps to the `'not-found'` error class the dialog renders
 * as its not-found state, any other failure to `'network'` (the dialog's
 * error + retry line), and a `null` id is the closed dialog (no request,
 * no stale detail). A changed id supersedes an older response (the
 * request-epoch guard — the `usePretrainedCard` discipline).
 *
 * The payload is the provider's generated type verbatim — the dialog
 * renders its blocks with the drift-guard reads (`?? null` on the
 * optional facts, model-store DEC-18) and the module's UNRECORDED
 * constant for a fact with no value; this layer's defensive duty is the
 * request side only.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiClient } from '@/api-client'
import type { ModelDetail } from '@/api-client/types'

/** The wire-status reader (the framework transport attaches `status`). */
const statusOf = (err: unknown): number | null =>
  err !== null &&
  typeof err === 'object' &&
  'status' in err &&
  typeof (err as { status: unknown }).status === 'number'
    ? (err as { status: number }).status
    : null

/** The 404's stable code (PROV-MS-2's `MODEL_NOT_FOUND`). */
const NOT_FOUND_STATUS = 404

/** The detail fetch's error class (the `usePretrainedCard` twin). */
export type TxrModelDetailError = 'not-found' | 'network' | null

export interface UseModelDetailResult {
  /** The model's full record, `null` while loading / on error / closed. */
  detail: ModelDetail | null
  /** True while the detail request is in flight. */
  loading: boolean
  /** The failure class: `'not-found'` is 404, `'network'` anything else. */
  error: TxrModelDetailError
  /** Re-issue the detail request for the current id. */
  retry: () => void
}

export function useModelDetail(id: string | null): UseModelDetailResult {
  const [detail, setDetail] = useState<ModelDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<TxrModelDetailError>(null)
  const [tick, setTick] = useState(0)
  const epoch = useRef(0)

  useEffect(() => {
    if (id === null) {
      // The closed dialog: no request, no stale detail.
      epoch.current += 1
      setDetail(null)
      setLoading(false)
      setError(null)
      return
    }
    const requestEpoch = (epoch.current += 1)
    setDetail(null)
    setLoading(true)
    setError(null)
    ApiClient.Models.getModel({ id })
      .then((record: ModelDetail) => {
        if (epoch.current !== requestEpoch) return
        setDetail(record)
        setLoading(false)
        setError(null)
      })
      .catch((err: unknown) => {
        if (epoch.current !== requestEpoch) return
        setDetail(null)
        setLoading(false)
        setError(statusOf(err) === NOT_FOUND_STATUS ? 'not-found' : 'network')
      })
  }, [id, tick])

  const retry = useCallback((): void => {
    setTick(count => count + 1)
  }, [])

  return { detail, loading, error, retry }
}
