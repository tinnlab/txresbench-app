/**
 * txrmodels — the J screen's inventory binding (ITEM-8; PROV-MS-2's
 * `GET /api/txr/models` with the server-side `q` search + the `?set=`
 * focus, CONS-UM-4).
 *
 * The J table is the third consumer of the models list (the I screen's
 * slice is the store's, loaded WITHOUT query filters — it owns the verdict
 * join); this hook is the J screen's own read: ONE request per
 * (debounced query, set focus) pair, the query debounced 250 ms (the
 * `useListEstimate` discipline — a burst of keystrokes costs one
 * round-trip), each response epoch-guarded (a stale resolve is discarded;
 * unmount cancels the pending timer and drops in-flight writes), and
 * `refresh()` as the post-mutation re-read (import/rename/delete tell the
 * store "the engine is the truth now — ask again").
 *
 * The optional-param rule: `q` is omitted from the wire body when empty
 * (the provider's substring filter; an empty `q` and an absent `q` are the
 * same read) and `set_id` is present exactly when the route carries the
 * `?set=` focus (DEC-19 — the provider filters, the URL is the view).
 * `models_dir` votes once per response — never per row — and a response
 * that has not arrived yet (or a failed first read) renders the pathless
 * footnote (DEC-11's drift-guard: the field is optional on the generated
 * shape, `?? null` here).
 *
 * `loading` covers the FIRST read and every re-read (the table's skeleton
 * rows); a failed read keeps the last response (the table never clears to
 * nothing over a transient error) and surfaces the error line beside the
 * Retry; a failed read with NO response at all is the error state.
 */
import { useEffect, useRef, useState } from 'react'
import { ApiClient } from '@/api-client'
import type { ModelListResponse } from '@/api-client/types'

/** The search keystroke debounce (the `useListEstimate` discipline). */
export const MODEL_SEARCH_DEBOUNCE_MS = 250

/** The one failure line (the transport's message, else this constant). */
const LIST_FAILED_LINE = 'The models could not be loaded.'

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
  return LIST_FAILED_LINE
}

export interface UseModelInventoryOptions {
  /** The search-input text (the hook owns the debounce to the server `q`). */
  query: string
  /** The `?set=` focus (DEC-19); null = the unfiltered inventory. */
  setId: string | null
}

export interface UseModelInventoryResult {
  /** The provider's list payload; `null` until the first response. */
  response: ModelListResponse | null
  /** True while a read is in flight (the table's skeleton rows). */
  loading: boolean
  /** The read failure line; `null` when healthy. */
  error: string | null
  /** Re-issue the read for the current (query, set) view — the
   *  post-mutation refresh (import / rename / delete). */
  refresh: () => void
}

export function useModelInventory(
  options: UseModelInventoryOptions,
): UseModelInventoryResult {
  const { query: rawQuery, setId } = options

  // The debounced query: the raw text is staged, the settled copy is the
  // wire value. Seeded with the mount value, so the first read fires
  // immediately (a 250 ms delay on mount is a one-time shimmer for
  // nothing) and every LATER keystroke settles once after the pause.
  const [query, setQuery] = useState(rawQuery)
  const [response, setResponse] = useState<ModelListResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const epoch = useRef(0)

  useEffect(() => {
    if (rawQuery === query) return
    const timer = setTimeout(() => {
      setQuery(rawQuery)
    }, MODEL_SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [rawQuery, query])

  useEffect(() => {
    const requestEpoch = (epoch.current += 1)
    setLoading(true)
    setError(null)
    const params = {
      ...(query === '' ? {} : { q: query }),
      ...(setId === null ? {} : { set_id: setId }),
    }
    ApiClient.Models.listModels(params)
      .then((res: ModelListResponse) => {
        if (epoch.current !== requestEpoch) return
        setResponse(res)
        setLoading(false)
        setError(null)
      })
      .catch((err: unknown) => {
        if (epoch.current !== requestEpoch) return
        // The last response stays (a scroll-to-nothing flash over a
        // transient error is worse than the stale rows + the error line).
        setLoading(false)
        setError(errorMessage(err))
      })
  }, [query, setId, tick])

  return {
    response,
    loading,
    error,
    refresh: () => setTick(t => t + 1),
  }
}
