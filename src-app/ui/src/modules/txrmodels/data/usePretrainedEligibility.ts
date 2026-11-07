/**
 * txrmodels — the D screen's verdict binding (ITEM-5; PROV-PC-8,
 * CONS-UM-19).
 *
 * `usePretrainedEligibility(inventory, catalogueIds)` scores the catalogue
 * cards against the uploaded predict file: ONE `POST
 * /api/txr/pretrained/eligibility` per stable key — the cards' can-run /
 * some / cannot verdicts with the per-row status/detail/time (the same
 * reason vocabulary as PROV-MS-9 with `ASSET_NOT_AVAILABLE`).
 *
 * Fetch semantics (the `useMethodRows` discipline, PROV-UI-LIST-3):
 *
 * - The HELD response is the provider's whole
 *   `PretrainedEligibilityResponse` (the D rows builder
 *   `buildPretrainedRows(cards, response)` consumes the response, not a
 *   re-derived map — PROV-UI-MODELS-4; the store's `eligibility` slice is
 *   the SAVED-model verdicts of PROV-MS-9 and stays untouched).
 * - The request key is the stable inventory content hash (`txrlist`'s
 *   `stableInventoryKey` — the ONE canonicalization, never a second one)
 *   joined with the sorted catalogue id list. The verdicts answer BOTH
 *   sides: a content-identical inventory rebuild (same hash) does not
 *   refetch, a changed inventory does, a changed id set does — and a
 *   catalogue that has not loaded yet (empty id list) never calls (the
 *   provider's body is `model_ids` 1..=200; the empty catalogue is the
 *   D page's no-models state, rendered from the synthesized empty
 *   response).
 * - SINGLE-SHOT: one request per key; `refetch()` re-issues it (the
 *   Retry path); a key change or a newer request supersedes an older
 *   response by request epoch (a stale resolve never writes), and an
 *   unmounted host discards the response.
 * - A failed call surfaces `error` and KEEPS the last good response (the
 *   rows stay — the header counts never drop out over a refetch).
 * - Every response field is read defensively (`?? 0` / `?? []`): a
 *   smaller provider payload renders the honest zero/empty verdict set
 *   instead of crashing the screen (the model-store DEC-18 drift-guard
 *   pattern; reconcile tightens).
 *
 * The request body carries the ONE inventory object VERBATIM (the ui-list
 * DEC-15 one-builder pin — the same object the methods / saved-models
 * eligibility calls carry).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiClient } from '@/api-client'
import type {
  InventoryEligibilityRequest,
  PretrainedEligibilityResponse,
} from '@/api-client/types'
import { stableInventoryKey } from '@/modules/txrlist'

/**
 * The empty verdict set: the D list with no catalogue ids (or an unwritten
 * response) is the no-models state — zero verdicts, zero counts — never a
 * fabricated card fact.
 */
const EMPTY_RESPONSE: PretrainedEligibilityResponse = {
  models: [],
  total_fit: 0,
  total_some: 0,
  total_cannot: 0,
}

/**
 * The same composite key rule as the store's saved-verdict memo
 * (`eligibilityKey', DRIFT-1 ITEM-3 #3) — one line, kept byte-identical and
 * cross-referenced so the D (this hook) and I (the store) verdicts can
 * never diverge; the canonicalization itself is the ONE `txrlist` hash.
 */
function verdictKey(inventory: InventoryEligibilityRequest, idsKey: string): string {
  return `${stableInventoryKey(inventory)}|id:${idsKey}`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Failed to check pretrained models'
}

export interface UsePretrainedEligibilityResult {
  /** The provider's verdicts for the current key, kept across a failed refetch. */
  response: PretrainedEligibilityResponse | null
  /** True while the verdict request is in flight. */
  loading: boolean
  /** The failure message, `null` when healthy. */
  error: string | null
  /** Re-issue the verdict request for the current key. */
  refetch: () => void
}

export function usePretrainedEligibility(
  inventory: InventoryEligibilityRequest | null,
  catalogueIds: string[],
): UsePretrainedEligibilityResult {
  // The id list's content key: order never refetches (the D page maps the
  // catalogue rows on every render — a fresh array, a stable key).
  const idsKey = useMemo(() => [...catalogueIds].sort().join('\u0000'), [catalogueIds])
  const key = useMemo(
    () => (inventory === null ? null : verdictKey(inventory, idsKey)),
    [inventory, idsKey],
  )
  const [response, setResponse] = useState<PretrainedEligibilityResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const epoch = useRef(0)

  useEffect(() => {
    if (inventory === null) {
      // No validated file: the not-ready screen state — no call, no verdicts.
      epoch.current += 1
      setResponse(null)
      setLoading(false)
      setError(null)
      return
    }
    if (catalogueIds.length === 0) {
      // The catalogue has not loaded yet: the no-models state, no call
      // (the provider's body bounds `model_ids` at 1..=200).
      epoch.current += 1
      setResponse(EMPTY_RESPONSE)
      setLoading(false)
      setError(null)
      return
    }
    const requestEpoch = (epoch.current += 1)
    setLoading(true)
    setError(null)
    ApiClient.Pretrained.checkEligibility({ model_ids: catalogueIds, inventory })
      .then((res: PretrainedEligibilityResponse) => {
        if (epoch.current !== requestEpoch) return
        setResponse({
          models: res?.models ?? [],
          total_fit: res?.total_fit ?? 0,
          total_some: res?.total_some ?? 0,
          total_cannot: res?.total_cannot ?? 0,
        })
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (epoch.current !== requestEpoch) return
        setError(errorMessage(err))
        setLoading(false)
      })
    // `inventory` / `catalogueIds` are deliberately not dependencies: the
    // content key is the pair's cache discriminator, and a content-identical
    // rebuild must not re-issue the request (same key -> no refetch).
  }, [key, tick])

  const refetch = useCallback((): void => {
    setTick(count => count + 1)
  }, [])

  return { response, loading, error, refetch }
}
