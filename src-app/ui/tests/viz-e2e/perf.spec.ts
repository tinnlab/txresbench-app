import { test, expect } from '@playwright/test'
import { trackErrors } from './_helpers'

// TEST-76 (covers ITEM-59): the perf-measurement + GPU-memory-budget surfaces.
//
// `perf-scatter` runs the real GPU scatter through a frame-timed sweep and publishes
// `{ stats, verdict }` on `window.__VIZ_PERF__`. We assert it actually rendered frames
// (frames > 0), reports a p95 number, and its LENIENT verdict passed. We do NOT assert
// 60fps — the blessed harness is headless SOFTWARE WebGL (swiftshader), so the story's own
// budget only gates on "rendered a batch of frames" (a real-GPU fps/p95 budget is applied
// by the driver via scripts/viz-perf.mjs, not here). We drive the sweep at a reduced
// point count via `?points=` so the software path completes quickly — the frame-timer /
// verdict code path is identical to the 1M default.
//
// `chunked-scatter` splits the dataset into N GPU layers under a per-layer memory budget
// and mirrors the plan (bytes estimate + chunk count + points-per-chunk) to
// `window.__VIZ_TEST__.chunkPlan`. We drive `?points=600000` so it splits into >1 chunk,
// proving the multi-layer path.
//
// Each surface loads on its OWN fresh page — transitioning between two heavy GPU stories
// in one page session stalls the software driver.
test('TEST-76 perf sweep reports frames + a passing lenient verdict; chunk plan reports bytes + chunks', async ({
  page,
}) => {
  test.setTimeout(150_000)
  const bag = trackErrors(page)

  // ── perf-scatter: frame-time / fps harness (reduced N for the software path) ──
  await page.goto('/viz-showcase.html?points=150000', { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 20_000 })
  await page.click('[data-testid="showcase-story-perf-scatter"]')

  await page.waitForFunction(
    () => {
      const r = (window as unknown as { __VIZ_PERF__?: { stats?: unknown } }).__VIZ_PERF__
      return !!r && !!r.stats
    },
    undefined,
    { timeout: 90_000 },
  )

  const perf = await page.evaluate(
    () =>
      (
        window as unknown as {
          __VIZ_PERF__: {
            stats: { frames: number; p95Ms: number; meanFps: number }
            verdict: { ok: boolean; reasons: string[] }
          }
        }
      ).__VIZ_PERF__,
  )

  expect(perf.stats.frames, 'the sweep should render at least one frame').toBeGreaterThan(0)
  expect(Number.isFinite(perf.stats.p95Ms), 'stats should report a finite p95').toBe(true)
  expect(
    perf.verdict.ok,
    `lenient verdict should pass under swiftshader: ${perf.verdict.reasons.join('; ')}`,
  ).toBe(true)

  // ── chunked-scatter: bytes estimate + chunk count (fresh page) ──────────────
  await page.goto('/viz-showcase.html?points=600000', { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 20_000 })
  await page.click('[data-testid="showcase-story-chunked-scatter"]')

  await page.waitForFunction(
    () => {
      const p = (window as unknown as { __VIZ_TEST__?: { chunkPlan?: unknown } }).__VIZ_TEST__?.chunkPlan as
        | { bytesEstimate?: number; chunks?: number }
        | undefined
      return !!p && typeof p.bytesEstimate === 'number' && typeof p.chunks === 'number'
    },
    undefined,
    { timeout: 60_000 },
  )

  const plan = await page.evaluate(
    () =>
      (
        window as unknown as {
          __VIZ_TEST__: {
            chunkPlan: { bytesEstimate: number; chunks: number; pointsPerChunk: number; total: number }
          }
        }
      ).__VIZ_TEST__.chunkPlan,
  )

  expect(plan.bytesEstimate, 'chunk plan should estimate GPU bytes').toBeGreaterThan(0)
  expect(plan.pointsPerChunk, 'chunk plan should report points-per-chunk').toBeGreaterThan(0)
  expect(plan.chunks, '600k under a 250k/layer budget should split into >1 GPU chunk').toBeGreaterThan(1)

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
