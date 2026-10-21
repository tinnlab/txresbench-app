import { test, expect, type Page } from '@playwright/test'
import { openStory, trackErrors } from './_helpers'

// Deferred item #6: the multi-cell GridWorkspace gains keyboard camera control when given
// `accessibleLabel`. The shared deck is N views over N dense cells, so the keyboard drives ONE FOCUSED
// dense cell: `[`/`]` cycle focus (a dashed outline marks it), arrows pan it, +/- zoom it, Enter/Space
// announce it, Esc clear — spoken through an ARIA live region. Pan/zoom flow through the same
// onViewStateChange the mouse uses. The `a11y-grid` story seeds TWO scatter cells; announcements mirror
// to window.__VIZ_TEST__.lastAnnouncement.

const lastAnnouncement = (page: Page) =>
  page.evaluate(() => (window as unknown as { __VIZ_TEST__?: { lastAnnouncement?: string } }).__VIZ_TEST__?.lastAnnouncement ?? '')

const realErrorsOf = (errs: string[]) =>
  errs.filter(e => !/context (lost|restored)|webglcontextlost|deck\.gl: assertion|deck: initialization/i.test(e))

test('grid a11y: focusable workspace + cell-cycle focus + keyboard camera + announcements', async ({ page }) => {
  test.setTimeout(90_000)
  const bag = trackErrors(page)
  await openStory(page, 'a11y-grid')

  const workspace = page.getByTestId('viz-grid-workspace')
  await expect(workspace).toBeVisible({ timeout: 20_000 })

  // A labeled, focusable application region over the whole workspace.
  await expect(workspace).toHaveAttribute('role', 'application')
  await expect(workspace).toHaveAttribute('tabindex', '0')
  await expect(workspace).toHaveAttribute('aria-label', /cycle the focused cell/i)

  // The focused-cell outline is a KEYBOARD affordance (`:focus-visible` semantics): it is NOT drawn
  // until the user actually drives the grid from the keyboard, so a mouse user never sees a box.
  await expect(page.getByTestId('viz-grid-a11y-focus-cell-1')).toHaveCount(0)

  // `]` cycles focus to the next dense cell (cell-2): outline appears there + it's announced.
  await workspace.focus()
  await page.keyboard.press(']')
  await expect(page.getByTestId('viz-grid-a11y-focus-cell-2')).toBeVisible({ timeout: 10_000 })
  await expect.poll(() => lastAnnouncement(page), { timeout: 10_000 }).toMatch(/cell 2 of 2 focused/i)

  // `[` cycles back to cell-1.
  await page.keyboard.press('[')
  await expect(page.getByTestId('viz-grid-a11y-focus-cell-1')).toBeVisible({ timeout: 10_000 })

  // Zoom the focused cell — spoken.
  await page.keyboard.press('=')
  await expect.poll(() => lastAnnouncement(page), { timeout: 10_000 }).toBe('Zoomed in')
  await page.keyboard.press('-')
  await expect.poll(() => lastAnnouncement(page), { timeout: 10_000 }).toBe('Zoomed out')

  // Enter announces the focused cell summary; Esc clears.
  await page.keyboard.press('Enter')
  await expect.poll(() => lastAnnouncement(page), { timeout: 10_000 }).toMatch(/points/i)
  await page.keyboard.press('Escape')
  await expect.poll(() => lastAnnouncement(page), { timeout: 10_000 }).toBe('Selection cleared')

  // Arrow pan doesn't crash and the shared deck canvas survives.
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => workspace.locator('canvas').count(), { timeout: 10_000 }).toBeGreaterThan(0)

  const realErrors = realErrorsOf(bag.errors)
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})
