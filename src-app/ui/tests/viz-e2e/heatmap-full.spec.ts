import { test, expect } from '@playwright/test'
import { openStory, expectSomeCanvasRendered, trackErrors, canvasPixelSignature } from './_helpers'

const HEATMAP_CANVAS = '[data-testid="viz-heatmap-view"] canvas'

// TEST-58 (covers ITEM-36/37/38): the full enriched heatmap — clustered rows/cols with
// PathLayer dendrograms + a categorical annotation track + a live z-score toggle. The
// story mounts HeatmapView with clusterRows/clusterCols/showDendrogram/showAnnotation ON;
// toggling the toolbar controls must never error and must keep rendering, and a cell hover
// must surface the value in the tooltip.
//
// RECONCILED: naming is GENERIC (Group/Feature/Value/Cell), NOT gene/cluster; charts are
// deck.gl canvases (no SVG) — the dendrogram/annotation are extra deck layers on the same
// canvas, so we assert canvas-non-blank rather than an SVG path.
test('TEST-58 enriched heatmap: cluster + z-score toggles render cleanly, cell hover shows value', async ({
  page,
}) => {
  const bag = trackErrors(page)
  await openStory(page, 'heatmap-enriched')

  // Baseline: clustered heatmap + dendrograms + annotation render on the single deck canvas.
  await expectSomeCanvasRendered(page)
  // Toolbar toggles are all present (dendrogram + annotation are exposed toggles).
  await expect(page.locator('[data-testid="viz-heatmap-toolbar"]')).toBeVisible()
  await expect(page.locator('[data-testid="viz-heatmap-dendrogram"]')).toBeVisible()
  await expect(page.locator('[data-testid="viz-heatmap-annotation-toggle"]')).toBeVisible()

  // DOWNSTREAM PROOF #1 — clustering REORDERS the matrix. Snapshot the heatmap texture,
  // toggle "Cluster rows" (enriched starts ON → this turns it OFF, dropping the leaf-order
  // reorder + row dendrogram), and assert the pixels CHANGED. A no-op toggle would leave
  // the rows in place → identical signature → this fails.
  const sigClusterOn = await canvasPixelSignature(page, HEATMAP_CANVAS)
  expect(sigClusterOn).not.toBe('no-canvas')
  await page.click('[data-testid="viz-heatmap-cluster-rows"]')
  await page.waitForTimeout(700)
  await expectSomeCanvasRendered(page)
  const sigClusterOff = await canvasPixelSignature(page, HEATMAP_CANVAS)
  expect(sigClusterOff, 'toggling row clustering must reorder the matrix (pixels change)').not.toBe(
    sigClusterOn,
  )
  expect(bag.errors, `after cluster-rows toggle: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)

  // DOWNSTREAM PROOF #2 — z-score rows swaps the colormap (per-row normalization → diverging
  // magma LUT centered at 0). Snapshot, toggle z-score ON, assert the recolor moved pixels.
  const sigRaw = await canvasPixelSignature(page, HEATMAP_CANVAS)
  await page.click('[data-testid="viz-heatmap-zscore"]')
  await page.waitForTimeout(700)
  await expectSomeCanvasRendered(page)
  const sigZscored = await canvasPixelSignature(page, HEATMAP_CANVAS)
  expect(sigZscored, 'z-score rows must renormalize + recolor the matrix (pixels change)').not.toBe(
    sigRaw,
  )
  expect(bag.errors, `after z-score toggle: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)

  // Hover a cell → the tooltip surfaces the cell's Value (O(1) resolveMatrixTooltip).
  const canvas = page.locator('[data-testid="viz-heatmap-view"] canvas').first()
  const box = await canvas.boundingBox()
  expect(box, 'heatmap canvas should have a layout box').not.toBeNull()
  const tooltip = page.locator('[data-testid="viz-tooltip"]')

  let appeared = false
  if (box) {
    outer: for (let gy = 0.25; gy <= 0.75 && !appeared; gy += 0.1) {
      for (let gx = 0.2; gx <= 0.7; gx += 0.06) {
        await page.mouse.move(box.x + box.width * gx, box.y + box.height * gy)
        await page.waitForTimeout(120)
        if (await tooltip.isVisible()) {
          appeared = true
          break outer
        }
      }
    }
  }
  expect(appeared, 'hovering a heatmap cell should surface the tooltip').toBe(true)
  const text = (await tooltip.innerText()).trim()
  expect(text, `tooltip text: ${text}`).toContain('Value')

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
