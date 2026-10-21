import { test, expect, type Page } from '@playwright/test'
import { openStory, trackErrors } from './_helpers'

// Interaction coverage (audit test-adequacy #5): the parallel-coordinates plot was render-smoke-only.
// This drives its real cross-plot selection flow via the deterministic seed buttons: an axis brush
// (PRODUCE) fans out a point selection; Clear resets it; a cluster seed (CONSUME) also lights it.
// window.__VIZ_TEST__.pointSelectionLength exposes the fan-out.

const selLen = (page: Page) =>
  page.evaluate(() => (window as unknown as { __VIZ_TEST__?: { pointSelectionLength?: number } }).__VIZ_TEST__?.pointSelectionLength ?? 0)

const realErrorsOf = (errs: string[]) =>
  errs.filter(e => !/context (lost|restored)|webglcontextlost|deck\.gl: assertion|deck: initialization/i.test(e))

test('parallel-coordinates: axis-brush PRODUCE fans out a selection; Clear resets it', async ({ page }) => {
  test.setTimeout(90_000)
  const bag = trackErrors(page)
  await openStory(page, 'viz-parallel-coordinates')
  await expect(page.getByTestId('viz-parallel-coordinates')).toBeVisible({ timeout: 20_000 })
  expect(await selLen(page), 'no selection initially').toBe(0)

  await page.getByTestId('viz-parallel-coordinates-brush-seed').click()
  await expect.poll(() => selLen(page), { timeout: 10_000 }).toBeGreaterThan(0)

  await page.getByTestId('viz-parallel-coordinates-clear').click()
  await expect.poll(() => selLen(page), { timeout: 10_000 }).toBe(0)

  // CONSUME: a selection seeded elsewhere also lights the plot.
  await page.getByTestId('viz-parallel-coordinates-consume-seed').click()
  await expect.poll(() => selLen(page), { timeout: 10_000 }).toBeGreaterThan(0)

  const realErrors = realErrorsOf(bag.errors)
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})
