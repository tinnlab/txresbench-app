import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// TEST-FV-29 — the browser decode library through the REAL File API on the
// gallery dev server (backend-free). The parse runs INSIDE the browser against
// the SHIPPED module (dynamic import of its dev-server URL) — no test-only
// adapter sits between the File bytes and the decoder, so this is the same
// code path the intake screens will call.

const fixture = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const readUtf8 = (rel: string) => readFileSync(fixture(rel), 'utf8')
const readBytes = (rel: string) => Array.from(readFileSync(fixture(rel)))

const MEASUREMENTS_EXAMPLE = '../../../../data/file-validator/examples/measurements.csv'
const PATIENTS_TEMPLATE = '../../../../data/file-validator/templates/patients.csv'
const WORKBOOK = './fixtures/txr-measurements.xlsx'

/** Capture page errors from before navigation so nothing slips past the assertion. */
function capturePageErrors(page: import('@playwright/test').Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(String(err)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(msg.text())
    }
  })
  return errors
}

test.describe('file-validator decode library (real browser, real File API)', () => {
  test('the committed measurements example decodes to the expected table', async ({ page }) => {
    const errors = capturePageErrors(page)
    // The gallery page boots the whole component gallery; this spec only needs
    // the dev server's ORIGIN + module pipeline for the decode library, so the
    // gallery's entry module is stubbed to a no-op (the gallery UI is not
    // under test — TEST-FV-29 is the decode library through the real File
    // API). No request is aborted, so no resource error is spawned.
    await page.route('**/dev/gallery/main.tsx', (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export {}' }),
    )
    await page.goto('/gallery.html', { waitUntil: 'commit' })

    const csvUrl = new URL('./lib/txr-files/csv.ts', page.url()).href
    const table = await page.evaluate(
      async ({ csvText, fileName, csvUrl }) => {
        const mod = await import(csvUrl)
        const file = new File([csvText], fileName)
        return mod.parseCsvFile(file, { kind: 'measurements' })
      },
      { csvText: readUtf8(MEASUREMENTS_EXAMPLE), fileName: 'measurements.csv', csvUrl },
    )

    expect(table.source).toEqual({ name: 'measurements.csv', format: 'csv' })
    expect(table.header_row).toBe(1)
    expect(table.columns).toEqual(['patient_id', 'day', 'marker', 'value', 'unit'])
    expect(table.rows).toHaveLength(3848)
    // The byte pin is the regenerated example (qa-fixes ITEM-6, F6): the
    // generator rounds whole days and 1-decimal values for display.
    expect(table.rows[0]).toEqual(['J0000', '0', 'M1', '12.4', 'a.u.'])
    expect(errors).toEqual([])
  })

  test('the committed patients template decodes with zero data rows', async ({ page }) => {
    const errors = capturePageErrors(page)
    await page.route('**/dev/gallery/main.tsx', (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export {}' }),
    )
    await page.goto('/gallery.html', { waitUntil: 'commit' })

    const csvUrl = new URL('./lib/txr-files/csv.ts', page.url()).href
    const table = await page.evaluate(
      async ({ csvText, fileName, csvUrl }) => {
        const mod = await import(csvUrl)
        const file = new File([csvText], fileName)
        return mod.parseCsvFile(file, { kind: 'patients' })
      },
      { csvText: readUtf8(PATIENTS_TEMPLATE), fileName: 'patients.csv', csvUrl },
    )

    expect(table.header_row).toBe(1)
    expect(table.columns).toEqual([
      'patient_id',
      'pfs_days',
      'pfs_event',
      'os_days',
      'os_event',
      'age',
      'sex',
      'stage',
    ])
    expect(table.rows).toHaveLength(0)
    expect(errors).toEqual([])
  })

  test('the committed Excel fixture decodes through workbook.ts to the same shape', async ({
    page,
  }) => {
    const errors = capturePageErrors(page)
    await page.route('**/dev/gallery/main.tsx', (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export {}' }),
    )
    await page.goto('/gallery.html', { waitUntil: 'commit' })

    const workbookUrl = new URL('./lib/txr-files/workbook.ts', page.url()).href
    const table = await page.evaluate(
      async ({ bytes, fileName, kind, workbookUrl }) => {
        const mod = await import(workbookUrl)
        const file = new File([new Uint8Array(bytes)], fileName)
        return mod.parseWorkbookFile(file, { kind })
      },
      {
        bytes: readBytes(WORKBOOK),
        fileName: 'txr-measurements.xlsx',
        kind: 'measurements',
        workbookUrl,
      },
    )

    expect(table.source).toEqual({ name: 'txr-measurements.xlsx', format: 'excel' })
    expect(table.header_row).toBe(3)
    expect(table.columns).toEqual(['patient_id', 'day', 'marker', 'value', 'unit'])
    expect(table.rows).toHaveLength(7)
    expect(table.rows[0]).toEqual(['P001', '0', 'M1', '12.5', 'U/L'])
    expect(table.rows[3]).toEqual(['P002', '21', 'M1', null, 'U/L'])
    expect(table.rows[6]).toEqual(['P004', '2024-01-15T00:00:00.000Z', 'M1', '5.2', 'U/L'])
    // The decoy sheet is never read — and the row count pins first-sheet-only.
    expect(table.rows.flat()).not.toContain('Q999')
    expect(errors).toEqual([])
  })
})
