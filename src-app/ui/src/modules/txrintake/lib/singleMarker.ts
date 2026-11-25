/**
 * txrintake — the step-3 single-marker group's pure facts
 * (single-marker-choice round 2).
 *
 * The group ("Methods that pick markers from your file") shows only when the
 * file is in, at least one method that FITS the answers has no fixed marker
 * list and takes one marker or a set number (single / multi, no list), and
 * the file has more than one main marker. This module computes those facts
 * from the provider data the page already holds:
 *
 * - `inventory` — the validated file inventory (`validation.inventory`):
 *   the file's main markers (companions never count) and the patients;
 * - `methods` — the runnable catalogue summaries (`GET /api/methods`);
 * - `verdicts` — the preview's per-method verdicts (the panel's live answer).
 *
 * "Fits the answers" is the panel's own classification (a method with an
 * ANSWER cause is left out; the environment fact alone is not an answer
 * cause — R2-1), so the group's `n` agrees with the panel's fit count.
 * Note the plan's ranking-less step-3 state: a no-list method on a
 * multi-marker file can still read `cannot_run` today (`MARKER_COUNT_UNMET`)
 * — it FITS the answers (no answer cause), which is exactly what the group
 * is about; step 4's ranking is the authority for the marker order.
 */
import type {
  InventoryEligibilityRequest,
  MethodEligibility,
  MethodSummary,
} from '@/api-client/types'
import { isCompanionKey, isNoFixedList } from '@/modules/txrlist/lib/markerPlan'
import { hasAnswerCause } from './preview'

/** One file marker the group's select offers (the file's main markers). */
export interface SingleMarkerOption {
  /** The file's marker key (the ranking / the plan's marker vocabulary). */
  key: string
  /** The marker's display name (the key when the inventory carries none). */
  name: string
  /** Patients with a value of the marker by the file check's decision day. */
  a: number
  /** Patients in the file. */
  b: number
}

/** The group's facts (what the page renders from). */
export interface SingleMarkerFacts {
  /** The group shows: file in, n ≥ 1, and more than one main marker. */
  visible: boolean
  /** "{n} of the methods that fit take one marker or a set number…" */
  n: number
  /**
   * When `n === 1`: the ONE method's kind (single → "takes one marker",
   * multi → "takes a set number of markers" — the sentence's words differ).
   */
  onlyKind: 'single' | 'multi' | null
  /** The file's main-marker count ("your file has {k} markers"). */
  k: number
  /** The select's markers (the file's main markers, each with its counts). */
  markers: SingleMarkerOption[]
}

/** The file's main markers with their plan facts (companions excluded). */
export function markerOptionsOf(
  inventory: InventoryEligibilityRequest | null,
): SingleMarkerOption[] {
  if (inventory === null) return []
  return inventory.markers
    .filter(marker => !isCompanionKey(marker.key))
    .map(marker => ({
      key: marker.key,
      name: marker.display_name?.trim().length > 0 ? marker.display_name : marker.key,
      a: marker.n_patients_with_value,
      b: inventory.patients,
    }))
}

/**
 * Whether a method takes one marker or a set number of markers with no fixed
 * list (single / multi only — an `any` method takes whatever is ranked, a
 * `panel` its declared count; the group's sentence counts the single/multi
 * ones).
 */
export function takesPlannedMarkerCount(method: MethodSummary): boolean {
  return isNoFixedList(method) && (method.markers.kind === 'single' || method.markers.kind === 'multi')
}

/**
 * The group's facts. `verdicts` is the preview's per-method answer by id
 * (the panel's `methods` map); a summary the preview does not know is not a
 * method that fits. `null` inventory (no checked file) → not visible.
 */
export function singleMarkerFacts(
  inventory: InventoryEligibilityRequest | null,
  methods: ReadonlyArray<MethodSummary>,
  verdicts: ReadonlyMap<string, MethodEligibility>,
): SingleMarkerFacts {
  const markers = markerOptionsOf(inventory)
  let n = 0
  let onlyKind: 'single' | 'multi' | null = null
  for (const method of methods) {
    if (!takesPlannedMarkerCount(method)) continue
    const verdict = verdicts.get(method.id)
    if (verdict === undefined || hasAnswerCause(verdict)) continue
    n += 1
    onlyKind = method.markers.kind === 'multi' ? 'multi' : 'single'
  }
  return {
    visible: inventory !== null && markers.length > 1 && n > 0,
    n,
    onlyKind: n === 1 ? onlyKind : null,
    k: markers.length,
    markers,
  }
}

/**
 * The group's question (the brief's bytes): "{n} of the methods that fit take
 * one marker or a set number of markers, and your file has {k} markers.
 * Which should they use?" — with n = 1 the sentence names the one method and
 * says "one marker" or "a set number of markers" by that method's kind.
 */
export function singleMarkerQuestion(facts: SingleMarkerFacts): string {
  if (facts.n === 1) {
    const word = facts.onlyKind === 'multi' ? 'a set number of markers' : 'one marker'
    return `1 of the methods that fit takes ${word}, and your file has ${facts.k} markers. Which should it use?`
  }
  return `${facts.n} of the methods that fit take one marker or a set number of markers, and your file has ${facts.k} markers. Which should they use?`
}
