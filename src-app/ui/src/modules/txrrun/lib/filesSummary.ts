/**
 * txrrun — the E screen's ONE compact files-summary builder (qa-fixes3
 * ITEM-2 (a)).
 *
 * The board's four slot chips (Patients / Measurements / Predict, each with
 * the file's name and its validated facts) are replaced by ONE line the
 * clinician reads at a glance — "94 patients · 82 events · 2 markers ·
 * draws from day 0 to 799 (93 different days)" — with the marker names
 * beside it and a "Details" disclosure holding the FULL list (the old chip
 * content). The facts are DATA from the intake state, never re-derived or
 * re-validated here (DEC-13, the same rule the slot lines obeyed):
 *
 * - the patients count + events count are the validator's
 *   `patients.rows` / `patients.primary_outcome_events` (the EVENTS
 *   count, qa-fixes ITEM-6 F1 — never `with_primary_outcome`);
 * - the marker count + names are the validated file's `markers` (the
 *   resolved column keys — the join-key names the app already shows);
 * - the draw range is `measurements.distinct_draw_days` (the server's
 *   ascending list): first day · last day · "N different days", and the
 *   full list is the Details disclosure's tail;
 * - the predict-mode line names the predict cohort's count when the
 *   validate for THIS mode describes it (TEST-FV-9's distinct patients),
 *   and the Details hold the predict slot as the old chip did.
 *
 * When the store carries no validation for the current state, the line
 * falls back to the adopted file names alone — the facts would be stale
 * (the store nulls the validation on every file/join/mapping/parameter
 * change — the same disclosure rule the slot lines had).
 */
import type { IntakeSnapshot } from '@/modules/txrintake'
import type { MarkerColumn } from '@/api-client/types'
import { buildSlotSummaries, type TxrSlotSnapshot, type TxrSlotSummarySlot } from './slotSummary'

/** The snapshot fields the builder reads. */
export type TxrFilesSummarySnapshot = TxrSlotSnapshot

/** The one line's facts (all DATA — the component only renders them). */
export interface TxrFilesSummaryFacts {
  /** The compact one-line summary (never empty: the file names always
   *  carry it; "0 events" is the validator's own honest count). */
  line: string
  /** The validated marker names (the resolved column keys — the names the
   *  Details list and the eligibility verdicts use). */
  markerNames: string[]
  /** The full per-file list (the old slot chips, verbatim — the Details
   *  disclosure's content). */
  details: TxrSlotSummarySlot[]
}

/** "N patients" / "N events" / "N markers" — the board's word, pluralized
 *  from the wire count. */
function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/** The draw-range segment: "draws from day 0 to 799 (93 different days)",
 *  and the single-day honest form ("draws at day 56"). */
function drawsSegment(days: readonly number[]): string | null {
  if (days.length === 0) return null
  const first = days[0]
  const last = days[days.length - 1]
  if (first === last) return `draws at day ${first}`
  return `draws from day ${first} to ${last} (${days.length} different ${
    days.length === 1 ? 'day' : 'days'
  })`
}

/** The marker names (the validated file's resolved column keys). */
function markerNames(markers: readonly MarkerColumn[]): string[] {
  return markers.map(marker => marker.key)
}

/** The compact line, segment by segment, omitting a segment the store does
 *  not describe (the validator's nulls are its own facts — a file's
 *  absence never prints a zero). */
function compactLine(snapshot: TxrFilesSummarySnapshot): string {
  const validation = snapshot.validation
  const parts: string[] = []
  if (validation?.patients !== undefined) {
    parts.push(plural(validation.patients.rows, 'patient'))
    parts.push(plural(validation.patients.primary_outcome_events, 'event'))
  }
  if (validation !== null && validation.markers.length > 0) {
    parts.push(plural(validation.markers.length, 'marker'))
  }
  const draws = drawsSegment(validation?.measurements.distinct_draw_days ?? [])
  if (draws !== null) parts.push(draws)
  if (snapshot.mode === 'predict' && validation !== null) {
    parts.push(`${plural(validation.measurements.patients, 'patient')} to predict`)
  }
  // The no-validation fallback: the adopted file names carry the line, so a
  // just-changed file state never reads stale numbers.
  if (parts.length === 0) {
    const names = buildSlotSummaries(snapshot).map(slot => slot.sourceName).filter(Boolean)
    return names.length > 0 ? names.join(' · ') : 'No files yet'
  }
  return parts.join(' · ')
}

/** The ONE summary of the file set (the compact line + the marker names +
 *  the full-per-file Details list). */
export function buildFilesSummary(snapshot: TxrFilesSummarySnapshot): TxrFilesSummaryFacts {
  const validation = snapshot.validation
  return {
    line: compactLine(snapshot),
    markerNames: validation === null ? [] : markerNames(validation.markers),
    details: buildSlotSummaries(snapshot),
  }
}

/** The snapshot shape for the caller (the intake store's fields the page
 *  already reads — TEST-RUN-13's snapshot, extended by nothing). */
export type TxrFilesSummarySnapshotInput = Pick<
  IntakeSnapshot,
  'mode' | 'patients' | 'measurements' | 'predictMeasurements' | 'validation'
>
