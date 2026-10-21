import { test, expect } from '@playwright/test'
import { openStory, trackErrors } from './_helpers'

// Proves the multi-continuous binding fix END-TO-END through the DECLARATIVE path.
// The `viz-candlestick-declarative` story drives `VizController.setOption` with a `candlestick`
// series over OhlcFixtureSource with NO per-channel encode, so the shared resolver
// (resolveBinding/makeChartModel — the exact code the fix touched) must bind open/high/low/close to
// FOUR DISTINCT columns. Before the fix, every continuous channel collapsed onto the first continuous
// column (1 distinct). The story exposes the resolved bindings on `__VIZ_TEST__`.
test('declarative candlestick resolves 4 DISTINCT price columns and mounts', async ({
  page,
}) => {
  const bag = trackErrors(page)

  await openStory(page, 'viz-candlestick-declarative')
  await expect(page.getByTestId('viz-candlestick-declarative')).toBeVisible()

  // The shared resolver bound open/high/low/close to 4 distinct columns (was 1 before the fix).
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (window as unknown as { __VIZ_TEST__?: Record<string, unknown> }).__VIZ_TEST__
              ?.candlestickDeclarativeDistinctPriceCols ?? 0,
        ),
      { timeout: 15_000, message: 'declarative candlestick binds 4 distinct price columns' },
    )
    .toBe(4)

  // The resolved bindings carry the four DISTINCT price columns (proves the id-match/ordinal fix,
  // not just a count) + a canvas is mounted. The non-blank RENDER of this story is owned by the
  // every-story sweep (matrix-render TEST-73), which samples with the harness's proven method.
  const bindings = await page.evaluate(
    () =>
      (window as unknown as { __VIZ_TEST__?: Record<string, unknown> }).__VIZ_TEST__
        ?.candlestickDeclarativeBindings as string | undefined,
  )
  const b = JSON.parse(bindings ?? '{}') as Record<string, string>
  const priceCols = [b.open, b.high, b.low, b.close]
  expect(new Set(priceCols).size, `4 distinct price columns, got ${JSON.stringify(b)}`).toBe(4)

  // The resolved bindings reached the render (the story shows the four bound columns) — a
  // deterministic DOM signal. The candlestick VIEW's non-blank canvas render is owned by the
  // every-story sweep (matrix-render TEST-73), which settles the ChartCanvas pane before sampling.
  await expect(page.getByTestId('viz-candlestick-declarative-bindings')).toBeVisible()
  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
