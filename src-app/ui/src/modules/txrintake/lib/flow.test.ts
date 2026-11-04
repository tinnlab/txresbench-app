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
  hasErrorProblems,
  inspectRequest,
  measurementsStatus,
  patientsStatus,
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
    patients: { rows: 151, with_primary_outcome: 62, median_followup_days: 231 },
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
    noMedian.patients = { rows: 4, with_primary_outcome: 1, median_followup_days: undefined }
    expect(patientsStatus(noMedian).line).toBe('Found 4 rows, 1 progressions or deaths. Ready.')
  })

  it('measurementsStatus fills the board-N-style box from the measurements summary', () => {
    expect(measurementsStatus(responseOf())).toEqual({
      heading: '✓ 38 patients read',
      line: 'Found 102 rows: markers ldh and cea; draws at day 0, 14, 28 and 56. Ready.',
    })
  })
})
