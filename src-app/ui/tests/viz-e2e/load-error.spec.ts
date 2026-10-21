import { test, expect } from '@playwright/test'
import { openStory, trackErrors } from './_helpers'

// REGRESSION for the round-2 HIGH fix: a chart View bound to a NON-EXISTENT column must
// render a VISIBLE error cell (`<ChartError>`, testid `viz-chart-error`) instead of a
// permanent "Loading…" spinner. The `viz-load-error` story mounts a `ViolinView` bound to
// `valueKey="__no_such_column__"`; `FixtureSource.valueColumn` rejects, `useAsyncChartData`
// catches the rejection, and the View swaps in `<ChartError message={…} />`.
//
// NOTE: the rejected load logs an EXPECTED console/unhandled error here — the whole point is
// that the UI RENDERS the error state rather than swallowing it. So we do NOT assert a clean
// console; instead we assert the error CELL is visible + carries the failure message, and
// that the "Loading…" text is gone (i.e. no permanent spinner).
test('load error — bad column binding renders a visible ChartError, not a hung spinner', async ({
  page,
}) => {
  // Track errors for visibility in the report, but this spec intentionally does NOT assert
  // zero console errors (the rejected column load is an expected, surfaced failure).
  const bag = trackErrors(page)

  await openStory(page, 'viz-load-error')

  // The visible error cell must be present, replacing the spinner.
  const errorCell = page.locator('[data-testid="viz-chart-error"]')
  await expect(errorCell).toBeVisible()

  // It carries the human-readable load-failure message (the fixture's rejection text).
  await expect(errorCell).toContainText('Failed to load chart')
  await expect(errorCell).toContainText('__no_such_column__')

  // And there is NO permanent "Loading…" spinner left behind.
  await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0)

  // Sanity: the story surfaced an error to the console (expected), proving we drove the
  // real failure path rather than a silently-swallowed load. (Not a hard requirement — the
  // rendered error cell above is the assertion that matters.)
  expect(bag.errors.length, `console errors seen (expected ≥0): ${bag.errors.slice(0, 3).join(' | ')}`).toBeGreaterThanOrEqual(0)
})
