/**
 * txrrun — the About-dialog data hook (PROV-UI-RUN-4's `TxrAboutDialog`
 * source, CONS-UI-RUN-5; ITEM-4).
 *
 * The row's "About" opens the method's detail card; the card's facts
 * (description, software, licence, references, params, timing, performance)
 * are the method catalogue's OWN payload — `ApiClient.MethodCatalogue.detail`
 * (PROV-MC-3), never a re-derived view: this hook fetches the generated
 * `Method` and the dialog renders its fields, nothing is rebuilt here.
 *
 * Error semantics (TEST-RUN-08):
 *
 * - a `404` (the engine's `METHOD_NOT_FOUND` — a method id the catalogue no
 *   longer serves, or a stale row from an older catalogue snapshot) maps to
 *   the `'not-found'` state, which the dialog renders as the module's
 *   `METHOD_NOT_FOUND_LINE` — never a blank card, never a crash;
 * - any other failure is `'network'` (the dialog's error+retry line);
 * - the effect's promise is always caught — a rejection cannot escape as an
 *   unhandled promise rejection;
 * - the id is part of the request key: a changed id resets the previous
 *   method's detail (the dialog is single-method; a stale detail must never
 *   render under a new id), and a `null` id is the closed state (no call).
 * - `retry()` re-issues the fetch for the id; the epoch guard discards an
 *   older response resolving after the retry's (or after an id change).
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

export type TxrMethodDetailError = 'not-found' | 'network' | null

/**
 * The About card's fallback line: the catalogue answered 404 — the method
 * no longer exists, but the card never renders blank.
 */
export const METHOD_NOT_FOUND_LINE = 'This method is no longer in the catalogue.'

export interface UseMethodDetailResult {
  /** The catalogue's `Method` payload, `null` while loading / on error. */
  detail: Method | null
  /** True while the fetch is in flight. */
  loading: boolean
  /** The failure class; `'not-found'` is 404 (METHOD_NOT_FOUND), `'network'`
   *  any other failure. `null` when healthy. */
  error: TxrMethodDetailError
  /** Re-issue the fetch for the current id. */
  retry(): void
}

export function useMethodDetail(id: string | null): UseMethodDetailResult {
  const [detail, setDetail] = useState<Method | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<TxrMethodDetailError>(null)
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
