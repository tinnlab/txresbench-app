import { test, expect } from '@playwright/test'
import { openStory, trackErrors, vizTest } from './_helpers'
import {
  expectAbsentPaneMeasuresNothing,
  expectDistinctPanePlots,
  expectPaneRepainted,
  panePlotSignature,
} from './_pixelsig'

// The matrix heatmap as a FIRST-CLASS coordination participant (story `heatmap-matrix-linked`).
// It proves the three coordination links the per-cell matrix heatmap now joins — asserted on
// the story's `__VIZ_TEST__` hooks (`pointSelectionLength` / `heatmapSelectedCols` /
// `heatmapSharedWindow`) AND on the actual rendered PIXELS of the participating canvases (the
// anti-inert check: a coordination link that flipped a number but moved no pixels FAILS here).
//
//   • SELECTION SYNC — scatter→heatmap CONSUME: "Select cluster 0" writes those points into the
//     shared store → the heatmap DIMS every column not in cluster 0 (its canvas repaints).
//   • SELECTION SYNC — heatmap→scatter PRODUCE: "Brush cols 0–500" writes columns via the SAME
//     `onSelectColumns` store path → the scatter EMPHASISES those points (its canvas repaints).
//   • ZOOM SYNC — two same-matrix heatmaps share ONE controlled navigation window, so dragging a
//     column dataZoom-BAR handle on `-sync-a` narrows the shared window and BOTH heatmaps
//     (`-sync-a` + `-sync-b`) track (both canvases repaint). No scroll-wheel zoom exists.
//
// WHICH CANVAS THIS SPEC READS, AND WHY IT IS NOT `canvasPixelSignatureInSelector`. Each pane here
// holds THREE canvases — the plot plus two dataZoom rails (`-datazoom-rows` 16x338,
// `-datazoom-cols` 490x16). Measured on this story: a column-slider drag repaints the plot AND
// both cols rails, so a spec reading a rail reports "the heatmap tracked the window" without ever
// looking at a heatmap. That is exactly how `selection-sync` TEST-35b passed while measuring a
// 16x141 rail. `panePlotSignature` resolves each pane to the canvas that COVERS it (or, inside a
// grid, to the shared-deck region under it) and `expectDistinctPanePlots` asserts that resolution
// instead of trusting it: four distinct canvases, each covering its pane, each actually painted.

// Base column count of the story's matrix fixture (ROWS=40, COLS=4000). Cluster 0 lights only a
// STRICT SUBSET of the columns, so `heatmapSelectedCols` must land in (0, COLS).
const COLS = 4000

const SCATTER = '[data-testid="viz-heatmap-linked-scatter"]'
const HEATMAP = '[data-testid="viz-heatmap-linked-heatmap"]'
const SYNC_A = '[data-testid="viz-heatmap-linked-sync-a"]'
const SYNC_B = '[data-testid="viz-heatmap-linked-sync-b"]'

test('matrix heatmap coordinates: selection dim (consume) + column brush (produce) + heatmap↔heatmap zoom sync', async ({
  page,
}) => {
  // Two 40×4000 heatmaps + a 4000-point scatter, all under headless swiftshader — a wide budget.
  test.setTimeout(180_000)
  const bag = trackErrors(page)
  await openStory(page, 'heatmap-matrix-linked')

  await expect(page.getByTestId('viz-heatmap-linked')).toBeVisible()
  await expect(page.getByTestId('viz-heatmap-linked-scatter')).toBeVisible()
  await expect(page.getByTestId('viz-heatmap-linked-heatmap')).toBeVisible()
  await expect(page.getByTestId('viz-heatmap-linked-sync-a')).toBeVisible()
  await expect(page.getByTestId('viz-heatmap-linked-sync-b')).toBeVisible()

  // ── CONTROLS: prove WHAT is being measured, before measuring anything ────────
  // Pane-specificity + rail-rejection: four panes, four DIFFERENT canvases, each covering its own
  // pane (a dataZoom rail covers ~3%) and each painted. Without this, two selectors collapsing onto
  // one canvas — or onto a rail — leaves every assertion below passing on the wrong pixels.
  const targets = await expectDistinctPanePlots(page, {
    SCATTER,
    HEATMAP,
    SYNC_A,
    SYNC_B,
  })
  // Absent-pane negative control: a selector that matches nothing must yield the "no measurement"
  // sentinel — which is why every repaint assertion below also asserts the pane still paints
  // (`expectPaneRepainted`): '' would otherwise satisfy `.not.toBe(before)` for a vanished pane.
  await expectAbsentPaneMeasuresNothing(page, '[data-testid="viz-heatmap-linked-no-such-pane"]')
  // eslint-disable-next-line no-console -- the measurement is the point; a failure must show it.
  console.log('pane plot targets:', JSON.stringify(targets, null, 1))

  // Shared selection starts empty.
  await expect
    .poll(() => vizTest<number>(page, 'pointSelectionLength'), { message: 'selection starts empty' })
    .toBe(0)

  // The heatmap canvas mounts + paints — capture its pre-selection baseline digest.
  await expect
    .poll(() => panePlotSignature(page, HEATMAP), {
      message: 'heatmap canvas mounts + renders',
      timeout: 30_000,
    })
    .not.toBe('')
  const heatmapBefore = await panePlotSignature(page, HEATMAP)

  // ── SELECTION SYNC — scatter → heatmap (CONSUME) ────────────────────────────
  // "Select cluster 0" writes those points into the shared store; the heatmap reads the same
  // store and DIMS the complement of the lit columns.
  await page.getByTestId('viz-heatmap-linked-seed-scatter').click()
  await expect
    .poll(() => vizTest<number>(page, 'pointSelectionLength'), {
      message: 'scatter selection fans out to the shared store',
    })
    .toBeGreaterThan(0)
  // The heatmap lit a STRICT SUBSET of its columns (cluster 0 ⊂ all columns).
  const litCols = await vizTest<number>(page, 'heatmapSelectedCols')
  expect(litCols, 'cluster-0 lights some heatmap columns').toBeGreaterThan(0)
  expect(litCols, 'cluster-0 lights fewer than ALL heatmap columns').toBeLessThan(COLS)
  // The heatmap canvas actually repainted (columns dimmed) — not merely a number flip.
  await expectPaneRepainted(
    page,
    HEATMAP,
    heatmapBefore,
    'heatmap repaints (columns dim) in response to the scatter selection',
  )

  // Clear returns the shared selection AND the heatmap-lit count to zero.
  await page.getByTestId('viz-heatmap-linked-clear').click()
  await expect
    .poll(() => vizTest<number>(page, 'pointSelectionLength'), { message: 'Clear resets selection' })
    .toBe(0)
  await expect.poll(() => vizTest<number>(page, 'heatmapSelectedCols')).toBe(0)

  // ── SELECTION SYNC — heatmap → scatter (PRODUCE) ────────────────────────────
  // Capture the scatter baseline AFTER the clear, then brush columns via the heatmap's store path
  // and prove the scatter emphasises those points (its canvas repaints).
  await expect
    .poll(() => panePlotSignature(page, SCATTER), {
      message: 'scatter canvas mounts + renders',
      timeout: 30_000,
    })
    .not.toBe('')
  const scatterBefore = await panePlotSignature(page, SCATTER)

  await page.getByTestId('viz-heatmap-linked-brush-cols').click()
  await expect
    .poll(() => vizTest<number>(page, 'pointSelectionLength'), {
      message: 'the column brush fans out to the shared store',
    })
    .toBeGreaterThan(0)
  await expectPaneRepainted(
    page,
    SCATTER,
    scatterBefore,
    'scatter repaints (emphasis) in response to the heatmap column brush',
  )

  await page.getByTestId('viz-heatmap-linked-clear').click()
  await expect
    .poll(() => vizTest<number>(page, 'pointSelectionLength'), { message: 'Clear resets selection' })
    .toBe(0)

  // ── ZOOM SYNC — two same-matrix heatmaps share one controlled navigation WINDOW ─────
  // Dragging a column dataZoom-BAR handle on `-sync-a` narrows the SHARED window; both `-sync-a`
  // and `-sync-b` re-read it and repaint together. (No scroll-wheel zoom exists on this view.)
  await expect
    .poll(() => panePlotSignature(page, SYNC_A), { timeout: 30_000 })
    .not.toBe('')
  await expect
    .poll(() => panePlotSignature(page, SYNC_B), { timeout: 30_000 })
    .not.toBe('')
  const syncABefore = await panePlotSignature(page, SYNC_A)
  const syncBBefore = await panePlotSignature(page, SYNC_B)
  const windowBefore = await vizTest<number>(page, 'heatmapSharedWindow')
  // The shared window starts at the full matrix (all COLS visible).
  expect(windowBefore, 'shared window starts full-width').toBe(COLS)

  // Drag the `-sync-a` COLUMN slider's high (right) handle inward to narrow the window.
  const colHandle = page.getByTestId('viz-heatmap-sync-a-datazoom-cols-handle-hi')
  await expect(colHandle).toBeVisible()
  const handleBox = await colHandle.boundingBox()
  const railBox = await page.getByTestId('viz-heatmap-sync-a-datazoom-cols').boundingBox()
  expect(handleBox, 'column slider handle has a box').not.toBeNull()
  expect(railBox, 'column slider rail has a box').not.toBeNull()
  if (handleBox && railBox) {
    const startX = handleBox.x + handleBox.width / 2
    const y = handleBox.y + handleBox.height / 2
    await page.mouse.move(startX, y)
    await page.mouse.down()
    // drag left ~35% of the rail width → col1 drops by ~35% of COLS.
    await page.mouse.move(startX - railBox.width * 0.35, y, { steps: 10 })
    await page.mouse.up()
  }

  // The shared window narrowed (fewer columns visible) …
  await expect
    .poll(() => vizTest<number>(page, 'heatmapSharedWindow'), {
      message: 'dragging the column dataZoom bar narrows the shared window',
    })
    .toBeLessThan(windowBefore)
  // … and BOTH heatmaps tracked it (each canvas repainted).
  await expectPaneRepainted(page, SYNC_A, syncABefore, 'sync-a heatmap tracks the shared window')
  await expectPaneRepainted(page, SYNC_B, syncBBefore, 'sync-b heatmap tracks the shared window')

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
