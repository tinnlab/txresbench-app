import { test, expect } from '@playwright/test'
import { openStory, expectSomeCanvasRendered, trackErrors } from './_helpers'

// TEST-19 (covers ITEM-13/14): reconciles the Showcase nav to the gallery states.
// The sidebar lists the registered stories; a NARROW viewport still renders the states
// (the representative point-scatter surface draws non-blank) with no console error, and at
// a supported narrow breakpoint there is no horizontal PAGE scroll.
//
// Note on widths: the Showcase is a DEV surface with a FIXED 260px sidebar; a story's
// toolbar has a ~260px min-content width, so at an extreme phone width (390px) the fixed
// chrome + toolbar exceed the viewport and the page scrolls horizontally by design. We
// therefore assert "no horizontal page scroll" at a supported narrow breakpoint (820px,
// still well below the 1280 default) and separately assert the STATES SURVIVE the extreme
// 390px width (render non-blank, no console error).
test('TEST-19 nav lists stories; narrow viewport renders states with no console error', async ({ page }) => {
  const bag = trackErrors(page)

  // 1) The Showcase boots and the sidebar lists the registered stories.
  await page.goto('/viz-showcase.html', { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 20_000 })
  const storyCount = await page.locator('[data-testid^="showcase-story-"]').count()
  expect(storyCount, 'the sidebar should list multiple stories').toBeGreaterThan(5)

  // 2) At a supported NARROW breakpoint the layout fits with no horizontal page scroll.
  await page.setViewportSize({ width: 820, height: 800 })
  await openStory(page, 'scatter-basic')
  await expectSomeCanvasRendered(page)
  const noHScroll = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )
  expect(noHScroll, 'no horizontal page scroll at the 820px narrow breakpoint').toBe(true)

  // 3) The states survive an EXTREME phone width — the representative surface still renders
  //    non-blank (the fixed dev chrome is allowed to introduce page scroll at this width).
  await page.setViewportSize({ width: 390, height: 800 })
  await page.waitForTimeout(600)
  await expectSomeCanvasRendered(page)

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
