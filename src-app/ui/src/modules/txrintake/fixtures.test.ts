/**
 * TEST-INT-8's ITEM-11 rows — the INV-3 fixture + cassette guard
 * (EXAMPLE-INT-6), `fixtures.ts`'s own file per the plan.
 *
 * Three duties:
 *
 * 1. **The synthetic-only scan** — `fixtures.ts` + `gallery.tsx` (which
 *    carries the cassette) contain no `restricted/` path and no identifier
 *    shape that could be a real patient id (dash-coded record ids, SSN-like
 *    digits, calendar dates); every identifier the fixtures generate is one
 *    of the provider's synthetic cohort families (`J0000…`/`P0001…`).
 * 2. **The data ↔ cassette agreement pins** — the embedded CSVs parse with
 *    the REAL PROV-FV-7 decoder (`parseCsvText`) to exactly the facts the
 *    cassette resolvers derive: the bad day at FILE row 14, the four P0187
 *    rows at FILE rows 88-91, the `ldh`/`LDH` spellings, and the fixed /
 *    predict / patients shapes.
 * 3. **Self-consistency of the resolvers** — `txrInspectResponse` /
 *    `txrValidateResponse` over the parsed fixture tables return the problem
 *    set the gallery-e2e asserts (R03 at row 14, four R08 rows, the A03
 *    question until the join is confirmed, no error after the fixed file is
 *    dropped) — so the story's server cannot drift from its data.
 *
 * The template-head bytes are provider-owned (the file-validator's committed
 * assets; their literal bytes are asserted against the REAL API at ITEM-12,
 * TEST-INT-17 — never mock-pinned here): this file pins the consumer-side
 * INV-3 facts and the fixture's own row contract.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseCsvText } from '@/lib/txr-files/csv'
import {
  TXR_INTAKE_FIXTURE_BUNDLE,
  TXR_INTAKE_MEASUREMENTS_CSV,
  TXR_INTAKE_MEASUREMENTS_FIXED_CSV,
  TXR_INTAKE_PATIENTS_CSV,
  TXR_INTAKE_PREDICT_CSV,
  TXR_INTAKE_TEMPLATE_CSV,
  txrInspectResponse,
  txrValidateResponse,
} from './fixtures'

const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url))
const moduleSource = (file: string): string =>
  readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')

/** The fixture + cassette sources the scan reads (TEST-INT-8's three files). */
function fixtureAndCassetteSources(): string {
  return [moduleSource('fixtures.ts'), moduleSource('gallery.tsx')].join('\n')
}

/** The synthetic id families the fixtures may carry (P0001.., J0000..). */
const SYNTHETIC_ID = /^(?:[PJ]0\d{4}|P0\d{3})$/i

describe('fixtures + cassette INV-3 scan (TEST-INT-8, ITEM-11)', () => {
  it('contains no restricted/ path and no real patient-id shape', () => {
    const source = fixtureAndCassetteSources()
    expect(source).not.toContain('restricted')
    // Dash-coded record ids (XXX-123456), SSN-like digit runs, date-like
    // identifiers: the shapes real cohorts carry and the synthetic ones do not.
    expect(source).not.toMatch(/[A-Z]{2,4}-[0-9]{4,}/)
    expect(source).not.toMatch(/[0-9]{3}-[0-9]{2}-[0-9]{4}/)
    expect(source).not.toMatch(/[0-9]{4}-[0-9]{2}-[0-9]{2}/)
  })

  it('every generated patient id is one of the synthetic cohort families', () => {
    const ids = new Set<string>()
    for (const csv of [
      TXR_INTAKE_PATIENTS_CSV,
      TXR_INTAKE_MEASUREMENTS_CSV,
      TXR_INTAKE_MEASUREMENTS_FIXED_CSV,
      TXR_INTAKE_PREDICT_CSV,
    ]) {
      const table = parseCsvText(csv, { kind: 'measurements' })
      for (const [patient] of table.rows) {
        if (patient !== null) ids.add(patient)
      }
    }
    expect(ids.size).toBeGreaterThan(0)
    for (const id of ids) {
      expect(id, `fixture id ${id} must be a synthetic cohort id`).toMatch(SYNTHETIC_ID)
    }
  })

  it('decodes to the row contract the cassette asserts (row 14, rows 88-91)', () => {
    const bad = parseCsvText(TXR_INTAKE_MEASUREMENTS_CSV, { kind: 'measurements' })
    // Data row 12 = FILE row 14 (header = row 1, the provider's numbering).
    expect(bad.rows[12]?.[1]).toBe('week 4')
    expect(bad.header_row).toBe(1)
    expect(bad.rows).toHaveLength(120)
    const p0187Rows = bad.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row[0] === 'P0187')
    expect(p0187Rows.map(({ index }) => index + 2)).toEqual([88, 89, 90, 91])
    const spellings = new Set(bad.rows.map(row => row[2]))
    expect([...spellings].sort()).toEqual(['LDH', 'cea', 'ldh'])
  })

  it('the fixed twin and the predict file carry none of the errors', () => {
    const fixed = parseCsvText(TXR_INTAKE_MEASUREMENTS_FIXED_CSV, { kind: 'measurements' })
    expect(Number.isFinite(Number(fixed.rows[12]?.[1]))).toBe(true)
    expect(fixed.rows.some(row => row[0] === 'P0187')).toBe(false)
    const predict = parseCsvText(TXR_INTAKE_PREDICT_CSV, { kind: 'measurements' })
    expect(predict.rows).toHaveLength(96)
    expect(predict.rows.every(row => row[2] === 'ldh')).toBe(true)
  })

  it('the template heads are the committed provider bytes', () => {
    expect(TXR_INTAKE_TEMPLATE_CSV.patients).toBe(
      'patient_id,pfs_days,pfs_event,os_days,os_event,age,sex,stage',
    )
    expect(TXR_INTAKE_TEMPLATE_CSV.measurements).toBe(
      'patient_id,day,marker,value,unit',
    )
    expect(TXR_INTAKE_FIXTURE_BUNDLE.templatePatients).toBe(TXR_INTAKE_TEMPLATE_CSV.patients)
    expect(TXR_INTAKE_FIXTURE_BUNDLE.templateMeasurements).toBe(
      TXR_INTAKE_TEMPLATE_CSV.measurements,
    )
  })
})

describe('the fixture resolvers agree with the parsed tables (the story server)', () => {
  const badTable = parseCsvText(TXR_INTAKE_MEASUREMENTS_CSV, { kind: 'measurements' })
  const fixedTable = parseCsvText(TXR_INTAKE_MEASUREMENTS_FIXED_CSV, {
    kind: 'measurements',
  })
  const patientsTable = parseCsvText(TXR_INTAKE_PATIENTS_CSV, { kind: 'patients' })
  const predictTable = parseCsvText(TXR_INTAKE_PREDICT_CSV, { kind: 'measurements' })

  it('inspect reports the row-14 R03 and the summary facts', () => {
    const inspection = txrInspectResponse({ kind: 'measurements', table: badTable })
    expect(inspection.problems).toEqual([
      {
        code: 'R03',
        severity: 'error',
        row: 14,
        column: 'day',
        message: '`week 4` is not a number in the day column',
      },
    ])
    expect(inspection.summary.rows).toBe(120)
    expect(inspection.summary.draw_days).toEqual([0, 14, 28, 56])
  })

  it('validate reports the A03 question until the join is confirmed', () => {
    const withProblem = txrValidateResponse({
      mode: 'files',
      measurements: badTable,
      patients: patientsTable,
    })
    expect(withProblem.problems.filter(problem => problem.code === 'A03')).toHaveLength(1)
    const joined = txrValidateResponse({
      mode: 'files',
      measurements: badTable,
      patients: patientsTable,
      joins: [{ variants: ['ldh', 'LDH'], key: 'ldh' }],
    })
    expect(joined.problems.filter(problem => problem.code === 'A03')).toHaveLength(0)
    // The R03 + four R08 rows stay regardless of the join.
    const remaining = joined.problems.map(problem => problem.code)
    expect(remaining).toEqual(['R03', 'R08', 'R08', 'R08', 'R08'])
  })

  it('the fixed file validates warning-only and the predict file clean', () => {
    const fixed = txrValidateResponse({
      mode: 'files',
      measurements: fixedTable,
      patients: patientsTable,
    })
    expect(fixed.problems.every(problem => problem.severity === 'warning')).toBe(true)
    const predict = txrValidateResponse({ mode: 'predict', measurements: predictTable })
    expect(predict.problems).toEqual([])
    expect(predict.patients).toBeUndefined()
    expect(predict.measurements).toEqual({
      rows: 96,
      patients: 24,
      distinct_draw_days: [0, 14, 28, 56],
    })
  })
})
