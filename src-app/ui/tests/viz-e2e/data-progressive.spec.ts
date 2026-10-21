import { test, expect } from '@playwright/test'
import { canvasNonBlank, canvasPixelSignature, vizTest, trackErrors } from './_helpers'

// STREAMING_PROGRESSIVE_PLAN Wave 2a — the friendly `<Viz data={…}>` progressive path. The whole
// product requirement: hand a STREAM or an ARRAY straight to `<Viz>` and it owns fetch/reframe/bin/
// progressive-emit/cancel with ZERO app plumbing; a plain array and a chunked stream render
// IDENTICALLY, differing only in WHEN bytes arrive. The story mirrors
// `__VIZ_TEST__ = { framesEmitted, rowsSeen, finalMatchesOneShot, mode }`.
//
// NOTE (orchestrator): the raster worker is Vite-bundled (`new URL('./cpuRaster.worker.ts',
// import.meta.url)`). Under the showcase preview build, verify the worker actually spawns (else the
// client silently uses the main-thread fallback — still correct, just on-thread). A first-frame
// timing measurement (time-to-first `data-raster-ready=1`) belongs here too.

test('progressive: a chunked stream fills in MORE THAN ONE frame and converges to the one-shot raster', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const bag = trackErrors(page)

  // Reduced N so the software path mounts quickly; the code path is identical to the default.
  await page.goto('/viz-showcase.html?points=120000', { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 20_000 })
  await page.click('[data-testid="showcase-story-data-progressive"]')
  await page.waitForSelector('[data-testid="viz-data-progressive-story"]', { timeout: 20_000 })

  // Story default = CHUNKED stream. The CpuRasterView surface mounts (the viz owns the raster path).
  await page.waitForSelector('[data-testid="viz-cpu-raster-view"]', { timeout: 20_000 })

  // The single binned+shaded BitmapLayer quad draws NON-BLANK (bytes arrived + binned).
  await page.waitForFunction(() => document.querySelectorAll('canvas').length >= 1, undefined, {
    timeout: 20_000,
  })
  await expect.poll(async () => await canvasNonBlank(page, 0), { timeout: 30_000 }).toBeGreaterThan(0)

  // Progressive: the chunked stream commits MORE THAN ONE raster frame (blurry→sharp).
  await expect
    .poll(async () => await vizTest<number>(page, 'framesEmitted'), { timeout: 30_000 })
    .toBeGreaterThan(1)

  // rowsSeen climbs to the full cloud (the whole stream was consumed).
  await expect
    .poll(async () => await vizTest<number>(page, 'rowsSeen'), { timeout: 30_000 })
    .toBe(120_000)

  // The completed raster equals a one-shot bin of the whole cloud (progressive-final invariant).
  expect(await vizTest<boolean>(page, 'finalMatchesOneShot')).toBe(true)
  expect(await vizTest<string>(page, 'mode')).toBe('stream')

  expect(bag.errors, `console/page errors: ${bag.errors.join('; ')}`).toEqual([])
})

test('whole-array mode renders through the SAME <Viz data> prop, non-blank', async ({ page }) => {
  test.setTimeout(120_000)
  const bag = trackErrors(page)

  await page.goto('/viz-showcase.html?points=120000', { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 20_000 })
  await page.click('[data-testid="showcase-story-data-progressive"]')
  await page.waitForSelector('[data-testid="viz-data-progressive-story"]', { timeout: 20_000 })

  // Switch to the WHOLE-ARRAY source — identical one-liner, instant render.
  await page.click('[data-testid="viz-data-mode-array"]')
  await expect.poll(async () => await vizTest<string>(page, 'mode'), { timeout: 10_000 }).toBe('array')

  await page.waitForSelector('[data-testid="viz-cpu-raster-view"]', { timeout: 20_000 })
  await expect.poll(async () => await canvasNonBlank(page, 0), { timeout: 30_000 }).toBeGreaterThan(0)

  // Same progressive-final invariant holds for the array source (one instant batch).
  expect(await vizTest<boolean>(page, 'finalMatchesOneShot')).toBe(true)

  expect(bag.errors, `console/page errors: ${bag.errors.join('; ')}`).toEqual([])
})

// STREAMING_PROGRESSIVE_PLAN Wave 2b — MULTI-CHANNEL coloring through the SAME `<Viz data colorBy>`
// surface: density → by-label (per-cell argmax hue) → by-value (mean over the KLL p1/p99 scale). The
// story mirrors `__VIZ_TEST__ = { shadeMode, valueP1, valueP99, categoryCount }`. (Assertion authored
// per the plan; not run here — the orchestrator runs the visual/e2e gate.)
test('colorBy: density → by-label → by-value re-shades the SAME <Viz data> surface, non-blank', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const bag = trackErrors(page)

  await page.goto('/viz-showcase.html?points=120000', { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 20_000 })
  await page.click('[data-testid="showcase-story-data-progressive"]')
  await page.waitForSelector('[data-testid="viz-data-progressive-story"]', { timeout: 20_000 })
  await page.waitForSelector('[data-testid="viz-cpu-raster-view"]', { timeout: 20_000 })

  // Default = density.
  expect(await vizTest<string>(page, 'shadeMode')).toBe('density')

  // The distinct-category count surfaces from the streaming HLL (≈ 6, the demo's category slots).
  const catCount = await vizTest<number>(page, 'categoryCount')
  expect(catCount).toBeGreaterThanOrEqual(5)
  expect(catCount).toBeLessThanOrEqual(7)

  // The value color scale is the KLL sketch p1 < p99 (a real, non-degenerate domain).
  const p1 = await vizTest<number>(page, 'valueP1')
  const p99 = await vizTest<number>(page, 'valueP99')
  expect(p99).toBeGreaterThan(p1)

  // Let the DENSITY stream fully land, then capture the COMMITTED raster hash. Each colorBy is proven
  // to actually RE-SHADE (the view commits a DIFFERENT raster) by a CHANGED `data-raster-hash` — a
  // checksum of the raw shaded RGBA AT THE SOURCE. This is reliable where the composited-canvas
  // signature is NOT: at sparse counts the density-viridis and category-hue rasters both composite to
  // near-black, so `canvasPixelSignature` can't distinguish them even though the shade genuinely
  // differs. `canvasNonBlank` alone would pass a broken re-shade that left the stale density raster up.
  await expect.poll(async () => await vizTest<number>(page, 'rowsSeen'), { timeout: 30_000 }).toBe(120_000)
  await expect.poll(async () => await canvasNonBlank(page, 0), { timeout: 30_000 }).toBeGreaterThan(0)
  const surface = page.locator('[data-testid="viz-cpu-raster-view"]')
  const hashDensity = await surface.getAttribute('data-raster-hash')

  // Color BY LABEL → per-cell argmax hue; non-blank AND the committed raster CHANGES vs density.
  await page.click('[data-testid="viz-color-mode-label"]')
  await expect.poll(async () => await vizTest<string>(page, 'shadeMode'), { timeout: 10_000 }).toBe('category')
  await expect.poll(async () => await canvasNonBlank(page, 0), { timeout: 30_000 }).toBeGreaterThan(0)
  await expect
    .poll(async () => await surface.getAttribute('data-raster-hash'), { timeout: 15_000 })
    .not.toBe(hashDensity)
  const hashLabel = await surface.getAttribute('data-raster-hash')

  // Color BY VALUE → mean over the sketch scale; matrix bind-a-column path, positions stay resident.
  await page.click('[data-testid="viz-color-mode-value"]')
  await expect.poll(async () => await vizTest<string>(page, 'shadeMode'), { timeout: 10_000 }).toBe('value')
  await expect.poll(async () => await canvasNonBlank(page, 0), { timeout: 30_000 }).toBeGreaterThan(0)
  await expect
    .poll(async () => await surface.getAttribute('data-raster-hash'), { timeout: 15_000 })
    .not.toBe(hashLabel)
  // …and by-value differs from density too (all three shade modes commit DISTINCT rasters).
  expect(await surface.getAttribute('data-raster-hash')).not.toBe(hashDensity)

  expect(bag.errors, `console/page errors: ${bag.errors.join('; ')}`).toEqual([])
})

// STREAMING_PROGRESSIVE_PLAN Wave 2c — item 16 (retain-raw zoom RE-BIN). After the stream completes,
// ZOOMING IN must RE-BIN the retained streamed cloud at the tighter viewport bounds (crisp detail),
// not just reproject the fixed data-extent raster. Observable through the CpuRasterView's committed
// `data-frame-count` (a zoom re-bin commits a fresh frame) + a CHANGED canvas pixel signature.
// (Assertion authored per the plan; the orchestrator runs the visual/e2e gate — NOT run here.)
test('zoom-rebin: a post-stream zoom re-bins the retained cloud (frame-count climbs, raster changes)', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const bag = trackErrors(page)

  await page.goto('/viz-showcase.html?points=120000', { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 20_000 })
  await page.click('[data-testid="showcase-story-data-progressive"]')
  await page.waitForSelector('[data-testid="viz-data-progressive-story"]', { timeout: 20_000 })
  const surface = page.locator('[data-testid="viz-cpu-raster-view"]')
  await surface.waitFor({ timeout: 20_000 })

  // Let the stream fully complete (rowsSeen = the whole cloud) so we're on the POST-stream zoom path.
  await expect.poll(async () => await vizTest<number>(page, 'rowsSeen'), { timeout: 30_000 }).toBe(120_000)
  await expect.poll(async () => await canvasNonBlank(page, 0), { timeout: 30_000 }).toBeGreaterThan(0)

  // Baseline: the committed frame count + the current raster pixel signature.
  const framesBefore = Number(await surface.getAttribute('data-frame-count'))
  const sigBefore = await canvasPixelSignature(page, 'canvas')

  // Zoom IN over the canvas center via wheel (deck OrthographicView controller): several negative
  // deltas so the camera zoom crosses the re-bin threshold, past the debounce.
  const box = await surface.boundingBox()
  if (!box) throw new Error('raster surface has no bounding box')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -240)
    await page.waitForTimeout(60)
  }

  // The zoom scheduled a debounced re-bin over the retained cloud at the TIGHTER bounds → a fresh
  // committed frame (data-frame-count climbs) …
  await expect
    .poll(async () => Number(await surface.getAttribute('data-frame-count')), { timeout: 15_000 })
    .toBeGreaterThan(framesBefore)

  // … and the re-binned raster differs from the pre-zoom overview (crisp sub-extent, not a scaled blur).
  await expect
    .poll(async () => await canvasPixelSignature(page, 'canvas'), { timeout: 15_000 })
    .not.toBe(sigBefore)

  expect(bag.errors, `console/page errors: ${bag.errors.join('; ')}`).toEqual([])
})
