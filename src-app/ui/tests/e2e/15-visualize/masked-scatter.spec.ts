import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import { commitFilter, seedRunnableExpression } from '../14-declarative-qc/_seed'
import { REAL_COMPUTE, REAL_COMPUTE_SKIP } from '../14-workbench/_analysis'
import { openVisualize } from './_visualize'

// TEST-26 [acceptance] [invariant: INV-26] (ITEM-12) — a masked SCATTER reads its x and y as two
// INDEPENDENT numeric columns whose masked results interleave to the kept points; NO `arrays[]` /
// `shape:[n,k]` 2-D positions member is served (D20 / D9 #2). Storing each dim as a 1-D column makes
// it an ordinary numeric column, masked by the numeric path server-side, and deletes the 2-D masking
// gap entirely; `streamingAdapter.positions()` re-interleaves the two `components` columns on read
// (unit-proven in `viz-core/data/streamingAdapter.test.ts`, "positions() from two component columns").
//
// This is the E2E leg of that invariant: it drives the REAL filter-VD visualize surface (a real
// filter commit mints the `source='filter'` VD) and asserts, at the app's own read-decode seam,
// that no 2-D positions member is EVER decoded — the wire is request-identical to a real dataset, so
// the scatter never sees an `n×k` member to mask.
//
// HOST-CAPABILITY-gated on CYTO_E2E_REAL_COMPUTE (bwrap + CYTO_ENV_ROOTFS_*): the filter VD is
// produced by a real filter run. The read-decode seam (`window.__cyto_read.decodes`) is exposed
// under VITE_ENABLE_TEST_SEAMS=1, which the visualize harness sets — a headless canvas has no GPU to
// screenshot.

type Decodes = { decodes: { counts: () => Record<string, number> } }

test.describe('a masked scatter reads two numeric position columns, never a 2-D member (INV-26)', () => {
  test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)

  test('no `arrays[]`/`shape:[n,k]` positions member is served for a masked matrix member @acceptance', async ({
    page,
    request,
  }) => {
    test.setTimeout(600_000)

    await loginAsOwner(page)
    const projectId = await createProject(request, `Masked Scatter ${Date.now()}`)
    await seedRunnableExpression(request, projectId, 'Demo')

    // A real filter commit mints the source='filter' VD (its finalize sink).
    await openWorkbench(page, projectId)
    await commitFilter(page, { column: 'total_counts', min: 42, label: 'kept' })

    // Open Visualize on the project; the filter VD is a coordinate set like any other.
    await openVisualize(page, projectId)

    // The scatter canvas renders for the VD.
    await expect(page.getByTestId('workbench-canvas-host').first()).toBeVisible({ timeout: 60_000 })

    // INV-26: whatever the surface decoded, none of it is a 2-D positions member. A masked
    // matrix member's positions come from two INDEPENDENT numeric column reads (the numeric masking
    // path), interleaved by the adapter — never a single `n×2` `positions`/`arrays[]` member the
    // client would have to mask in 2-D.
    const decodeKinds = await page.evaluate(() => {
      const r = (window as unknown as { __cyto_read?: Decodes }).__cyto_read
      return r ? Object.keys(r.decodes.counts()) : []
    })
    expect(
      decodeKinds.every(k => !/shape:\[.*,.*\]|arrays\[/.test(k)),
      'no 2-D `arrays[]`/`shape:[n,k]` member is served for a masked matrix member (INV-26) — ' +
        `saw decode kinds: [${decodeKinds.join(', ')}]`,
    ).toBeTruthy()
  })
})
