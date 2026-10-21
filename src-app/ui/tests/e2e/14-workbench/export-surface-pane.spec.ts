import { expect, test, type Locator, type Page } from '@playwright/test'
import { loginAsOwner, ownerToken } from '../project/_helpers'
import { BACKEND, createProject, openWorkbench, trackErrors } from './_dock'
import { seedPlottableProject } from '../14-declarative-qc/_seed'

// The canvas EXPORT surface renders as a RIGHT-SIDE WORKBENCH PANE, beside the canvas — for the
// WHOLE-GRID export (the reported symptom) and for a single plot's export alike.
//
// ── The reported symptom, and what makes it measurable ──────────────────────────────────────
// `@ziee/viz`'s grid falls back to its OWN internal right panel (`viz-edit-panel`) whenever the
// host provides no container for an open surface, and that panel is a ~300px column INSIDE the
// workspace, a flex SIBLING of `viz-grid-workspace`. So "Export whole grid" opened inside the
// canvas and shrank the very grid the user was about to export.
//
// The assertions are therefore GEOMETRIC and STRUCTURAL, never a class name:
//   (1) the grid workspace's own width does not change when the export opens — the canvas keeps
//       the whole centre region. That is the reported symptom, measured directly.
//   (2) the dialog's DOM ancestry is a `region-pane-body-…` in the RIGHT region and is NOT
//       under `viz-grid-workspace`; it paints to the right of the grid's right edge.
//   (3) the grid's internal panel is not rendered at all — nothing was left to stack in it.
//
// ── The invariant most likely to be silently lost ───────────────────────────────────────────
// The export surface is GRID-SCOPED as well as plot-scoped: viz owns ONE export target and
// resolves its container with that target's grid pane id — or with the reserved `'__grid__'`
// sentinel for a whole-grid export. So the host mints one container per SUBJECT, and because
// only one export can be open, exactly one export pane exists at a time and it must name the
// subject actually being exported. A host that keyed every target to one container would
// satisfy every "not in the grid" assertion above while leaving the pane claiming to export
// the wrong thing — so this spec exports the whole grid, then exports a single plot, and
// asserts the pane FOLLOWED (one tab, retitled), with the per-plot path landing in a pane of
// its own rather than being collateral damage.
//
// The jsdom sibling (`src/modules/workbench/core/shell/regions/exportSurfacePane.test.tsx`)
// carries the live CONTROL — a resolver that answers nothing puts the dialog back inside
// `grid-root` — which is not reachable here: the resolver is wired at the mount site.
//
// Real backend, real seeded artifacts, the real deck.gl grid. No `page.route` mocking.

/** The grid's per-plot toolbar actions, BY ACCESSIBLE NAME (the kit gives an icon button its
 *  tooltip as its aria-label). The toolbar folds actions into an overflow menu at narrow
 *  widths and the folded row carries the same name — so: click it where it is, else open the
 *  overflow and click it there. */
const ACTION_NAME: Record<'export', string> = { export: 'Export this pane' }

async function paneAction(page: Page, plotId: string, key: 'export'): Promise<void> {
  const toolbar = page.getByTestId(`viz-pane-toolbar-${plotId}`)
  const inline = toolbar.getByRole('button', { name: ACTION_NAME[key] })
  if (await inline.count()) {
    await inline.first().click()
    return
  }
  await toolbar.getByRole('button', { name: `More actions for ${plotId}`, exact: true }).click()
  await page.getByRole('button', { name: ACTION_NAME[key] }).first().click()
  await page.keyboard.press('Escape')
}

/** The plot pane ids the canvas grid currently renders, read off each plot's toolbar. */
async function plotIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="viz-pane-toolbar-"]')].map(el =>
      (el.getAttribute('data-testid') as string).slice('viz-pane-toolbar-'.length),
    ),
  )
}

/** The container the shell minted for the export of `subject` (a plot pane id, or viz's
 *  reserved whole-grid sentinel). Present in the document only while its pane is the region's
 *  ACTIVE tab. */
function exportHost(page: Page, subject: string): Locator {
  return page.locator(`[data-pane-surface-host="export:${subject}"]`)
}

/** Every open EXPORT pane tab, by accessible name — present whether or not the pane is active. */
function exportTabs(page: Page): Locator {
  return page.getByRole('tab', { name: /^Export · / })
}

async function boxOf(loc: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await loc.boundingBox()
  expect(box, 'element must have a layout box').not.toBeNull()
  return box as { x: number; y: number; width: number; height: number }
}

/** Where a surface container sits, structurally. */
async function placementOf(host: Locator, dialogTestId: string) {
  return host.evaluate((el, dialog) => {
    return {
      insideGrid: !!el.closest('[data-testid="viz-grid-workspace"]'),
      paneBody: el.closest('[data-testid^="region-pane-body-"]')?.getAttribute('data-testid') ?? null,
      region: el.closest('[data-region]')?.getAttribute('data-region') ?? null,
      // The surface's OWN root, so this is the real dialog and not an empty container.
      dialog: el.querySelector(`[data-testid="${dialog}"]`) ? dialog : null,
    }
  }, dialogTestId)
}

test.describe('the canvas export surface docks as a right-side workbench pane', () => {
  test('Export whole grid docks right, the canvas keeps full width, a per-plot export follows', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const token = await ownerToken(request)
    expect(token, 'the owner session is required to seed').toBeTruthy()
    expect(BACKEND, 'the harness resolves a backend origin').toBeTruthy()
    const projectId = await createProject(request, `Export surface pane ${Date.now()}`)
    await seedPlottableProject(request, projectId)

    const bag = trackErrors(page)
    await openWorkbench(page, projectId)

    const grid = page.getByTestId('viz-grid-workspace')
    await expect(grid, 'the centre canvas mounted the real viz grid').toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-testid^="viz-pane-toolbar-"]').first()).toBeVisible({ timeout: 30_000 })
    const ids = await plotIds(page)
    expect(ids.length, 'the canvas rendered a plot pane').toBeGreaterThan(0)
    const plotA = ids[0]

    // ── (1) THE REPORTED SYMPTOM, measured: grid width before vs after the WHOLE-GRID export ──
    const gridBefore = await boxOf(grid)
    await page.getByTestId('viz-tool-rail-export-grid').click()

    // viz's reserved whole-grid subject id — the same token `exportDialogContainer` is called
    // with, so this asserts the grid-scoped container specifically, not "some export container".
    const gridExport = exportHost(page, '__grid__')
    await expect(gridExport, 'the shell minted a container for the whole-grid export').toHaveCount(1)
    await expect(gridExport).toBeVisible()

    const gridAfter = await boxOf(grid)
    expect(
      Math.abs(gridAfter.width - gridBefore.width),
      'exporting the whole grid must not take width from the grid being exported (the reported symptom)',
    ).toBeLessThanOrEqual(1)

    // ── (2) STRUCTURE: the dialog hangs off a pane body in the RIGHT region, not off the grid ──
    const gridPlacement = await placementOf(gridExport, 'viz-export-dialog-grid')
    expect(gridPlacement.insideGrid, 'the export surface must not be inside the canvas grid').toBe(false)
    expect(gridPlacement.paneBody, 'the export surface must be inside a workbench pane body').not.toBeNull()
    expect(gridPlacement.region, 'the pane must live in the RIGHT region').toBe('right')
    expect(gridPlacement.dialog, 'the pane must hold the real export dialog').toBe('viz-export-dialog-grid')

    // …and it paints BESIDE the grid, not over it.
    const gridExportBox = await boxOf(gridExport)
    expect(gridExportBox.x, 'the pane sits to the right of the canvas').toBeGreaterThanOrEqual(
      gridAfter.x + gridAfter.width - 1,
    )

    // ── (3) the grid's internal fallback panel is not used at all ───────────────────────────
    await expect(page.getByTestId('viz-edit-panel')).toHaveCount(0)

    // The tab names the SUBJECT, and the reserved sentinel never reaches the user.
    await expect(exportTabs(page)).toHaveCount(1)
    await expect(page.getByRole('tab', { name: 'Export · Whole grid', exact: true })).toHaveCount(1)
    await expect(page.getByRole('tab', { name: /__grid__/ })).toHaveCount(0)

    await page.screenshot({ path: test.info().outputPath('export-whole-grid-docked-right.png'), fullPage: false })
    await test.info().attach('export-whole-grid-docked-right', {
      path: test.info().outputPath('export-whole-grid-docked-right.png'),
      contentType: 'image/png',
    })

    // ── the PER-PLOT export path is not collateral damage: one export at a time, retitled ────
    await paneAction(page, plotA, 'export')
    const plotExport = exportHost(page, plotA)
    await expect(plotExport, 'the per-plot export minted its OWN container').toHaveCount(1)
    await expect(exportHost(page, '__grid__'), 'the previous subject was retired with its pane').toHaveCount(0)
    await expect(exportTabs(page), 'viz allows ONE open export, so there is ONE export pane').toHaveCount(1)
    await expect(page.getByRole('tab', { name: `Export · ${plotA}`, exact: true })).toHaveCount(1)

    const plotPlacement = await placementOf(plotExport, `viz-export-dialog-${plotA}`)
    expect(plotPlacement.insideGrid, 'the per-plot export must not be inside the grid either').toBe(false)
    expect(plotPlacement.region).toBe('right')
    expect(plotPlacement.dialog).toBe(`viz-export-dialog-${plotA}`)
    await expect(page.getByTestId('viz-edit-panel')).toHaveCount(0)

    // The canvas is STILL full width.
    const gridWithPlotExport = await boxOf(grid)
    expect(Math.abs(gridWithPlotExport.width - gridBefore.width)).toBeLessThanOrEqual(1)

    // ── closing the surface takes its pane with it, leaving no orphan tab ────────────────────
    await plotExport.locator(`[data-testid="viz-export-close-${plotA}"]`).click()
    await expect(exportTabs(page), 'the pane goes with the surface').toHaveCount(0)
    await expect(exportHost(page, plotA)).toHaveCount(0)
    await expect(page.getByTestId('viz-edit-panel')).toHaveCount(0)

    expect(bag.errors, 'docking the export surface must not throw').toEqual([])
  })
})
