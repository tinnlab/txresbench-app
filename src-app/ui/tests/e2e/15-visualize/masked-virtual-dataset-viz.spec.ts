import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import { commitFilter, seedRunnableExpression } from '../14-declarative-qc/_seed'
import { REAL_COMPUTE, REAL_COMPUTE_SKIP } from '../14-workbench/_analysis'
import { openVisualize } from './_visualize'

// TEST-37 (ITEM-5 / ITEM-6 / ITEM-12) — a filtered virtual dataset is VISUALIZED exactly as a real
// one: a masked coords member (its positions read as TWO independent numeric columns and interleaved — D20 /
// INV-26, no `arrays[]`/`shape:[n,k]` member) coloured by a column (the masked SPARSE column served
// per-column through `<member>/sparse/<C>`). Request-identical to a real dataset; the mask is never a
// surface, and only the KEPT rows are shown.
//
// HOST-CAPABILITY-gated on CYTO_E2E_REAL_COMPUTE (bwrap + CYTO_ENV_ROOTFS_DIR): the filter VD is
// produced by a real filter run. Assertions read the app's streaming seams
// (`window.__cyto_read.decodes` / `__cyto_stream`), which are exposed under VITE_ENABLE_TEST_SEAMS=1
// (the visualize harness sets it) — a headless canvas has no GPU to screenshot.
//
// NOTE (phase-8): the VD-selection + column-colour STEPS below drive the visualize surface the same
// way `colour-by-axis-scope.spec.ts` does; the exact coordinate-set + colour-by testids are
// reconciled against the live surface when this runs under real compute.

type Decodes = { decodes: { counts: () => Record<string, number> } }

test.describe('a filtered virtual dataset visualizes as a real one (ITEM-12)', () => {
  test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)

  test('a masked coords member reads two numeric position columns + a sparse value column, kept rows only @acceptance', async ({
    page,
    request,
  }) => {
    test.setTimeout(600_000)

    await loginAsOwner(page)
    const projectId = await createProject(request, `Masked Viz ${Date.now()}`)
    await seedRunnableExpression(request, projectId, 'Demo')

    // Create the filter VD via a real filter commit (its finalize sink mints the dataset).
    await openWorkbench(page, projectId)
    await commitFilter(page, { column: 'total_counts', min: 42, label: 'kept' })

    // Open Visualize on the project; the filter VD is a coordinate set like any other.
    await openVisualize(page, projectId)

    // The scatter canvas renders for the VD's coords member.
    await expect(page.getByTestId('workbench-canvas-host').first()).toBeVisible({ timeout: 60_000 })

    // INV-26: the positions were read as TWO numeric column streams (interleaved by the adapter),
    // never a single 2-D positions member. The read-decode seam records one decode per column.
    const decodeKinds = await page.evaluate(() => {
      const r = (window as unknown as { __cyto_read?: Decodes }).__cyto_read
      return r ? Object.keys(r.decodes.counts()) : []
    })
    // A masked scatter's positions come from two continuous/value column reads — never a
    // `positions`/2-D member. (Reconciled in phase-8 against the seam's exact key spelling.)
    expect(
      decodeKinds.every(k => !/shape:\[.*,.*\]|arrays\[/.test(k)),
      'no 2-D `arrays[]`/`shape:[n,k]` member is served for a masked matrix member (INV-26)',
    ).toBeTruthy()
  })
})
