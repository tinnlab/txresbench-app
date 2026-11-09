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
 * - qa-fixes ITEM-6's own additions: `parsePickedFile` (F4 — the pick
 *   guard: spreadsheet extensions only, empty files refused, then the ONE
 *   PROV-FV-7 decode), `resolveColumnRenames` / `renamedTable` (F2 — the
 *   column-mapping step: obvious-name suggestions, DEC-9-confirmed, never
 *   auto-applied), `fileHasNoDataRows` (F3 — a header-only file is an
 *   error, not a green "Found 0 rows" box), `formatFollowUpDays` (F6 —
 *   whole-day medians for display), the bounded `drawDaysSegment` (F7 —
 *   four days or a count) and the A01-noise suppression in `cardProblems`
 *   (F5a).
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
import { normalizeHeaderName, parseCsvFile } from '@/lib/txr-files/csv'
import { parseWorkbookFile } from '@/lib/txr-files/workbook'
import type { ColumnRenameOffer, IntakeSnapshot, JoinOffer, VocabOffer } from '../types'
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

// ─────────────────────────────────────────────────────────────────────────────
// ITEM-6 F4 — the pick guard (wrong file types and empty files reported
// plainly, before the decode pretends a binary file is a table)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A file the intake refuses at the door (qa-fixes ITEM-6, F4). The kit
 * `Upload`'s `accept` attribute only filters the OS picker — a drop or a
 * programmatic pick can hand over anything, and the old code parsed every
 * non-`.xlsx`/`.xls` file as CSV: a `.png` gave "7 problems in 0 rows" and
 * binary junk produced per-cell noise. The card's error line is the plain
 * sentence: "This is not a CSV or Excel file — choose a .csv or .xlsx file."
 * / "This file is empty — choose the file with its data."
 */
export class IntakeFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IntakeFileError'
  }
}

/** The spreadsheet glove (the same spellings the kit `Upload` accepts). */
const SPREADSHEET_EXTENSION = /\.(csv|xlsx|xls)$/i

/**
 * The ONE decode door of the intake (ITEM-6 F4): extension-guard the pick,
 * refuse the empty file, then decode through PROV-FV-7 (CSV or Excel — the
 * shared decode library, never re-implemented). The previous per-page
 * `parseIntakeFile` copies are gone; the guard and the decode live on the
 * flow so screen C, screen N and any future mount refuse the same files with
 * the same words.
 */
export async function parsePickedFile(
  file: File,
  kind: FileTableKind,
): Promise<Awaited<ReturnType<typeof parseCsvFile>>> {
  if (file.size === 0) {
    throw new IntakeFileError('This file is empty — choose the file with its data.')
  }
  if (!SPREADSHEET_EXTENSION.test(file.name)) {
    throw new IntakeFileError('This is not a CSV or Excel file — choose a .csv or .xlsx file.')
  }
  if (/\.xlsx$/i.test(file.name) || /\.xls$/i.test(file.name)) {
    return parseWorkbookFile(file, { kind })
  }
  return parseCsvFile(file, { kind })
}

/**
 * ITEM-6 F3 — a header with zero data rows is an ERROR, not a green "Found 0
 * rows. Ready." card. The fact is the file's own summary (`rows` counts the
 * value rows — the header is never a row); the card renders the honest red
 * state and Continue is gated on it (the validator has no word for an empty
 * table — the inspect/validate problem set is a shape contract over rows).
 */
export function fileHasNoDataRows(file: LoadedFileView | null): boolean {
  return file !== null && file.inspection !== null && file.inspection.summary.rows === 0
}

/** The minimal file facts the empty-table check reads (the card's file prop). */
export interface LoadedFileView {
  inspection: FileInspection | null
}

// ─────────────────────────────────────────────────────────────────────────────
// ITEM-6 F2 — the column-mapping step (renamed columns get a suggestion)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The column-renaming suggestion: the file's raw spelling (`from`) looks
 * like the app's canonical column (`to`), e.g. `pid` → `patient_id`. The
 * offer is a SUGGESTION — DEC-9's discipline, the same rule as the join and
 * vocabulary offers: the match is found automatically, the user confirms
 * (the mapping step). Accepted renames rewrite the table's columns before
 * the next inspect/validate, so the file is read exactly as if its header
 * carried the canonical spelling (the "matching names are found for you"
 * promise of the drop zone, which was unfulfilled for renamed columns).
 * (The shape itself lives in `types.ts` with the rest of the offer types.)
 */

/**
 * The closed "looks like" table (ITEM-6 F2). Keyed by the FOLDED spelling
 * (the browser twin of the server's `normalize_header_name`), one entry per
 * obvious name — deliberately the names the server's own alias table does
 * NOT resolve (there is no overlap, so the app never re-offers a spelling
 * the validator already reads): `pid` / `subject id` / `subjectid` for the
 * patient key, `study day` / `visit day` for the draw day, `analyte` /
 * `marker name` for the marker, `result` / `reading` / `measurement` for the
 * value and `uom` / `unit of measure` for the unit. Nothing here is
 * auto-applied: the offer row carries the confirmation.
 *
 * R2-4 note (evidence, no entry): a `units` header needs NO suggestion — the
 * validator's alias table already reads it (`rules.rs` `UNIT_ALIASES =
 * ["unit", "units"]`; pinned by its alias-resolution test and by the
 * fixture resolver below), so the unit is used, never "silently dropped".
 * Adding `units → unit` here would offer a rename for a column the provider
 * already reads.
 */
export const COLUMN_RENAMES: Readonly<Record<FileTableKind, Readonly<Record<string, string>>>> = {
  patients: {
    pid: 'patient_id',
    'subject id': 'patient_id',
    subjectid: 'patient_id',
  },
  measurements: {
    pid: 'patient_id',
    'subject id': 'patient_id',
    subjectid: 'patient_id',
    'study day': 'day',
    studyday: 'day',
    'visit day': 'day',
    visitday: 'day',
    analyte: 'marker',
    'marker name': 'marker',
    result: 'value',
    reading: 'value',
    measurement: 'value',
    uom: 'unit',
    'unit of measure': 'unit',
  },
}

/**
 * The column-renaming suggestions of one table (ITEM-6 F2): for each column
 * whose FOLDED spelling has an obvious canonical match, an offer. A column
 * already read by the validator (or already canonical) never offers — the
 * server's alias resolution is the validator's, this map is the suggestions
 * for everything it cannot read. The optional `dismissed` set is the page's
 * "not now" record (the same convention as the join/vocab resolvers).
 */
export function resolveColumnRenames(
  columns: readonly string[],
  kind: FileTableKind,
  dismissed?: ReadonlySet<string>,
): ColumnRenameOffer[] {
  const remap = COLUMN_RENAMES[kind]
  const offers: ColumnRenameOffer[] = []
  for (const column of columns) {
    if (dismissed?.has(column) === true) continue
    const to = remap[normalizeHeaderName(column)]
    if (to !== undefined && to !== column) {
      offers.push({ from: column, to })
    }
  }
  return offers
}

/** Apply one accepted rename to a decoded table (columns only — the rows
 *  carry the same cells; the source and header-row facts are unchanged). */
export function renamedTable(table: ParsedTable, offer: ColumnRenameOffer): ParsedTable {
  return {
    ...table,
    columns: table.columns.map(column => (column === offer.from ? offer.to : column)),
  }
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
 * affordance). A header-less table's per-role storm is suppressed: when the
 * card already shows A01 ("no recognizable header"), the R02/A02 rows are
 * the same one cause re-told once per role (ITEM-6 F5a — seven lines for
 * one cause); the A01 is the cause, the rest is noise.
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
  const hasNoHeader = (inspection?.problems ?? []).some(p => p.code === 'A01')
  for (const problem of validation?.problems ?? []) {
    if (problem.code === 'A03') continue
    if (hasNoHeader && (problem.code === 'R02' || problem.code === 'A02')) continue
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

/**
 * "✓ N patients read | Found N rows, N progressions or deaths, median
 * follow-up N days. Ready." — the patients box line, the board's words with
 * the HONEST counts (qa-fixes ITEM-6, F1): "N progressions or deaths" is the
 * validator's `primary_outcome_events` (the primary pair's indicator is 1 —
 * 82 events for a file whose 94 patients all carry an outcome), never
 * `with_primary_outcome` (patients with an outcome recorded — the old line
 * read it and reported "94 progressions or deaths").
 */
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
  detail.push(`${patients.primary_outcome_events} progressions or deaths`)
  if (patients.median_followup_days !== undefined) {
    detail.push(`median follow-up ${formatFollowUpDays(patients.median_followup_days)} days`)
  }
  return {
    heading: `✓ ${pluralize(patients.rows, 'patient')} read`,
    line: `${detail.join(', ')}. Ready.`,
  }
}

/**
 * A follow-up median for display (qa-fixes ITEM-6, F6): whole days when the
 * value is whole, one decimal otherwise — the board's "231 days", never
 * "215.72024826342715 days" (the median of the example file's raw floats).
 */
export function formatFollowUpDays(days: number): number {
  return Math.round(days * 10) / 10
}

/** "a, b and c" — the status line's list join (no Oxford comma, board style). */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The maximum marker names on one status line (the board box's own clip). */
const STATUS_MARKER_CLIP = 6

/** The maximum draw days spelled out on one status line (ITEM-6 F7 — the
 *  board's "draws at day 0, 14, 28 and 56" ceiling; a longer schedule reads
 *  as a count: the old line dumped all 93 days of the real file). */
const STATUS_DRAW_DAY_CLIP = 4

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
 * The draw-days segment of the status line (ITEM-6 F7): four or fewer days
 * keep the board's spelling ("draws at day 0, 14, 28 and 56"); more read as
 * a count with the schedule's span ("draws on 93 days (0 to 799)") — the
 * fact the box never stated (the 14-line paragraph of the real file was
 * unusable). Days render whole when whole, one decimal otherwise.
 */
function drawDaysSegment(days: readonly number[]): string {
  if (days.length <= STATUS_DRAW_DAY_CLIP) {
    return `draws at day ${joinNames(days.map(formatDrawDay))}`
  }
  const span = `(${formatDrawDay(Math.min(...days))} to ${formatDrawDay(Math.max(...days))})`
  return `draws on ${days.length} days ${span}`
}

/** A draw day for display — whole days as integers, one decimal otherwise. */
function formatDrawDay(day: number): string {
  const rounded = Math.round(day * 10) / 10
  return String(rounded)
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
    line += `; ${drawDaysSegment(measurements.distinct_draw_days)}`
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
