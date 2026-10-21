import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { authToken, createProjectViaApi, gotoProjects, loginAsOwner } from '../mcp/helpers'
import { createDatasetApi } from '../datasets/_helpers'

// TEST-104 (PLAN.md ITEM-3) — CONTEXT gating of the ⌘K command palette. Proves
// the gating is real (not an empty/broken registry):
//   • a `context:'workbench'` action (`analysis.launch`) is ABSENT off the
//     workbench and APPEARS once the Workspace section mounts (the section
//     calls `useActiveContext('workbench')` + registers its live instance);
//   • a `surfaces.palette:false` action (`dataset.process`, AI-only) NEVER
//     appears in ⌘K — even on the dataset detail page where its `'dataset'`
//     context IS active (isolating the palette-surface opt-out from context);
//   • a `context:'global'` action (`project.create`) stays visible everywhere.
//
// RUNS in Phase 8 (per TESTS.md) — the workbench "appears" assertion depends on
// the W2 dock registering the live `'workbench'` instance the palette offers
// `analysis.launch` against.

const palette = (page: Page) => page.locator('[data-slot="dialog-content"]')

async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press('Control+K')
  await expect(page.getByTestId('command-palette-input')).toBeVisible()
}

async function closePalette(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(palette(page)).toHaveCount(0)
}

test.describe('command palette — context gating', () => {
  test('a workbench-context action appears only on the workbench; a palette-hidden action never appears; a global action always shows', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    await gotoProjects(page)
    const token = await authToken(page)

    // ── Off the workbench: the `'workbench'` context is INACTIVE.
    await openPalette(page)
    // context:'global' positive control — always offered.
    await expect(page.getByTestId('command-palette-item-project.create')).toBeVisible()
    // context:'workbench' action absent (context inactive).
    await expect(page.getByTestId('command-palette-item-analysis.launch')).toHaveCount(0)
    // surfaces.palette:false action absent (opted out of ⌘K).
    await expect(page.getByTestId('command-palette-item-dataset.process')).toHaveCount(0)
    await closePalette(page)

    // ── On the workbench: the section mounts → `'workbench'` context active +
    //    its live instance registered → `analysis.launch` becomes offerable.
    const project = await createProjectViaApi(request, token, `Ctx-Palette ${Date.now()}`)
    await page.goto(`/projects/${project.id}/workspace`)
    await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 20_000 })

    await openPalette(page)
    await expect(page.getByTestId('command-palette-item-analysis.launch')).toBeVisible()
    // global action still visible; palette-hidden still hidden.
    await expect(page.getByTestId('command-palette-item-project.create')).toBeVisible()
    await expect(page.getByTestId('command-palette-item-dataset.process')).toHaveCount(0)
    await closePalette(page)

    // ── On the dataset detail page: `'dataset'` context is ACTIVE, yet
    //    `dataset.process` STILL does not appear — proving `palette:false`
    //    (not merely context) hides it. `analysis.launch` (workbench) is gone
    //    here (that context is now inactive), a further gating positive.
    const dataset = await createDatasetApi(request, token, `Ctx-Palette DS ${Date.now()}`)
    await page.goto(`/datasets/${dataset.id}`)
    await page.getByTestId('dataset-detail-page').waitFor({ state: 'visible', timeout: 20_000 })

    await openPalette(page)
    await expect(page.getByTestId('command-palette-item-dataset.process')).toHaveCount(0)
    await expect(page.getByTestId('command-palette-item-analysis.launch')).toHaveCount(0)
    await expect(page.getByTestId('command-palette-item-project.create')).toBeVisible()
    await closePalette(page)
  })
})
