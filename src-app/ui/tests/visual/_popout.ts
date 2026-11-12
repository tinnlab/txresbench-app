// Driving a REAL popped-out OS window from a gallery spec.
//
// A pane popped out of the workbench renders into a second window's document (`window.open` →
// `@txresbench/dock`'s `ContainerWindows` portals the pane's React subtree into it), and every kit
// overlay opened from inside it must portal into — and be laid out against — THAT window.
//
// Extracted here because two suites under two different Playwright configs need it:
// `tests/gallery-e2e/popout-overlay-document.spec.ts` (the portal contract) and
// `tests/visual/picker-popup-width.spec.ts` (the popup-width contract). A copy in each would
// drift silently — and a popout driver that quietly stopped popping out reads exactly like a
// working one, because every assertion downstream of it is simply never reached.

import { expect, type Page } from '@playwright/test'

/** The gallery surface that mounts the real workbench shell over a seeded fake host. */
export const POPOUT_SURFACE = '/gallery.html?surface=workbench-artifacts'

/** The popped-out window's geometry, from `core/shell/regions/regionPopout.ts`. */
export const POPUP_W = 900
export const POPUP_H = 680

export async function openWorkbench(page: Page): Promise<void> {
  await page.goto(POPOUT_SURFACE, { waitUntil: 'domcontentloaded' })
  await page.getByTestId('workbench-gallery-frame').waitFor({ state: 'visible', timeout: 30_000 })
  await expect(page.locator('[data-testid^="region-popout-"]').first()).toBeVisible({ timeout: 30_000 })
}

/**
 * Open a pane of `kind` through the workbench's programmatic pane seam, make it the active pane in
 * its region (only the active pane exposes a pop-out affordance), then pop it out and return the
 * popup page. The seam is the same `requestAddPane` a toolbar affordance calls.
 */
export async function popOutPane(page: Page, kind: string): Promise<{ popup: Page; paneId: string }> {
  const paneId = await page.evaluate(
    k => (window as unknown as { __workbenchPanes: { open: (k: string) => string } }).__workbenchPanes.open(k),
    kind,
  )
  const tab = page.getByTestId(`region-tab-${paneId}`)
  await tab.waitFor({ state: 'visible', timeout: 20_000 })
  await tab.click({ force: true })

  const popoutButton = page.getByTestId(`region-popout-${paneId}`)
  await popoutButton.waitFor({ state: 'visible', timeout: 20_000 })
  const [popup] = await Promise.all([
    page.context().waitForEvent('page'),
    popoutButton.click({ force: true }),
  ])
  await popup.waitForLoadState('domcontentloaded')
  // The pane's content is mounted by the portal, not by a navigation — wait for the pane node.
  await popup.getByTestId(`region-popout-pane-${paneId}`).waitFor({ state: 'attached', timeout: 20_000 })
  return { popup, paneId }
}

/** Assert an overlay is laid out inside the popup's own viewport, not the opener's. */
export async function expectInsidePopupViewport(popup: Page, selector: string): Promise<void> {
  const box = await popup.locator(selector).first().boundingBox()
  expect(box, `${selector} has no box in the popup`).not.toBeNull()
  expect(box!.width).toBeGreaterThan(0)
  expect(box!.height).toBeGreaterThan(0)
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(POPUP_W)
  expect(box!.y + box!.height).toBeLessThanOrEqual(POPUP_H)
}
