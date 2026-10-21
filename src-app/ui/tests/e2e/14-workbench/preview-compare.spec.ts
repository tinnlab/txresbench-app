import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from './_dock'

// TEST-537 (ITEM-65) — the compare PANE mounts via the programmatic seam and shows its
// honest empty state in a run-less project (its populated N-run form is exercised in
// `rerun-diff.spec.ts`). No compute backend needed.
//
// ITEM-39 REMOVED this spec's param→outcome LIVE PREVIEW half, and it is a genuine
// coverage LOSS, not a feature deletion: `ParamOutcomePreview` still ships, but it only
// renders for NUMBER params (`paramPreview.ts::previewParamOutcomes` skips every other
// field type) and its only vehicle was the `selection.demo` dogfood's `min_genes`, deleted
// with its FE-code package (ITEM-15/16). No surviving `packages/*` analysis declares a
// number param (`qc.10x` / `cell.filter` / `cellranger.count` / the two converters declare
// artifact-ref / enum / string fields only), so the preview strip has NO shipping producer
// to drive it from. Repoint this half at the first processor analysis that declares one —
// do NOT re-add an app-side fixture analysis to satisfy the spec.

test.describe('compare pane (ITEM-65)', () => {
  test('the compare pane mounts via the programmatic seam and shows its honest empty state', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Preview ${Date.now()}`)
    await openWorkbench(page, id)

    // `open()` ADDS the pane but does not activate it (RegionShell keeps the region's
    // current active tab), so activate its tab — otherwise only the active pane's body renders.
    const comparePaneId = await page.evaluate(() =>
      (window as unknown as { __workbenchPanes: { open: (k: string) => string } }).__workbenchPanes.open('compare'),
    )
    const compareTab = page.getByTestId(`region-tab-${comparePaneId}`)
    await compareTab.waitFor({ state: 'visible', timeout: 20_000 })
    await compareTab.click()
    const comparePane = page.locator('[data-testid^="workbench-compare-pane-"]').first()
    await expect(comparePane).toBeVisible({ timeout: 20_000 })
    await expect(comparePane.locator('[data-testid^="workbench-compare-pane-empty-"]')).toBeVisible()
  })
})
