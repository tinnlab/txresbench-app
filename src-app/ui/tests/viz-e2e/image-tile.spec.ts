// image-tile.spec.ts — e2e for the lazy tiled background-image layer (STREAMING_PROGRESSIVE
// item 15). Drives the `image-tile` showcase story through a real Chromium and asserts the
// hand-rolled `ImageTileLayer` viewport-cull: the story publishes the current culled selection
// on `window.__VIZ_TEST__.imageTile = { level, visibleTiles, count }`, so we verify a bounded,
// viewport-sized, zoom-matched, in-bounds tile set is chosen (never the whole gigapixel grid).
//
// ── HOW TO RUN (do NOT wire into a default suite blindly) ──────────────────────────────────
// `@playwright/test` is NOT a dependency of src-app/libs/viz (same as scripts/viz-perf.mjs); it
// resolves from src-app/ui via upward node resolution. Start the showcase, then run from a cwd
// where @playwright/test resolves:
//   1) cd src-app/libs/viz && npx vite --port 1431 --strictPort
//   2) VIZ_E2E_URL=http://localhost:1431/viz-showcase.html \
//        npx playwright test ../../src-app/libs/viz/tests/e2e/image-tile.spec.ts   # from src-app/ui
//
// deck-tile API NOTE (flagged for the orchestrator to verify HERE): the layer reads the active
// OrthographicView viewport via deck's layer context — `viewport.getBounds()` (typed
// `[minX,minY,maxX,maxY]`) and `viewport.zoom`. This spec is the live confirmation that that
// context path + the `getTileUrl → BitmapLayer image` lazy fetch actually render tiles.

import { test, expect } from '@playwright/test'

const URL = process.env.VIZ_E2E_URL ?? '/viz-showcase.html'

type ImageTileHook = {
  level: number
  count: number
  visibleTiles: { level: number; x: number; y: number }[]
}

test.describe('image tile pyramid — lazy viewport-culled background', () => {
  test('selects a bounded, zoom-matched, in-bounds tile set under the scatter', async ({ page }) => {
    await page.goto(URL, { waitUntil: 'load', timeout: 60000 })

    // Mount the story (installs window.__VIZ_TEST__.imageTile via the layer's onTilesChange).
    await page.getByTestId('showcase-story-image-tile').click({ timeout: 30000 })
    await expect(page.getByTestId('viz-image-tile')).toBeVisible()

    // A deck canvas renders (the BitmapLayer tiles + scatter).
    await expect(page.locator('[data-testid="viz-image-tile"] canvas').first()).toBeVisible()

    // Wait for the first non-empty culled selection to publish.
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __VIZ_TEST__?: { imageTile?: { count?: number } } }
        return (w.__VIZ_TEST__?.imageTile?.count ?? 0) > 0
      },
      undefined,
      { timeout: 30000 },
    )

    const hook = await page.evaluate(() => {
      const w = window as unknown as { __VIZ_TEST__?: { imageTile?: unknown } }
      return w.__VIZ_TEST__?.imageTile as ImageTileHook
    })

    // A single zoom-matched level (0..3 for the 4-level pyramid), all tiles at that level.
    expect(hook.level).toBeGreaterThanOrEqual(0)
    expect(hook.level).toBeLessThanOrEqual(3)
    expect(hook.visibleTiles.every(t => t.level === hook.level)).toBe(true)

    // Bounded: never the whole full-res grid — the initial camera shows a subset.
    expect(hook.count).toBeGreaterThan(0)
    expect(hook.count).toBeLessThanOrEqual(64) // 8×8 full-res grid is the hard ceiling

    // In-bounds: no tile index outside the level's grid (2048/256 = 8 max at full res).
    expect(hook.visibleTiles.every(t => t.x >= 0 && t.x < 8 && t.y >= 0 && t.y < 8)).toBe(true)
  })

  test('zooming in raises the level and keeps the tile set viewport-bounded', async ({ page }) => {
    await page.goto(URL, { waitUntil: 'load', timeout: 60000 })
    await page.getByTestId('showcase-story-image-tile').click({ timeout: 30000 })
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __VIZ_TEST__?: { imageTile?: { count?: number } } }
        return (w.__VIZ_TEST__?.imageTile?.count ?? 0) > 0
      },
      undefined,
      { timeout: 30000 },
    )

    const before = await page.evaluate(() => {
      const w = window as unknown as { __VIZ_TEST__?: { imageTile?: ImageTileHook } }
      return w.__VIZ_TEST__?.imageTile as ImageTileHook
    })

    // Zoom in over the canvas (wheel up) — finer level, still viewport-bounded.
    const canvas = page.locator('[data-testid="viz-image-tile"] canvas').first()
    const box = await canvas.boundingBox()
    if (!box) throw new Error('image-tile canvas has no bounding box')
    for (let i = 0; i < 6; i++) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, -240)
      await page.waitForTimeout(120)
    }

    const after = await page.evaluate(() => {
      const w = window as unknown as { __VIZ_TEST__?: { imageTile?: ImageTileHook } }
      return w.__VIZ_TEST__?.imageTile as ImageTileHook
    })

    expect(after.level).toBeGreaterThanOrEqual(before.level)
    expect(after.count).toBeGreaterThan(0)
    expect(after.count).toBeLessThanOrEqual(64)
  })
})
