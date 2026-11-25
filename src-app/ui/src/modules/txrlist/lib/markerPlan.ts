/**
 * txrlist marker-plan facts — the pure side of the step-4 plan block.
 *
 * The step-4 page copies the ranking route's result onto the eligibility
 * request as its `marker_plan` (mode + marker + top/offered + error), so the
 * verdicts match the run; the cards read the SAME block for the "uses M1"
 * needs-line fact. This file is the client-side port of the server's
 * `marker_rank::markers_slice` + `is_no_list` (ONE slice rule, two engines —
 * the same shape the server's own `plan_markers` applies): a no-list
 * `single` method gets the top 1, a no-list `multi` k the top k, no-list
 * `any`/`panel` the top 5; `chosen` leads with the person's marker and the
 * rest follow the offered ranking without it; `leave_out` and a ranking
 * error give the method nothing (its verdict is the refusal).
 *
 * The ranked slice reads the OFFERED order (the server's `top` is only the
 * display's first five) — a multi method above 5 still gets its k.
 *
 * The planning happens at render time from the plan block (never a stored
 * copy): while the ranking is still loading the plan is absent and the
 * cards show no "uses …" fact yet.
 */
import type { MarkerKind, PlanBlock } from '@/api-client/types'

/** The ranking's top cut (`marker_rank::TOP_N` = 5, the runner's `TOP_N`). */
export const MARKER_TOP_N = 5

/** The expected marker count of a kind (the only kinds with a count rule). */
export function expectedMarkers(kind: MarkerKind, count: number): number {
  switch (kind) {
    case 'single':
      return 1
    case 'multi':
      return count
    case 'any':
    case 'panel':
      return MARKER_TOP_N
  }
}

/** How many markers the plan gives the kind (the server's `markers_slice` limit). */
export function planLimit(kind: MarkerKind, count: number): number {
  switch (kind) {
    case 'single':
      return 1
    case 'multi':
      return count
    case 'any':
    case 'panel':
      return MARKER_TOP_N
  }
}

/** A method has NO fixed marker list exactly when `required_markers` is null
 *  (`required_markers == null` covers the wire's explicit null and an absent
 *  field — the generated optional collapses both, same as the server's
 *  `Option::is_none`). */
export function isNoFixedList(summary: {
  required_markers?: unknown
}): boolean {
  return summary.required_markers == null
}

/** The port of the engine's `is_companion` (`data.py`'s predicate): a
 *  `__detected`/`__lod` column is NEVER a main marker — it travels as its
 *  base marker's companion fact, never a ranking candidate. */
export function isCompanionKey(key: string): boolean {
  return key.endsWith('__detected') || key.endsWith('__lod')
}

/** The file's main marker names (the inventory's marker keys, companions
 *  excluded) — the same candidate set the ranking route ranks and the plan
 *  validates `chosen` markers against. */
export function mainMarkerKeys(
  markers: ReadonlyArray<{ key: string }>,
): string[] {
  return markers.map(marker => marker.key).filter(key => !isCompanionKey(key))
}

/**
 * The planned markers of a no-list method under the plan block; `null` when
 * there is none (a fixed-list method, no plan yet, `leave_out`, a ranking
 * error, or a chosen marker that is not one of the file's main markers).
 *
 * `mains` (the file's main marker keys/names) is the optional validation the
 * `chosen` mode needs: a marker the file does not carry is never shown as
 * "uses …" — the eligibility verdict carries the `MARKER_NOT_IN_FILE`
 * refusal. When the caller cannot supply the list the chosen marker is taken
 * on trust (the registered action refuses an unknown one before it is
 * stored, so production is always already validated).
 */
export function plannedMarkerNames(
  kind: MarkerKind,
  count: number,
  noFixedList: boolean,
  plan: PlanBlock | null | undefined,
  mains: ReadonlyArray<string> | null = null,
): string[] | null {
  if (!noFixedList || plan === null || plan === undefined) return null
  const top = plan.top ?? []
  const offered = plan.offered ?? []
  const limit = planLimit(kind, count)
  let markers: string[]
  switch (plan.mode) {
    case 'leave_out':
      return null
    case 'chosen': {
      const chosen = plan.marker
      if (chosen === undefined || chosen === null || chosen.length === 0) return null
      if (mains !== null && !mains.includes(chosen)) return null
      markers = [chosen]
      if (kind !== 'single') {
        const rest = offered.filter(marker => marker !== chosen)
        markers = markers.concat(rest.slice(0, Math.max(0, limit - 1)))
      }
      break
    }
    case 'ranked': {
      if (plan.error !== undefined && plan.error !== null) return null
      // The ranked slice reads the OFFERED order (top is the display's first
      // five; a multi k above 5 needs the full order for its k).
      const ranked = offered.length > 0 ? offered : top
      markers = ranked.slice(0, limit)
      break
    }
  }
  return markers.length > 0 ? markers : null
}
