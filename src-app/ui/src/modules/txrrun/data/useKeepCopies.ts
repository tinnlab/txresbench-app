/**
 * txrrun — the E screen's keep-copies hook (ITEM-8, CONS-UI-RUN-17 /
 * TEST-RUN-36, PROV-HS-4).
 *
 * The K screen owns the "Copies are kept with this run" preference (the
 * `txr_history_preferences` singleton, id = 1 — the engine's entity); the E
 * screen READS it once at setup (read-elsewhere, D66 — this node stores
 * nothing it did not ask the engine to store) and passes the result as
 * `input.keep_copies` when the run is created: the intake builder's own
 * default is `true`, and the preference wins when it answers; a failed read
 * leaves the default (a broken preferences read must never block a run and
 * must never silently drop the user's file copies — the conservative fallback
 * is the board's default).
 *
 * The read is exactly once per mount (the hook's effect has no dependency),
 * through the generated `ApiClient.History.getPreferences` — the operation
 * the history-store node's PROV-HS-4 provides, never a local mirror.
 */
import { useEffect, useRef, useState } from 'react'
import { ApiClient } from '@/api-client'
import type { TxrHistoryPreferences } from '@/api-client/types'

export interface UseKeepCopiesResult {
  /** The preference's `keep_file_copies`; the builder default `true` until
   *  the read lands or when it fails. */
  keepCopies: boolean
}

export function useKeepCopies(): UseKeepCopiesResult {
  const [keepCopies, setKeepCopies] = useState(true)
  const epoch = useRef(0)

  useEffect(() => {
    const requestEpoch = (epoch.current += 1)
    ApiClient.History.getPreferences()
      .then((preferences: TxrHistoryPreferences) => {
        if (epoch.current !== requestEpoch) return
        setKeepCopies(preferences.keep_file_copies)
      })
      .catch(() => {
        // A failed read is the builder default (true) — the preference is a
        // retention hint, never a run blocker.
      })
    return () => {
      // The epoch guard: a read resolving after a remount never writes the
      // older request's value over the newer mount's.
      epoch.current += 1
    }
  }, [])

  return { keepCopies }
}
