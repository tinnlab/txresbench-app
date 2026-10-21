import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import { openLauncher } from '../14-workbench/_analysis'
import { seedQcDataset, awaitFilterSurface, CF, CFRow } from './_seed'

// TEST-A6 (e2e) [acceptance] [invariant: INV-6] [covers: ITEM-16, ITEM-3] — a processor shipping
// ONLY `packages/<name>/{manifest.yaml, ui/*.yaml}` DATA (no `.tsx`, no app-code edit) renders
// through the GENERAL `DeclarativeRegion` interpreter AND registers its declared action in
// `workbenchRegistry` — the zero-app-change-new-processor proof (no processor-specific UI in the
// workbench). Proven end-to-end WITHOUT app code:
//  (a) the DATA manifest's contribution is registered (the analysis is launchable), and
//  (b) the DATA `ui/cell-filter.yaml` renders its widgets AND its declared action is
//      interpreted (clicking the declared `Add criterion` button — action `cf.addCriterion` — appends
//      a criterion row, i.e. the `listAppend` effect ran through the general engine), and
//  (c) the ONLY cell-filter/QC surfaces are the general run pane + center CANVAS — NO retired
//      per-analysis view pane fans (INV-6 / DESIGN_FIDELITY DEC-15).
// PURE — no compute run (seeds obs directly); the whole point is that zero React was authored.

test.describe('a DATA-only processor renders + registers with zero app-code (INV-6, TEST-A6)', () => {
  test('the declarative cell-filter surface renders its widgets, its declared action runs, and no per-analysis view pane exists', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `INV6 ${Date.now()}`)
    await seedQcDataset(request, id, { annotated: true })
    await openWorkbench(page, id)

    // (a) the DATA manifest contribution registered → the analysis is launchable.
    //
    // Through `openLauncher`, whose own docstring states the rule this spec was the last one to
    // ignore: a SEEDED project auto-mounts every AVAILABLE contributed view as a sibling pane of
    // the launcher, and a region renders only its active tab. This passed for years on luck —
    // the auto-mount used to happen before the shell's `ensureProject` reset the regions slice,
    // so the focus that `moveToRegion` takes was handed back to the launcher a frame later. The
    // auto-mount gate moves the mount AFTER that reset (it waits on the catalog's produced type
    // ids), so the focus now stays with the last-mounted analysis pane and the launcher's rows
    // are not rendered until its tab is activated. Which pane holds the region is not this
    // spec's subject; that the row EXISTS is.
    await openLauncher(page)
    await expect(page.getByTestId('workbench-launcher-row-cell.filter')).toBeVisible({ timeout: 20_000 })

    // (b) the DATA view_spec renders (its declared widgets appear) — no `.tsx` for this processor.
    await awaitFilterSurface(page)
    // The criteria builder is a TABLE, so a row is a row of the grid — counted through the
    // per-row control the appended criterion renders.
    const rows = page.locator(`[data-testid^="${CF.table}-select-column-"]`)
    const before = await rows.count()
    // The declared `Add criterion` action (`cf.addCriterion` → `listAppend`) runs through the
    // general interpreter — a criterion row is appended (proves the action registered + interpreted).
    await page.getByTestId(CF.add).first().click()
    await expect(rows).toHaveCount(before + 1)

    // (c) surfaces = run pane + center canvas ONLY; NO retired per-analysis view pane fans.
    await expect(page.getByTestId('workbench-canvas-host')).toBeAttached({ timeout: 20_000 })
    for (const gone of ['Filter cells', 'QC review', 'Filter cells form', 'Clustering result']) {
      await expect(page.getByRole('tab', { name: gone, exact: true })).toHaveCount(0)
    }
    // No fanned declarative-region tab (the retired `view_id::region::<x>` fan).
    await expect(page.getByRole('tab', { name: /::region::/ })).toHaveCount(0)
  })
})
