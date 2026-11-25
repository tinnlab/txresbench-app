/**
 * txrintake — the step-3 single-marker group's pure facts
 * (single-marker-choice round 2).
 *
 * The group ("Methods that pick markers from your file") shows only when the
 * file is in, at least one method that FITS the answers has no fixed marker
 * list, takes one marker or a set number (single / multi, no list) and fewer
 * markers than the file has, and the file has more than one main marker.
 * This module computes those facts from the provider data the page already
 * holds:
 *
 * - `inventory` — the validated file inventory (`validation.inventory`):
 *   the file's main markers (companions never count) and the patients;
 * - `methods` — the runnable catalogue summaries (`GET /api/methods`);
 * - `verdicts` — the preview's per-method verdicts (the panel's live answer).
 *
 * "Fits the answers" is the panel's own classification (a method with an
 * ANSWER cause is left out; the environment fact alone is not an answer
 * cause — R2-1), so the group's `n` agrees with the panel's fit count.
 * The user's count rule: only the methods that take FEWER
 * markers than the file has are in the question — a method that takes
 * exactly the file's count fits but needs no choice, and a method that
 * needs MORE can never run on the file (it is a step-3 left-out, already
 * reading `MARKER_COUNT_UNMET`, the step-3 preview's refusal for it).
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
  /** The fitting no-list single/multi count ("{n} of the methods that fit use fewer"). */
  n: number
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
 * `panel` its declared count; the group's n counts the single/multi ones).
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
  // The file's main-marker count (the question's "your file has {k}").
  const k = markers.length
  let n = 0
  for (const method of methods) {
    if (!takesPlannedMarkerCount(method)) continue
    const verdict = verdicts.get(method.id)
    if (verdict === undefined || hasAnswerCause(verdict)) continue
    // The user's rule: only a method that takes FEWER markers than the file
    // has is in the question (its choice is what the group asks). Exactly
    // the file's count fits without a choice; more can never run on it —
    // that method is the step-3 left-out, not a count in this group.
    const declared = method.markers.kind === 'single' ? 1 : method.markers.count
    if (declared >= k) continue
    n += 1
  }
  return {
    visible: inventory !== null && markers.length > 1 && n > 0,
    n,
    k,
    markers,
  }
}

/**
 * The group's question (the brief's bytes): "Your file has {k} markers, but
 * {n} of the methods that fit use fewer. Which markers should they use?" —
 * at n = 1 the singular "it" replaces "they".
 */
export function singleMarkerQuestion(facts: SingleMarkerFacts): string {
  if (facts.n === 1) {
    return `Your file has ${facts.k} markers, but 1 of the methods that fit uses fewer. Which markers should it use?`
  }
  return `Your file has ${facts.k} markers, but ${facts.n} of the methods that fit use fewer. Which markers should they use?`
}
