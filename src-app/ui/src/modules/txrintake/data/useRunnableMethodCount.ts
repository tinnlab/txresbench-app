/**
 * txrintake — the screen-A learn-card method count (PROV-UI-INTAKE-3,
 * CONS-UI-INTAKE-3): `GET /api/methods?runnable=true` → `MethodListResponse`,
 * the card reads `total`. The count is COMPUTED from the live catalogue —
 * the board's method-count line is a design example (DEC-13), never shipped
 * as a literal.
 *
 * The generated operation id is `ApiClient.MethodCatalogue.list` — the real
 * provider id; the plan's `Methods.list` assertion is a recorded reconcile
 * fact (DRIFT-1 ITEM-2 #4).
 *
 * Failure is graceful degradation on purpose: the count is a nicety, never a
 * gate — `count: null` and the card renders the number-free line (the
 * pretrained/saved cards already carry no counts until their nodes exist,
 * OWNER-7).
 *
 * This file is ITEM-10's planned home (its TEST-INT-5 deep tests + the
 * `useMarkers` sibling ship there); ITEM-4 creates it because the Start page
 * is compile-blocked without it — the ITEM-1 pages precedent (DRIFT-1
 * ITEM-4 #1), and the hook surface stays the plan's `{ count: number | null }`.
 */
import { useEffect, useState } from 'react'
import { ApiClient } from '@/api-client'

export interface UseRunnableMethodCountResult {
  /** The runnable method count, `null` while loading or after a failure. */
  count: number | null
}

export function useRunnableMethodCount(): UseRunnableMethodCountResult {
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    // One fetch per mount. The A screen is the route home, so a mount means
    // the user is on screen A; a failure keeps `count` null (the card's
    // number-free line) and the mount's cancellation flag keeps a late
    // response from writing after unmount.
    let cancelled = false
    ApiClient.MethodCatalogue.list({ runnable: true })
      .then(response => {
        if (!cancelled) setCount(response.total)
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
