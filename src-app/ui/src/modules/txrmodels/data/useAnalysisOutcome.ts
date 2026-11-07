/**
 * txrmodels — the I screen's outcome-facts read (ITEM-7; the
 * `TxrOutcomeMatch` source of the "Same outcome as my file" chip).
 *
 * The chip's predicate (ITEM-4's `savedChipPredicate`) matches a saved
 * model's endpoint + horizon against the ANALYSIS's own endpoint +
 * look-ahead day. The inventory the eligibility calls carry has no
 * endpoint/horizon (its outcomes block is presence flags only — DEC-6),
 * and the intake screen's outcome answer is display-only at screen B (the
 * preview endpoint carries no outcome field, OWNER-3), so the ONE source of the
 * engine's outcome facts is its sticky analysis config
 * (`ApiClient.Txr.getAnalysisConfig`, PROV-EE-8 — the same wire the E
 * screen's settings mount).
 *
 * `useAnalysisOutcome()` reads that config RAW — endpoint +
 * `look_ahead_day` as stored, with NO fallback to the engine's
 * `DEFAULT_RUN_SETTINGS` values. A config that has never carried an
 * outcome (or a read failure) yields `{ endpoint: null, lookAheadDay:
 * null }` — and the plan's rule is explicit: "null facts → matches
 * NOTHING (a count honest about an unset outcome)" — a defaulted fact
 * would fabricate an outcome match the analysis never declared. The E
 * screen's merge-with-defaults is its settings-layer concern; the chip's
 * question is "does a saved model predict what THIS analysis predicts",
 * and an analysis with no recorded answer is not a match.
 *
 * ONCE per screen mount, no new I/O beyond the generated client's
 * loopback (INV-5); the failure of this read is not an error line — the
 * chip's honest zero count is the surface.
 */
import { useEffect, useState } from 'react'
import { ApiClient } from '@/api-client'
import type { TxrOutcomeMatch } from '../lib/filters'

/** The no-answer pair (the chip matches nothing — the plan's rule). */
const UNKNOWN_OUTCOME: TxrOutcomeMatch = { endpoint: null, lookAheadDay: null }

export function useAnalysisOutcome(): TxrOutcomeMatch {
  const [outcome, setOutcome] = useState<TxrOutcomeMatch>(UNKNOWN_OUTCOME)

  useEffect(() => {
    let cancelled = false
    ApiClient.Txr.getAnalysisConfig()
      .then(engine => {
        if (cancelled) return
        const config = engine.config ?? null
        setOutcome({
          endpoint: config?.endpoint ?? null,
          lookAheadDay: config?.look_ahead_day ?? null,
        })
      })
      .catch(() => {
        // A failed read is an unset outcome: the chip's count is 0, the
        // list's own error surface is untouched by this secondary read.
        if (!cancelled) setOutcome(UNKNOWN_OUTCOME)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return outcome
}
