import { test, expect } from '@playwright/test'
import { openStory, canvasNonBlank, vizTest, trackErrors } from './_helpers'

// PERFORMANCE_PLAN.md Phase 1 — the CPU-raster fast path. The blessed e2e harness renders under
// SOFTWARE WebGL (SwiftShader), so this spec FORCES the mode via the story's `override` toggle
// (deterministic; not ambient auto) and asserts the render actually SWAPPED, not just that a
// control flipped:
//   • override ON  → the CpuRasterView surface is mounted (`viz-cpu-raster-view`), the point
//     surface (`viz-categorical-points-view`) is GONE, and the canvas renders NON-BLANK (the
//     single binned+shaded BitmapLayer quad drew).
//   • toggle OFF   → the point surface returns and the raster surface is gone.
// It also pans while raster mode is on and asserts the canvas stays non-blank + no errors (the
// fixed-quad reproject path — A2 amortization).

test('CPU raster mode swaps the point cloud for a single non-blank BitmapLayer, and back', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const bag = trackErrors(page)

  // Drive a reduced N so the software path mounts quickly; the code path is identical to the default.
  await page.goto('/viz-showcase.html?points=120000', { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 20_000 })
  await page.click('[data-testid="showcase-story-cpu-raster"]')
  await page.waitForSelector('[data-testid="viz-cpu-raster-story"]', { timeout: 20_000 })

  // ── Raster ON (story default) ─────────────────────────────────────────────────────────────
  // The CpuRasterView surface is mounted and the point surface is not.
  await page.waitForSelector('[data-testid="viz-cpu-raster-view"]', { timeout: 20_000 })
  expect(await page.locator('[data-testid="viz-categorical-points-view"]').count()).toBe(0)

  // Exactly one WebGL canvas, and it renders non-blank (the BitmapLayer quad drew).
  await page.waitForFunction(() => document.querySelectorAll('canvas').length >= 1, undefined, {
    timeout: 20_000,
  })
  await expect
    .poll(async () => await canvasNonBlank(page, 0), { timeout: 20_000 })
    .toBeGreaterThan(0)

  expect(await vizTest<boolean>(page, 'rasterActive')).toBe(true)
  expect(await vizTest<boolean>(page, 'bitmapLayerPresent')).toBe(true)
  expect(await vizTest<boolean>(page, 'pointLayerPresent')).toBe(false)

  // ── Pan while raster is on: fixed-quad reproject, stays non-blank, no errors ────────────────
  const canvas = page.locator('[data-testid="viz-cpu-raster-view"] canvas').first()
  const box = await canvas.boundingBox()
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2 - 40, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(400)
  }
  expect(await canvasNonBlank(page, 0)).toBeGreaterThan(0)

  // ── Toggle OFF → the GPU point surface returns, the raster surface is gone ──────────────────
  await page.click('[data-testid="viz-cpu-raster-toggle"]')
  await page.waitForSelector('[data-testid="viz-categorical-points-view"]', { timeout: 20_000 })
  expect(await page.locator('[data-testid="viz-cpu-raster-view"]').count()).toBe(0)
  await expect
    .poll(async () => await canvasNonBlank(page, 0), { timeout: 20_000 })
    .toBeGreaterThan(0)

  expect(await vizTest<boolean>(page, 'rasterActive')).toBe(false)
  expect(await vizTest<boolean>(page, 'pointLayerPresent')).toBe(true)

  // No console/page errors across the whole flow.
  expect(bag.errors, `console/page errors: ${bag.errors.join('; ')}`).toEqual([])
})

// PERFORMANCE_PLAN.md Phase 2 — the 10M LOAD-enabling gate. Under SwiftShader the harness must be
// able to LOAD a 10M-point cloud: raster-first means NO GL_POINTS layers are ever built (the thing
// that stalled load), and 16-bit packing halves the worker transfer. This spec drives the story at
// ?points=10000000&packed=1, asserts the raster surface mounts (never the point surface), the
// canvas renders NON-BLANK (the binned quad drew), and the packed path is active.
test('CPU raster LOADS a 10M-point cloud under software (raster-first + 16-bit packing)', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const bag = trackErrors(page)

  await page.goto('/viz-showcase.html?points=10000000&packed=1', { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 30_000 })
  await page.click('[data-testid="showcase-story-cpu-raster"]')
  await page.waitForSelector('[data-testid="viz-cpu-raster-story"]', { timeout: 30_000 })

  // The fixture built + the view mounted (the generator did not OOM/hang).
  await expect.poll(async () => await vizTest<boolean>(page, 'loaded'), { timeout: 120_000 }).toBe(true)
  expect(await vizTest<number>(page, 'pointCount')).toBe(10_000_000)
  expect(await vizTest<boolean>(page, 'packed')).toBe(true)

  // Raster-first: the point surface is NEVER mounted for the 10M cloud; only the raster surface.
  await page.waitForSelector('[data-testid="viz-cpu-raster-view"]', { timeout: 120_000 })
  expect(await page.locator('[data-testid="viz-categorical-points-view"]').count()).toBe(0)

  // The single binned+shaded BitmapLayer quad actually drew (non-blank), i.e. 10M rendered.
  await page.waitForFunction(() => document.querySelectorAll('canvas').length >= 1, undefined, {
    timeout: 60_000,
  })
  await expect
    .poll(async () => await canvasNonBlank(page, 0), { timeout: 120_000 })
    .toBeGreaterThan(0)

  expect(await vizTest<boolean>(page, 'rasterActive')).toBe(true)
  expect(await vizTest<boolean>(page, 'pointLayerPresent')).toBe(false)

  expect(bag.errors, `console/page errors: ${bag.errors.join('; ')}`).toEqual([])
})
