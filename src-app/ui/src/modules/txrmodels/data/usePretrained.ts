/**
 * txrmodels — the D screen's catalogue bindings (ITEM-5; PROV-PC-3/4,
 * CONS-UM-17/18).
 *
 * Two hooks, one file — the catalogue's two PROV-PC surfaces:
 *
 * - `usePretrained` — the catalogue LIST (`GET /api/txr/pretrained`, the
 *   PROV-PC-3 `PretrainedListResponse`): the D page's card rows, fetched
 *   ONCE PER SCREEN MOUNT. The catalogue is a global read (it is not
 *   inventory-keyed — the eligibility verdicts are the inventory-keyed
 *   half, `usePretrainedEligibility`), so the mount adapter's key is the
 *   constant it is; the fetch is the store's `loadPretrained` (the
 *   whole-store-lazy slice + the in-flight dedupe), and the "same key →
 *   no refetch" rule is the effect's static dependency: a re-render never
 *   re-issues the request, a remount gets one fresh request, `refetch()`
 *   is the `{force: true}` retry path.
 * - `usePretrainedCard(id)` — the per-id CARD payload
 *   (`GET /api/txr/pretrained/{id}`, PROV-PC-4 `PretrainedModel`) for the
 *   "Model card" dialog: fetched on demand (the card is NEVER N+1'd into
 *   the list slice — DRIFT-1 #1), one request per id, and a `404` (the
 *   provider's `PRETRAINED_UNKNOWN`) maps to the `'not-found'` error class
 *   the dialog renders as its not-found state (CONS-UM-18) — never a blank
 *   card, never a crash, the `useMethodDetail` idiom.
 *
 * The only wire surface is the generated `ApiClient.Pretrained.*` (no
 * `fetch()`, no host literal — the allowlist guard's terms, INV-5) and the
 * payloads are the provider's generated types verbatim (never vendored,
 * never restated; a regen drives the typecheck). The card is returned as
 * the provider's own shape — the DIALOG renders its fields defensively
 * (`?? null` on the optional blocks, ITEM-6's read) — this layer's
 * defensive duty is the request side: a null id never calls, a 404 is a
 * state, and the promise is always caught (no unhandled rejection).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { ApiClient } from '@/api-client'
import type { PretrainedModel, PretrainedSummary } from '@/api-client/types'
import { useTxrModelsStore } from '../stores/TxrModels.store'

/** The wire-status reader (the framework transport attaches `status`). */
const statusOf = (err: unknown): number | null =>
  err !== null &&
  typeof err === 'object' &&
  'status' in err &&
  typeof (err as { status: unknown }).status === 'number'
    ? (err as { status: number }).status
    : null

/** The 404's stable code (PROV-PC-4's `PRETRAINED_UNKNOWN`). */
const NOT_FOUND_STATUS = 404

export interface UsePretrainedResult {
  /** The catalogue's card rows, in the catalogue's order. */
  cards: PretrainedSummary[]
  /** True while the list request is in flight. */
  loading: boolean
  /** The fetch failure message, `null` when healthy. */
  error: string | null
  /** Re-issue the list request (`{force: true}` — the retry path). */
  refetch: () => void
}

/** The failure line for the list (the Datasets-store idiom). */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Failed to load pretrained models'
}

export function usePretrained(): UsePretrainedResult {
  // The store's slice is the single source of truth: the D page's rows, the
  // loading skeleton and the failure line all come from the ONE chunk
  // (ITEM-3) — this hook is the mount adapter, never a second fetch path.
  const slice = useStore(useTxrModelsStore, s => s.pretrained)
  useEffect(() => {
    void useTxrModelsStore.getState().loadPretrained()
  }, [])
  const refetch = useCallback((): void => {
    void useTxrModelsStore.getState().loadPretrained({ force: true })
  }, [])
  return { cards: slice.cards, loading: slice.loading, error: slice.error, refetch }
}

/**
 * The card fetch's error class: a `404` (the catalogue no longer serves the
 * id — `PRETRAINED_UNKNOWN`) is `'not-found'` (the dialog's not-found
 * state), any other failure `'network'` (the dialog's error + retry line).
 */
export type TxrPretrainedCardError = 'not-found' | 'network' | null

export interface UsePretrainedCardResult {
  /** The catalogue's card payload, `null` while loading / on error / closed. */
  card: PretrainedModel | null
  /** True while the card request is in flight. */
  loading: boolean
  /** The failure class: `'not-found'` is 404, `'network'` anything else. */
  error: TxrPretrainedCardError
  /** Re-issue the card request for the current id. */
  retry: () => void
}

export function usePretrainedCard(id: string | null): UsePretrainedCardResult {
  const [card, setCard] = useState<PretrainedModel | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<TxrPretrainedCardError>(null)
  const [tick, setTick] = useState(0)
  const epoch = useRef(0)

  useEffect(() => {
    if (id === null) {
      // The closed dialog: no request, no stale card.
      epoch.current += 1
      setCard(null)
      setLoading(false)
      setError(null)
      return
    }
    const requestEpoch = (epoch.current += 1)
    setCard(null)
    setLoading(true)
    setError(null)
    ApiClient.Pretrained.getModel({ id })
      .then((model: PretrainedModel) => {
        if (epoch.current !== requestEpoch) return
        setCard(model)
        setLoading(false)
        setError(null)
      })
      .catch((err: unknown) => {
        if (epoch.current !== requestEpoch) return
        setCard(null)
        setLoading(false)
        setError(statusOf(err) === NOT_FOUND_STATUS ? 'not-found' : 'network')
      })
  }, [id, tick])

  const retry = useCallback((): void => {
    setTick(count => count + 1)
  }, [])

  return { card, loading, error, retry }
}
