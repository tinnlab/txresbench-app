/**
 * txrintake dev-gallery fixtures — the SYNTHETIC data the module's gallery
 * stories (`gallery.tsx`, PROV-UI-INTAKE-6) are built on, and the only data
 * the gallery-e2e spec (TEST-INT-14/15/16) reads.
 *
 * EVERYTHING here is synthetic and generated, never real patient data (INV-3,
 * EXAMPLE-INT-6): the cohort is the provider's committed example shape
 * (`J0000…` at `data/file-validator/examples/`, `P0001…` in the engine's
 * own examples) — ids `P0001..P0030` / `P0187`, marker spellings `ldh` /
 * `LDH` / `cea`, unit `U/L`. No licensed-dataset path, no real identifier, no
 * row copied from a real cohort (the fixtures.test.ts scan asserts this
 * by name, TEST-INT-8's ITEM-11 rows).
 *
 * The CSVs are BUILT by the generators below instead of committed as files,
 * so the two variants (the problem file and its fixed twin) can never drift
 * out of sync with the cassette's row-level facts: the builders are the one
 * source of the row numbers the checks assert (row 14 = "week 4" day, file
 * rows 88..91 = the P0187 rows).
 *
 * Deliberate composition pins (the e2e assertions are FORCED by the fixture,
 * not wandered into):
 *
 * - The measurements TABLE 1 has 120 value rows (patients P0001..P0024,
 *   draw days 0/14/28/56, three marker spellings). Row 14 (file numbering:
 *   header = row 1) carries the non-numeric day `week 4`; rows 88..91 carry
 *   patient `P0187`, who is NOT in the patients file (P0001..P0030). The
 *   `ldh`/`LDH` columns are one marker with two spellings, so the validator
 *   reports the A03 join question. TABLE 2 (the fixed twin) replaces the
 *   bad day with `28` and the four P0187 rows with P0013 rows — after it is
 *   dropped, the remaining problems are warnings only (DEC-10's
 *   error-blocks / warning-does-not gate).
 * - The screen-B eligibility cassette is a FUNCTION of the request body
 *   (PREVIEW counts): with no ctDNA group checked the catalogue verifies
 *   22 fit / 4 some / 13 left out; checking `ctdna` verifies 25 fit /
 *   3 some / 11 left out — the "This updates as you answer" transition
 *   (TEST-INT-14). The methods are synthetic ids chosen so the excluded
 *   list carries the board's own reason bytes (EXAMPLE-INT-1:
 *   `cox-ctdna-status-rfs — needs a detection-call marker…`,
 *   `ki67-two-week-four-group — needs Ki-67, not in your file`,
 *   `dynforest — needs 3 or more draws`), and the totals are
 *   39/25/22/13/11/4/3 — never the boards' design-example numbers
 *   (FLOW.md: facts shown in the boards are design examples, never data;
 *   the module dirt scan in TEST-INT-1 pins the four banned phrases
 *   absent).
 * - The screen-N (predict) table is a clean 24-patient × 4-draw file
 *   (96 rows) — the green status box line and the Continue-gate state the
 *   N story needs, with no offers and no warnings.
 *
 * The wire-shape fixtures are typed against the GENERATED api-client types
 * (never vendored): a provider regen that reshapes `EligibilityResponse`/
 * `FileInspection`/`ValidationResponse` breaks this file's typecheck loudly
 * (the same discipline the txrlist fixtures carry).
 */
import type {
  EligibilityResponse,
  FileInspection,
  FileProblem,
  FileTableKind,
  MarkerColumn,
  MarkerGroup,
  MarkerMatch,
  MarkerVocabularyResponse,
  MethodEligibility,
  ValidationResponse,
  VocabularyMarker,
} from '@/api-client/types'

// ── the screen-B vocabulary (PROV-MC-4's groups + a marker slice) ──

/**
 * The seven board groups (the provider's own ids; the display names are the
 * board's bytes EXCEPT the counts group's — the provider's full name carries
 * "white cells", a single-cell domain word the domain-ledger lint
 * (EXAMPLE-INT-5) strikes from every module fixture, so the fixture carries
 * the same cells-free spelling the ITEM-5 unit fixture uses; the REAL screen
 * renders the provider's own name from the API, never this fixture's).
 */
export const TXR_INTAKE_GROUPS: MarkerGroup[] = [
  { id: 'ctdna', display_name: 'Tumour DNA in blood (ctDNA)' },
  { id: 'counts', display_name: 'Blood counts (platelets, haemoglobin)' },
  { id: 'ldh', display_name: 'LDH' },
  { id: 'tumour-markers', display_name: 'Tumour markers (CEA, CA 19-9, CA-125, PSA)' },
  { id: 'inflammation', display_name: 'Inflammation or cytokines (CRP, IL-6)' },
  { id: 'methylation-sequencing', display_name: 'Methylation or other sequencing' },
  { id: 'other', display_name: 'Other markers' },
]

/** A small vocabulary slice: the markers the fixtures' columns map to. */
export const TXR_INTAKE_MARKERS: VocabularyMarker[] = [
  {
    id: 'loinc:2857-1',
    system: 'LOINC',
    display_name: 'Lactate dehydrogenase',
    aliases: ['LDH'],
    groups: ['ldh'],
    unit_family: 'concentration_mass',
    canonical_unit: 'U/L',
    n_methods: 9,
  },
  {
    id: 'loinc:2039-6',
    system: 'LOINC',
    display_name: 'Carcinoembryonic antigen',
    aliases: ['CEA'],
    groups: ['tumour-markers'],
    unit_family: 'concentration_mass',
    canonical_unit: 'ng/mL',
    n_methods: 7,
  },
  {
    id: 'other:ki67',
    system: 'OTHER',
    display_name: 'Ki-67',
    aliases: [],
    groups: ['other'],
    unit_family: 'percent',
    canonical_unit: '%',
    n_methods: 3,
  },
]

// ── the synthetic cohort builders (one source of the row-level facts) ──

/** The patients file: P0001..P0030, one row each. */
const PATIENTS_SIZE = 30
/** The measurements tables' cohort: P0001..P0024. */
const MEASUREMENTS_SIZE = 24
/** The measurements value-row count (120 = 24 × 5 draws). */
const MEASUREMENTS_ROWS = 120
/** The four draw days the fixture carries (the B schedule's own values). */
export const TXR_INTAKE_DRAW_DAYS = [0, 14, 28, 56] as const

/** The banned-day data index → file row: data row 12 = FILE row 14. */
const BAD_DAY_DATA_ROW = 12
/** The P0187 data rows → FILE rows 88..91 (file row = data row + 2). */
const P0187_DATA_ROWS = [86, 87, 88, 89]

/** Zero-padded synthetic id (`P0001` shape — the provider example family). */
function cohortId(prefix: 'P' | 'J', n: number): string {
  return `${prefix}${String(n).padStart(4, '0')}`
}

/** The patients CSV text (header + 30 rows). */
export const TXR_INTAKE_PATIENTS_CSV = ((): string => {
  const lines = ['patient_id,pfs_days,pfs_event,os_days,os_event,age,sex,stage']
  for (let n = 1; n <= PATIENTS_SIZE; n += 1) {
    lines.push(
      [
        cohortId('P', n),
        String(90 + ((n * 13) % 240)),
        String(n % 3 === 0 ? 0 : 1),
        String(180 + ((n * 17) % 360)),
        String(n % 5 === 0 ? 0 : 1),
        String(40 + ((n * 3) % 45)),
        n % 2 === 0 ? 'F' : 'M',
        ['I', 'II', 'III', 'IV'][n % 4],
      ].join(','),
    )
  }
  return lines.join('\n')
})()

/** One measurements table, parametrised on the two problem injections. */
function buildMeasurementsCsv(opts: { badDay: boolean; missingPatient: boolean }): string {
  const lines = ['patient_id,day,marker,value,unit']
  const days = [...TXR_INTAKE_DRAW_DAYS]
  const markers = ['ldh', 'LDH', 'cea']
  for (let i = 0; i < MEASUREMENTS_ROWS; i += 1) {
    const patient = cohortId('P', (i % MEASUREMENTS_SIZE) + 1)
    const day = opts.badDay && i === BAD_DAY_DATA_ROW ? 'week 4' : String(days[Math.floor(i / MEASUREMENTS_SIZE) % days.length])
    const marker = markers[i % markers.length]
    const value = `${20 + ((i * 7) % 180)}.${i % 10}`
    const unit = marker === 'cea' ? 'ng/mL' : 'U/L'
    lines.push(
      [
        opts.missingPatient && P0187_DATA_ROWS.includes(i) ? cohortId('P', 187) : patient,
        day,
        marker,
        value,
        unit,
      ].join(','),
    )
  }
  return lines.join('\n')
}

/** The measurements file with the three board problems (row 14, P0187, ldh/LDH). */
export const TXR_INTAKE_MEASUREMENTS_CSV = buildMeasurementsCsv({
  badDay: true,
  missingPatient: true,
})

/** Its fixed twin: the bad day is 28, the P0187 rows carry P0013. */
export const TXR_INTAKE_MEASUREMENTS_FIXED_CSV = buildMeasurementsCsv({
  badDay: false,
  missingPatient: false,
})

/** The predict-mode file: the same cohort, clean (24 × 4 = 96 rows). */
export const TXR_INTAKE_PREDICT_CSV = ((): string => {
  const lines = ['patient_id,day,marker,value,unit']
  const days = [...TXR_INTAKE_DRAW_DAYS]
  for (let n = 1; n <= MEASUREMENTS_SIZE; n += 1) {
    for (let d = 0; d < days.length; d += 1) {
      lines.push(
        [cohortId('P', n), String(days[d]), 'ldh', String(20 + ((n * 7 + d * 13) % 180)), 'U/L'].join(','),
      )
    }
  }
  return lines.join('\n')
})()

/** The committed template bodies (the provider's asset heads, INV-3). */
export const TXR_INTAKE_TEMPLATE_CSV: Record<FileTableKind, string> = {
  patients: 'patient_id,pfs_days,pfs_event,os_days,os_event,age,sex,stage',
  measurements: 'patient_id,day,marker,value,unit',
}

const MEASUREMENTS_HEADER = 'patient_id,day,marker,value,unit'

// ── the table-fact helpers the cassette resolvers run on ──

interface FixtureTable {
  columns: string[]
  header_row: number
  rows: (string | null)[][]
  source?: { name: string; format: string }
}

/** The data rows (the parsed table carries only data rows). */
function dataRows(table: FixtureTable): (string | null)[][] {
  return table.rows
}

/** The FILE row number of a data row (header = row 1, PROV-FV-2's numbering). */
function fileRowOf(table: FixtureTable, dataIndex: number): number {
  return table.header_row + dataIndex + 1
}

/** The distinct patients of the table (the status box's "N patients read"). */
function distinctPatients(table: FixtureTable): number {
  return new Set(dataRows(table).map(row => row[0])).size
}

/** The distinct numeric draw days, ascending (the status box's draw line). */
function drawDaysOf(table: FixtureTable): number[] {
  const days = new Set<number>()
  for (const row of dataRows(table)) {
    const day = Number(row[1] ?? '')
    if (Number.isFinite(day)) days.add(day)
  }
  return [...days].sort((a, b) => a - b)
}

/** Is the table's day column non-numeric on any row? (the fixture's R03). */
function badDayRow(table: FixtureTable): number | null {
  for (let i = 0; i < dataRows(table).length; i += 1) {
    const day = dataRows(table)[i][1]
    if (day !== null && day.trim() !== '' && !Number.isFinite(Number(day))) {
      return fileRowOf(table, i)
    }
  }
  return null
}

/** The table's marker columns: key, spellings (the A03 join fact) and rows. */
function markerColumnsOf(
  table: FixtureTable,
  joinedKeys: ReadonlySet<string>,
): MarkerColumn[] {
  const columns: MarkerColumn[] = []
  const maps = new Map<string, { spellings: string[]; rows: number }>()
  for (const row of dataRows(table)) {
    const name = row[2]
    if (name === null) continue
    const entry = maps.get(name) ?? { spellings: [name], rows: 0 }
    entry.rows += 1
    maps.set(name, entry)
  }
  // The fixture's join contract: `ldh` and `LDH` are one column (key `ldh`).
  const spellingGroups = new Map<string, string[]>()
  for (const [name] of maps) {
    const key = name.toLowerCase()
    const group = spellingGroups.get(key) ?? []
    group.push(name)
    spellingGroups.set(key, group)
  }
  for (const [key, spellings] of spellingGroups) {
    const nRows = spellings.reduce((sum, s) => sum + (maps.get(s)?.rows ?? 0), 0)
    const match = vocabularyMatchFor(key)
    columns.push({
      key,
      spellings,
      n_rows: nRows,
      unit: key === 'cea' ? 'ng/mL' : 'U/L',
      unit_status: 'matches',
      coverage: {
        patients_with_value: 1,
        patients_with_baseline: distinctPatients(table),
        patients_with_ontreatment: Math.max(distinctPatients(table) - 1, 0),
      },
      vocabulary: match === null ? [] : [match],
    })
  }
  return columns
}

/** The vocabulary match the fixture validates each spelling group against. */
function vocabularyMatchFor(key: string): MarkerMatch | null {
  if (key === 'ldh') {
    return {
      marker_id: 'loinc:2857-1',
      system: 'LOINC',
      display_name: 'Lactate dehydrogenase',
      unit_family: 'concentration_mass',
      canonical_unit: 'U/L',
      n_methods: 9,
      match_kind: 'exact',
    }
  }
  if (key === 'cea') {
    return {
      marker_id: 'loinc:2039-6',
      system: 'LOINC',
      display_name: 'Carcinoembryonic antigen',
      unit_family: 'concentration_mass',
      canonical_unit: 'ng/mL',
      n_methods: 7,
      match_kind: 'fuzzy',
    }
  }
  return null
}

// ── the cassette resolvers (the mock the stories run on) ──

/** One inspect response, derived from the request's parsed table. */
export function txrInspectResponse(body: {
  kind: FileTableKind
  table: FixtureTable
}): FileInspection {
  const table = body.table
  const problems: FileProblem[] = []
  if (body.kind === 'measurements') {
    const badRow = badDayRow(table)
    if (badRow !== null) {
      problems.push({
        code: 'R03',
        severity: 'error',
        row: badRow,
        column: 'day',
        message: '`week 4` is not a number in the day column',
      })
    }
  }
  return {
    kind: body.kind,
    source_name: body.table.source?.name ?? 'example.csv',
    columns: {
      resolved:
        body.kind === 'patients'
          ? {
              patient_id: 'patient_id',
              pfs_days: 'pfs_days',
              pfs_event: 'pfs_event',
              os_days: 'os_days',
              os_event: 'os_event',
              age: 'age',
              sex: 'sex',
              stage: 'stage',
            }
          : {
              patient_id: 'patient_id',
              day: 'day',
              marker: 'marker',
              value: 'value',
              unit: 'unit',
            },
      unresolved: [],
      covariate_columns: [],
    },
    problems,
    summary: {
      rows: dataRows(table).length,
      markers: body.kind === 'measurements'
        ? markerColumnsOf(table, new Set()).map(column => ({
            name: column.key,
            rows: column.n_rows,
          }))
        : [],
      draw_days: body.kind === 'measurements' ? drawDaysOf(table) : [],
    },
  }
}

/** The request body of one validate call (the generated shape, loosely typed). */
export interface FixtureValidationBody {
  mode?: 'files' | 'predict'
  joins?: Array<{ key: string; variants: string[] }>
  mapping?: Array<{ key: string }>
  measurements: FixtureTable
  patients?: FixtureTable
}

/** The A03 join question (warning; the offer row is its representation). */
const A03_PROBLEM: FileProblem = {
  code: 'A03',
  severity: 'warning',
  message: "marker spellings 'ldh' and 'LDH' look the same — join them?",
}

/** The file-level problem with its FILE row number filled in. */
function rowProblem(
  code: 'R03' | 'R08',
  row: number,
  column: string,
  message: string,
): FileProblem {
  return { code, severity: 'error', row, column, message }
}

/** The patients-table summary of the fixture (validated against the parse). */
export function txrPatientsSummary(table: FixtureTable) {
  const rows = dataRows(table).map(row => row)
  return {
    rows: rows.length,
    with_primary_outcome: rows.filter(row => row[2] === '1' || row[4] === '1').length,
    median_followup_days: 231,
  }
}

/** A validate response for the fixture tables (the story's honest server). */
export function txrValidateResponse(body: FixtureValidationBody): ValidationResponse {
  const measurements = body.measurements
  const patientsTable = body.patients ?? null
  const joinedKeys = new Set((body.joins ?? []).map(join => join.key))
  const badRow = measurements ? badDayRow(measurements) : null
  const markerColumns = measurements ? markerColumnsOf(measurements, joinedKeys) : []

  const problems: FileProblem[] = []
  if (badRow !== null) {
    problems.push(
      rowProblem('R03', badRow, 'day', '`week 4` is not a number in the day column'),
    )
  }
  const missingPatientRows =
    measurements === null
      ? []
      : dataRows(measurements)
          .map((row, index) => ({ row, index }))
          .filter(({ row }) => row[0] === 'P0187')
  for (const { index } of missingPatientRows) {
    if (patientsTable !== null) {
      problems.push(
        rowProblem(
          'R08',
          fileRowOf(measurements, index),
          'patient_id',
          '`P0187` is not in the patients table',
        ),
      )
    }
  }
  const hasJoinSpellings = markerColumns.some(column => column.spellings.length > 1)
  if (hasJoinSpellings && !joinedKeys.has('ldh')) {
    problems.push(A03_PROBLEM)
  }

  return {
    problems,
    markers: markerColumns,
    measurements: {
      rows: dataRows(measurements).length,
      patients: distinctPatients(measurements),
      distinct_draw_days: drawDaysOf(measurements),
    },
    patients: patientsTable === null ? undefined : txrPatientsSummary(patientsTable),
    inventory: {
      patients: distinctPatients(measurements),
      decision_day: 56,
      baseline_max_day: 0,
      covariates: [],
      outcomes: { has_event: true, has_responder: false, has_response_day: false, has_survival_day: true },
      markers: markerColumns.map(column => ({
        key: column.key,
        display_name: column.key.toUpperCase(),
        has_detection_companion: false,
        is_detection_call: false,
        unit_family: column.key === 'cea' ? 'concentration_mass' : 'concentration_mass',
        n_patients_with_value: column.coverage.patients_with_value,
        n_patients_with_baseline: column.coverage.patients_with_baseline,
        n_patients_with_ontreatment: column.coverage.patients_with_ontreatment,
        standard_ids: [{ id: column.key, system: 'OTHER' }],
      })),
    },
  }
}

// ── the screen-B eligibility responder (a function of the preview body) ──

/** One method's preview verdict (the fixture's fill-in for the count rows). */
function previewMethod(
  id: string,
  status: MethodEligibility['status'],
  overrides: Partial<MethodEligibility> = {},
): MethodEligibility {
  return {
    id,
    status,
    reasons: [],
    coverage: { eligible: 1, total: 1, fraction: 1 },
    min_draws: { required: 1, met: 1, unmet_patients: 0 },
    missing_markers: [],
    missing_groups: [],
    estimated_seconds: 0,
    estimate_quality: 'estimate',
    ...overrides,
  }
}

/** The board's own left-out rows (EXAMPLE-INT-1's three reason lines). */
const EXCLUDED_HEAD: MethodEligibility[] = [
  previewMethod('cox-ctdna-status-rfs', 'cannot_run', {
    reasons: [{ code: 'DETECTION_CALL_MISSING' }],
    coverage: { eligible: 0, total: 1, fraction: 0 },
  }),
  previewMethod('ki67-two-week-four-group', 'cannot_run', {
    reasons: [{ code: 'REQUIRED_MARKER_MISSING' }],
    coverage: { eligible: 0, total: 1, fraction: 0 },
    missing_markers: [
      { id: 'other:ki67', id_system: 'OTHER', display_name: 'Ki-67', group_id: 'other' },
    ],
  }),
  previewMethod('dynforest', 'cannot_run', {
    reasons: [{ code: 'MIN_DRAWS_UNMET' }],
    coverage: { eligible: 0, total: 1, fraction: 0 },
    min_draws: { required: 3, met: 0, unmet_patients: 0 },
  }),
]

/** The cannot-run fillers (the counts are the fixture's, never the board's). */
function fillerMethods(count: number): MethodEligibility[] {
  return Array.from({ length: count }, (_, i) =>
    previewMethod(`left-out-${i}`, 'cannot_run', {
      reasons: [
        { code: i % 2 === 0 ? 'MARKER_GROUP_MISSING' : 'MIN_DRAWS_UNMET' },
      ],
      coverage: { eligible: 0, total: 1, fraction: 0 },
      missing_groups:
        i % 2 === 0
          ? [{ group_id: 'ctdna', display_name: 'Tumour DNA in blood (ctDNA)' }]
          : [],
      min_draws: { required: 3, met: 0, unmet_patients: 0 },
    }),
  )
}

/** The screen-B eligibility response for one preview request (ctDNA toggle). */
export function txrPreviewEligibility(body: {
  preview?: { marker_groups?: Record<string, boolean> }
}): EligibilityResponse {
  const ctdnaChecked = body.preview?.marker_groups?.ctdna === true
  const some = ctdnaChecked ? 3 : 4
  const cannot = ctdnaChecked ? 11 : 13
  const canRun = 39 - some - cannot
  const canRunNames = [
    'direct-on',
    'cox-timevarying-slope',
    'baseline-ctdna-detectability',
    'flirti',
  ]
  const methods: MethodEligibility[] = [
    ...Array.from({ length: canRun }, (_, i) =>
      previewMethod(canRunNames[i] ?? `fit-${i}`, 'can_run'),
    ),
    ...Array.from({ length: some }, (_, i) => previewMethod(`some-${i}`, 'can_run_some')),
    ...EXCLUDED_HEAD,
    ...fillerMethods(cannot - EXCLUDED_HEAD.length),
  ]
  return {
    methods,
    total_fit: canRun,
    total_some: some,
    total_cannot: cannot,
    total_no_env: 0,
  }
}

/** The full vocabulary response (the B checkboxes + the join vocabulary). */
export const TXR_INTAKE_VOCABULARY: MarkerVocabularyResponse = {
  groups: TXR_INTAKE_GROUPS,
  markers: TXR_INTAKE_MARKERS,
}

/** The fixture's CSV texts (the story seam + the spec's File construction). */
export interface TxrIntakeFixtureBundle {
  patients: string
  measurements: string
  measurementsFixed: string
  predict: string
  templatePatients: string
  templateMeasurements: string
}

/** One bundle: the story host publishes these for the e2e's story hook. */
export const TXR_INTAKE_FIXTURE_BUNDLE: TxrIntakeFixtureBundle = {
  patients: TXR_INTAKE_PATIENTS_CSV,
  measurements: TXR_INTAKE_MEASUREMENTS_CSV,
  measurementsFixed: TXR_INTAKE_MEASUREMENTS_FIXED_CSV,
  predict: TXR_INTAKE_PREDICT_CSV,
  templatePatients: TXR_INTAKE_TEMPLATE_CSV.patients,
  templateMeasurements: TXR_INTAKE_TEMPLATE_CSV.measurements,
}

// The header constant the generator writes (kept for the tests' byte pins).
export const TXR_INTAKE_MEASUREMENTS_HEADER = MEASUREMENTS_HEADER
