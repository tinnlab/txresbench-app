import { test, expect, type Page } from '@playwright/test'
import { openStory, trackErrors } from './_helpers'

// MULTI-DATASOURCE isolation (ITEM-16 NEGATIVE control / TEST-16 / DEC-M4 guard). Two datasets with
// DISJOINT canonical barcodes must NOT auto-link: a selection in A lights ZERO cells in B (raw row
// indices never link — auto-link keys on canonical barcodes only). The `multi-datasource-isolated`
// story gives B a barcode range with no overlap with A.

const viz = (page: Page) =>
  page.evaluate(() => (window as unknown as { __VIZ_TEST__?: Record<string, number> }).__VIZ_TEST__ ?? {})

const realErrorsOf = (errs: string[]) =>
  errs.filter(e => !/context (lost|restored)|webglcontextlost|deck\.gl: assertion|deck: initialization/i.test(e))

test('multi-datasource isolation: disjoint-barcode datasets do NOT cross-light', async ({ page }) => {
  test.setTimeout(90_000)
  const bag = trackErrors(page)
  await openStory(page, 'multi-datasource-isolated')

  await expect(page.getByTestId('viz-grid-workspace')).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => (await viz(page)).ready, { timeout: 30_000 }).toBe(1)

  // Select a subset in A → A lights, but B (disjoint barcodes) stays DARK.
  await page.getByTestId('viz-md-select-a').click()
  await expect.poll(async () => (await viz(page)).aLit, { timeout: 10_000 }).toBeGreaterThan(0)
  // The guard: B never lights on a raw-index / non-matching-barcode selection.
  expect((await viz(page)).bLit).toBe(0)
  // Hold the negative across a moment (no async race lighting B late).
  await page.waitForTimeout(500)
  expect((await viz(page)).bLit).toBe(0)

  const realErrors = realErrorsOf(bag.errors)
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})
