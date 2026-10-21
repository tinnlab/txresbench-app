import { test, expect } from '@playwright/test'
import { openStory, expectSomeCanvasRendered, trackErrors } from './_helpers'

// TEST-74 (covers ITEM-57): WebGL context-loss recovery. Force a GPU context loss on a
// live canvas via the dev hook `window.__VIZ_FORCE_CONTEXT_LOSS__` (installed by
// `useCanvasRecovery` → `installForceContextLoss` in viz-core/core/contextLoss.ts, which
// `DeckScatterCanvas` mounts). Assert the recovery STATE MACHINE runs end-to-end: the badge
// (`viz-context-lost`) appears on loss, then CLEARS on `webglcontextrestored` (lost → false,
// restoreKey bumped) — the observable proof the recovery reducer + listeners work — without
// a page reload.
//
// Software-WebGL limitation (blessed harness = swiftshader): after a forced loss+restore,
// deck.gl throws a one-shot re-init assertion while re-creating the scatter-basic layer on
// the just-restored SOFTWARE context, and the canvas repaints blank. That is a swiftshader
// artifact (a real GPU re-uploads the still-in-JS buffers fine — the reducer/budget logic is
// unit-tested in contextLoss.ts), so we deliberately do NOT assert a non-blank REPAINT after
// restore, and we tolerate ONLY that ONE documented message in the console.
//
// The tolerated string is pinned to the EXACT deck message for THIS story's scatter layer
// (`viz-scatter`) — captured verbatim from the harness — so it swallows only the known
// swiftshader re-init assertion. Any OTHER console error (a different layer, a different
// failure, anything unrelated) does NOT match and still fails the test. (The old broad
// `/deck: initialization of|assertion failed|WebGL context/i` would have masked unrelated
// errors — that is exactly the over-broad allow-list this narrows.)
const SOFTWARE_WEBGL_REINIT =
  /^deck: initialization of ScatterplotLayer\(\{id: 'viz-scatter'\}\): deck\.gl: assertion failed\. Error: deck\.gl: assertion failed\./

test('TEST-74 forced context loss shows recovery badge then clears on restore without reload', async ({ page }) => {
  test.setTimeout(120_000)
  const bag = trackErrors(page)

  await openStory(page, 'scatter-basic')
  await expectSomeCanvasRendered(page)

  // Initial render must be clean BEFORE we intentionally break the context.
  expect(
    bag.errors,
    `clean initial render: ${bag.errors.slice(0, 3).join(' | ')}`,
  ).toHaveLength(0)

  // The dev force-loss hook is wired for scatter-basic (DeckScatterCanvas installs it).
  const hookWired = await page.evaluate(
    () =>
      typeof (window as unknown as { __VIZ_FORCE_CONTEXT_LOSS__?: unknown }).__VIZ_FORCE_CONTEXT_LOSS__ ===
      'function',
  )
  expect(hookWired, '__VIZ_FORCE_CONTEXT_LOSS__ dev hook should be installed on the canvas').toBe(true)

  // Fire the loss with a short restore delay; returns true when WEBGL_lose_context drove it.
  const fired = await page.evaluate(
    () =>
      (window as unknown as { __VIZ_FORCE_CONTEXT_LOSS__: (d?: number) => boolean }).__VIZ_FORCE_CONTEXT_LOSS__(
        250,
      ),
  )
  expect(fired, 'the force-loss hook should drive WEBGL_lose_context').toBe(true)

  // The non-blocking recovery badge appears while the context is down (software WebGL can
  // take several seconds to deliver `webglcontextlost`, hence the generous timeout) …
  await expect(page.locator('[data-testid="viz-context-lost"]')).toBeVisible({ timeout: 30_000 })

  // … then the scheduled restoreContext() fires `webglcontextrestored`, the reducer clears
  // `lost`, and the badge is removed — recovery without a page reload.
  await expect(page.locator('[data-testid="viz-context-lost"]')).toBeHidden({ timeout: 20_000 })

  // No console error beyond the known software-WebGL deck re-init assertion.
  const unexpected = bag.errors.filter(e => !SOFTWARE_WEBGL_REINIT.test(e))
  expect(
    unexpected,
    `only the known swiftshader deck re-init assertion is tolerated: ${unexpected.slice(0, 3).join(' | ')}`,
  ).toHaveLength(0)
})
