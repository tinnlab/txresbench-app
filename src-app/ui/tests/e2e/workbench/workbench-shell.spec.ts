import { expect, test } from '@playwright/test'
import { loginAsOwner, ownerToken } from '../project/_helpers'

// The workbench SHELL mount + per-project layout persistence, on the real backend.
//
// REWRITTEN for the RegionShell redesign. The pre-RegionShell surfaces these specs used
// to assert are GONE from the app and their coverage moved:
//   • `workbench-toolbar*` (plot-type / layout / Run / Export / reset / color-by) — the
//     TopToolbar was removed; Run is driven from the launcher + run pane
//     (`14-workbench/run-config.spec.ts`, `viewer-readonly.spec.ts`).
//   • `workbench-dock-<side>-collapse` / `workbench-stripe-<side>` — replaced by
//     `region-collapse-<region>` / `region-strip-<region>`.
//   • `workbench-metadata-field-*` click-to-color — the hardcoded left rail became the
//     `fieldProviders` registry rail, and ITEM-33 then deleted BOTH (the registry had zero
//     contributors once the single-cell processor package went). Click-to-recolour is gone
//     as a user-visible affordance; declarative colouring is unaffected (a processor's
//     `view_spec` encodes it as `valueKey`/`groupKey`/`colorBy`). The left dock AREA
//     remains, vacant — `14-workbench/dock-areas-views.spec.ts` asserts its empty state.
//   • tab add / switch / close mechanics — `14-workbench/region-dock-mechanics.spec.ts`.
//   • the `project-section-tab-workspace` tab — the project detail page IS the full-bleed
//     workbench now (`/projects/:id` lands on `/workspace`), so there is no section strip.
// What remains genuinely unique here: the full-bleed mount + no page h-scroll, and the
// per-project layout PERSISTENCE across a reload.

// The backend base for API-request helpers. Imported from `_owner`, which derives it from
// `E2E_BACKEND` — the value `playwright.config.ts` assigns from the port it RESOLVED for this
// run. There is deliberately no `?? 'http://127.0.0.1:3155'` fallback any more: a committed
// default is only correct while every run uses the same port, and the moment ports became
// per-worktree it would have aimed these helpers at whatever else happened to be on :3155.
import { BACKEND } from '../_owner'

async function createProject(request: import('@playwright/test').APIRequestContext, name: string): Promise<string> {
  const admin = await ownerToken(request)
  const r = await request.post(`${BACKEND}/api/projects`, {
    headers: { authorization: `Bearer ${admin}` },
    data: { name, description: '' },
  })
  expect(r.ok()).toBeTruthy()
  return (await r.json()).id
}

async function openWorkbench(page: import('@playwright/test').Page, projectId: string) {
  await page.goto(`/projects/${projectId}/workspace`)
  await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 20_000 })
}

test.describe('workbench shell', () => {
  // TEST-5 / TEST-23: the region shell mounts full-bleed with all regions + the canvas hero.
  test('mounts the region shell full-bleed at /projects/:id/workspace — TEST-5', async ({ page, request }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `WB Shell ${Date.now()}`)
    await openWorkbench(page, id)

    // full-bleed — no max-w-5xl clamp on the page container.
    await expect(page.getByTestId('project-detail-page')).not.toHaveClass(/max-w-5xl/)
    // all regions + the canvas hero present.
    await expect(page.getByTestId('workbench-region-shell')).toBeVisible()
    await expect(page.getByTestId('region-left')).toBeVisible()
    await expect(page.getByTestId('region-center')).toBeVisible()
    await expect(page.getByTestId('region-right')).toBeVisible()
    await expect(page.getByTestId('region-bottom')).toBeVisible()
    await expect(page.getByTestId('workbench-canvas-host')).toBeVisible()
    // no horizontal page scroll (the min-h-0/min-w-0 chain holds).
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    )
    expect(overflow).toBe(true)
  })

  // TEST-23 / TEST-24: the project detail page IS the workspace (full-bleed workbench) —
  // a bare /projects/:id lands on it rather than a separate section tab.
  test('a bare /projects/:id lands on the full-bleed workspace — TEST-23', async ({ page, request }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `WB Nav ${Date.now()}`)
    await page.goto(`/projects/${id}`)
    await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 20_000 })
    await expect(page).toHaveURL(/\/workspace$/)
  })

  // TEST-6 / TEST-7: collapse a region → labeled strip → one-click reopen, a11y aria-expanded.
  test('collapses a region to a labeled strip and reopens it — TEST-6', async ({ page, request }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `WB Collapse ${Date.now()}`)
    await openWorkbench(page, id)

    // The activity STRIP is always mounted (it hosts the region's tabs + the collapse
    // toggle); collapsing removes the expanded region PANEL beside it.
    const collapse = page.getByTestId('region-collapse-left')
    await expect(collapse).toBeVisible()
    await expect(page.getByTestId('region-left')).toBeVisible()
    await collapse.click()
    await expect(page.getByTestId('region-left')).toHaveCount(0)
    await expect(page.getByTestId('region-strip-left')).toBeVisible()
    // one click on the same toggle reopens it.
    await page.getByTestId('region-collapse-left').click()
    await expect(page.getByTestId('region-left')).toBeVisible()
  })

  // TEST-4 (ITEM-2): the per-project PANE layout persists across a reload.
  test('persists the per-project pane layout across reload — TEST-4', async ({ page, request }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `WB Persist ${Date.now()}`)
    await openWorkbench(page, id)

    // Add a Jobs pane to the right region (the same affordance region-dock-mechanics drives).
    await page.getByTestId('region-add-pane-right').click()
    await page.getByTestId('region-add-pane-menu-right').getByTestId('region-add-pane-item-jobs').click()
    const jobsPane = page.locator('[data-testid^="workbench-jobs-pane-"]').first()
    await expect(jobsPane).toBeVisible({ timeout: 20_000 })

    await page.reload()
    await page.getByTestId('workbench-shell').waitFor({ state: 'visible' })

    // persisted: the added pane is still part of THIS project's layout after a reload
    // (its tab is present; activating it re-renders its body).
    const jobsTab = page.locator('[data-testid^="region-tab-pane-"]')
    await expect(jobsTab.first()).toBeVisible({ timeout: 20_000 })
    const restored = await page.evaluate(() =>
      (window as unknown as { __workbenchPanes: { panes: () => string[] } }).__workbenchPanes.panes(),
    )
    expect(restored.some(p => p.startsWith('pane-'))).toBe(true)
  })

  // TEST-4b: the region ARRANGEMENT (collapse / size / active tab) survives a reload.
  //
  // This is the assertion the pre-RegionShell TEST-4 used to make and that the redesign dropped:
  // the pane LAYOUT persisted (`WorkbenchDock.store` → localStorage) but the arrangement lived in
  // an unpersisted in-memory `WorkbenchRegions.store`, so every reload reset it. Reverting
  // `WorkbenchRegions.store`'s persistence turns this test red at the first assertion below.
  test('persists the region arrangement (collapse / size / active tab) across reload — TEST-4b', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `WB Arrangement ${Date.now()}`)
    await openWorkbench(page, id)

    // The left region holds 3 default panes (Visualize / Selection / Datasets) → real tabs.
    // Activate a NON-default one (the default active falls back to the first pane).
    const datasetsTab = page.getByTestId('region-tab-p-datasets')
    await expect(datasetsTab).toBeVisible({ timeout: 20_000 })
    await datasetsTab.click()
    await expect(page.getByTestId('region-pane-body-p-datasets')).toBeVisible()

    // Resize the left region by dragging its divider (the real pointer path → `setLeftWidth`).
    const leftPanel = page.getByTestId('region-left')
    const widthOf = async () => (await leftPanel.evaluate(el => (el as HTMLElement).style.width)) || ''
    expect(await widthOf()).toBe('260px') // the default
    const divider = page.locator('[data-region="left"] [role="separator"]').first()
    const box = (await divider.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect.poll(widthOf).toBe('340px')

    // Collapse the RIGHT region (left stays expanded so its width + active tab stay observable).
    await page.getByTestId('region-collapse-right').click()
    await expect(page.getByTestId('region-right')).toHaveCount(0)

    await page.reload()
    await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 20_000 })

    // COLLAPSE survived — the right region is still a bare strip.
    await expect(page.getByTestId('region-strip-right')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('region-right')).toHaveCount(0)
    // SIZE survived. Sizes are a GLOBAL preference the store reads at construction, so the width
    // is already right at the first paint (no default-width flash) — hence a plain read, not a poll.
    expect(await widthOf()).toBe('340px')
    // ACTIVE TAB survived — Datasets, not the first-pane fallback (Visualize).
    await expect(page.getByTestId('region-tab-p-datasets')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('region-pane-body-p-datasets')).toBeVisible()
    await expect(page.getByTestId('region-pane-body-p-visualize')).toHaveCount(0)
  })
})
