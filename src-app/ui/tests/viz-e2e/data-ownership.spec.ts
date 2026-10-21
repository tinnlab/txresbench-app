import { test, expect } from '@playwright/test'
import {
  openStory,
  canvasNonBlank,
  canvasPixelSignature,
  trackErrors,
  vizTest,
} from './_helpers'

/** Count mounted <canvas> elements. */
function canvasCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('canvas').length)
}

// DATA-OWNERSHIP INVERSION: the app mounts `<Viz source={…} option={…} />` with NO
// positions/colors/catalog props. The viz PULLS + OWNS its data once (the deck rendering non-blank
// proves the self-pull worked), and every manipulation is an imperative controller command —
// add a cell, recolor the owned scatter, remove the cell — with NO buffer ever re-passed. This is
// the full production path for the buffers-omitted façade.
test('data-ownership: buffers-omitted <Viz> self-pulls and mutates via imperative commands', async ({
  page,
}) => {
  // One 60k-point deck + async owned-data pull + recolor fetches; deck redraws under headless
  // swiftshader are slow, so give this surface a wider budget than the 60s default.
  test.setTimeout(120_000)
  const bag = trackErrors(page)
  await openStory(page, 'viz-data-ownership')

  // The story container + the workspace both mount.
  await expect(page.getByTestId('viz-data-ownership')).toBeVisible()
  await expect(page.getByTestId('viz-grid-workspace')).toBeVisible()

  // The one-time ownership handoff resolved: the deck rendered non-blank content from the
  // viz-OWNED buffers (pulled from `source` — the app passed no positions/colors). The transient
  // loading overlay must be gone.
  await expect
    .poll(async () => canvasNonBlank(page, 0), {
      message: 'deck renders non-blank from the self-pulled owned buffers',
      timeout: 30_000,
    })
    .toBeGreaterThan(0)
  await expect(page.getByTestId('viz-grid-loading')).toHaveCount(0)

  // Starts with exactly the one cell the initial `option` declared.
  expect(await vizTest<number>(page, 'ownershipCellCount')).toBe(1)
  expect(await vizTest<boolean>(page, 'ownershipHasController')).toBe(true)

  // ADD a cell imperatively (no buffer re-pass) — the grid grows.
  await page.getByTestId('ownership-add-cell').click()
  await expect
    .poll(async () => vizTest<number>(page, 'ownershipCellCount'), {
      message: 'controller.addCell grew the viz-owned grid',
    })
    .toBe(2)
  expect(await canvasCount(page), 'canvases persist after add').toBeGreaterThan(0)

  // RECOLOR the owned scatter by intent only — the viz recolors by pulling the column from its
  // OWNED source; the rendered image must actually change (not a no-op). The self-pulled default is
  // categorical-by-`group`, so recolor to the CONTINUOUS `qcA` (a genuinely different encoding) —
  // recoloring to `group` again would be a visual no-op.
  const sigBefore = await canvasPixelSignature(page, 0)
  await page.getByTestId('ownership-color-value').click()
  await expect
    .poll(async () => vizTest<string>(page, 'ownershipMainColorMode'), {
      message: 'setCellColorBy stamped the continuous intent',
    })
    .toBe('continuous')
  await expect
    .poll(async () => canvasPixelSignature(page, 0), {
      message: 'the owned scatter recolored (pixels moved) with no color buffer re-pass',
      timeout: 20_000,
    })
    .not.toBe(sigBefore)

  // REMOVE the added cell imperatively — back to one, still rendering.
  await page.getByTestId('ownership-remove-cell').click()
  await expect
    .poll(async () => vizTest<number>(page, 'ownershipCellCount'), {
      message: 'controller.removeCell shrank the viz-owned grid',
    })
    .toBe(1)
  await expect(page.getByTestId('viz-grid-workspace')).toBeVisible()
  expect(await canvasCount(page), 'canvases survive removal').toBeGreaterThan(0)

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
