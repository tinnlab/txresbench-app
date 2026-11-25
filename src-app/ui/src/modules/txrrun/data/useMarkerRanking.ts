/**
 * txrrun — the step-4 marker-ranking fetch (single-marker-choice round 2):
 * `POST /api/txr/runs/marker-ranking` with the SAME parsed tables the run
 * request carries + the current endpoint, decision day and the person's
 * choice, debounced 200 ms per change (the step-3 preview's discipline) with
 * the stale-response epoch guard.
 *
 * Semantics:
 *
 * - The request is keyed by its CONTENT (stable JSON): the parsed tables,
 *   the joins/mapping, `keep_copies`, the endpoint, the decision day and the
 *   choice are all ranking inputs — a content-identical rebuild never
 *   refetches; any of them changing re-issues (debounced: a burst costs one
 *   call).
 * - `loading` is true from a key change until THAT key's response lands (or
 *   fails); the last `response` is dropped on a key change, so a stale
 *   ranking for the OLD endpoint/day is never read (the step-4 line says
 *   "Ranking your markers…" and the eligibility request carries no stale
 *   plan).
 * - A failure surfaces `error` and no response — the page keeps the
 *   method-list verdicts (today's count rule) rather than a stale plan. A
 *   MALFORMED answer (round 2c: the transport's crash-safe `[]` for an
 *   unseeded endpoint) is the same failure — the plan readers touch
 *   `response.top` at render time, so no shape but the route's own may cross.
 * - `null` request (no inventory yet, or the demo) → nothing happens.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiClient } from '@/api-client'
import type {
  MarkerRankingRequest,
  MarkerRankingResponse,
} from '@/api-client/types'
import { isMarkerRankingResponse } from '../lib/markerPlan'

export const MARKER_RANKING_DEBOUNCE_MS = 200

export interface UseMarkerRankingResult {
  /** The ranking answer for the current request; `null` while loading/after a failure. */
  response: MarkerRankingResponse | null
  /** True from a request change until that response lands. */
  loading: boolean
  /** The fetch failure message (the route's own rejection, or the constant). */
  error: string | null
  refetch: () => void
}

/** The stable content key of the request (array order kept — it is content
 *  order for the tables; object keys sorted). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

function requestKey(request: MarkerRankingRequest): string {
  return JSON.stringify(canonicalize(request))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'The markers could not be ranked.'
}

export function useMarkerRanking(request: MarkerRankingRequest | null): UseMarkerRankingResult {
  const key = useMemo(() => (request === null ? null : requestKey(request)), [request])
  const [response, setResponse] = useState<MarkerRankingResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const epoch = useRef(0)

  useEffect(() => {
    if (key === null) return
    // A NEW request: the previous answer described the old inputs — drop it
    // (the line waits; the eligibility plan is absent until this settles).
    const requestEpoch = (epoch.current += 1)
    setResponse(null)
    setLoading(true)
    setError(null)
    const timer = setTimeout(() => {
      // The call runs inside a promise tick: a missing/broken client method
      // (the page tests mock only the routes they use) rejects like a fetch
      // failure instead of throwing out of the timer.
      Promise.resolve()
        .then(() => ApiClient.Txr.markerRanking(request as MarkerRankingRequest))
        .then(answer => {
          if (epoch.current !== requestEpoch) return
          // A malformed answer (the mock's unseeded `[]`, an empty body) is
          // the SAME state as a failed call: no response — the page keeps
          // the count rule and shows no ranked line (round 2c; before the
          // guard the `[]` reached the plan readers and threw in render).
          if (!isMarkerRankingResponse(answer)) {
            setError('The markers could not be ranked.')
            setLoading(false)
            return
          }
          setResponse(answer)
          setLoading(false)
        })
        .catch((err: unknown) => {
          if (epoch.current !== requestEpoch) return
          setError(errorMessage(err))
          setLoading(false)
        })
    }, MARKER_RANKING_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
    }
    // The content key is the discriminator; `request` is the closure's
    // snapshot (a content-identical rebuild must not refetch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refresh])

  const refetch = () => {
    setRefresh(count => count + 1)
  }

  return { response, loading, error, refetch }
}
