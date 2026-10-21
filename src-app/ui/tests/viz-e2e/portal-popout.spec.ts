import { test, expect } from '@playwright/test'
import { trackErrors } from './_helpers'

// Portal-move pop-out: prove the SAME React instance is MOVED into a real popup window (state
// preserved), not a second synced copy. The counter is the proof — it keeps its value across
// pop-out and pop-back-in (a second copy would reset to 0). window.open needs a user gesture; the
// "Pop out" click is one.

test('portal pop-out moves the same instance into a real window with state intact', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000)
  const bag = trackErrors(page)

  await page.goto('/viz-showcase.html', { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 20_000 })
  await page.click('[data-testid="showcase-story-portal-popout"]')
  await page.waitForSelector('[data-testid="viz-portal-story"]', { timeout: 20_000 })

  // Build up state in-place: count → 3.
  await expect(page.locator('[data-testid="viz-portal-count"]')).toHaveText('count: 0')
  for (let i = 0; i < 3; i++) await page.click('[data-testid="viz-portal-inc"]')
  await expect(page.locator('[data-testid="viz-portal-count"]')).toHaveText('count: 3')
  await expect(page.locator('[data-testid="viz-portal-isopen"]')).toHaveText('closed')

  // Pop out → a REAL popup window opens (Playwright sees a new page).
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.click('[data-testid="viz-portal-open"]'),
  ])
  await popup.waitForLoadState('domcontentloaded')

  // The SAME instance now renders in the popup, count STILL 3 (moved, not re-created).
  await expect(popup.locator('[data-testid="viz-portal-count"]')).toHaveText('count: 3', {
    timeout: 15_000,
  })
  await expect(popup.locator('[data-testid="viz-portal-location"]')).toContainText('POPUP')
  // The main window no longer hosts the content (it was moved out) + reports open.
  await expect(page.locator('[data-testid="viz-portal-isopen"]')).toHaveText('open')
  await expect(page.locator('[data-testid="viz-portal-content"]')).toHaveCount(0)

  // Interacting in the popup drives the SAME React tree → count 3 → 4.
  await popup.click('[data-testid="viz-portal-inc"]')
  await expect(popup.locator('[data-testid="viz-portal-count"]')).toHaveText('count: 4')

  // Return → content moves back in-place, state (4) preserved, popup closed.
  await page.click('[data-testid="viz-portal-close"]')
  await expect(page.locator('[data-testid="viz-portal-isopen"]')).toHaveText('closed')
  await expect(page.locator('[data-testid="viz-portal-count"]')).toHaveText('count: 4')
  await expect(page.locator('[data-testid="viz-portal-location"]')).toContainText('IN-PLACE')
  expect(popup.isClosed()).toBe(true)

  expect(bag.errors, `console errors: ${bag.errors.join('\n')}`).toEqual([])
})
