import { test, expect } from '@playwright/test'
import { openStory, expectSomeCanvasRendered, trackErrors } from './_helpers'

// TEST-59 (covers ITEM-39..42): the statistical view kinds (violin / box / volcano / bar)
// each render a non-blank deck.gl canvas with zero console errors, and the interactive
// volcano's draggable fold-change threshold rail (DragRail) drags without crashing.
//
// RECONCILED: charts are deck.gl/GPU canvases (no SVG); naming is generic.

const RENDER_STORIES: Array<{ id: string; kind: string }> = [
  { id: 'chart-violin', kind: 'violin' },
  { id: 'chart-box', kind: 'box' },
  { id: 'chart-bar', kind: 'bar' },
]

for (const { id, kind } of RENDER_STORIES) {
  test(`TEST-59 ${kind} (${id}) renders non-blank with no console error`, async ({ page }) => {
    const bag = trackErrors(page)
    await openStory(page, id)
    await expectSomeCanvasRendered(page)
    expect(bag.errors, `${id} console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
  })
}

test('TEST-59 interactive volcano renders + dragging the fc threshold rail does not crash', async ({
  page,
}) => {
  const bag = trackErrors(page)
  // chart-volcano-interactive exposes the draggable ±fc / p rails (DragRail).
  await openStory(page, 'chart-volcano-interactive')

  await expectSomeCanvasRendered(page)
  await expect(page.locator('[data-testid="viz-volcano-controls"]')).toBeVisible()

  // The fc rail has handles={1} → only the "hi" handle exists. Drag it right, which recolors
  // points + moves the guide. We assert the drag doesn't crash and the chart still renders.
  const handle = page.locator('[data-testid="viz-volcano-fc-rail-handle-hi"]')
  await expect(handle).toBeVisible()
  const hb = await handle.boundingBox()
  expect(hb, 'fc-rail handle should have a layout box').not.toBeNull()
  if (hb) {
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb.x + hb.width / 2 + 40, hb.y + hb.height / 2, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(500)
  }

  await expectSomeCanvasRendered(page)
  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
