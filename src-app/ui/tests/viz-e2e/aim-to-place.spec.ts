import { test, expect } from '@playwright/test'
import { openStory, trackErrors } from './_helpers'

// Aim-to-place (docking P5). With a pop-out window open, requesting a NEW plot enters AIM-TO-PLACE: a
// reminder banner appears in every window, a click PLACES the plot where you aim, and Escape DISCARDS
// it. The `aim-to-place` story seeds two scatter cells (p-1, p-2); the test pops p-1 out (so p-2 stays
// in the main), then drives the add → aim → place / discard flow in the main window.

const realErrorsOf = (errs: string[]) =>
  errs.filter(e => !/context (lost|restored)|webglcontextlost|deck\.gl: assertion|deck: initialization/i.test(e))

test('add plot with a window open → aim, click to PLACE the new plot in the main', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  const bag = trackErrors(page)
  await openStory(page, 'aim-to-place')
  await expect(page.getByTestId('viz-cell-view-p-1')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('viz-cell-view-p-2')).toBeVisible()

  // Pop p-1 out → a real popup window; the main keeps p-2.
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.locator('[data-testid="viz-cell-popout-p-1"]').click({ force: true }),
  ])
  await popup.waitForLoadState('domcontentloaded')
  await expect(page.locator('[data-testid="viz-cell-view-p-1"]')).toHaveCount(0, { timeout: 15_000 })
  await expect(page.locator('[data-testid^="viz-cell-view-"]')).toHaveCount(1) // just p-2 in the main

  // Request a new plot → aim-to-place engages (a window is open): the reminder appears.
  await page.getByTestId('viz-aim-add').click()
  await expect(page.getByTestId('viz-placement-hint-main')).toBeVisible({ timeout: 10_000 })

  // Aim over the remaining main cell + click → the plot is placed there (docks beside p-2).
  const box = await page.getByTestId('viz-cell-view-p-2').boundingBox()
  expect(box).toBeTruthy()
  if (!box) return
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.click(cx, cy)

  // A new plot appeared in the main (now 2 cells); the reminder dismissed.
  await expect(page.getByTestId('viz-placement-hint-main')).toHaveCount(0, { timeout: 10_000 })
  await expect(page.locator('[data-testid^="viz-cell-view-"]')).toHaveCount(2, { timeout: 10_000 })

  const realErrors = realErrorsOf(bag.errors)
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})

test('Escape during aim-to-place DISCARDS the new plot', async ({ page, context }) => {
  test.setTimeout(120_000)
  await openStory(page, 'aim-to-place')
  await expect(page.getByTestId('viz-cell-view-p-1')).toBeVisible({ timeout: 20_000 })

  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.locator('[data-testid="viz-cell-popout-p-1"]').click({ force: true }),
  ])
  await popup.waitForLoadState('domcontentloaded')
  await expect(page.locator('[data-testid^="viz-cell-view-"]')).toHaveCount(1)

  await page.getByTestId('viz-aim-add').click()
  await expect(page.getByTestId('viz-placement-hint-main')).toBeVisible({ timeout: 10_000 })

  // Move into the workspace (arm the preview) then Escape → discard.
  const box = await page.getByTestId('viz-cell-view-p-2').boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.keyboard.press('Escape')

  // The reminder dismissed and NO new plot was placed (still just p-2 in the main).
  await expect(page.getByTestId('viz-placement-hint-main')).toHaveCount(0, { timeout: 10_000 })
  await expect(page.locator('[data-testid^="viz-cell-view-"]')).toHaveCount(1)
})
