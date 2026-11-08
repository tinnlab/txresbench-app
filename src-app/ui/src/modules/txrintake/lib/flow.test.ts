// @vitest-environment jsdom
/**
 * TEST-INT-3 [acceptance, INV-2] — the C/N file flow lib (`lib/flow.ts`,
 * ITEM-6): `inspectRequest` + `validateRequest` build the EXACT PROV-FV-2/3
 * bodies (patient/inspect kinds; the module's `'study'` mode maps to the
 * provider's wire spelling `'files'`; `patients` rides in study mode and is
 * OMITTED in predict — the plan's `null` under the generated optional
 * field); `hasErrorProblems` is the DEC-10 Continue gate; `resolveJoins`
 * builds `{variants, key}` from `MarkerColumn.spellings.length > 1` (the
 * A03 group, never auto-joined) and `resolveMapping` auto-accepts
 * exact/alias/standard_id while surfacing fuzzy as a `VocabOffer`;
 * `cardProblems` splits the validate problem set onto the two cards
 * (identity + code/column rule); the status builders fill the board strings
 * from the response.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type {
  FileInspection,
  FileProblem,
  MarkerColumn,
  MarkerMatch,
  ValidationResponse,
} from '@/api-client/types'
import type { ParsedTable } from '@/lib/txr-files/types'
import {
  cardProblems,
  fileHasNoDataRows,
  formatFollowUpDays,
  hasErrorProblems,
  inspectRequest,
  measurementsStatus,
  parsePickedFile,
  patientsStatus,
  predictMeasurementsStatus,
  renamedTable,
  resolveColumnRenames,
  resolveJoins,
  resolveMapping,
  validateRequest,
} from './flow'
import type { IntakeSnapshot, JoinOffer, LoadedFile } from '../types'

const csv = (name: string, columns: string[], rows: (string | null)[][]): ParsedTable => ({
  source: { name, format: 'csv' },
  header_row: 1,
  columns,
  rows,
})

const PATIENTS_TABLE = csv('patients.csv', ['patient_id', 'pfs_days', 'pfs_event'], [
  ['P0001', '214', '1'],
])
const MEASUREMENTS_TABLE = csv('measurements.csv', ['patient_id', 'day', 'marker', 'value'], [
  ['P0001', '0', 'ldh', '210'],
])

function loadedFile(name: string, table: ParsedTable): LoadedFile {
  return {
    source: table.source,
    table,
    inspection: null,
    problems: [],
    prepared: false,
    joinOffers: [],
    vocabOffers: [],
    columnOffers: [],
  }
}

const joins: JoinOffer[] = [{ variants: ['ldh', 'LDH'], key: 'ldh' }]

function makeSnapshot(overrides: Partial<IntakeSnapshot> = {}): IntakeSnapshot {
  return {
    intent: 'train',
    mode: 'study',
    study: {
      disease: 'colorectal',
      treatment: null,
      outcome: 'progression-by-day',
      markerGroups: null,
      beforeTreatment: null,
      drawsDuringTreatment: null,
      lastDrawDay: null,
    },
    patients: loadedFile('patients.csv', PATIENTS_TABLE),
    measurements: loadedFile('measurements.csv', MEASUREMENTS_TABLE),
    predictMeasurements: null,
    joins,
    mapping: [{ key: 'ldh', marker_id: 'loinc:2857-1' }],
    parameters: { decision_day: 56, baseline_max_day: 0 },
    validation: null,
    ...overrides,
  }
}

function errorProblem(row: number | undefined = 14, column = 'day', message = 'week 4'): FileProblem {
  return { code: 'R03', severity: 'error', row, column, message }
}

const warningProblem: FileProblem = {
  code: 'A04',
  severity: 'warning',
  row: undefined,
  column: 'ldh',
  message: 'unit differs within a marker',
}

const inspectionOf = (kind: 'patients' | 'measurements'): FileInspection => ({
  kind,
  source_name: kind === 'patients' ? 'patients.csv' : 'measurements.csv',
  columns: {
    resolved: { patient_id: 'patient_id' },
    unresolved: [],
    covariate_columns: [],
  },
  problems: [],
  summary: { rows: 1, markers: [], draw_days: [] },
})

const exactMatch: MarkerMatch = {
  marker_id: 'loinc:2857-1',
  system: 'LOINC',
  display_name: 'Lactate dehydrogenase',
  unit_family: 'concentration_mass',
  canonical_unit: 'U/L',
  n_methods: 12,
  match_kind: 'exact',
}

const fuzzyMatch: MarkerMatch = {
  marker_id: 'loinc:2857-1',
  system: 'LOINC',
  display_name: 'Lactate dehydrogenase',
  unit_family: 'concentration_mass',
  canonical_unit: 'U/L',
  n_methods: 12,
  match_kind: 'fuzzy',
}

function markerColumn(overrides: Partial<MarkerColumn> = {}): MarkerColumn {
  return {
    key: 'ldh',
    spellings: ['ldh', 'LDH'],
    n_rows: 4,
    unit: 'U/L',
    unit_status: 'matches',
    coverage: {
      patients_with_value: 2,
      patients_with_baseline: 2,
      patients_with_ontreatment: 1,
    },
    vocabulary: [exactMatch],
    ...overrides,
  }
}

const ldhColumn = markerColumn()
const ceaColumn = markerColumn({
  key: 'cea',
  spellings: ['cea'],
  vocabulary: [fuzzyMatch],
})

function responseOf(overrides: Partial<ValidationResponse> = {}): ValidationResponse {
  return {
    problems: [errorProblem(14, 'day', '`week 4` is not a number in the day column')],
    markers: [ldhColumn, ceaColumn],
    measurements: {
      rows: 102,
      patients: 38,
      distinct_draw_days: [0, 14, 28, 56],
    },
    patients: { rows: 151, with_primary_outcome: 62,
    primary_outcome_events: 62, median_followup_days: 231 },
    inventory: {
      baseline_max_day: 0,
      decision_day: 56,
      patients: 151,
      covariates: [],
      markers: [],
    },
    ...overrides,
  }
}

describe('lib/flow.ts (TEST-INT-3, ITEM-6)', () => {
  beforeEach(() => {
    // vitest restores nothing here; a failed assertion leaves the fixtures
    // pure for the next test (all fixtures are module constants).
  })

  it('inspectRequest builds the exact PROV-FV-2 body for each kind', () => {
    const patients = inspectRequest('patients', PATIENTS_TABLE)
    expect(patients.kind).toBe('patients')
    expect(patients.table.columns).toEqual(['patient_id', 'pfs_days', 'pfs_event'])
    expect(patients.table.source.name).toBe('patients.csv')

    const measurements = inspectRequest('measurements', MEASUREMENTS_TABLE)
    expect(measurements.kind).toBe('measurements')
    expect(measurements.table.columns).toEqual(['patient_id', 'day', 'marker', 'value'])
  })

  it('validateRequest builds the exact PROV-FV-3 study body from the snapshot', () => {
    const request = validateRequest('study', makeSnapshot())
    expect(request.mode).toBe('files')
    expect(request.measurements.rows).toEqual(MEASUREMENTS_TABLE.rows)
    expect(request.patients?.rows).toEqual(PATIENTS_TABLE.rows)
    expect(request.joins).toEqual(joins)
    expect(request.mapping).toEqual([{ key: 'ldh', marker_id: 'loinc:2857-1' }])
    expect(request.parameters).toEqual({ decision_day: 56, baseline_max_day: 0 })
  })

  it('validateRequest omits the patients side in predict mode (the plan: patients null)', () => {
    const snapshot = makeSnapshot({
      mode: 'predict',
      patients: null,
      predictMeasurements: loadedFile('next.csv', MEASUREMENTS_TABLE),
    })
    const request = validateRequest('predict', snapshot)
    expect(request.mode).toBe('predict')
    expect(request.measurements.rows).toEqual(MEASUREMENTS_TABLE.rows)
    expect(request.patients).toBeUndefined()
    expect('patients' in request).toBe(false)
  })

  it('hasErrorProblems gates Continue on severity (DEC-10)', () => {
    expect(hasErrorProblems([errorProblem()])).toBe(true)
    expect(hasErrorProblems([warningProblem])).toBe(false)
    expect(hasErrorProblems([warningProblem, errorProblem(88, 'patient_id')])).toBe(true)
    expect(hasErrorProblems([])).toBe(false)
  })

  it('resolveJoins builds one offer per spelling-variant group, never the confirmed one', () => {
    const offers = resolveJoins([ldhColumn, ceaColumn], [])
    expect(offers).toEqual([{ variants: ['ldh', 'LDH'], key: 'ldh' }])

    const afterAccept = resolveJoins([ldhColumn, ceaColumn], joins)
    expect(afterAccept).toEqual([])

    const dismissed = new Set(['ldh'])
    expect(resolveJoins([ldhColumn], [], dismissed)).toEqual([])
    expect(resolveJoins([ldhColumn], [])).toEqual([{ variants: ['ldh', 'LDH'], key: 'ldh' }])
  })

  it('resolveMapping auto-accepts exact/alias/standard_id and surfaces fuzzy only', () => {
    const resolution = resolveMapping([ldhColumn, ceaColumn], [])
    expect(resolution.auto).toEqual([{ key: 'ldh', match: exactMatch, accepted: true }])
    expect(resolution.offers).toEqual([{ key: 'cea', match: fuzzyMatch, accepted: null }])

    // A confirmed key never re-offers and never re-maps.
    const confirmed = [{ key: 'ldh', marker_id: 'loinc:2857-1' }]
    expect(resolveMapping([ldhColumn, ceaColumn], confirmed).auto).toEqual([])
    expect(resolveMapping([ldhColumn, ceaColumn], confirmed).offers).toEqual([
      { key: 'cea', match: fuzzyMatch, accepted: null },
    ])

    // A dismissed key stays off the card.
    expect(resolveMapping([ceaColumn], [], new Set(['cea'])).offers).toEqual([])
  })

  it('cardProblems claims validation rows by inspect identity and column/code side', () => {
    // A validation R03 row identical to the measurements inspect's own R03
    // appears once, on the measurements card.
    const dayProblem = errorProblem(14, 'day', '`week 4` is not a number in the day column')
    const measurementsInspection = inspectionOf('measurements')
    measurementsInspection.problems = [dayProblem]
    const patientsInspection = inspectionOf('patients')
    const r08: FileProblem = {
      code: 'R08',
      severity: 'error',
      row: 88,
      column: 'patient_id',
      message: '`P0187` is not in the patients table',
    }
    const response = responseOf({
      problems: [dayProblem, warningProblem, r08],
    })

    const patientsProblems = cardProblems('patients', patientsInspection, measurementsInspection, response)
    const measurementsProblems = cardProblems(
      'measurements',
      measurementsInspection,
      patientsInspection,
      response,
    )

    // The shared day problem: identity-claimed by the measurements card, the
    // patients card does not duplicate it; the cross-table R08 (row 88,
    // patient_id column — a MEASUREMENTS row by its code even though the
    // column is named `patient_id`) belongs to the measurements card; the
    // unit warning (null row, marker column) also belongs to it.
    expect(patientsProblems).toEqual([])
    expect(measurementsProblems).toHaveLength(3)
    expect(measurementsProblems.map(p => p.row)).toEqual([14, undefined, 88])
    expect(measurementsProblems[1].severity).toBe('warning')
  })

  it('cardProblems sends patient-file outcome rows to the patients card', () => {
    const r14: FileProblem = {
      code: 'R14',
      severity: 'warning',
      row: undefined,
      column: undefined,
      message: 'fewer than 10 patients have an outcome',
    }
    const response = responseOf({ problems: [r14] })
    const patientsProblems = cardProblems('patients', inspectionOf('patients'), inspectionOf('measurements'), response)
    expect(patientsProblems).toHaveLength(1)
    expect(patientsProblems[0].code).toBe('R14')
    const measurementsProblems = cardProblems(
      'measurements',
      inspectionOf('measurements'),
      inspectionOf('patients'),
      response,
    )
    expect(measurementsProblems).toEqual([])
  })

  it('after a join is accepted the re-validation drops the A03 problem (EXAMPLE-INT-2)', () => {
    const a03: FileProblem = {
      code: 'A03',
      severity: 'warning',
      row: undefined,
      column: undefined,
      message: "marker spellings 'ldh' and 'LDH' look the same — join them?",
    }
    const before = responseOf({ problems: [errorProblem(), a03] })
    const afterAccept = responseOf({
      problems: [errorProblem()],
      markers: [markerColumn({ key: 'ldh', spellings: ['ldh', 'LDH'] })],
    })

    // The A03 row is never a generic problem line — the join OFFER row is
    // its representation (the offer carries the answer affordance).
    const beforeProblems = cardProblems(
      'measurements',
      inspectionOf('measurements'),
      inspectionOf('patients'),
      before,
    )
    expect(beforeProblems.some(p => p.code === 'A03')).toBe(false)
    // ... but the offer exists while it is unanswered, and disappears once
    // the join is confirmed.
    expect(resolveJoins(before.markers, [])).toEqual([{ variants: ['ldh', 'LDH'], key: 'ldh' }])
    expect(resolveJoins(afterAccept.markers, joins)).toEqual([])
  })

  it('patientsStatus fills the board box from the patients summary', () => {
    expect(patientsStatus(responseOf())).toEqual({
      heading: '✓ 151 patients read',
      line: 'Found 151 rows, 62 progressions or deaths, median follow-up 231 days. Ready.',
    })
    const noMedian = responseOf()
    noMedian.patients = { rows: 4, with_primary_outcome: 1,
    primary_outcome_events: 1, median_followup_days: undefined }
    expect(patientsStatus(noMedian).line).toBe('Found 4 rows, 1 progressions or deaths. Ready.')
    // The wire's `null` IS the generator's "no property" (qa-fixes RES-01):
    // a validation response with no patient summary reads the honest
    // "patients read / Ready." card — never a "reading 'rows'" crash.
    const noPatients = responseOf()
    noPatients.patients = null as unknown as ValidationResponse['patients']
    expect(patientsStatus(noPatients)).toEqual({ heading: '✓ patients read', line: 'Ready.' })
  })

  it('measurementsStatus fills the board-N-style box from the measurements summary', () => {
    expect(measurementsStatus(responseOf())).toEqual({
      heading: '✓ 38 patients read',
      line: 'Found 102 rows: markers ldh and cea; draws at day 0, 14, 28 and 56. Ready.',
    })
  })

  it('predictMeasurementsStatus fills the board-N box with the N continuation (ITEM-7)', () => {
    // The N screen's OWN green line (PredictFiles.dc.html): the same detail
    // body as the C box, ending with the board's "Next you choose the
    // models…" continuation instead of "Ready."
    expect(predictMeasurementsStatus(responseOf())).toEqual({
      heading: '✓ 38 patients read',
      line: 'Found 102 rows: markers ldh and cea; draws at day 0, 14, 28 and 56. Next you choose the models that can run on it.',
    })
  })

  it('the two measurements status lines share ONE detail body (C terminator vs N continuation)', () => {
    const c = measurementsStatus(responseOf())
    const n = predictMeasurementsStatus(responseOf())
    expect(n.heading).toBe(c.heading)
    expect(n.line).toBe(c.line.replace('. Ready.', '. Next you choose the models that can run on it.'))
  })

  it('the status boxes render the board grouping for counts over 999 (ITEM-8)', () => {
    // The board's own "Found 1,102 rows" (PredictFiles.dc.html) — the
    // row-label builders (lib/format.ts) group with the board's fixed
    // bytes; counts under 1000 are unchanged (the ITEM-6 pins above).
    const big = responseOf({ measurements: { rows: 1102, patients: 38, distinct_draw_days: [0, 14, 28, 56] } })
    expect(measurementsStatus(big).line).toBe(
      'Found 1,102 rows: markers ldh and cea; draws at day 0, 14, 28 and 56. Ready.',
    )
    const bigPatients = responseOf()
    bigPatients.patients = { rows: 1234, with_primary_outcome: 62,
    primary_outcome_events: 62, median_followup_days: 231 }
    expect(patientsStatus(bigPatients).heading).toBe('✓ 1,234 patients read')
    expect(predictMeasurementsStatus(big).heading).toBe('✓ 38 patients read')
  })

  it('predictMeasurementsStatus clips long marker lists like the C box', () => {
    const many = responseOf()
    many.markers = [
      markerColumn(),
      markerColumn({ key: 'cea', spellings: ['cea'] }),
      markerColumn({ key: 'wbc', spellings: ['wbc'] }),
      markerColumn({ key: 'plt', spellings: ['plt'] }),
      markerColumn({ key: 'nse', spellings: ['nse'] }),
      markerColumn({ key: 'cyfra', spellings: ['cyfra'] }),
      markerColumn({ key: 'cea2', spellings: ['cea2'] }),
    ]
    expect(predictMeasurementsStatus(many).line).toBe(
      'Found 102 rows: markers ldh, cea, wbc, plt, nse and cyfra…; draws at day 0, 14, 28 and 56. Next you choose the models that can run on it.',
    )
  })
})

describe('ITEM-6 (global QA intake fixes) — F1 events, F2 mapping, F3 empty, F4 pick guard, F5a noise, F7 bounded draws', () => {
  it('the patients line reports EVENTS, not patients with an outcome (F1)', () => {
    // The defect: the old line read `with_primary_outcome` ("94
    // progressions or deaths" for a file with 94 patients but 82 events).
    const response = responseOf()
    response.patients = {
      rows: 94,
      with_primary_outcome: 94,
      primary_outcome_events: 82,
      median_followup_days: 59,
    }
    expect(patientsStatus(response).line).toBe(
      'Found 94 rows, 82 progressions or deaths, median follow-up 59 days. Ready.',
    )
  })

  it('the draw-days segment bounds the schedule: four spelled, more a count (F7)', () => {
    const four = responseOf({ measurements: { rows: 630, patients: 94, distinct_draw_days: [0, 14, 28, 56] } })
    expect(measurementsStatus(four).line).toContain('draws at day 0, 14, 28 and 56.')
    const many = responseOf({
      measurements: { rows: 630, patients: 94, distinct_draw_days: [...Array.from({ length: 93 }, (_, i) => i * 12), 799] },
    })
    expect(measurementsStatus(many).line).not.toContain('draws at day 0, 12, 24')
    expect(measurementsStatus(many).line).toContain('draws on 94 days (0 to 1104).')
  })

  it('the mapping step suggests obvious renamed columns only (F2)', () => {
    // The report's renamed file: pid, study_day, analyte, result, units.
    expect(
      resolveColumnRenames(['pid', 'study_day', 'analyte', 'result', 'units'], 'measurements'),
    ).toEqual([
      { from: 'pid', to: 'patient_id' },
      { from: 'study_day', to: 'day' },
      { from: 'analyte', to: 'marker' },
      { from: 'result', to: 'value' },
    ])
    // `units` is the SERVER's own alias (UNIT_ALIASES) — no overlap: the
    // app never re-offers a spelling the validator already reads.
    expect(resolveColumnRenames(['units'], 'measurements')).toEqual([])
    expect(resolveColumnRenames(['patient_id', 'day', 'marker', 'value'], 'measurements')).toEqual([])
    expect(resolveColumnRenames(['pid'], 'patients')).toEqual([
      { from: 'pid', to: 'patient_id' },
    ])
    // The dismissed "not now" record suppresses the offer (session rule).
    expect(
      resolveColumnRenames(['pid'], 'measurements', new Set(['pid'])),
    ).toEqual([])
  })

  it('an accepted rename rewrites the table columns (F2)', () => {
    const table = csv('m.csv', ['pid', 'day', 'marker', 'value'], [['P1', '0', 'ldh', '1']])
    const next = renamedTable(table, { from: 'pid', to: 'patient_id' })
    expect(next.columns).toEqual(['patient_id', 'day', 'marker', 'value'])
    expect(next.rows).toBe(table.rows)
    expect(next.source).toBe(table.source)
  })

  it('a header-only file is an error fact (F3)', () => {
    const empty = loadedFile('m.csv', csv('m.csv', ['patient_id', 'day'], []))
    empty.inspection = { ...inspectionOf('measurements'), summary: { rows: 0, markers: [], draw_days: [] } }
    expect(fileHasNoDataRows(empty)).toBe(true)
    const full = loadedFile('m.csv', MEASUREMENTS_TABLE)
    full.inspection = inspectionOf('measurements')
    expect(fileHasNoDataRows(full)).toBe(false)
    expect(fileHasNoDataRows(loadedFile('m.csv', MEASUREMENTS_TABLE))).toBe(false)
  })

  it('the pick guard refuses wrong file types and empty files plainly (F4)', async () => {
    await expect(
      parsePickedFile(new File(['x'], 'report.pdf', { type: 'application/pdf' }), 'measurements'),
    ).rejects.toThrow('This is not a CSV or Excel file — choose a .csv or .xlsx file.')
    await expect(
      parsePickedFile(new File([''], 'empty.csv', { type: 'text/csv' }), 'measurements'),
    ).rejects.toThrow('This file is empty — choose the file with its data.')
    // A legacy .xls reaches the workbook decode (the provider's own
    // legacy_xls message is the authority — the read-side tolerance).
    await expect(
      parsePickedFile(new File(['x'], 'old.xls', { type: 'application/vnd.ms-excel' }), 'measurements'),
    ).rejects.not.toThrow('This is not a CSV or Excel file')
  })

  it('the A01 header-less cause suppresses the per-role storm (F5a)', () => {
    const a01: FileProblem = {
      code: 'A01',
      severity: 'error',
      row: 1,
      column: undefined,
      message: 'no recognizable header in the measurements table: none of the 5 column(s) matches a known name; is row 1 the header?',
    }
    const r02: FileProblem = {
      code: 'R02',
      severity: 'error',
      row: 1,
      column: 'day',
      message: 'required column `day` is missing from the measurements table',
    }
    const a02: FileProblem = {
      code: 'A02',
      severity: 'error',
      row: 1,
      column: undefined,
      message: 'no outcome column',
    }
    const r03 = errorProblem(4)
    const response = responseOf({ problems: [a01, r02, a02, r03] })
    const inspection = inspectionOf('measurements')
    inspection.problems = [a01]
    const problems = cardProblems('measurements', inspection, inspectionOf('patients'), response)
    expect(problems.some(p => p.code === 'R02')).toBe(false)
    expect(problems.some(p => p.code === 'A02')).toBe(false)
    expect(problems.some(p => p.code === 'A01')).toBe(true)
    expect(problems.some(p => p.code === 'R03')).toBe(true)
  })

  it('the median follow-up renders whole or one-decimal (F6)', () => {
    expect(formatFollowUpDays(215.72024826342715)).toBe(215.7)
    expect(formatFollowUpDays(231)).toBe(231)
    expect(formatFollowUpDays(215.5)).toBe(215.5)
  })
})
