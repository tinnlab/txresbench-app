/**
 * txrlist method-card detail hook (qa-fixes3 ITEM-1) — the in-place About
 * disclosure's data source (a single `GET /api/methods/{id}` per opened
 * disclosure, the provider's own payload — the same class as the D/I model
 * cards: the consumer renders, the provider owns the facts).
 *
 * Semantics (the module's fetch discipline):
 * - no request, no stale detail while the disclosure is closed (`id`
 *   `null` — the same closed-state rule as the module's other hooks);
 * - the effect's promise is always caught; a `404` (a stale row whose
 *   method the catalogue no longer serves) maps to the `'not-found'` state
 *   rendered as the constant line — never blank, never a crash;
 * - `retry()` re-issues the fetch; the epoch guard discards an older
 *   response resolving after the retry's or after an id change.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiClient } from '@/api-client'
import type { Method } from '@/api-client/types'

/** The wire-status reader (the framework transport attaches `status`). */
const statusOf = (err: unknown): number | null =>
  err !== null &&
  typeof err === 'object' &&
  'status' in err &&
  typeof (err as { status: unknown }).status === 'number'
    ? (err as { status: number }).status
    : null

/** The 404's stable machine code (PROV-MC-3's `METHOD_NOT_FOUND`). */
const NOT_FOUND_STATUS = 404

/** The disclosure's fallback line: the catalogue answered 404 — the method
 *  no longer exists, but the disclosure never renders blank. */
export const METHOD_NOT_FOUND_LINE = 'This method is no longer in the catalogue.'

export type TxrMethodCardDetailError = 'not-found' | 'network' | null

export interface UseMethodCardDetailResult {
  /** The catalogue's `Method` payload, `null` while loading / on error. */
  detail: Method | null
  /** True while the fetch is in flight. */
  loading: boolean
  /** The failure class; `'not-found'` is 404 (METHOD_NOT_FOUND), `'network'`
   *  any other failure. `null` when healthy. */
  error: TxrMethodCardDetailError
  /** Re-issue the fetch for the current id. */
  retry(): void
}

export function useMethodCardDetail(id: string | null): UseMethodCardDetailResult {
  const [detail, setDetail] = useState<Method | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<TxrMethodCardDetailError>(null)
  const [tick, setTick] = useState(0)
  const epoch = useRef(0)

  useEffect(() => {
    if (id === null) {
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
    ApiClient.MethodCatalogue.detail({ method_id: id })
      .then((method: Method) => {
        if (epoch.current !== requestEpoch) return
        setDetail(method)
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
