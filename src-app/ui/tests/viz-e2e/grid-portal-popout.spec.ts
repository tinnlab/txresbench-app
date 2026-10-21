import { test, expect } from '@playwright/test'
import { openStory, trackErrors } from './_helpers'

// Grid cell PORTAL DOCKING pop-out (P3): clicking a cell's pop-out affordance MOVES that cell into a
// new popup window that renders it as its OWN GridWorkspace, and the MAIN grid REFLOWS to reclaim the
// slot (no placeholder). Returning (from the popup's Return affordance) docks the cell back into the
// main grid and closes the now-empty popup. window.open needs a user gesture — the click is one.

test('grid cell pops out into a real popup window (main grid reflows) and returns', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000)
  const bag = trackErrors(page)
  await openStory(page, 'grid-nonuniform')
  await expect(page.getByTestId('viz-grid-workspace')).toBeVisible()

  const cellIds = await page.$$eval('[data-testid^="viz-cell-popout-"]', els =>
    els.map(e => e.getAttribute('data-testid')!.replace('viz-cell-popout-', '')),
  )
  expect(cellIds.length).toBeGreaterThan(0)
  const cellId = cellIds[0]

  // Pop out → a REAL popup window opens.
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.locator(`[data-testid="viz-cell-popout-${cellId}"]`).click({ force: true }),
  ])
  await popup.waitForLoadState('domcontentloaded')

  // MAIN grid reflowed: the popped cell's view is GONE from the main window (moved out, no placeholder).
  await expect(page.locator(`[data-testid="viz-cell-view-${cellId}"]`)).toHaveCount(0, {
    timeout: 20_000,
  })

  // POPUP renders the cell as its own workspace: the cell view + a Return affordance + a live canvas
  // (a chart's own canvas, or the popup workspace's shared deck for a dense cell — proving the popup
  // GridWorkspace measured + rendered).
  await expect(popup.getByTestId(`viz-cell-view-${cellId}`)).toBeVisible({ timeout: 20_000 })
  await expect(popup.getByTestId(`viz-cell-return-${cellId}`)).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(() => popup.evaluate(() => document.querySelectorAll('canvas').length), { timeout: 30_000 })
    .toBeGreaterThan(0)

  // Return from the popup → the cell docks back into the main grid; the now-empty popup auto-closes.
  await popup.getByTestId(`viz-cell-return-${cellId}`).click()
  await expect(page.locator(`[data-testid="viz-cell-view-${cellId}"]`)).toHaveCount(1, {
    timeout: 20_000,
  })
  await expect.poll(() => popup.isClosed(), { timeout: 20_000 }).toBe(true)

  const realErrors = bag.errors.filter(e => !/context (lost|restored)|webglcontextlost|deck\.gl: assertion|deck: initialization/i.test(e))
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})
