import { expect, test, type Page } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import { seedQcDataset, awaitFilterSurface, addCriterion, CFRow } from './_seed'

// REGRESSION GUARD — the declarative canvas must NOT enter a publish↔re-render loop on a form edit.
//
// The bug this pins (React "Maximum update depth exceeded" → the router `AppErrorBoundary` unmounted
// the WHOLE declarative surface): a declarative form edit re-issues `VizController.setOption`, which
// hydrates `PlotInteraction.dataZoomWindows` from the option — an option with no `dataZoom` block
// CLEARS every window entry. `ValueDataZoom`'s reset-to-full effect only re-seeds when the domain
// VALUES change, so the owned window stayed permanently `null` and the `win ?? fullValueWindow(...)`
// fallback MINTED a fresh `{lo,hi}` object on every render. That fresh identity cascaded
// `ViolinBody.bounds` → its `layers` memo → `ChartCanvas.allLayers` → `ChartLayerSink.publish`, whose
// equality gate compares `layers` BY REFERENCE — so it notified, `GridWorkspace` re-rendered, the
// chart re-rendered, a new fallback object was minted, forever. Fixed by memoizing the active window
// on the domain VALUES (`DataZoom.tsx`).
//
// The guard is the SYMPTOM, not the mechanism, so it survives a refactor of either side: after a
// threshold edit the surface must still be mounted (its controls + its declarative store), the
// canvas must still be the live viz grid, and no update-depth / ErrorBoundary error may appear.

/** The active declarative stores exposed by the read-only `window.__declarativeStores` e2e seam. */
async function declarativeStores(page: Page): Promise<Array<{ type: string; keptTotal: number }>> {
  return page.evaluate(() => {
    const read = (window as unknown as {
      __declarativeStores?: () => Array<{ type: string; keptTotal: number }>
    }).__declarativeStores
    return read ? read() : []
  })
}

test.describe('declarative canvas — no infinite update loop on a form edit', () => {
  test('a threshold edit keeps the surface, its store and the canvas alive (no React #185)', async ({
    page,
    request,
  }) => {
    // Only the loop's fingerprints — an update-depth throw or the router ErrorBoundary catching one.
    // Everything else (headless-GL noise, the known canvas 400s) is out of scope for THIS guard.
    const loopErrors: string[] = []
    const keep = (t: string) => {
      if (/Maximum update depth exceeded|AppErrorBoundary|Minified React error #185/i.test(t)) loopErrors.push(t)
    }
    page.on('console', m => {
      if (m.type() === 'error') keep(m.text())
    })
    page.on('pageerror', e => keep(String(e)))

    await loginAsOwner(page)
    const id = await createProject(request, `CanvasLoopGuard ${Date.now()}`)
    await seedQcDataset(request, id, { annotated: true, nCells: 200 })
    await openWorkbench(page, id)
    await awaitFilterSurface(page)

    // A criterion on a continuous column → the declared before/after violin pair drives the ONE
    // canvas grid (the chart cells whose shared-deck publish the loop ran through).
    await addCriterion(page, 0, { column: 'nCount' })
    const host = page.getByTestId('workbench-canvas-host')
    await expect(host).toHaveAttribute('data-viz-framework', 'true', { timeout: 20_000 })
    expect(await declarativeStores(page), 'the declarative store is mounted before the edit').not.toEqual([])

    // THE EDIT. Under the bug this re-issued `setOption`, cleared the dataZoom window and started an
    // unbounded publish↔re-render cascade that unmounted the whole surface within ~2s.
    const max = page.getByTestId(CFRow.max(0))
    await max.fill('-1')
    // Tolerated: under the bug the input is already DETACHED by the time blur lands (the surface
    // unmounted mid-edit), and a bare `blur()` would just burn the test timeout instead of reporting
    // WHY. Swallow it so the assertions below produce the diagnostic.
    await max.blur().catch(() => {})
    // Give a loop time to blow the update-depth limit (it did so in well under a second). Tolerated
    // for the same reason as the blur: an unbounded loop can take the renderer down outright, and the
    // collected `loopErrors` below are the diagnostic worth reporting.
    await page.waitForTimeout(4_000).catch(() => {})

    // 1. No update-depth throw and no ErrorBoundary catch.
    expect(loopErrors, `React update-loop / ErrorBoundary errors:\n${loopErrors.join('\n')}`).toEqual([])
    // 2. The surface is still mounted — its threshold controls survived (they went 1 → 0 under the bug).
    await expect(page.getByTestId(CFRow.max(0))).toHaveCount(1)
    await expect(page.getByTestId(CFRow.min(0))).toHaveCount(1)
    // 3. The declarative store survived (`__declarativeStores()` returned [] under the bug).
    const stores = await declarativeStores(page)
    expect(stores.map(s => s.type), 'the cell.filter declarative store survived the edit').toContain('cell.filter')
    expect(stores.find(s => s.type === 'cell.filter')?.keptTotal).toBe(200)
    // 4. The canvas is still the live viz grid (not the ErrorBoundary fallback / empty hero).
    await expect(host).toHaveAttribute('data-viz-framework', 'true')
  })
})
