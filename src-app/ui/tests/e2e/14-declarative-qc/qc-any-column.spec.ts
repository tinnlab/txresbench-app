import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import { seedQcDataset, awaitQcSurface, awaitFilterSurface, addCriterion, METRIC_ROWS, QC, CFRow } from './_seed'

// TEST-E3 (e2e) [covers: ITEM-25] — the compute-any-obs-column flow (DEC-25: metrics are
// user-driven presets over a GENERAL engine, not a fixed set). The user REPLACES a preset metric
// (edits its name in the declared metric table), ADDS a custom `{name, pattern}` metric, and builds
// a cell-filter criterion on a column of their choosing — proving the metric/criterion engine
// targets ANY obs column, not a hardcoded mito/min-genes pair.
// PURE — form interactions over the seeded obs surface (no compute run needed to prove the
// affordances; the actual compute is the REAL-gated run in declarative-processor-ui.spec.ts).

test.describe('QC/filter are fully user-driven over any obs column (ITEM-25, TEST-E3)', () => {
  test('replace a preset metric, add a custom {name,pattern} metric, filter on a chosen column', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `QC Any Column ${Date.now()}`)
    await seedQcDataset(request, id, { annotated: true })
    await openWorkbench(page, id)
    await awaitQcSurface(page)

    // METRIC rows only — a row carrying a message renders a band `<tr>` under itself.
    const rows = page.locator(METRIC_ROWS)
    const initial = await rows.count()
    expect(initial).toBeGreaterThan(0)

    // REPLACE a preset: edit the first metric row's name (presets are DATA seeding `state.qc_metrics`,
    // editable — DEC-25). The editable_text cell dispatches `qc.setMetricField`.
    const firstName = page.getByTestId('widget-metricTable-edit-name-0')
    await firstName.fill('total_umi')
    await expect(firstName).toHaveValue('total_umi')

    // ADD a custom {name, pattern} metric — the general compute-any-column affordance.
    await page.getByTestId(QC.addMetric).click()
    await expect(rows).toHaveCount(initial + 1)
    const idx = initial
    await page.getByTestId(`widget-metricTable-edit-name-${idx}`).fill('hb')
    await page.getByTestId(`widget-metricTable-edit-pattern-${idx}`).fill('^HB[AB]')
    await expect(page.getByTestId(`widget-metricTable-edit-pattern-${idx}`)).toHaveValue('^HB[AB]')

    // Build a cell-filter criterion on a column the user picks — the filter targets ANY obs column
    // (a computed metric OR pre-existing metadata like `ident`), not a fixed set.
    await awaitFilterSurface(page)
    await addCriterion(page, 0)
    await expect(page.getByTestId(CFRow.col(0))).toBeVisible()
    // The chosen column drove a control (continuous → min/max, categorical → keep-set) — assert one
    // of the type-derived controls rendered (DEC-18 control-follows-column).
    const hasControl =
      (await page.getByTestId(CFRow.min(0)).count()) > 0 ||
      (await page.getByTestId(CFRow.keep(0)).count()) > 0
    expect(hasControl, 'the chosen column derived a min/max or keep-set control').toBeTruthy()
  })
})
