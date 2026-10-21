import { test, expect } from '@playwright/test'
import { openStory, expectSomeCanvasRendered, trackErrors, canvasPixelSignature } from './_helpers'

// TEST-28 (covers ITEM-17..21): the companion statistical charts (violin / dotplot /
// heatmap / volcano) each mount a non-blank deck.gl WebGL canvas with zero console errors.
//
// RECONCILED from the stale TESTS.md text ("SVG present"): the delivered charts are ALL
// deck.gl/GPU — there is NO <svg>. We assert a <canvas> renders non-blank pixels instead.
//
// Linked / coordinated recolor: no chart story here exposes a `window.__VIZ_TEST__`
// coordination hook (those hooks live only in the selection / selectionSync stories). The
// cross-plot linked-recolor behavior is exercised by the selectionSync story + covered by
// the selectionSync unit/spec path; here we assert the render + clean console per chart.
const STORIES: Array<{ id: string; kind: string }> = [
  { id: 'chart-violin', kind: 'violin' },
  { id: 'chart-dotplot', kind: 'dotplot' },
  { id: 'chart-heatmap', kind: 'heatmap' },
  { id: 'chart-volcano', kind: 'volcano' },
]

for (const { id, kind } of STORIES) {
  test(`TEST-28 ${kind} (${id}) mounts a non-blank deck.gl canvas with no console error`, async ({
    page,
  }) => {
    const bag = trackErrors(page)
    await openStory(page, id)

    await expectSomeCanvasRendered(page)

    expect(bag.errors, `${id} console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
  })
}

// TEST-28 (interaction proof): the render smoke above would pass on an inert canvas, so
// prove at least ONE companion chart is LIVE, not a bare snapshot. The heatmap chart
// exposes a real control (`viz-heatmap-cluster-rows`); toggling it clusters/reorders the
// matrix, which MUST move pixels. A cosmetic/inert chart leaves the signature identical →
// this assertion fails, distinguishing a live chart from a dead one.
test('TEST-28 companion heatmap chart is interactive — clustering reorders the pixels', async ({
  page,
}) => {
  const bag = trackErrors(page)
  await openStory(page, 'chart-heatmap')

  await expectSomeCanvasRendered(page)
  const canvas = '[data-testid="viz-heatmap-view"] canvas'

  const before = await canvasPixelSignature(page, canvas)
  expect(before).not.toBe('no-canvas')

  // Plain mean heatmap boots with clustering OFF → turn "Cluster rows" ON (leaf-order reorder).
  const clusterRows = page.locator('[data-testid="viz-heatmap-cluster-rows"]')
  await expect(clusterRows).toBeVisible()
  await clusterRows.click()
  await page.waitForTimeout(700)

  const after = await canvasPixelSignature(page, canvas)
  expect(after, 'clustering the heatmap rows must reorder the matrix (pixels change)').not.toBe(before)

  expect(bag.errors, `chart-heatmap console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
