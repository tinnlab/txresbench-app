/**
 * txrmodels total-time layer — PROV-UI-MODELS-4 (ITEM-4).
 *
 * DEC-7 (owner D20): the D/I bottom-bar total is a pure client-side SUM of
 * the selected models' `estimated_seconds` (the boards read as a plain
 * sum; the engine's `schedule_seconds` exists for METHODS and no endpoint
 * takes model ids — a new estimate endpoint would be invented here). The
 * string is `txrlist`'s `formatTotalTime`; this function is only the sum.
 */

/**
 * The pure Σ of the selected models' estimates (DEC-7):
 *
 * - an EMPTY selection → `null` (the bar's "…" loading state — nothing is
 *   known about a run with nothing selected);
 * - `null` entries (a verdict with no estimate, an unverdict row) are
 *   SKIPPED — the sum adds what is known, never a zero for an unknown
 *   model (a fabricated "about 1 minute" for an unmeasured model would be
 *   a guessed fact);
 * - a selection whose entries are ALL unknown → `null` (the bar cannot
 *   state a total it has no basis for) — `formatTotalTime(null)` renders
 *   the board's "…", the honest loading/unknown state.
 *
 * The conversion from the selection's verdict rows is the caller's
 * one-liner (`eligibility.byKey.get(key)?.estimated_seconds`): the sum's
 * contract is numbers, the verdict join is the page's.
 */
export function totalSecondsFor(selected: ReadonlyArray<number | null | undefined>): number | null {
  let total = 0
  let known = 0
  for (const value of selected) {
    if (value === null || value === undefined || !Number.isFinite(value)) continue
    total += value
    known += 1
  }
  return known === 0 ? null : total
}

/** The minimal verdict slice the selection sum reads (both eligibility
 *  shapes — `ModelEligibility` and `PretrainedEligibilityEntry` — carry
 *  it; the store's `byKey` map is the D/I screens' verdict view). */
export interface TxrTimedVerdict {
  estimated_seconds?: number | null
}

/**
 * `totalSecondsFor` over the store's verdict map — the D/I bottom bar's
 * exact input: the selected row keys resolving through the eligibility
 * `byKey` map (an absent entry — the verdict still loading, or a key the
 * response omitted — is unknown and skipped, never a fabricated zero).
 * A convenience so the page does not hand-join the map per render; the
 * pure sum stays `totalSecondsFor`.
 */
export function totalSecondsForSelection(
  selected: ReadonlySet<string>,
  byKey: ReadonlyMap<string, TxrTimedVerdict | null> | null,
): number | null {
  const entries: Array<number | null> = []
  for (const key of selected) {
    const verdict = byKey?.get(key) ?? null
    entries.push(verdict?.estimated_seconds ?? null)
  }
  return totalSecondsFor(entries)
}
