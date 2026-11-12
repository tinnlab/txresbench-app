import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import { seedRunnableExpression, awaitQcSurface, METRIC_ROWS, QC } from './_seed'
import { REAL_COMPUTE, REAL_COMPUTE_SKIP } from '../14-workbench/_analysis'

// TEST-E1 (e2e) [covers: ITEM-12, ITEM-8, ITEM-5] — a user runs QC with a custom-regex metric
// added via the DECLARED control (`ui/qc.yaml` metric table → `qc.addMetric` → editable_text cells),
// the run dispatches through the declared `run_processor`→`wait_for` bridge and COMPLETES, and the
// metric is computed — the full declared path with ZERO bespoke React mounted; then the SAME declared
// surface is driven once via the AI co-drive seam (`window.__actions.run`) to prove co-drive (INV-3).
//
// REAL-compute — gated on TXR_E2E_REAL_COMPUTE (a sandbox-executable backend: bwrap +
// TXR_ENV_ROOTFS_DIR). The run must COMPLETE a real `qc.10x` job over a seeded runnable `.h5ad`.
// The gate is a describe-level `test.skip` so a container-only run REPORTS it as skipped, with the
// env var to set — see `../14-workbench/_analysis.ts` for why it is not an `if (REAL) { … }` wrapper.

test.describe('declarative QC — custom-regex metric, real run, co-drive (TEST-E1)', () => {
  test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)

  test('runs QC with a custom metric through the declared bridge and co-drives the same surface', async ({
    page,
    request,
  }) => {
    // The run below is waited on for 120 s — exactly the config's per-test budget, so without
    // this the test died of TEST timeout at the same instant its own expect was due to fire,
    // and the "QC metrics computed" diagnosis could never print. (`seedRunnableExpression`
    // adds its import budget on top of whatever is set here.)
    test.setTimeout(300_000)
    await loginAsOwner(page)
    const id = await createProject(request, `Declarative QC ${Date.now()}`)
    await seedRunnableExpression(request, id, 'PBMC')
    await openWorkbench(page, id)
    await awaitQcSurface(page)

    // Add a CUSTOM metric row via the declared `Add custom metric` button (`qc.addMetric`).
    // METRIC rows only — a row carrying a message renders a band `<tr>` under itself.
    const rows = page.locator(METRIC_ROWS)
    const before = await rows.count()
    await page.getByTestId(QC.addMetric).click()
    await expect(rows).toHaveCount(before + 1)
    const newIdx = before
    // Fill the new row's name + gene-regex via the table's editable_text cells.
    await page.getByTestId(`widget-metricTable-edit-name-${newIdx}`).fill('hb')
    await page.getByTestId(`widget-metricTable-edit-pattern-${newIdx}`).fill('^HB[AB]')

    // Run via the declared QC Run button (`widget-runBtn`, labeled "Compute QC metrics"). Target it
    // by its widget testid — a role+name lookup is ambiguous (the pane tab's close/pop-out buttons
    // + the launcher card all carry "Compute QC metrics" in their accessible name). The QC surface
    // is the active right-region pane (cell-filter's pane body is not mounted while inactive), so
    // its `widget-runBtn` is unique. This is the DECLARED `run_processor`→`wait_for` bridge.
    await page.getByTestId(QC.run).click()

    // The declared `toast` success fires on completion (the run reached a terminal `completed`).
    await expect(page.getByText('QC metrics computed', { exact: false })).toBeVisible({ timeout: 120_000 })

    // Co-drive (INV-3): the SAME declared action fires from `runAction` via the `window.__actions`
    // seam, exactly as the AI engine would — a criterion/metric mutation runs through the identical
    // permission-gated path.
    //
    // Two ids, deliberately distinct since INV-3 collapsed the pane onto the ANALYSIS: the registry
    // lists ONE contribution per analysis (`qc.10x`), while the per-instance store key + the action
    // NAMESPACE stay the VIEW FILE's own spec id (`qc.compute`) — one store per file, however many
    // an analysis stacks. Asserting the contribution id here is what makes a regression to a
    // per-file (or region-fanned) pane fail loudly rather than silently re-mount two tabs.
    const contributionId = await page.evaluate(() => {
      const reg = (window as unknown as { __workbenchRegistry?: { views: () => string[] } }).__workbenchRegistry
      return reg?.views().find(v => v === 'qc.10x')
    })
    expect(contributionId, 'the declarative qc pane is registered under its ANALYSIS id').toBe('qc.10x')
    const viewId = 'qc.compute' // the view FILE's spec id — the store key + action namespace
    const beforeCo = await rows.count()
    await page.evaluate(
      ([vid]) => {
        const actions = (window as unknown as { __actions?: { run: (id: string, p: Record<string, unknown>) => Promise<unknown> } }).__actions
        return actions?.run(`${vid}::qc.addMetric`, { view_id: vid })
      },
      [viewId],
    )
    await expect(rows).toHaveCount(beforeCo + 1)
  })
})
