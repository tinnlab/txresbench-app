import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from './_dock'

// Dock mechanics for the fixed 4-region shell (RegionShell) — the RegionShell-era replacement for
// the removed free-form dock's grip-drag / cross-window / pane-frame specs. Covers the region "+"
// add-pane menu, tab switching (mouse + keyboard), and close-activates-previous (activeHistory).
// Region defaults (regionModel): left = visualize/datasets, center = canvas, right = launcher.

test.describe('RegionShell dock mechanics', () => {
  test('the region "+" menu adds a pane; its content renders', async ({ page, request }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `RegionAdd ${Date.now()}`)
    await openWorkbench(page, id)

    // Add a Jobs pane to the right region via its "+" menu.
    await page.getByTestId('region-add-pane-right').click()
    const menu = page.getByTestId('region-add-pane-menu-right')
    await expect(menu).toBeVisible()
    await menu.getByTestId('region-add-pane-item-jobs').click()

    // The jobs pane mounts + becomes active — its content renders in a region body.
    await expect(page.locator('[data-testid^="workbench-jobs-pane-"]').first()).toBeVisible({ timeout: 20_000 })
  })

  test('clicking a region tab activates its pane; keyboard (Enter) activates too', async ({ page, request }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `RegionTabs ${Date.now()}`)
    await openWorkbench(page, id)

    // Click the datasets tab (left region) → its body becomes visible.
    await page.getByTestId('region-tab-p-datasets').click()
    await expect(page.getByTestId('region-pane-body-p-datasets')).toBeVisible()

    // Keyboard a11y: focus the visualize tab, press Enter → it activates (the tabIndex/onKeyDown fix).
    const visualizeTab = page.getByTestId('region-tab-p-visualize')
    await visualizeTab.focus()
    await visualizeTab.press('Enter')
    await expect(page.getByTestId('region-pane-body-p-visualize')).toBeVisible()
  })

  test('closing the active tab activates the PREVIOUS active (activeHistory), not the first', async ({ page, request }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `RegionHistory ${Date.now()}`)
    await openWorkbench(page, id)

    // The property under test needs THREE tabs in one region: with two, "the previous" and
    // "the first" are the same tab and the assertion proves nothing. The left region used to
    // ship three by default (visualize/datasets/selection); the `selection` "Inspector" pane is
    // deleted, so the third is added here through the region "+" menu — which also makes the
    // test independent of how many panes the default IA happens to seed.
    await page.getByTestId('region-add-pane-left').click()
    const menu = page.getByTestId('region-add-pane-menu-left')
    await expect(menu).toBeVisible()
    await menu.getByTestId('region-add-pane-item-jobs').click()

    // Its pane id is generated (`pane-<n>`), so read it off the tab rather than guessing.
    const jobsTab = page.getByTestId('region-strip-left').locator('[role="tab"][aria-label="Jobs"]')
    await expect(jobsTab).toBeVisible()
    const jobsId = ((await jobsTab.getAttribute('data-testid')) as string).slice('region-tab-'.length)

    // Left region tabs: activate datasets, then jobs → jobs active, datasets the previous.
    await page.getByTestId('region-tab-p-datasets').click()
    await jobsTab.click()
    await expect(page.getByTestId(`region-pane-body-${jobsId}`)).toBeVisible()

    // Close the active (jobs) tab (its close X appears on hover).
    await jobsTab.hover()
    await page.getByTestId(`region-tab-close-${jobsId}`).click()

    // The PREVIOUS active (datasets) is now shown — NOT visualize (the first tab).
    await expect(page.getByTestId('region-pane-body-p-datasets')).toBeVisible()
    await expect(page.getByTestId('region-pane-body-p-visualize')).toHaveCount(0)
    await expect(jobsTab).toHaveCount(0)
  })
})
