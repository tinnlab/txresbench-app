import { test, expect, type Page } from '@playwright/test'
import { openStory, trackErrors, vizTest } from './_helpers'
import {
  expectAbsentPaneMeasuresNothing,
  expectDistinctPanePlots,
  expectPaneRepainted,
  panePlotSignature,
  panePlotTarget,
} from './_pixelsig'

// The VIOLIN as a first-class, fully-synced SELECTION surface + a VALUE-AXIS-only zoom
// (story `violin-linked`). A GPU scatter (left) and a `ViolinView` (right) share ONE
// coordination store + ONE index space. Asserted on the story hooks (`pointSelectionLength`
// / `violinSelectedDots` / `violinSelectedGroups`) AND on the participating canvases' pixels.
//
//   • CONSUME (scatter→violin): "Select group 0" emphasises the matching DOTS + GROUP body in
//     the violin (its canvas repaints); the shared count reflects the selection.
//   • PRODUCE (violin band→scatter): "Band-select group 1" runs the value-band producer → the
//     scatter emphasises those points (its canvas repaints).
//   • VALUE-AXIS ZOOM: a wheel over the violin (pan mode) narrows the VALUE (y) window — the
//     violin repaints and stays non-blank (re-densify, not blank), and the X (group) extent of
//     the drawn content stays ~stable (it is value-axis-only zoom, NOT a free 2-D camera). The
//     DragRail hi-handle drag is the second value-window gesture and likewise repaints.

// The violin canvas lives inside `viz-violin-linked-violin`; the scatter's DeckGL canvas inside
// `viz-violin-linked-scatter`. Scope every pixel read to the right pane so we never read the
// wrong canvas — and PROVE that scoping rather than assume it. The violin pane holds TWO canvases
// (the 489x749 plot and the 16x749 value-zoom rail) and, measured on this story, BOTH repaint on
// the wheel zoom and on the rail drag: a spec reading the rail would report "the violin repainted"
// on precisely the two gestures it is meant to police. `panePlotSignature` resolves each pane to
// the canvas that COVERS it (a rail covers ~3%) and `expectDistinctPanePlots` asserts that
// resolution up front — the same control that turned `selection-sync` TEST-35b from luck into a
// measurement.
const VIOLIN = '[data-testid="viz-violin-linked-violin"]'
const SCATTER = '[data-testid="viz-violin-linked-scatter"]'

/**
 * Opaque-pixel stats of a pane's PLOT canvas (resolved by `panePlotTarget`, not by DOM order):
 * non-blank count + the fractional X-extent [xmin,xmax] (0..1) of columns carrying opaque content.
 * Used to assert the drawn content's horizontal span is ~unchanged across a value-axis (y) zoom.
 * Returns a blank/empty extent when the pane has no measurable plot canvas / on a tainted read.
 */
async function violinCanvasStats(
  page: Page,
  selector: string,
): Promise<{ opaque: number; xmin: number; xmax: number }> {
  // Resolved through the SAME pane-plot rule as every digest in this spec, so the X-extent
  // assertion can never end up measuring the value-zoom rail (whose extent is trivially stable,
  // which would make the "value-axis-only" claim pass for free).
  const target = await panePlotTarget(page, selector)
  if (target.kind !== 'own') return { opaque: 0, xmin: 1, xmax: 0 }
  return page.evaluate((idx) => {
    const c = document.querySelectorAll('canvas')[idx] as HTMLCanvasElement | undefined
    const blank = { opaque: 0, xmin: 1, xmax: 0 }
    if (!c) return blank
    const off = document.createElement('canvas')
    off.width = c.width
    off.height = c.height
    const ctx = off.getContext('2d')
    if (!ctx) return blank
    try {
      ctx.drawImage(c, 0, 0)
      const { data, width, height } = ctx.getImageData(0, 0, off.width, off.height)
      let opaque = 0
      let minX = width
      let maxX = -1
      // Stride over rows/cols cheaply; any opaque pixel widens the X-extent.
      for (let y = 0; y < height; y += 3) {
        for (let x = 0; x < width; x += 3) {
          const a = data[(y * width + x) * 4 + 3]
          if (a > 10) {
            opaque++
            if (x < minX) minX = x
            if (x > maxX) maxX = x
          }
        }
      }
      if (maxX < 0) return blank
      return { opaque, xmin: minX / width, xmax: maxX / width }
    } catch {
      return blank
    }
  }, target.index)
}

test('violin coordinates: dot/group emphasis (consume) + value-band brush (produce) + value-axis-only zoom', async ({
  page,
}) => {
  // 8k-point fixture + debounced KDE recompute, under headless swiftshader — a wide budget.
  test.setTimeout(180_000)
  const bag = trackErrors(page)
  await openStory(page, 'violin-linked')

  await expect(page.getByTestId('viz-violin-linked')).toBeVisible()
  await expect(page.getByTestId('viz-violin-linked-violin')).toBeVisible()
  await expect(page.getByTestId('viz-violin-linked-scatter')).toBeVisible()

  // ── CONTROLS: prove WHAT is being measured, before measuring anything ────────
  // Pane-specificity + rail-rejection: the violin and the scatter must resolve to DIFFERENT
  // canvases, each covering its own pane (the value-zoom rail covers ~3%) and each painted.
  const targets = await expectDistinctPanePlots(page, { VIOLIN, SCATTER })
  // Absent-pane negative control: a selector matching nothing yields the "no measurement"
  // sentinel — the reason every repaint assertion below also asserts the pane still paints.
  await expectAbsentPaneMeasuresNothing(page, '[data-testid="viz-violin-linked-no-such-pane"]')
  // eslint-disable-next-line no-console -- the measurement is the point; a failure must show it.
  console.log('pane plot targets:', JSON.stringify(targets, null, 1))

  await expect
    .poll(() => vizTest<number>(page, 'pointSelectionLength'), { message: 'selection starts empty' })
    .toBe(0)

  // ── CONSUME (scatter → violin) ──────────────────────────────────────────────
  await expect
    .poll(() => panePlotSignature(page, VIOLIN), {
      message: 'violin canvas mounts + renders',
      timeout: 30_000,
    })
    .not.toBe('')
  const violinBefore = await panePlotSignature(page, VIOLIN)

  await page.getByTestId('viz-violin-linked-seed').click()
  await expect
    .poll(() => vizTest<number>(page, 'violinSelectedDots'), {
      message: 'group-0 selection emphasises violin dots',
    })
    .toBeGreaterThan(0)
  await expect
    .poll(() => vizTest<number>(page, 'violinSelectedGroups'), {
      message: 'the emphasised dots cover at least one group body',
    })
    .toBeGreaterThanOrEqual(1)
  await expectPaneRepainted(
    page,
    VIOLIN,
    violinBefore,
    'violin repaints (dot/group emphasis) on the scatter selection',
  )

  await page.getByTestId('viz-violin-linked-clear').click()
  await expect
    .poll(() => vizTest<number>(page, 'violinSelectedDots'), { message: 'Clear resets dots' })
    .toBe(0)
  await expect.poll(() => vizTest<number>(page, 'pointSelectionLength')).toBe(0)

  // ── PRODUCE (violin value-band → scatter) ───────────────────────────────────
  await expect
    .poll(() => panePlotSignature(page, SCATTER), {
      message: 'scatter canvas mounts + renders',
      timeout: 30_000,
    })
    .not.toBe('')
  const scatterBefore = await panePlotSignature(page, SCATTER)

  await page.getByTestId('viz-violin-linked-seed-band').click()
  await expect
    .poll(() => vizTest<number>(page, 'pointSelectionLength'), {
      message: 'the violin value-band brush fans out to the shared store',
    })
    .toBeGreaterThan(0)
  await expectPaneRepainted(
    page,
    SCATTER,
    scatterBefore,
    'scatter repaints (emphasis) on the violin value-band selection',
  )

  await page.getByTestId('viz-violin-linked-clear').click()
  await expect
    .poll(() => vizTest<number>(page, 'pointSelectionLength'), { message: 'Clear resets selection' })
    .toBe(0)

  // ── VALUE-AXIS ZOOM (wheel, pan mode) ───────────────────────────────────────
  // Enter pan mode so the wheel drives the value window (the band/lasso overlays own the pointer
  // in the other modes).
  await page.getByTestId('viz-violin-mode-pan').click()
  await expect(page.getByTestId('viz-violin-mode-pan')).toHaveAttribute('aria-pressed', 'true')
  await page.waitForTimeout(300)

  const zoomBaselineSig = await panePlotSignature(page, VIOLIN)
  const beforeStats = await violinCanvasStats(page, VIOLIN)
  expect(beforeStats.opaque, 'violin has drawn content before the wheel zoom').toBeGreaterThan(0)

  // Wheel-zoom IN over the violin canvas (deltaY < 0 = narrow the value window toward the cursor).
  const violinCanvas = page.locator(`${VIOLIN} canvas`).first()
  const box = await violinCanvas.boundingBox()
  expect(box, 'violin canvas has a measured rect').not.toBeNull()
  if (box) {
    const cx = box.x + box.width * 0.5
    const cy = box.y + box.height * 0.5
    await page.mouse.move(cx, cy)
    await page.mouse.wheel(0, -240)
    await page.waitForTimeout(250)
    await page.mouse.wheel(0, -240)
    await page.waitForTimeout(400)
  }

  // The violin repainted (value window narrowed) …
  await expectPaneRepainted(page, VIOLIN, zoomBaselineSig, 'violin repaints on the value-axis wheel zoom')
  // … and stayed non-blank (re-densify, not a blank frame).
  const afterStats = await violinCanvasStats(page, VIOLIN)
  expect(afterStats.opaque, 'violin stays non-blank after the value-axis zoom').toBeGreaterThan(0)

  // VALUE-AXIS-ONLY assertion: the groups are fixed on X, so the drawn content's horizontal
  // extent is ~stable across the y-zoom (allow ~15% tolerance for KDE-body width jitter). A free
  // 2-D zoom would have scaled X too and blown this tolerance.
  const spanBefore = beforeStats.xmax - beforeStats.xmin
  const spanAfter = afterStats.xmax - afterStats.xmin
  expect(spanBefore, 'measurable X-extent before zoom').toBeGreaterThan(0)
  expect(spanAfter, 'measurable X-extent after zoom').toBeGreaterThan(0)
  expect(
    Math.abs(spanAfter - spanBefore),
    `X (group) extent stays ~stable across the value-axis zoom (before=${spanBefore.toFixed(3)} after=${spanAfter.toFixed(3)})`,
  ).toBeLessThan(0.15)

  // ── VALUE-AXIS ZOOM (DragRail hi-handle) ────────────────────────────────────
  // Drag the HI handle DOWN toward the rail centre (top = domain max). Dragging lo-UP does not
  // engage; the HI-down drag shrinks the value window from the top → the violin repaints.
  const railSig = await panePlotSignature(page, VIOLIN)
  const rail = page.getByTestId('viz-violin-value-zoom-slider')
  const hiHandle = page.getByTestId('viz-violin-value-zoom-slider-handle-hi')
  await expect(rail).toBeVisible()
  await expect(hiHandle).toBeVisible()
  const railBox = await rail.boundingBox()
  const handleBox = await hiHandle.boundingBox()
  expect(railBox, 'rail has a measured rect').not.toBeNull()
  expect(handleBox, 'hi-handle has a measured rect').not.toBeNull()
  if (railBox && handleBox) {
    const sx = handleBox.x + handleBox.width / 2
    const sy = handleBox.y + handleBox.height / 2
    await page.mouse.move(sx, sy)
    await page.mouse.down()
    await page.mouse.move(sx, railBox.y + railBox.height * 0.5, { steps: 10 })
    await page.mouse.move(sx, railBox.y + railBox.height * 0.75, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(500)
  }
  await expectPaneRepainted(
    page,
    VIOLIN,
    railSig,
    'violin repaints on the value-zoom rail hi-handle drag',
  )

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
