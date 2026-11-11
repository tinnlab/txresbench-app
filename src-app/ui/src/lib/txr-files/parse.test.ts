/**
 * The shared decode library's unit suite (TEST-FV-27 / TEST-FV-32): BOM
 * strip, delimiter sniffing, header-row detection, the `ParsedTable` wire
 * shape, raw-text entries, and the Excel conversions — all through the same
 * two public entry points the screens will call (INV-3).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseCsvFile, parseCsvText } from './csv'
import { HEADER_SCAN_MAX_ROWS } from './types'
import { UnsupportedFileError, parseWorkbookFile } from './workbook'

const fixture = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const csvFixture = (rel: string) => readFileSync(fixture(rel), 'utf8')
const workbookFixture = (rel: string) => readFileSync(fixture(rel))

const MEASUREMENTS_ROWS = [
  'P1,0,M1,12.5,U/L',
  'P1,21,M1,16.3,U/L',
  'P2,0,M2,4.2,U/L',
].join('\n')

describe('parseCsvFile', () => {
  it('strips a UTF-8 BOM before parsing and sniffing', async () => {
    const table = await parseCsvFile(
      new File(['\ufeffpatient_id,day,marker,value,unit\n' + MEASUREMENTS_ROWS], 'bom.csv'),
    )
    expect(table.header_row).toBe(1)
    expect(table.columns).toEqual(['patient_id', 'day', 'marker', 'value', 'unit'])
    expect(table.rows).toHaveLength(3)
  })

  it('detects a tab-delimited file', async () => {
    const table = await parseCsvFile(
      new File(['patient_id\tday\tmarker\tvalue\tunit\nP1\t0\tM1\t12.5\tU/L'], 'tab.tsv'),
    )
    expect(table.columns).toEqual(['patient_id', 'day', 'marker', 'value', 'unit'])
    expect(table.rows[0]).toEqual(['P1', '0', 'M1', '12.5', 'U/L'])
  })

  it('detects a semicolon-delimited file (comma-decimal locale)', async () => {
    const table = await parseCsvFile(
      new File(['patient_id;day;marker;value;unit\nP1;7;M1;12,5;U/L'], 'nl.csv'),
    )
    expect(table.columns).toEqual(['patient_id', 'day', 'marker', 'value', 'unit'])
    expect(table.rows[0]).toEqual(['P1', '7', 'M1', '12,5', 'U/L'])
  })

  it('does not let a quoted delimiter fool the sniff', async () => {
    const text = 'patient_id,day,marker,value,unit\nP1,7,M1,"a,b",U/L\n'
    const table = await parseCsvFile(new File([text], 'quoted.csv'))
    expect(table.rows[0]).toEqual(['P1', '7', 'M1', 'a,b', 'U/L'])
  })

  it('finds a header row below title rows (DEC-6 scan)', async () => {
    const text = [
      'Patient measurements export',
      'Synthetic example - not real patient data',
      'patient_id,day,marker,value,unit',
      'P1,0,M1,12.5,U/L',
    ].join('\n')
    const table = await parseCsvFile(new File([text], 'titled.csv'), { kind: 'measurements' })
    expect(table.header_row).toBe(3)
    expect(table.columns).toEqual(['patient_id', 'day', 'marker', 'value', 'unit'])
    expect(table.rows).toEqual([['P1', '0', 'M1', '12.5', 'U/L']])
  })

  it('returns only data rows with raw text entries and null for empty entries', async () => {
    const text = 'patient_id,day,marker,value,unit\nP1,0,M1,,U/L\nP1,7,M2,4.2,U/L\n'
    const table = await parseCsvFile(new File([text], 'entries.csv'))
    expect(table.rows[0]).toEqual(['P1', '0', 'M1', null, 'U/L'])
    expect(table.rows[1]).toEqual(['P1', '7', 'M2', '4.2', 'U/L'])
  })

  it('never scans more than HEADER_SCAN_MAX_ROWS rows for a header', async () => {
    const lines = ['noise,line', 'still,noise', 'more,noise', 'four,noise', 'five,noise']
    // A header on row 6 is beyond the scan window: row 1 becomes the header.
    const text = lines.concat([
      'patient_id,day,marker,value,unit',
      'P1,0,M1,12.5,U/L',
    ]).join('\n')
    const table = await parseCsvFile(new File([text], 'deep.csv'), { kind: 'patients' })
    expect(HEADER_SCAN_MAX_ROWS).toBe(5)
    expect(table.header_row).toBe(1)
    expect(table.columns).toEqual(lines[0].split(','))
  })

  it('surfaces an unrecognized column set as row-1 columns (the server reports A01/A02)', async () => {
    const table = await parseCsvFile(new File(['Stuff,More\n1,2\n'], 'junk.csv'))
    expect(table.header_row).toBe(1)
    expect(table.columns).toEqual(['Stuff', 'More'])
    expect(table.rows).toEqual([['1', '2']])
  })

  it('keeps data rows narrower than the header as null-padded (wire shape)', async () => {
    const text = 'patient_id,day,marker,value,unit\nP1,0\n'
    const table = await parseCsvFile(new File([text], 'ragged.csv'), { kind: 'measurements' })
    expect(table.rows[0]).toEqual(['P1', '0', null, null, null])
  })
})

describe('the committed material through the shared decoder', () => {
  it('reads the committed measurements example (2958 value rows)', async () => {
    const text = csvFixture('../../../../../data/file-validator/examples/measurements.csv')
    const table = await parseCsvFile(new File([text], 'measurements.csv'), {
      kind: 'measurements',
    })
    expect(table.header_row).toBe(1)
    expect(table.columns).toEqual(['patient_id', 'day', 'marker', 'value', 'unit'])
    expect(table.rows).toHaveLength(2959)
    // Raw text entries: the marker/unit spellings survive the decode untouched.
    // The byte pin is the regenerated example (qa-fixes ITEM-6, F6): the
    // generator rounds whole days and 1-decimal values for display, so the
    // first row reads the rounded bytes the committed file now carries.
    expect(table.rows[0]).toEqual(['J0000', '-28', 'M1', '8.1', 'a.u.'])
  })

  it('reads the committed patients template (header only) in the patients shape', async () => {
    const text = csvFixture('../../../../../data/file-validator/templates/patients.csv')
    const table = await parseCsvFile(new File([text], 'patients.csv'), { kind: 'patients' })
    expect(table.header_row).toBe(1)
    expect(table.columns).toEqual([
      'patient_id',
      'pfs_days',
      'pfs_event',
      'os_days',
      'os_event',
      'responder',
      'response_day',
      'age',
      'sex',
      'stage',
    ])
    expect(table.rows).toHaveLength(0)
  })
})

describe('parseWorkbookFile', () => {
  it('reads the first sheet, finds the header on row 3 and converts entries to text', async () => {
    const buf = workbookFixture('../../../tests/gallery-e2e/fixtures/txr-measurements.xlsx')
    const table = await parseWorkbookFile(new File([buf], 'measures.xlsx'))
    // Title rows (1-2) then the header on FILE row 3 (DEC-6).
    expect(table.header_row).toBe(3)
    expect(table.columns).toEqual(['patient_id', 'day', 'marker', 'value', 'unit'])
    expect(table.rows).toHaveLength(7)
    // Numeric Excel entries became text, in the user's file order.
    expect(table.rows[0]).toEqual(['P001', '0', 'M1', '12.5', 'U/L'])
    expect(table.rows[1]).toEqual(['P001', '14', 'M2', '4.25', 'U/L'])
    // An empty entry is null.
    expect(table.rows[3]).toEqual(['P002', '21', 'M1', null, 'U/L'])
    // A negative day stays text ('-3').
    expect(table.rows[4]).toEqual(['P003', '-3', 'M1', '7.7', 'U/L'])
    // A boolean entry renders as the spreadsheet's display text.
    expect(table.rows[5]).toEqual(['P003', '7', 'M1', 'TRUE', 'U/L'])
    // A date entry is ISO text (the validator's day checks then report it honestly).
    expect(table.rows[6]).toEqual(['P004', '2024-01-15T00:00:00.000Z', 'M1', '5.2', 'U/L'])
  })

  it('never reads the second sheet', async () => {
    const buf = workbookFixture('../../../tests/gallery-e2e/fixtures/txr-measurements.xlsx')
    const table = await parseWorkbookFile(new File([buf], 'measures.xlsx'))
    const flat = table.rows.flat()
    expect(flat).not.toContain('Q999')
  })

  it('rejects a legacy .xls (OLE2 bytes) with a distinguishable result (DEC-13)', async () => {
    const legacy = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])
    const promise = parseWorkbookFile(new File([legacy], 'old.xls'))
    await expect(promise).rejects.toBeInstanceOf(UnsupportedFileError)
    await expect(promise).rejects.toMatchObject({
      code: 'unsupported_file_type',
      reason: 'legacy_xls',
    })
  })

  it('rejects a file that is not a workbook with a distinguishable result', async () => {
    const promise = parseWorkbookFile(new File(['just some text'], 'notes.csv'))
    await expect(promise).rejects.toMatchObject({
      code: 'unsupported_file_type',
      reason: 'not_a_workbook',
    })
  })
})

describe('the ParsedTable wire shape', () => {
  it('round-trips as the server contract expects (source/header_row/columns/rows)', async () => {
    const table = await parseCsvFile(new File(['patient_id,day\nP1,0\n'], 't.csv'), {
      kind: 'patients',
    })
    // field-by-field, not by shape-only: the decode output IS the request body.
    expect(Object.keys(table).sort()).toEqual(['columns', 'header_row', 'rows', 'source'])
    expect(table.source).toEqual({ name: 't.csv', format: 'csv' })
    expect(typeof table.header_row).toBe('number')
    expect(Array.isArray(table.columns)).toBe(true)
    const allTextOrNull = table.rows.every((row) =>
      row.every((entry) => entry === null || typeof entry === 'string'),
    )
    expect(allTextOrNull).toBe(true)
  })

  it('the pure text path and the File path agree (one parsing story)', async () => {
    const text = 'patient_id,day,marker,value,unit\n' + MEASUREMENTS_ROWS
    const fromText = parseCsvText(text, { kind: 'measurements' }, 'same.csv')
    const fromFile = await parseCsvFile(new File([text], 'same.csv'), { kind: 'measurements' })
    expect(fromText).toEqual(fromFile)
  })
})
