import { test, expect } from '@playwright/test'
import { openStory, trackErrors, vizTest } from './_helpers'

// PROVES the Wave-2 "enable/disable dataZoom PER PLOT" contract is real, not hardcoded
// (story `datazoom-toggle`). Asserted on the story's `__VIZ_TEST__` hooks
// (`boxDataZoomEnabled` / `dataZoomBarsVisible` / `scatterXWindow`) AND on the LIVE DOM rail
// count scoped to the box pane — so a toggle that flipped a number but left the rail mounted
// (an inert control) would FAIL here.
//
//   • BOX dataZoom ENABLE→DISABLE→ENABLE — the toggle button flips `boxDataZoomEnabled` and the
//     box pane's value-slider RAIL is actually REMOVED (rail count 0) / restored (rail count ≥1).
//   • SCATTER camera-bound slider — dragging the x-axis dataZoom rail's high handle LEFT narrows
//     the scatter's live world window (`scatterXWindow` changes).

// Rail-container testids in this story all end in one of these suffixes; the DragRail
// handle/band children (`-handle-hi`/`-handle-lo`/`-band`) do NOT — so this counts ONLY rails.
const RAIL_SELECTOR = '[data-testid$="-slider"], [data-testid$="-cols"], [data-testid$="-rows"]'

// The scatter x-axis (horizontal) dataZoom rail + its high (right) handle. ScatterDataZoom's
// default testId is `viz-scatter-datazoom`; `{ x:'slider', y:'slider' }` renders an x (horizontal)
// and y (vertical) rail — we drag the x one, so `scatterXWindow` is what moves.
const SCATTER_X_HANDLE_HI = 'viz-scatter-datazoom-x-slider-handle-hi'
const SCATTER_X_RAIL = 'viz-scatter-datazoom-x-slider'

test('dataZoom is enabled/disabled PER PLOT: box toggle removes/restores its rail; scatter slider drives the camera window', async ({
  page,
}) => {
  // Software swiftshader renders + a 12k-point fixture scatter — a wide budget.
  test.setTimeout(180_000)
  const bag = trackErrors(page)
  await openStory(page, 'datazoom-toggle')

  await expect(page.getByTestId('viz-datazoom-toggle')).toBeVisible()

  const boxPane = page.getByTestId('viz-datazoom-toggle-box-pane')
  await expect(boxPane).toBeVisible()
  const boxRails = boxPane.locator(RAIL_SELECTOR)

  // ── BOX dataZoom starts ENABLED — the box pane has ≥1 rail and the hook agrees. ──────────
  await expect
    .poll(() => boxRails.count(), { message: 'box pane starts with a value-slider rail' })
    .toBeGreaterThan(0)
  await expect
    .poll(() => vizTest<boolean>(page, 'boxDataZoomEnabled'), { message: 'box dataZoom starts ON' })
    .toBe(true)

  // ── Toggle OFF — the box rail is REMOVED (count 0) and the hook flips false. ──────────────
  await page.getByTestId('viz-datazoom-toggle-box').click()
  await expect
    .poll(() => boxRails.count(), { message: 'toggling OFF removes the box rail (count 0)' })
    .toBe(0)
  await expect
    .poll(() => vizTest<boolean>(page, 'boxDataZoomEnabled'), { message: 'box dataZoom flips OFF' })
    .toBe(false)

  // ── Toggle ON — the box rail is RESTORED. ───────────────────────────────────────────────
  await page.getByTestId('viz-datazoom-toggle-box').click()
  await expect
    .poll(() => boxRails.count(), { message: 'toggling ON restores the box rail (count ≥1)' })
    .toBeGreaterThan(0)
  await expect
    .poll(() => vizTest<boolean>(page, 'boxDataZoomEnabled'), { message: 'box dataZoom flips ON' })
    .toBe(true)

  // ── SCATTER camera-bound slider — drag the x-rail high handle LEFT, window changes. ──────
  const handle = page.getByTestId(SCATTER_X_HANDLE_HI)
  await expect(handle, 'scatter x-slider high handle mounts once the fixture loads').toBeVisible({
    timeout: 60_000,
  })

  // The scatter reports its live world window through `onWindowsChange`; wait for a real
  // (non-null) x window before capturing the baseline.
  await expect
    .poll(() => vizTest<[number, number] | null>(page, 'scatterXWindow'), {
      message: 'scatter reports its live x window',
      timeout: 30_000,
    })
    .not.toBeNull()
  const before = JSON.stringify(await vizTest<[number, number] | null>(page, 'scatterXWindow'))

  const handleBox = await handle.boundingBox()
  const railBox = await page.getByTestId(SCATTER_X_RAIL).boundingBox()
  expect(handleBox, 'x-slider handle has a box').not.toBeNull()
  expect(railBox, 'x-slider rail has a box').not.toBeNull()
  if (handleBox && railBox) {
    const startX = handleBox.x + handleBox.width / 2
    const y = handleBox.y + handleBox.height / 2
    await page.mouse.move(startX, y)
    await page.mouse.down()
    // Drag the (right/max) handle LEFT ~35% of the rail width → the x window's hi edge drops.
    await page.mouse.move(startX - railBox.width * 0.35, y, { steps: 10 })
    await page.mouse.up()
  }

  await expect
    .poll(async () => JSON.stringify(await vizTest<[number, number] | null>(page, 'scatterXWindow')), {
      message: 'dragging the scatter x-slider narrows/moves its live world window',
    })
    .not.toBe(before)

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
