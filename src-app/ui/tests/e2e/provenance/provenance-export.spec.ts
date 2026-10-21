import { expect, test } from '@playwright/test'
import { createProject, loginAsOwner, ownerToken } from './_helpers'

// TEST-29: open the Export drawer, assert the Sheet opens with the scope RadioGroup
// (this run / whole project), trigger Build, assert the export POST SUCCEEDS (2xx), and
// assert the drawer reaches the READY state (bundle built) — a whole-project export
// produces a valid bundle even with NO captured runs. A broken export (non-2xx, or an
// error alert) fails the test.
//
// ── R4C-06 (round 4b): rewritten, and the capability it covers was RESTORED ────────
//
// This spec drove `provenance-open-export` on the project-detail `provenance-panel`.
// Commit 6d231748 retired that section in favour of a workbench pane, and neither testid
// exists in `src/` any more — so the spec could only fail, and the EMPTY-GRAPH export
// path it was the sole cover for went unwatched. Worse, the capability itself had gone:
// `ProvenancePane` rendered its "Export bundle" button only in the NON-empty branch, so a
// project that had not run an analysis yet had no export affordance at all — even though
// the backend builds a perfectly valid bundle for it (which is precisely what this test
// asserts). `ProvenancePane`'s empty state now carries the button again, and this spec
// drives it through the real user path: workspace → "+" menu → Provenance pane → Export.
test('the export drawer opens from an EMPTY provenance graph, offers a scope, and builds a bundle', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const project = await createProject(request, admin, `Provenance Export ${Date.now()}`)

  await loginAsOwner(page)
  await page.goto(`/projects/${project.id}/workspace`)
  await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 30_000 })

  // Open the Provenance pane through the real "+" affordance.
  const add = page.getByTestId('region-add-pane-right')
  await expect(add).toBeVisible({ timeout: 30_000 })
  await add.click()
  await page.getByTestId('region-add-pane-item-reproducibility').click()

  // A fresh project has NO captured runs, so the pane is in its empty state — and the
  // export affordance must still be there (the R4C-06 regression).
  await expect(page.locator('[data-testid^="workbench-provenance-pane-empty-"]')).toBeVisible({
    timeout: 30_000,
  })
  // Pane-scoped testid (`provenance-export-bundle-<paneId>`) — two open reproducibility
  // panes would make an unscoped getByTestId a strict-mode violation.
  const exportBtn = page.locator('[data-testid^="provenance-export-bundle-"]')
  await expect(
    exportBtn,
    'a project with no runs must still be exportable — the backend builds a valid ' +
      'whole-project bundle for it, and the retired panel always offered the button',
  ).toBeVisible()
  await exportBtn.click()

  const drawer = page.getByTestId('provenance-export-drawer')
  await expect(drawer).toBeVisible()

  // The scope RadioGroup is present (this run / whole project).
  await expect(page.getByTestId('provenance-export-scope')).toBeVisible()
  await expect(page.getByRole('radio', { name: /whole project/i })).toBeVisible()

  // Trigger the build and wait for the server's export response so the phase
  // transition is observable rather than racing the assertion.
  const exportResp = page.waitForResponse(
    r => r.url().includes('/api/provenance/export') && r.request().method() === 'POST',
    { timeout: 30_000 },
  )
  await page.getByTestId('provenance-export-build').click()
  const resp = await exportResp
  // The export POST must SUCCEED — a non-2xx here means export is broken.
  expect(resp.ok(), `export POST returned ${resp.status()}`).toBeTruthy()

  // The build reaches the READY state (bundle built + downloaded), never an error
  // and never a silent "building" spinner.
  await expect(page.getByTestId('provenance-export-ready')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('provenance-export-error')).toHaveCount(0)
})
