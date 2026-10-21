import { test, expect } from '@playwright/test'
import { openStory, trackErrors } from './_helpers'

// Session-restore CHOICE (docking P5). A restored `<Viz initialState>` whose snapshot had a pane docked
// in a popup window can't reopen that window on reload (no user gesture), so the main grid shows a
// choice dialog: MERGE the popup pane back into the main grid, or REOPEN the window (the click is the
// gesture). The `session-restore-docking` story mounts exactly that state (cell r-1 in main, r-2 in
// popup:0).

const realErrorsOf = (errs: string[]) =>
  errs.filter(e => !/context (lost|restored)|webglcontextlost|deck\.gl: assertion|deck: initialization/i.test(e))

test('restore dialog → Merge to main folds the popped pane back into the grid', async ({ page }) => {
  test.setTimeout(120_000)
  const bag = trackErrors(page)
  await openStory(page, 'session-restore-docking')

  // The restore ran after the first setOption → the choice dialog appears; only r-1 is in the main.
  await expect(page.getByTestId('viz-restore-dialog')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('viz-cell-view-r-1')).toBeVisible()
  await expect(page.locator('[data-testid="viz-cell-view-r-2"]')).toHaveCount(0)

  await page.getByTestId('viz-restore-merge').click()

  // The popup pane docked into the main grid; the dialog dismissed.
  await expect(page.getByTestId('viz-restore-dialog')).toHaveCount(0, { timeout: 10_000 })
  await expect(page.getByTestId('viz-cell-view-r-2')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('[data-testid^="viz-cell-view-"]')).toHaveCount(2)

  const realErrors = realErrorsOf(bag.errors)
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})

test('restore dialog → Reopen windows opens the popup and renders its pane', async ({ page, context }) => {
  test.setTimeout(120_000)
  const bag = trackErrors(page)
  await openStory(page, 'session-restore-docking')

  await expect(page.getByTestId('viz-restore-dialog')).toBeVisible({ timeout: 20_000 })

  // Reopen → a REAL popup window opens (the click is the gesture window.open needs).
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.getByTestId('viz-restore-reopen').click(),
  ])
  await popup.waitForLoadState('domcontentloaded')

  // The dialog dismissed; the popup renders the docked pane; the main still holds only r-1.
  await expect(page.getByTestId('viz-restore-dialog')).toHaveCount(0, { timeout: 10_000 })
  await expect(popup.getByTestId('viz-cell-view-r-2')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('viz-cell-view-r-1')).toBeVisible()
  await expect(page.locator('[data-testid="viz-cell-view-r-2"]')).toHaveCount(0)

  const realErrors = realErrorsOf(bag.errors)
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})
