/**
 * txrintake — the screen-A learn-card method count (PROV-UI-INTAKE-3,
 * CONS-UI-INTAKE-3): `GET /api/methods?runnable=true` →
 * `MethodListResponse`, the card reads `total`. The count is COMPUTED from
 * the live catalogue — the board's method-count line is a design example
 * (DEC-13), never shipped as a literal.
 *
 * The generated operation id is `ApiClient.MethodCatalogue.list` — the real
 * provider id; the plan's `Methods.list` assertion is a recorded reconcile
 * fact (DRIFT-1 ITEM-2 #4).
 *
 * Fetch semantics (ITEM-10 — the plan's "cached by stable key; no refetch
 * storm on mount"): the runnable set is ONE static response per catalogue,
 * so the hook reads the module-level fetch cache under the module's
 * stable key `RUNNABLE_COUNT_KEY`. A revisiting mount (A → B → A) serves
 * the settled count on its first frame with no second request; two mounts
 * that arrive while the request is in flight share one round trip; a
 * failed fetch is dropped from the cache (never cached), so the next
 * mount retries.
 *
 * Failure is graceful degradation on purpose: the count is a nicety, never
 * a gate — `count: null` and the card renders the number-free line (the
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
import type { MethodListResponse } from '@/api-client/types'
import { fetchCached, readCached } from './fetchCache'

export interface UseRunnableMethodCountResult {
  /** The runnable method count, `null` while loading or after a failure. */
  count: number | null
}

/** The stable key — the runnable set is ONE static response, fetched once. */
const RUNNABLE_COUNT_KEY = 'methods:runnable'

export function useRunnableMethodCount(): UseRunnableMethodCountResult {
  // A settled cache entry renders the count on the first frame: the
  // runnable set is static per catalogue, so a revisiting mount needs no
  // blank count line and fires no second request.
  const cached = readCached<MethodListResponse>(RUNNABLE_COUNT_KEY)
  const [count, setCount] = useState<number | null>(cached?.total ?? null)

  useEffect(() => {
    // One request per session under the stable key: a failure keeps
    // `count` null (the card's number-free line), leaves the cache entry
    // dropped (rejections are never cached — the next mount retries), and
    // the mount's cancellation flag keeps a late response from writing
    // after unmount.
    let cancelled = false
    void fetchCached(RUNNABLE_COUNT_KEY, () => ApiClient.MethodCatalogue.list({ runnable: true }))
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
