import { expect, test, type Locator, type Page } from '@playwright/test'
import { loginAsOwner, ownerToken } from '../project/_helpers'
import { BACKEND, createProject, openWorkbench, trackErrors } from './_dock'
import { seedPlottableProject } from '../14-declarative-qc/_seed'

// A plot's "Edit plot" / "View table" surfaces render as SEPARATE RIGHT-SIDE WORKBENCH PANES,
// beside the canvas — not inside it.
//
// ── The reported symptom, and what makes it measurable ──────────────────────────────────────
// `@ziee/viz`'s grid falls back to its OWN internal right panel (`viz-edit-panel`) whenever the
// host provides no container for an open surface, and that panel is a ~300px column INSIDE the
// workspace. So opening a plot's editor SHRANK the plot being edited. The workbench passed no
// container resolver at all, so every surface took that path.
//
// The assertions are therefore GEOMETRIC and STRUCTURAL, never a class name:
//   (1) the grid workspace's own width does not change when a surface opens — the canvas keeps
//       the whole centre region. That is the reported symptom, measured directly.
//   (2) the surface's DOM ancestry is a `region-pane-body-…` in the RIGHT region and is NOT
//       under `viz-grid-workspace`; it paints to the right of the grid's right edge.
//   (3) the grid's internal panel is not rendered at all — nothing was left to stack in it.
//
// ── The invariant most likely to be silently lost ───────────────────────────────────────────
// The grid resolves its container ONCE PER OPEN SURFACE (viz INV-8). Two plots edited at once
// must be TWO panes with TWO containers, not one pane that retargets — which would satisfy
// every assertion above while making the second plot's editor unreachable. So this opens two
// plots' editors and asserts two panes, and that each is independently operable: each holds
// its OWN plot's live title field, and a value typed into one survives the other being used.
//
// HOW THE SHELL SHOWS TWO PANES IN ONE REGION: a workbench region is TABBED, so both surfaces
// are simultaneously OPEN (two panes, two containers, two mounted forms) and the region shows
// one at a time. A non-active pane's container is DETACHED, never unmounted — which is why the
// spec asserts the second pane through its TAB and then selects it, and why the value typed
// into it is still there afterwards.
//
// Real backend, real seeded artifacts, the real deck.gl grid. No `page.route` mocking.

/** The grid's per-plot toolbar actions, BY ACCESSIBLE NAME (the kit gives an icon button its
 *  tooltip as its aria-label), so this drives the affordance a user sees rather than a testid.
 *  The toolbar folds actions into an overflow menu at narrow widths, and the folded row carries
 *  the same name — so: click it where it is, else open the overflow and click it there. */
const ACTION_NAME: Record<'edit' | 'data' | 'split', string | RegExp> = {
  edit: 'Edit this plot',
  data: 'Show plotting data as a table',
  // A PREFIX pattern rather than the whole label: the split action's label carries a domain
  // noun the app surface is guarded against spelling (`lint-no-domain-in-builtin`), and the
  // prefix identifies the button just as uniquely inside one plot's toolbar.
  split: /^Split\b/,
}

async function paneAction(page: Page, plotId: string, key: 'edit' | 'data' | 'split'): Promise<void> {
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

/** The container the shell minted for `(kind, plotId)`. Present in the document only while its
 *  pane is the region's ACTIVE tab (see the tab note above). */
function surfaceHost(page: Page, kind: 'edit-plot' | 'data-table', plotId: string): Locator {
  return page.locator(`[data-pane-surface-host="${kind}:${plotId}"]`)
}

/** The region tab for a hosted surface, by its accessible name — the user-visible handle, and
 *  the one thing that is present whether or not the pane is the active tab. */
function surfaceTab(page: Page, title: string, plotId: string): Locator {
  return page.getByRole('tab', { name: `${title} · ${plotId}`, exact: true })
}

async function boxOf(loc: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await loc.boundingBox()
  expect(box, 'element must have a layout box').not.toBeNull()
  return box as { x: number; y: number; width: number; height: number }
}

test.describe('a plot surface docks as a right-side workbench pane', () => {
  test('Edit plot + View table dock right, the canvas keeps full width, two plots stay independent', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const token = await ownerToken(request)
    expect(token, 'the owner session is required to seed').toBeTruthy()
    expect(BACKEND, 'the harness resolves a backend origin').toBeTruthy()
    const projectId = await createProject(request, `Plot surface panes ${Date.now()}`)
    await seedPlottableProject(request, projectId)

    const bag = trackErrors(page)
    await openWorkbench(page, projectId)

    const grid = page.getByTestId('viz-grid-workspace')
    await expect(grid, 'the centre canvas mounted the real viz grid').toBeVisible({ timeout: 30_000 })

    // The canvas paints at least one plot pane; a second comes from the grid's own Split action,
    // so the two-plot case exercises the SAME production path a user takes.
    await expect(page.locator('[data-testid^="viz-pane-toolbar-"]').first()).toBeVisible({ timeout: 30_000 })
    let ids = await plotIds(page)
    expect(ids.length, 'the canvas rendered a plot pane to edit').toBeGreaterThan(0)
    if (ids.length < 2) {
      await paneAction(page, ids[0], 'split')
      await expect.poll(async () => (await plotIds(page)).length, { timeout: 15_000 }).toBeGreaterThan(1)
      ids = await plotIds(page)
    }
    const [plotA, plotB] = ids

    // ── (1) THE REPORTED SYMPTOM, measured: the grid's width before vs after opening a surface ──
    const gridBefore = await boxOf(grid)
    await paneAction(page, plotA, 'edit')

    const hostA = surfaceHost(page, 'edit-plot', plotA)
    await expect(hostA, 'the shell minted a container for the open surface').toHaveCount(1)
    await expect(hostA).toBeVisible()

    const gridAfter = await boxOf(grid)
    expect(
      Math.abs(gridAfter.width - gridBefore.width),
      'opening a plot surface must not take width from the canvas (the reported symptom)',
    ).toBeLessThanOrEqual(1)

    // ── (2) STRUCTURE: the form hangs off a pane body in the RIGHT region, not off the grid ──
    const placement = await hostA.evaluate(el => ({
      insideGrid: !!el.closest('[data-testid="viz-grid-workspace"]'),
      paneBody: el.closest('[data-testid^="region-pane-body-"]')?.getAttribute('data-testid') ?? null,
      region: el.closest('[data-region]')?.getAttribute('data-region') ?? null,
      // The surface's OWN root, so this is the real form and not an empty container.
      form: el.querySelector('[data-testid^="viz-edit-form-"]')?.getAttribute('data-testid') ?? null,
    }))
    expect(placement.insideGrid, 'the surface must not be inside the canvas grid').toBe(false)
    expect(placement.paneBody, 'the surface must be inside a workbench pane body').not.toBeNull()
    expect(placement.region, 'the pane must live in the RIGHT region').toBe('right')
    expect(placement.form, 'the pane must hold the real edit form').toBe(`viz-edit-form-${plotA}`)
    // HOSTED ⇒ HEADERLESS. The pane's own header (shell chrome) is the only title, so the form's
    // own title + close row stands down. Asserted on the DOM, not on a class: a CSS-hidden header
    // would still be in the accessibility tree and the duplicate would survive there.
    await expect(
      page.getByTestId(`viz-edit-form-close-${plotA}`),
      'the hosted edit form must not draw its own close under the pane header',
    ).toHaveCount(0)
    await expect(
      hostA.getByText('Edit plot', { exact: true }),
      'the hosted edit form must not print its own "Edit plot" title beside the pane header',
    ).toHaveCount(0)

    // …and it paints BESIDE the grid, not over it.
    const hostBoxA = await boxOf(hostA)
    expect(hostBoxA.x, 'the pane sits to the right of the canvas').toBeGreaterThanOrEqual(
      gridAfter.x + gridAfter.width - 1,
    )

    // ── (3) the grid's internal fallback panel is not used at all ───────────────────────────
    await expect(page.getByTestId('viz-edit-panel')).toHaveCount(0)

    // ── INV-8: a SECOND plot's editor is a SECOND pane, not a retarget of the first ─────────
    await paneAction(page, plotB, 'edit')
    const tabA = surfaceTab(page, 'Edit plot', plotA)
    const tabB = surfaceTab(page, 'Edit plot', plotB)
    await expect(tabB, 'the second plot opened its own pane').toHaveCount(1)
    await expect(tabA, 'the first plot kept its pane (a retarget would leave one tab)').toHaveCount(1)
    await expect(page.getByTestId('viz-edit-panel')).toHaveCount(0)
    const gridWithTwo = await boxOf(grid)
    expect(Math.abs(gridWithTwo.width - gridBefore.width)).toBeLessThanOrEqual(1)

    // …and it is B's OWN form in B's own container.
    const hostB = surfaceHost(page, 'edit-plot', plotB)
    await expect(hostB).toBeVisible()
    await expect(hostB.locator(`[data-testid="viz-edit-form-${plotB}"]`)).toHaveCount(1)
    await expect(hostB.locator(`[data-testid="viz-edit-form-${plotA}"]`)).toHaveCount(0)

    // ── each is independently operable ──────────────────────────────────────────────────────
    const titleB = hostB.locator(`[data-testid="viz-edit-title-${plotB}"]`)
    await titleB.fill('beta plot')
    await titleB.blur()

    await tabA.click()
    const hostAgainA = surfaceHost(page, 'edit-plot', plotA)
    await expect(hostAgainA).toBeVisible()
    const titleA = hostAgainA.locator(`[data-testid="viz-edit-title-${plotA}"]`)
    expect(
      await titleA.inputValue(),
      "editing one plot's title must not reach the other",
    ).not.toBe('beta plot')
    await titleA.fill('alpha plot')
    await titleA.blur()

    // Back to B: its edit survived A's pane taking the region — two live, independent forms.
    await tabB.click()
    await expect(surfaceHost(page, 'edit-plot', plotB).locator(`[data-testid="viz-edit-title-${plotB}"]`)).toHaveValue(
      'beta plot',
    )

    // ── the plotting-data table is a SEPARATE pane of its own ──────────────────────────────
    await paneAction(page, plotA, 'data')
    const tableHost = surfaceHost(page, 'data-table', plotA)
    await expect(tableHost).toHaveCount(1)
    await expect(tableHost.locator('[data-testid="viz-plot-data-table"]')).toHaveCount(1)
    expect(
      await tableHost.evaluate(el => !el.closest('[data-testid="viz-grid-workspace"]')),
      'the table must not be inside the canvas grid either',
    ).toBe(true)
    await expect(surfaceTab(page, 'Plot data', plotA)).toHaveCount(1)
    await expect(page.getByTestId('viz-edit-panel')).toHaveCount(0)
    // The canvas is STILL full width with three surfaces open.
    const gridWithThree = await boxOf(grid)
    expect(Math.abs(gridWithThree.width - gridBefore.width)).toBeLessThanOrEqual(1)

    await page.screenshot({ path: test.info().outputPath('plot-surfaces-docked-right.png') })
    await test.info().attach('plot-surfaces-docked-right', {
      path: test.info().outputPath('plot-surfaces-docked-right.png'),
      contentType: 'image/png',
    })

    // ── the pane looks and closes like EVERY OTHER PANE ───────────────────────────────────
    //
    // It used to carry no shell close at all: a close that only removed the projection would have
    // left the surface open in a detached container, invisible, with the plot's toggle still lit.
    // viz now hands the shell a real closer (`registerHostedSurfaceClose`), so the affordance is
    // shipped WORKING rather than withheld — and the surface renders HEADERLESS underneath the
    // shell's pane header, so the title is on screen once.
    const paneBodyId = await tableHost.evaluate(
      el => el.closest('[data-testid^="region-pane-body-"]')?.getAttribute('data-testid') ?? '',
    )
    const paneId = paneBodyId.slice('region-pane-body-'.length)
    await expect(
      tableHost.locator('[data-testid="viz-plot-data-close"]'),
      'a hosted surface must not draw its own close beside the shell\'s — one pane, one close',
    ).toHaveCount(0)
    // The shell's close, where the user looked for it.
    const shellClose = page.getByTestId(`region-tab-close-${paneId}`)
    await expect(shellClose, 'every pane title carries a close').toHaveCount(1)
    await shellClose.click()
    // THE OUTCOME: the SURFACE closed, not merely its projection — its container is gone from the
    // document, so nothing is left mounted and unreachable.
    await expect(surfaceHost(page, 'data-table', plotA), 'the surface itself must close').toHaveCount(0)
    await expect(surfaceTab(page, 'Plot data', plotA), 'the pane goes with the surface').toHaveCount(0)
    await expect(tabA, 'the other panes are untouched').toHaveCount(1)
    await expect(tabB).toHaveCount(1)

    expect(bag.errors, 'docking a plot surface must not throw').toEqual([])
  })
})
