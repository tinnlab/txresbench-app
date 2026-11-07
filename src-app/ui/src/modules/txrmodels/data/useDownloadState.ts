/**
 * txrmodels — the D card's download controller (ITEM-5; PROV-PC-6,
 * CONS-UM-20).
 *
 * `useDownloadState(id)` is ONE card's download state + actions, composed
 * over the module store's `downloadState[id]` map and `requestDownload`
 * (PROV-UI-MODELS-3): the store owns the poll (fixed interval, terminal
 * committed once, transient poll failures keep polling with the error line
 * — the ITEM-3 contract, DRIFT-1 #7), this hook adds the retry/backoff
 * POLISH the plan defers here and the per-id view the D column renders.
 *
 * The polish, exactly:
 *
 * - **backoff + retry**: a failed START request (the store's entry is
 *   `{status: null, error: …}` — nothing was started, no poll is live)
 *   is re-issued automatically on an exponential schedule —
 *   `DOWNLOAD_RETRY_BASE_MS · 2^attempt`, capped at `DOWNLOAD_RETRY_CAP_MS`
 *   — up to `DOWNLOAD_MAX_RETRIES` attempts, then the error line stays for
 *   the card's Retry button. The download itself is never auto-restarted:
 *   a `failed` TERMINAL state (the provider's sha256 verify) is the
 *   human's Retry. One attempt is ever in flight: a re-issue is armed
 *   only after the previous response landed (the entry reference changed),
 *   so a slow start never overlaps a second start.
 * - **stop-on-terminal**: any non-null status (the download started, or
 *   the terminal `ready`/`failed` committed by the store) stops the retry
 *   schedule — one schedule per card, never a second poll loop.
 * - `start()` / `retry()` both re-issue `store.requestDownload(id)` (the
 *   store's guard: a live or terminal entry is a no-op, a failed entry is
 *   re-requestable — the idempotent PROV-PC-6 start) and cancel a pending
 *   automatic retry first (a manual Retry is never doubled by the timer).
 * - unmount-safe: a pending backoff timer is cleared on unmount and on an
 *   id change (no retry against a card the user left).
 *
 * The entry is the store's `TxrModelDownloadState` verbatim (the provider's
 * `PretrainedDownloadStatus` + the failure line) — never a restated shape.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import type { TxrModelDownloadState } from '../types'
import { useTxrModelsStore } from '../stores/TxrModels.store'

/** The backoff schedule's base: first retry after 2 s (the poll cadence's order). */
export const DOWNLOAD_RETRY_BASE_MS = 2000

/** The backoff schedule's cap: 2 s, 4 s, 8 s, 16 s, 30 s, 30 s … */
export const DOWNLOAD_RETRY_CAP_MS = 30000

/** The automatic re-issue limit after a failed start: 3 retries, then the human's Retry. */
export const DOWNLOAD_MAX_RETRIES = 3

/** The exponential backoff delay for the `attempt`-th retry (0-based), capped. */
export function downloadBackoffMs(
  attempt: number,
  baseMs: number = DOWNLOAD_RETRY_BASE_MS,
  capMs: number = DOWNLOAD_RETRY_CAP_MS,
): number {
  return Math.min(baseMs * 2 ** attempt, capMs)
}

export interface UseDownloadStateResult {
  /** The store's per-id view (the provider status + the failure line),
   *  `undefined` before the first start. */
  entry: TxrModelDownloadState | undefined
  /** True while an automatic retry is scheduled (the card's "retrying…" line). */
  retrying: boolean
  /** Start the download (no-op while a download is live or terminal — the
   *  store's guard); a failed start re-issues itself with backoff. */
  start: () => void
  /** The card's Retry — same start path, also the backoff reset. */
  retry: () => void
}

/** Does the entry need an automatic re-issue? Only a failed START (nothing
 *  was started — no status, an error line); a live or terminal entry never
 *  auto-retries (a provider `failed` is the human's call). */
function needsStartRetry(entry: TxrModelDownloadState | undefined): boolean {
  return entry !== undefined && entry.status === null && entry.error !== null
}

export function useDownloadState(id: string): UseDownloadStateResult {
  const entry = useStore(useTxrModelsStore, s => s.downloadState[id])
  const [attempt, setAttempt] = useState(0)
  const [retrying, setRetrying] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** True between a re-issue and its response; the response changes the
   *  entry REFERENCE, which is the settled signal. */
  const inFlight = useRef(false)
  /** The entry reference the last effect run saw — a run with the same
   *  reference is an attempt-budget advance, not a response. */
  const seenEntry = useRef<TxrModelDownloadState | undefined>(undefined)

  const clearSchedule = useCallback((): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    setRetrying(false)
  }, [])

  // An id change cancels the old card's schedule and starts a fresh attempt
  // budget (the card subtree is per-id; a stale timer must never fire).
  useEffect(() => {
    setAttempt(0)
    setRetrying(false)
    inFlight.current = false
    seenEntry.current = undefined
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
      }
    }
  }, [id])

  useEffect(() => {
    if (seenEntry.current !== entry) {
      // The entry changed: a response (or a reset) landed — the previous
      // re-issue, if any, has settled.
      seenEntry.current = entry
      inFlight.current = false
    }
    if (!needsStartRetry(entry)) {
      // Healthy (a status is committed — live or terminal — or never
      // started): no retry owed.
      clearSchedule()
      setAttempt(0)
      return
    }
    if (inFlight.current) {
      // A re-issue is waiting on the wire: no schedule until it settles
      // (the entry-reference change re-runs this effect).
      setRetrying(true)
      return
    }
    if (attempt >= DOWNLOAD_MAX_RETRIES) {
      // The budget is spent: the error line stays for the card's Retry.
      clearSchedule()
      return
    }
    setRetrying(true)
    const delay = downloadBackoffMs(attempt)
    const t = setTimeout(() => {
      timer.current = null
      setAttempt(a => a + 1)
      inFlight.current = true
      void useTxrModelsStore.getState().requestDownload(id)
    }, delay)
    timer.current = t
    return () => {
      // A re-run (entry update / attempt advance) cancels the pending one;
      // the fired callback nulls the ref first, so its own cleanup is a no-op.
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
      }
    }
  }, [entry, attempt, id, clearSchedule])

  const start = useCallback((): void => {
    clearSchedule()
    setAttempt(0)
    inFlight.current = true
    void useTxrModelsStore.getState().requestDownload(id)
  }, [id, clearSchedule])

  return { entry, retrying, start, retry: start }
}
