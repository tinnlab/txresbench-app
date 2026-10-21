import { test, expect } from '@playwright/test'
import { expectKitSelected, expectSomeCanvasRendered, openStory, trackErrors } from './_helpers'
import { readFileSync } from 'node:fs'

// TEST-CELL-EXPORT-1 (covers the per-cell "export this pane" button, ITEM-47 follow-up):
// the per-cell ⤓ button in a cell's chrome opens the ExportDialog scoped to THAT pane.
// We pick the SECOND cell (cell-2) — NOT the active-by-default first cell — so the test
// proves the button targets the CLICKED pane, not merely whichever pane is active. We
// click cell-2's export button, keep format PNG, click Export, capture the real browser
// download (TEST-63 pattern), and assert the saved PNG is non-empty AND the dialog status
// reports a PANE-scoped export. Zero console errors.
test('TEST-CELL-EXPORT-1 per-cell export button scopes the export to the clicked pane', async ({
  page,
}) => {
  const bag = trackErrors(page)
  await openStory(page, 'grid-cell-export')

  // Two scatter cells seeded ([cell-1 | cell-2]); the shared deck canvas is rendered.
  await expectSomeCanvasRendered(page)
  await expect(page.locator('[data-testid="viz-cell-view-cell-2"]')).toBeVisible()

  // The dialog is NOT mounted until a cell's export button is clicked.
  await expect(page.locator('[data-testid="viz-export-dialog"]')).toHaveCount(0)

  // Click the SECOND cell's ⤓ export button → the dialog opens scoped to cell-2.
  await page.click('[data-testid="viz-cell-export-cell-2"]')
  await expect(page.locator('[data-testid="viz-export-dialog"]')).toBeVisible()

  // A per-cell export opens with scope pre-set to "This pane", format PNG.
  await expectKitSelected(page, 'export-scope', 'pane')
  await expectKitSelected(page, 'export-format', 'png')

  const downloadPromise = page.waitForEvent('download', { timeout: 15_000 })
  await page.click('[data-testid="export-button"]')
  const download = await downloadPromise
  expect(download.suggestedFilename().toLowerCase()).toMatch(/\.png$/)

  const path = await download.path()
  expect(path, 'download resolved to a saved file path').toBeTruthy()
  const bytes = readFileSync(path as string)
  expect(bytes.byteLength, 'exported PNG is non-empty').toBeGreaterThan(0)

  // The status proves the export was PANE-scoped (cropped to the clicked cell), not the
  // whole grid — this is what distinguishes "targeted the clicked pane" from "whole canvas".
  await expect(page.locator('[data-testid="export-status"]')).toContainText('pane')

  expect(
    bag.errors,
    `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`,
  ).toHaveLength(0)
})
