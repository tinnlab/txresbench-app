import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from './_dock'

// TEST-520 (ITEM-56) — the center canvas is the viz `GridWorkspace` (not the old Observable-Plot
// fallback). A fresh project has no embedding, so the canvas host renders its honest empty state.
// (The RegionShell redesign removed the TopToolbar, so the former top plot-type / color-by controls
// no longer exist as testid'd affordances — color-by is now an on-canvas chip that appears WITH
// data; a real GPU deck render is a manual/CI concern, WebGL being unavailable headless.) NEEDS the
// real backend.

test.describe('center canvas embeds viz GridWorkspace (ITEM-56)', () => {
  test('canvas host renders its empty state on a fresh project', async ({ page, request }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `WB Canvas ${Date.now()}`)
    await openWorkbench(page, id)

    // The center canvas host renders. A fresh project has no embedding, so it shows the honest
    // empty state (the color-by chip + deck grid only mount once there's a plottable artifact).
    // (The RegionShell redesign removed the TopToolbar; color-by/plot-type are no longer top-bar
    // affordances — color-by is the on-canvas chip that appears with data.)
    await expect(page.getByTestId('workbench-canvas-host').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('workbench-canvas-empty').first()).toBeVisible()
  })
})
