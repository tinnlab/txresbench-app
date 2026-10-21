import { test, expect, type Page } from '@playwright/test'
import { openStory, trackErrors } from './_helpers'

// Interaction coverage (audit test-adequacy #5): the spatial-segmentation label mask was
// render-smoke-only. This hovers the segmentation image and asserts the picked LABEL id surfaces via
// window.__VIZ_TEST__.hoveredCellId (the O(1) label-mask pick).

const hoveredId = (page: Page) =>
  page.evaluate(() => (window as unknown as { __VIZ_TEST__?: { hoveredCellId?: unknown } }).__VIZ_TEST__?.hoveredCellId ?? null)

const realErrorsOf = (errs: string[]) =>
  errs.filter(e => !/context (lost|restored)|webglcontextlost|deck\.gl: assertion|deck: initialization/i.test(e))

test('spatial-segmentation: hovering the mask surfaces the picked label id', async ({ page }) => {
  test.setTimeout(90_000)
  const bag = trackErrors(page)
  await openStory(page, 'spatial-segmentation')
  const view = page.getByTestId('viz-spatial-segmentation')
  await expect(view).toBeVisible({ timeout: 20_000 })
  const box = await view.boundingBox()
  expect(box).toBeTruthy()
  if (!box) return

  // Sweep an interior grid until a labeled region is picked (the fixture has blobs + background gaps);
  // the hover readout is rAF-throttled, so settle briefly after each move.
  const grid = [0.25, 0.375, 0.5, 0.625, 0.75]
  let picked: unknown = null
  outer: for (const fy of grid) {
    for (const fx of grid) {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 3 })
      await page.waitForTimeout(150)
      picked = await hoveredId(page)
      if (picked != null) break outer
    }
  }
  expect(picked, 'hovering the segmentation mask surfaced a picked label id').not.toBeNull()

  const realErrors = realErrorsOf(bag.errors)
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})
