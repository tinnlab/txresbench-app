import { test, expect } from '@playwright/test'
import { openStory, trackErrors } from './_helpers'

// Merge-audit F2 follow-up: the PRODUCTION DeckScatterCanvas is accessible when given `accessibleLabel`
// — the canvas container itself is keyboard-focusable (tabIndex/role=application/aria-label) with
// keyboard camera control + spoken ARIA-live announcements (no manual wrapper in the consumer). The
// `a11y-builtin` story mounts exactly that; announcements mirror to window.__VIZ_TEST__.lastAnnouncement.

const lastAnnouncement = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as { __VIZ_TEST__?: { lastAnnouncement?: string } }).__VIZ_TEST__?.lastAnnouncement ?? '')

test('built-in canvas a11y: focusable + labeled + keyboard camera + announcements', async ({ page }) => {
  test.setTimeout(90_000)
  const bag = trackErrors(page)
  await openStory(page, 'a11y-builtin')

  const canvas = page.getByTestId('viz-scatter-canvas')
  await expect(canvas).toBeVisible({ timeout: 20_000 })

  // The canvas container is a labeled, focusable application region (not an opaque canvas to a SR).
  await expect(canvas).toHaveAttribute('role', 'application')
  await expect(canvas).toHaveAttribute('tabindex', '0')
  await expect(canvas).toHaveAttribute('aria-label', /arrow keys to pan/i)

  // Focus it and drive keyboard camera control; each change is SPOKEN.
  await canvas.focus()
  await page.keyboard.press('=') // '+'/'=' → zoom in
  await expect.poll(() => lastAnnouncement(page), { timeout: 10_000 }).toBe('Zoomed in')

  await page.keyboard.press('-') // zoom out
  await expect.poll(() => lastAnnouncement(page), { timeout: 10_000 }).toBe('Zoomed out')

  await page.keyboard.press('Escape') // clear
  await expect.poll(() => lastAnnouncement(page), { timeout: 10_000 }).toBe('Selection cleared')

  // Arrow pan doesn't crash and the deck canvas survives (the a11y remount re-renders it).
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowUp')
  await expect.poll(() => canvas.locator('canvas').count(), { timeout: 10_000 }).toBeGreaterThan(0)

  const realErrors = bag.errors.filter(
    e => !/context (lost|restored)|webglcontextlost|deck\.gl: assertion|deck: initialization/i.test(e),
  )
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})
