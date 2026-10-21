import { test, expect } from '@playwright/test'
import {
  openStory,
  expectSomeCanvasRendered,
  trackErrors,
  canvasNonBlank,
  canvasPixelSignature,
} from './_helpers'

// TEST-12 (covers ITEM-9): the scatter recolors when the generic `scatter-colorby`
// select switches color-by MODE — categorical group → a continuous/value column. We
// assert the GPU canvas re-renders (still non-blank) with no console error. This
// reconciles the legacy "color by gene X → colorbar; cluster → legend" into ONE generic
// color-by select that recolors (DEC-28 generic naming: value/group, never gene/cluster).
test('TEST-12 color-by select switches categorical → continuous and recolors', async ({ page }) => {
  const bag = trackErrors(page)
  await openStory(page, 'scatter-basic')

  await expectSomeCanvasRendered(page)

  const select = page.locator('[data-testid="scatter-colorby"]')
  await expect(select).toBeVisible()

  // The select starts on a categorical column (`categorical:group`).
  const startValue = await select.inputValue()
  expect(startValue.startsWith('categorical:'), `starts categorical, got "${startValue}"`).toBeTruthy()

  // Find a continuous option value the story populated from the catalog.
  const continuousValue = await select.evaluate((el: HTMLSelectElement) => {
    const opt = Array.from(el.options).find(o => o.value.startsWith('continuous:'))
    return opt?.value ?? null
  })
  expect(continuousValue, 'a continuous color-by option should exist').not.toBeNull()

  const nonBlankBefore = await canvasNonBlank(page, 0)
  expect(nonBlankBefore).toBeGreaterThan(0)

  // DOWNSTREAM PROOF: snapshot the rendered scatter PIXELS before the recolor. A cosmetic
  // test (inert canvas / dead select handler) would leave these identical.
  const sigBefore = await canvasPixelSignature(page, 0)
  expect(sigBefore).not.toBe('no-canvas')

  await select.selectOption(continuousValue as string)
  // let the recolor effect + a couple deck.gl frames land
  await page.waitForTimeout(1500)

  await expect(select).toHaveValue(continuousValue as string)
  const after = await canvasNonBlank(page, 0)
  expect(after, 'canvas still renders non-blank after continuous recolor').toBeGreaterThan(0)

  // The scatter must have actually RECOLORED: categorical→continuous repaints every point,
  // so the pixel signature MUST differ. This assertion fails if the recolor were a no-op.
  const sigAfter = await canvasPixelSignature(page, 0)
  expect(sigAfter, 'switching color-by column must recolor the scatter (pixels change)').not.toBe(
    sigBefore,
  )

  await expectSomeCanvasRendered(page)
  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
