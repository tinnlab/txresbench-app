/**
 * txrrun — the E screen's catalogue-list hook (ITEM-8, DEC-8;
 * PROV-UI-RUN-2's `buildGroupChips` source, CONS-UI-RUN-4).
 *
 * The E group filter chips need the method GROUPS (ids + labels + counts);
 * the shared row contract (`TxrListRow`) deliberately carries no group id —
 * only the chip label/tone (DEC-8) — so the page consumes ONE
 * `ApiClient.MethodCatalogue.list` payload itself for the chip facts. The
 * list is bounded (≤ ~400 rows, no pagination per PROV-MC-2), the payload
 * is the same one `useMethodRows` fetches internally (the "one extra
 * loopback call" DEC-8 records), and the call goes through the generated
 * client only — no `fetch()`, no host literal (the allowlist guard's terms).
 *
 * Fetch semantics (the module's hook discipline):
 *
 * - ONE request on mount; `refetch()` re-issues it (the chips' Retry).
 * - The epoch guard discards a stale response (a refetch resolving after a
 *   newer one never overwrites the list).
 * - A failure surfaces `error` and keeps the last good list (the chips keep
 *   rendering — the E screen never loses a chip column over a refetch).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiClient } from '@/api-client'
import type { MethodListResponse, MethodSummary } from '@/api-client/types'

export interface UseMethodListResult {
  /** The catalogue's method rows, in the catalogue's order. */
  methods: MethodSummary[]
  /** True while the first/refetch request is in flight. */
  loading: boolean
  /** The fetch failure message, `null` when healthy. */
  error: string | null
  /** Re-issue the list request. */
  refetch: () => void
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Failed to load methods'
}

export function useMethodList(): UseMethodListResult {
  const [methods, setMethods] = useState<MethodSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const epoch = useRef(0)

  useEffect(() => {
    const requestEpoch = (epoch.current += 1)
    setLoading(true)
    setError(null)
    ApiClient.MethodCatalogue.list({})
      .then((response: MethodListResponse) => {
        if (epoch.current !== requestEpoch) return
        setMethods(response.methods)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (epoch.current !== requestEpoch) return
        setError(errorMessage(err))
        setLoading(false)
      })
  }, [tick])

  const refetch = useCallback((): void => {
    setTick(count => count + 1)
  }, [])

  return { methods, loading, error, refetch }
}
