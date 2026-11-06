/**
 * The ONE slot-summary builder of screen E (DEC-13, CONS-UI-RUN-13).
 *
 * The E screen's three slot lines — Patients / Measurements / Predict, each
 * with the adopted file's name and the validated facts (the board chip's
 * "NAME · count · count" shape) — are DATA from the intake state, never
 * facts this module re-derives or re-validates:
 *
 * - the file name is the adopted file's own `source.name`;
 * - the summary text is the intake store's ONE `ValidationResponse`
 *   (`TxrIntake.validation` — the field the intake store grows for the
 *   E/D/I screens, OWNER-4/D73): the patients summary's rows + primary-
 *   outcome count, the measurements summary's marker count + draw days,
 *   and the predict-mode validate's measurements patient count;
 * - when the store carries no validation for the current state, the chip
 *   renders the name alone (the summary would be stale — the store nulls
 *   the validation on every file/join/mapping/parameter change).
 *
 * The board's slot copy ("Patients", "Measurements", "Predict") is the
 * component's label map; the facts here are the wire's own words (the
 * board's "62 events" is the validator's `with_primary_outcome`, its "5
 * markers" the resolved markers of the validated file, its "38 patients"
 * the predict-mode cohort's distinct patients). The builder is pure: the
 * page reads the store, the component renders.
 */
import type { IntakeSnapshot } from '@/modules/txrintake'
import type { ValidationResponse } from '@/api-client/types'

/** The three board slot kinds, in the board's row order. */
export type TxrSlotKind = 'patients' | 'measurements' | 'predict'

/** The snapshot fields the slot line + missing-piece logic read. */
export type TxrSlotSnapshot = Pick<
  IntakeSnapshot,
  'mode' | 'patients' | 'measurements' | 'predictMeasurements' | 'validation'
>

/** One slot line's facts — the name + the validated summary (both DATA). */
export interface TxrSlotSummarySlot {
  kind: TxrSlotKind
  /** The adopted file's name (the board's "patients.csv" column). */
  sourceName: string | null
  /** The validated facts line (the board chip's data-filled tail). */
  summaryText: string | null
}

/** "N patient(s)" — the board's word, pluralized from the wire count. */
function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/** The patients line (rows + primary outcomes, the board chip's data-filled tail). */
function patientsSummary(validation: ValidationResponse | null): string | null {
  const patients = validation?.patients
  if (patients === undefined) return null
  return `${plural(patients.rows, 'patient')} · ${plural(patients.with_primary_outcome, 'event')}`
}

/** The measurements line: "5 markers · draws at day 0, 14, 28, 56". */
function measurementsSummary(validation: ValidationResponse | null): string | null {
  if (validation === null) return null
  const parts: string[] = []
  if (validation.markers.length > 0) {
    parts.push(plural(validation.markers.length, 'marker'))
  }
  const draws = validation.measurements.distinct_draw_days
  if (draws.length > 0) {
    parts.push(`draws at day ${draws.join(', ')}`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * The predict line: "38 patients" — the predict-mode validate's
 * measurements summary (the distinct-patient count of the table the run
 * will predict for, TEST-FV-9's "predict-mode cohort"). Only the
 * predict-mode validation describes the predict file: in the train-mode
 * flow the store's validation is the train tables', whose measurements
 * summary is a DIFFERENT table's cohort — so the count stays null there
 * rather than showing the wrong number.
 */
function predictSummary(snapshot: TxrSlotSnapshot): string | null {
  if (snapshot.mode !== 'predict') return null
  const validation = snapshot.validation
  if (validation === null) return null
  return plural(validation.measurements.patients, 'patient')
}

/**
 * The three slots of the snapshot, in the board's order, each with the
 * facts the store carries. A slot without an adopted file is omitted
 * (TEST-RUN-13's "omit a slot without data") — the rows render only what
 * the user actually uploaded.
 */
export function buildSlotSummaries(snapshot: TxrSlotSnapshot): TxrSlotSummarySlot[] {
  const out: TxrSlotSummarySlot[] = []
  const patients = snapshot.patients
  if (patients !== null) {
    out.push({
      kind: 'patients',
      sourceName: patients.source.name,
      summaryText: patientsSummary(snapshot.validation),
    })
  }
  const measurements = snapshot.measurements
  if (measurements !== null) {
    out.push({
      kind: 'measurements',
      sourceName: measurements.source.name,
      summaryText: measurementsSummary(snapshot.validation),
    })
  }
  const predict = snapshot.predictMeasurements
  if (predict !== null) {
    out.push({
      kind: 'predict',
      sourceName: predict.source.name,
      summaryText: predictSummary(snapshot),
    })
  }
  return out
}

/**
 * The first input the run's mode still misses, for the empty state's
 * named-missing-piece line (DEC-16: nothing partial renders half-broken;
 * the state names what is missing). `null` = the mode's inputs are
 * present — the E screen renders.
 */
export function runSetupMissing(
  snapshot: Pick<IntakeSnapshot, 'mode' | 'patients' | 'measurements' | 'predictMeasurements'>,
): TxrSlotKind | null {
  if (snapshot.mode === 'predict') {
    return snapshot.predictMeasurements === null ? 'predict' : null
  }
  if (snapshot.patients === null) return 'patients'
  if (snapshot.measurements === null) return 'measurements'
  return null
}
