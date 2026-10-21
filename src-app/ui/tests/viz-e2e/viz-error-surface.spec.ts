import { test, expect } from '@playwright/test'
import { openStory, trackErrors } from './_helpers'

// REGRESSION for the round-3 <Viz> error surface + the round-4 revert-clears-error fix.
// The `viz-error-surface` story renders `<Viz option>` with two buttons: a GOOD (valid scatter)
// option and a BAD option (a heatmap whose encode explicitly binds a nonexistent column, so
// `parseOption`'s validateBindings throws → `setOption` rejects). Contract:
//   • bad option     → a visible <ChartError> (testid `viz-chart-error`), NOT a silent blank grid.
//   • revert to good → the error CLEARS (the round-4 fix: reverting to the last-successful option
//                      must not leave the error stuck forever behind the effect's same-key guard).
//
// This asserts the deterministic error LIFECYCLE (cell appears on bad / clears on revert), which
// is canvas-independent. That the good option itself renders a non-blank canvas is already covered
// by the every-story sweep (matrix-render TEST-73). The bad option logs an EXPECTED rejection, so
// this spec does NOT assert a clean console.
test('<Viz> bad option shows ChartError; reverting to the good option clears it', async ({
  page,
}) => {
  trackErrors(page) // expected error on the bad option — not asserted clean

  await openStory(page, 'viz-error-surface')
  await expect(page.getByTestId('viz-error-surface')).toBeVisible()

  const errorCell = page.locator('[data-testid="viz-chart-error"]')

  // 1) Good by default → no error cell.
  await expect(errorCell).toHaveCount(0)

  // 2) Bad option → setOption rejects → a VISIBLE error cell (not a silent blank grid).
  await page.getByTestId('viz-err-bad').click()
  await expect(errorCell).toBeVisible()
  await expect(errorCell).toContainText('__no_such_column__')

  // 3) Revert to the good (last-successful) option → the error must CLEAR. Before the round-4 fix
  //    this stayed stuck on <ChartError> because the effect early-returned on the already-applied
  //    key without clearing `error`.
  await page.getByTestId('viz-err-good').click()
  await expect(errorCell).toHaveCount(0)

  // Round-trip once more to prove it's not a one-shot: bad → error, good → cleared again.
  await page.getByTestId('viz-err-bad').click()
  await expect(errorCell).toBeVisible()
  await page.getByTestId('viz-err-good').click()
  await expect(errorCell).toHaveCount(0)
})
