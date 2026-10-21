import { test, expect, type Page } from '@playwright/test'
import { openPerfStory } from './_renderPerf'

// plot-data-table-camera.spec.ts — FIX_ROUND-1 / DEC-46. "AN OPEN PLOT-DATA TABLE FOLLOWS THE
// CAMERA", proven against ALL THREE camera writers that do not pass through the deck's gesture
// callback.
//
// WHY THIS SPEC EXISTS. `buildPlotDataTable` lists the points VISIBLE IN THE PANE'S CURRENT WINDOW,
// and it reads the live camera off `viewStateRef` during `GridDockLayer`'s render. On origin/main the
// shell SUBSCRIBED to the camera, so any camera write re-rendered it and the table re-derived for
// free. Split A moved the camera into `GridDeckLayer` — where nothing above it subscribes, which is
// the whole perf win — and replaced that subscription with an explicit `onCameraCommit` notification
// that the shell converts into a `cameraEpoch` bump WHILE ≥1 table is open.
//
// The notification was raised from the gesture callback, which is ONE of five camera writers. The
// other four moved the deck with no notification at all, so an open table kept listing the PRE-MOVE
// window — and its CSV export, which serializes the same rows, matched the stale window. There was no
// coverage: nothing in `tests/viz-e2e` opened a plot-data table at all.
//
// The three tests below are the three drives that reach the four un-notified writers:
//   F1  deck gesture     — the notified path. The POSITIVE CONTROL: it must stay green, and it is
//                          what makes an F2/F3 failure attributable to the writer rather than to the
//                          fixture, the table, or the row reader.
//   F2  host dispatch    — `controller.dispatch({type:'gridViewState', spaceKey, viewState})` writes
//                          the coordination store's per-space scope directly. Covers writer (3) and,
//                          because a popped-out second `<GridWorkspace>` panning the same space
//                          writes the SAME scope by the same code path, writer (4) with it.
//   F3  image framing    — `useGridRaster`'s load effect seeds the camera through the deck layer's
//                          idempotent `seedViewState` handle. Writer (5).
//
// Every test asserts the CAMERA ACTUALLY MOVED (from the dev seam) before it asserts anything about
// the table: a drive that silently did nothing would otherwise report "the table is unchanged" as a
// pass on F1 and as a failure with the wrong diagnosis on F2/F3.

/** The dev-only per-cell camera + cell→space map `GridDeckLayer` publishes. */
interface GridViewSeam {
  zoom: Record<string, number>
  target: Record<string, number[]>
  spaces: Record<string, string>
}

async function camera(page: Page): Promise<GridViewSeam> {
  const seam = await page.evaluate(
    () => (window as unknown as { __VIZ_GRID_VIEW__?: GridViewSeam }).__VIZ_GRID_VIEW__ ?? null,
  )
  if (!seam?.zoom || !seam.spaces)
    throw new Error(
      'window.__VIZ_GRID_VIEW__ is absent — the camera cannot be read, so neither "the camera moved" ' +
        'nor "the camera did not move" can be asserted. REFUSING to proceed rather than measure ' +
        'a table against an unknown camera.',
    )
  return seam
}

/** The pane's camera as a comparable tuple. */
function cam(seam: GridViewSeam, cellId: string): string {
  return `zoom=${seam.zoom[cellId]} target=${(seam.target[cellId] ?? []).slice(0, 2).join(',')}`
}

/** The number of rows the ONE open plot-data table is listing, read from its own header. */
async function visibleRows(page: Page): Promise<number> {
  const table = page.getByTestId('viz-plot-data-table')
  await expect(table).toHaveCount(1)
  const text = await table.getByText(/visible rows?$/).innerText()
  const m = /^([\d,]+) visible rows?$/.exec(text.trim())
  if (!m) throw new Error(`could not read the row count from the table header: ${JSON.stringify(text)}`)
  return Number(m[1].replace(/,/g, ''))
}

/** Open the perf grid and the plot-data table on pane `p0`. Returns the table's opening row count,
 *  asserted NON-ZERO — every assertion below is "the window changed", which a table that lists
 *  nothing to begin with cannot show. */
async function openStoryWithTable(page: Page): Promise<number> {
  await openPerfStory(page, 'render-perf', { panes: 2, points: 3_000 })
  await expect(page.locator('[data-viz-cell]')).toHaveCount(2)
  await page.getByTestId('viz-cell-data-p0').click()
  await expect(page.getByTestId('viz-plot-data-table')).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(1_000)
  const rows = await visibleRows(page)
  expect(rows, 'the table must list rows before the camera moves, or "the rows changed" is unmeasurable').toBeGreaterThan(0)
  return rows
}

test.describe('an open plot-data table follows the camera (DEC-46)', () => {
  test('TEST-F1 a DECK GESTURE moves the camera and the open table re-derives', async ({ page }) => {
    test.setTimeout(180_000)
    const before = await openStoryWithTable(page)
    const camBefore = cam(await camera(page), 'p0')

    const box = await page.locator('[data-viz-cell="p0"]').boundingBox()
    if (!box) throw new Error('pane p0 has no bounding box')
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.6)
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, -120)
      await page.waitForTimeout(120)
    }
    await page.waitForTimeout(1_200)

    const camAfter = cam(await camera(page), 'p0')
    expect(camAfter, 'the wheel must have moved the camera').not.toBe(camBefore)
    const after = await visibleRows(page)
    console.log(`[TEST-F1] gesture: ${before} rows -> ${after} rows (${camBefore} -> ${camAfter})`)
    // Zooming IN strictly shrinks the window, so the visible set must strictly shrink.
    expect(after, 'zooming in must shrink the table to the points still inside the window').toBeLessThan(before)
  })

  test('TEST-F2 a HOST gridViewState dispatch moves the camera and the open table re-derives', async ({ page }) => {
    test.setTimeout(180_000)
    const before = await openStoryWithTable(page)
    const seam = await camera(page)
    const camBefore = cam(seam, 'p0')
    // Address the pane's ACTUAL coordinate space (it folds in the cell kind and any datasetId) rather
    // than guessing the key: a wrong key is a silent no-op that reads exactly like "no camera move".
    const spaceKey = seam.spaces.p0
    expect(spaceKey, 'the deck layer must publish pane p0 coordinate space').toBeTruthy()

    const dispatched = await page.evaluate(
      ({ spaceKey }) => {
        const c = (window as unknown as { __VIZ_CONTROLLER__?: { dispatch?: (a: unknown) => void } })
          .__VIZ_CONTROLLER__
        if (typeof c?.dispatch !== 'function') return false
        c.dispatch({ type: 'gridViewState', spaceKey, viewState: { target: [3, 3], zoom: 8 } })
        return true
      },
      { spaceKey },
    )
    expect(dispatched, 'window.__VIZ_CONTROLLER__.dispatch must exist — the host camera path is what this test drives').toBe(true)
    await page.waitForTimeout(1_500)

    const camAfter = cam(await camera(page), 'p0')
    expect(camAfter, 'the host dispatch must have moved the camera').not.toBe(camBefore)
    const after = await visibleRows(page)
    console.log(`[TEST-F2] host dispatch: ${before} rows -> ${after} rows (${camBefore} -> ${camAfter})`)
    expect(after, 'the table must re-derive against the camera the HOST wrote, not the pre-move one').not.toBe(before)
  })

  test('TEST-F3 the IMAGE-FRAMING seed moves the camera and the open table re-derives', async ({ page }) => {
    test.setTimeout(180_000)
    const before = await openStoryWithTable(page)
    const camBefore = cam(await camera(page), 'p0')

    // Switch p0 to an IMAGE view. Its raster resolves asynchronously; `useGridRaster`'s framing effect
    // then seeds the pane's camera onto the image extent through `seedViewState` — the fifth writer,
    // and the one no callback ever saw. (`cellData` is kind-agnostic, so the pane keeps listing the
    // dataset's points and the table stays a camera-derived surface across the switch.)
    await page.getByTestId('viz-cell-kind-p0').click()
    await page.getByRole('option', { name: 'image', exact: true }).click()
    await expect
      .poll(async () => cam(await camera(page), 'p0'), {
        message: 'the image-framing seed must move p0 camera onto the image extent',
        timeout: 30_000,
      })
      .not.toBe(camBefore)
    await page.waitForTimeout(1_500)

    const camAfter = cam(await camera(page), 'p0')
    const after = await visibleRows(page)
    console.log(`[TEST-F3] image seed: ${before} rows -> ${after} rows (${camBefore} -> ${camAfter})`)
    expect(after, 'the table must re-derive against the SEEDED camera, not the pre-framing one').not.toBe(before)
  })
})
