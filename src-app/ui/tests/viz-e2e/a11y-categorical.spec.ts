import { test, expect, type Page } from '@playwright/test'
import { openStory, trackErrors, canvasNonBlank } from './_helpers'

// Deferred item #4: CategoricalPointsView gains full keyboard camera control when given
// `accessibleLabel` — the view container is a labeled, focusable application region with arrow-pan /
// +-zoom / Enter-summary / Esc keyboard control + spoken ARIA-live announcements, AND the legend
// checkboxes keep their OWN keys (a focused checkbox's Space toggles it, not hijacked as 'activate' —
// the `guardTarget` seam). The `a11y-categorical` story mounts exactly that; announcements mirror to
// window.__VIZ_TEST__.lastAnnouncement.

const lastAnnouncement = (page: Page) =>
  page.evaluate(() => (window as unknown as { __VIZ_TEST__?: { lastAnnouncement?: string } }).__VIZ_TEST__?.lastAnnouncement ?? '')

const realErrorsOf = (errs: string[]) =>
  errs.filter(e => !/context (lost|restored)|webglcontextlost|deck\.gl: assertion|deck: initialization/i.test(e))

test('categorical-points a11y: focusable + labeled + keyboard camera + legend keeps its keys', async ({ page }) => {
  test.setTimeout(90_000)
  const bag = trackErrors(page)
  await openStory(page, 'a11y-categorical')

  const view = page.getByTestId('viz-categorical-points-view')
  await expect(view).toBeVisible({ timeout: 20_000 })

  // The plain GPU point path actually RENDERS (not a cosmetic pass): the categorical cloud draws.
  await expect.poll(() => canvasNonBlank(page, 0), { timeout: 30_000 }).toBeGreaterThan(0)

  // A labeled, focusable application region (not an opaque canvas to a screen reader).
  await expect(view).toHaveAttribute('role', 'application')
  await expect(view).toHaveAttribute('tabindex', '0')
  await expect(view).toHaveAttribute('aria-label', /arrow keys to pan/i)

  // Keyboard camera control is spoken.
  await view.focus()
  await page.keyboard.press('=') // zoom in
  await expect.poll(() => lastAnnouncement(page), { timeout: 10_000 }).toBe('Zoomed in')
  await page.keyboard.press('-') // zoom out
  await expect.poll(() => lastAnnouncement(page), { timeout: 10_000 }).toBe('Zoomed out')
  await page.keyboard.press('Escape') // clear
  await expect.poll(() => lastAnnouncement(page), { timeout: 10_000 }).toBe('Selection cleared')

  // Enter announces the category summary (not a crash).
  await view.focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => lastAnnouncement(page), { timeout: 10_000 }).toMatch(/categories shown/i)

  // Arrow pan re-reads the camera via the a11y remount; the deck canvas survives.
  await view.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowUp')
  await expect.poll(() => view.locator('canvas').count(), { timeout: 10_000 }).toBeGreaterThan(0)

  // guardTarget: a FOCUSED legend checkbox keeps its own Space key (toggles), NOT hijacked as
  // 'activate'. Focus the first legend checkbox, read its state, press Space, assert it flipped.
  const firstBox = view.getByTestId('viz-categorical-points-legend-item-0').locator('input[type=checkbox]')
  await expect(firstBox).toBeChecked()
  await firstBox.focus()
  await page.keyboard.press('Space')
  await expect(firstBox).not.toBeChecked()

  const realErrors = realErrorsOf(bag.errors)
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})
