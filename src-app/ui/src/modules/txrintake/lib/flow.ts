/**
 * txrintake screen-C/N file flow — ITEM-6 (PROV-UI-INTAKE-4).
 *
 * The pure functions between a dropped `File` and the two file cards:
 *
 * - `inspectRequest` / `validateRequest` — the EXACT PROV-FV-2/3 request
 *   bodies (the browser decode is CONS-UI-INTAKE-7's own library, consumed
 *   here, never re-implemented); `validateRequest` maps the module's
 *   `'study'` mode to the provider's wire spelling `'files'`
 *   (see `toValidationMode`).
 * - `hasErrorProblems` — the DEC-10 Continue gate (errors block, warnings
 *   do not).
 * - `resolveJoins` / `resolveMapping` — the offers the validate response
 *   implies. DEC-9: nothing is ever auto-joined; a spelling-variant column
 *   (`MarkerColumn.spellings.length > 1`) becomes ONE JOIN OFFER per group
 *   (the server's A03 question), and a vocabulary ladder match is
 *   auto-accepted only for `exact` / `alias` / `standard_id` (the same
 *   marker by the vocabulary's own declaration) while `fuzzy` stays a
 *   confirm offer. Both take the ALREADY-CONFIRMED lists (`joins` /
 *   `mapping`) so an accepted group never re-offers, and an optional
 *   `dismissed` set is the page's record of the user's "not now" answers.
 * - `cardProblems` — the per-card problem list: the card's OWN inspect
 *   problems first (PROV-FV-2), then the validation problem set's rows that
 *   belong to this card. The validate response's `problems` array carries
 *   both tables' rows with no side tag, so a validation problem is claimed
 *   by (a) identity with the card's inspect problems, (b) the other card's
 *   identity (a patients-file row is never the measurements card's), and
 *   (c) the code/column side table below (cross-table, unit, join and
 *   outcome rows that inspect never sees). The fallback is the
 *   measurements side — the board's problem detail list lives on the
 *   measurements card, and every inspect-reproducible row was already
 *   claimed by (a)/(b).
 * - `patientsStatus` / `measurementsStatus` — the green card box lines,
 *   data-filled from the validate response (board strings; the numbers are
 *   the provider's, never design examples). The counts use `lib/format.ts`'s
 *   row-label builders (`pluralize` / `rowLabel`) so the board's own
 *   "1,102 rows" grouping renders (ITEM-8's wiring); `measurementsStatus`
 *   is the C screen's box (the board-N line with the C "Ready." terminator,
 *   per ITEM-6); `predictMeasurementsStatus` is the N screen's OWN box —
 *   the same line with the board-N continuation ("Next you choose the
 *   models that can run on it.", ITEM-7).
 */

import type {
  FileInspection,
  FileInspectionRequest,
  FileProblem,
  FileTableKind,
  MarkerColumn,
  MarkerMapping,
  MarkerMatch,
  ParsedTable as EngineTable,
  ValidationRequest,
  ValidationResponse,
} from '@/api-client/types'
import type { ParsedTable } from '@/lib/txr-files/types'
import type { IntakeSnapshot, JoinOffer, VocabOffer } from '../types'
import { pluralize, rowLabel } from './format'

/**
 * The provider's wire spelling for the C screen. The generated
 * `ValidationMode` is `'files' | 'predict'` — the plan's `'study'` word is
 * the one the study-literal guard bans across `src-app/**`, so the wire
 * value is the provider's own word for the same screen (the plan's
 * PROV-FV-3 `mode: "study"|"predict"` reading is the CONSUMER's vocabulary;
 * the request body's byte is the provider's, DRIFT-1 ITEM-6).
 */
export function toValidationMode(mode: IntakeSnapshot['mode']): ValidationRequest['mode'] {
  return mode === 'study' ? 'files' : 'predict'
}

/** The exact PROV-FV-2 inspect body: one file, its decoded table, its kind. */
export function inspectRequest(kind: FileTableKind, table: ParsedTable): FileInspectionRequest {
  return { kind, table: toEngineTable(table) }
}

/** The exact PROV-FV-3 validate body for a snapshot (CONS-UI-INTAKE-5). */
export function validateRequest(
  mode: IntakeSnapshot['mode'],
  s: IntakeSnapshot,
): ValidationRequest {
  const measurements = mode === 'predict' ? s.predictMeasurements : s.measurements
  if (!measurements) {
    throw new Error(
      'TxrIntake: no measurements file adopted — validate needs the measurements table',
    )
  }
  const request: ValidationRequest = {
    mode: toValidationMode(mode),
    measurements: toEngineTable(measurements.table),
    joins: s.joins,
    mapping: s.mapping,
    parameters: {
      decision_day: s.parameters.decision_day,
      baseline_max_day: s.parameters.baseline_max_day,
    },
  }
  // Study mode: the patients table rides along when adopted. Predict mode
  // has NO patients side (PROV-FV-3: MISSING_PATIENTS does not apply) — the
  // plan's `patients: null` renders as the key OMITTED: the generated type
  // declares the field optional (serde `Option<ParsedTable>`), so the wire
  // bytes for "no patients side" are the same under either spelling, and
  // the type never carries a `null` literal (DRIFT-1 ITEM-6).
  if (mode === 'study' && s.patients) {
    request.patients = toEngineTable(s.patients.table)
  }
  return request
}

/** DEC-10: any error-severity problem disables Continue; warnings never do. */
export function hasErrorProblems(problems: readonly FileProblem[]): boolean {
  return problems.some(p => p.severity === 'error')
}

/** The spelling-variant join offers the validate response implies. */
export function resolveJoins(
  markers: readonly MarkerColumn[],
  confirmed: readonly JoinOffer[],
  dismissed?: ReadonlySet<string>,
): JoinOffer[] {
  const confirmedKeys = new Set(confirmed.map(join => join.key))
  const offers: JoinOffer[] = []
  for (const column of markers) {
    if (column.spellings.length <= 1) continue
    if (confirmedKeys.has(column.key)) continue
    if (dismissed?.has(column.key) === true) continue
    offers.push({ variants: [...column.spellings], key: column.key })
  }
  return offers
}

/** The mapping resolution of one validate response (DEC-9). */
export interface MappingResolution {
  /**
   * The auto-accepted non-fuzzy ladder matches (`exact` / `alias` /
   * `standard_id`) — the same marker by the vocabulary's own declaration,
   * recorded as `accepted: true` offers (the store's `acceptVocab` is the
   * ONE mapping writer; the page replays these through it).
   */
  auto: VocabOffer[]
  /** The `fuzzy` candidates awaiting the user's confirm (`accepted: null`). */
  offers: VocabOffer[]
}

/** The ladder priority of one match (the server emits `exact` → `alias` → `standard_id` → `fuzzy`). */
function firstAutoMatch(matches: readonly MarkerMatch[]): MarkerMatch | undefined {
  return matches.find(match => match.match_kind !== 'fuzzy')
}

/** The vocabulary offers + auto-mappings the validate response implies. */
export function resolveMapping(
  markers: readonly MarkerColumn[],
  confirmed: readonly MarkerMapping[],
  dismissed?: ReadonlySet<string>,
): MappingResolution {
  const confirmedKeys = new Set(confirmed.map(mapping => mapping.key))
  const auto: VocabOffer[] = []
  const offers: VocabOffer[] = []
  for (const column of markers) {
    if (confirmedKeys.has(column.key)) continue
    if (dismissed?.has(column.key) === true) continue
    const best = firstAutoMatch(column.vocabulary)
    if (best !== undefined) {
      auto.push({ key: column.key, match: best, accepted: true })
      continue
    }
    const fuzzy = column.vocabulary[0]
    if (fuzzy !== undefined) {
      offers.push({ key: column.key, match: fuzzy, accepted: null })
    }
  }
  return { auto, offers }
}

/** The measurement-side column names (a problem on one of them is value-side). */
const MEASUREMENTS_COLUMNS: ReadonlySet<string> = new Set([
  'day',
  'marker',
  'value',
  'unit',
  'patient_id, day, marker',
])

/** The patients-side column names (a problem on one of them is patient-side). */
const PATIENTS_COLUMNS: ReadonlySet<string> = new Set([
  'patient_id',
  'pfs_days',
  'pfs_event',
  'os_days',
  'os_event',
  'responder',
  'response_day',
  'time_unit',
])

/** Problem codes inspect can never produce: cross-table, units, joins, notices. */
const MEASUREMENTS_CODES: ReadonlySet<string> = new Set([
  'R08',
  'R09',
  'R10',
  'R11',
  'R13',
  'R15',
  'R16',
  'R17',
  'R20',
  'A04',
  'A05',
  'A06',
  'A07',
])

/** Problem codes that are patient-file facts (outcomes, shape, units of time). */
const PATIENTS_CODES: ReadonlySet<string> = new Set([
  'R05',
  'R06',
  'R12',
  'R14',
  'R18',
  'R19',
])

/** The identity of one problem (a validation row claimed by the SAME inspect row). */
function problemKey(problem: FileProblem): string {
  return `${problem.code}\u0000${problem.row ?? ''}\u0000${problem.column ?? ''}`
}

/** Which card owns an inspection-unclaimed validation problem (code/column table). */
function sideOf(problem: FileProblem): FileTableKind {
  const column = problem.column ?? ''
  // The cross-table / unit / notice codes are measurement-side by DEFINITION
  // (a value row, a marker column, a file notice) even when their column is
  // named `patient_id` (R08/R15 reference the patients file FROM the value
  // rows).
  if (MEASUREMENTS_CODES.has(problem.code)) return 'measurements'
  if (PATIENTS_CODES.has(problem.code)) return 'patients'
  if (MEASUREMENTS_COLUMNS.has(column)) return 'measurements'
  if (PATIENTS_COLUMNS.has(column) || column.startsWith('covariate:')) return 'patients'
  // A null-column shared code (R02/A01/A02 header rows) that no inspect
  // claimed: the measurements side is the home of the board's problem detail
  // list (the identity claims above already caught every inspect-reproducible
  // occurrence).
  return 'measurements'
}

/**
 * One card's current problem list: the card's OWN inspect problems first
 * (the plan's documented order), then the validation rows that belong to
 * this card. A validation row identical to a card's inspect row is already
 * shown (never duplicated); a row identical to the OTHER card's inspect row
 * is the other card's; an A03 spelling-variant row is NOT listed here at
 * all — the join OFFER row is its representation (the A03 message would
 * duplicate the offer's own question, and the offer carries the answer
 * affordance).
 */
export function cardProblems(
  kind: FileTableKind,
  inspection: FileInspection | null,
  otherInspection: FileInspection | null,
  validation: ValidationResponse | null,
): FileProblem[] {
  const own = new Set((inspection?.problems ?? []).map(problemKey))
  const other = new Set((otherInspection?.problems ?? []).map(problemKey))
  const out: FileProblem[] = [...(inspection?.problems ?? [])]
  for (const problem of validation?.problems ?? []) {
    if (problem.code === 'A03') continue
    if (own.has(problemKey(problem))) continue
    if (other.has(problemKey(problem))) continue
    if (sideOf(problem) === kind) out.push(problem)
  }
  return out
}

/** One card's green box: the heading line + the detail line (board strings). */
export interface CardStatus {
  heading: string
  line: string
}

/** "✓ N patients read | Found N rows, N progressions or deaths, median follow-up N days. Ready." */
export function patientsStatus(response: ValidationResponse): CardStatus {
  const patients = response.patients
  // `== null` (NOT `=== undefined`): the provider's `Option` emits JSON
  // `null` for the absent shape while the generated type renders it
  // optional-only (the qa-fixes RES-01 null-vs-undefined rule) — a table
  // with no patient-row summary is the honest "patients read" card, never
  // a "reading 'rows'" crash.
  if (patients == null) {
    return { heading: '✓ patients read', line: 'Ready.' }
  }
  const detail: string[] = [`Found ${rowLabel(patients.rows)}`]
  detail.push(`${patients.with_primary_outcome} progressions or deaths`)
  if (patients.median_followup_days !== undefined) {
    detail.push(`median follow-up ${patients.median_followup_days} days`)
  }
  return {
    heading: `✓ ${pluralize(patients.rows, 'patient')} read`,
    line: `${detail.join(', ')}. Ready.`,
  }
}

/** "a, b and c" — the status line's list join (no Oxford comma, board style). */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The maximum marker names on one status line (the board box's own clip). */
const STATUS_MARKER_CLIP = 6

/**
 * "✓ 38 patients read | Found 1,102 rows: markers ctDNA, LDH, …; draws at
 * day 0, 14, 28 and 56. Ready." — the measurements card's green box, the
 * board-N line with the C screen's Ready terminator.
 * `measurements.patients` is the distinct-patient count of the measurements
 * file, `rows` the value rows, `markers` the resolved column keys,
 * `distinct_draw_days` the schedule the file actually carries.
 */
export function measurementsStatus(response: ValidationResponse): CardStatus {
  const measurements = response.measurements
  return {
    heading: `✓ ${pluralize(measurements.patients, 'patient')} read`,
    line: `${measurementsDetail(response)}. Ready.`,
  }
}

/**
 * "✓ 38 patients read | Found 1,102 rows: markers ctDNA, LDH, …; draws at
 * day 0, 14, 28 and 56. Next you choose the models that can run on it." —
 * the N screen's green box (board PredictFiles.dc.html, ITEM-7): the same
 * data-filled detail as `measurementsStatus` with the board's own
 * continuation in place of the C screen's "Ready." terminator. The doubled
 * detail builder keeps the two boards' terminators in one place; the
 * heading ("✓ N patients read") and the marker/draw facts are the
 * provider's, never design examples.
 */
export function predictMeasurementsStatus(response: ValidationResponse): CardStatus {
  const measurements = response.measurements
  return {
    heading: `✓ ${pluralize(measurements.patients, 'patient')} read`,
    line: `${measurementsDetail(response)}. Next you choose the models that can run on it.`,
  }
}

/**
 * The measurements detail line's body — "Found 1,102 rows: markers ctDNA,
 * LDH, …; draws at day 0, 14, 28 and 56" — the shared part of the two
 * status lines (C's "Ready." terminator, N's board continuation).
 */
function measurementsDetail(response: ValidationResponse): string {
  const measurements = response.measurements
  const markers = response.markers.map(column => column.key)
  const shown = markers.slice(0, STATUS_MARKER_CLIP)
  const clipped = markers.length > STATUS_MARKER_CLIP ? '…' : ''
  let line = `Found ${rowLabel(measurements.rows)}`
  if (shown.length > 0) line += `: markers ${joinNames(shown)}${clipped}`
  if (measurements.distinct_draw_days.length > 0) {
    line += `; draws at day ${joinNames(measurements.distinct_draw_days.map(String))}`
  }
  return line
}

/**
 * The lib's decoded `ParsedTable` crossing into the generated engine types —
 * the same openapi-generator artifact ITEM-3's builder bridges at
 * `TxrRunInput` (the generated `ParsedTable.rows` is `string | null[][]`
 * while the decode library's is `(string | null)[][]`; the wire bytes are
 * identical). One bridge per consumer file, never a vendor copy; the fix is
 * the provider regen's (DRIFT-1 ITEM-3 #3).
 */
function toEngineTable(table: ParsedTable): EngineTable {
  return table as unknown as EngineTable
}
