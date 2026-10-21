import { expect, test, type Page } from '@playwright/test'
import { loginAsOwner, ownerToken } from '../project/_helpers'
import { createProject } from './_dock'

// TEST-323 (ITEM-31) — the mobile fallback. Below the 768px breakpoint the workbench renders
// `MobileShell` (the registry-driven `PlacedArea` regions in bottom-bar Sheets, canvas as the
// hero), and the tiling dock — with its pane-drag GRIPS + POP-OUT buttons — is NOT mounted, so
// those layout affordances are absent (a phone can't tile/pop-out). A DESKTOP width (positive
// control) DOES mount the dock with grips + pop-out, so the mobile absences are non-vacuous.

async function openWorkspace(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/workspace`)
  await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 20_000 })
}

test('below the breakpoint the workbench renders MobileShell with pop-out + drag disabled — TEST-323', async ({
  browser,
  request,
}) => {
  // Create the project over REST (ownerToken handles first-run setup if this runs first).
  await ownerToken(request)
  const id = await createProject(request, `Mobile ${Date.now()}`)

  // Mobile viewport (390px < 768) → the MobileShell branch.
  const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 800 } })
  const mp = await mobileCtx.newPage()
  await loginAsOwner(mp)
  await openWorkspace(mp, id)

  // MobileShell markers render (the bottom bar + the mobile flag).
  await expect(mp.locator('[data-testid="workbench-shell"][data-workbench-mobile="true"]')).toBeVisible()
  await expect(mp.getByTestId('workbench-mobile-bar')).toBeVisible()
  // The tiling dock's pane-drag GRIPS + POP-OUT buttons are absent (not mounted on mobile).
  await expect(mp.locator('[data-testid^="region-tab-"]')).toHaveCount(0)
  await expect(mp.locator('[data-testid^="region-popout-"]')).toHaveCount(0)
  await mobileCtx.close()

  // Positive control — a DESKTOP width mounts the dock WITH grips + pop-out (non-vacuous).
  const wideCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const wp = await wideCtx.newPage()
  await loginAsOwner(wp)
  await openWorkspace(wp, id)
  await expect(wp.locator('[data-testid="workbench-shell"][data-workbench-mobile="true"]')).toHaveCount(0)
  await expect(wp.locator('[data-testid^="region-tab-"]').first()).toBeVisible()
  await expect(wp.locator('[data-testid^="region-popout-"]').first()).toBeVisible()
  await wideCtx.close()
})
