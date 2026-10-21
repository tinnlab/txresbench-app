import { test, expect } from '@playwright/test'
import { canvasNonBlank, trackErrors } from './_helpers'

// TEST-84 (covers ITEM-66): the Showcase catalog is the visual-regression baseline surface.
// Assert `viz-showcase.html` boots, the category sidebar lists its sections, then select a
// representative story from EACH category and assert its live demo renders (non-blank
// canvas) with zero console error across light + dark. Finally assert the `__VIZ_TEST__`
// test-hook inspector is present (the mechanism the render harness + e2e read state from).
//
// The whole showcase is loaded with `?points=50000` so the Scale/perf category's
// representative (the 1M-default `chunked-scatter`) renders quickly under the blessed
// software-WebGL harness; the param only affects the two Scale/perf stories. Each theme runs
// on a fresh page so swiftshader's live-context budget resets between passes.
const SHOWCASE_URL = '/viz-showcase.html?points=50000'

test('TEST-84 showcase boots; a representative story per category renders in light + dark', async ({ page }) => {
  test.setTimeout(150_000)
  const bag = trackErrors(page)

  await page.goto(SHOWCASE_URL, { waitUntil: 'networkidle' })
  await expect(page).toHaveTitle(/Visualization Showcase/i)
  await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 20_000 })

  // Enumerate category groups + a representative (first) story of each. A group is a
  // sidebar child that actually contains story buttons (excludes the title/toggle row);
  // its first child <div> is the uppercase category header.
  const cats = await page.evaluate(() => {
    // Stories that intentionally render an error state (not a healthy canvas) — never pick one
    // as a category's representative for the non-blank / no-console-error assertion.
    const EXPECTED_ERROR = new Set(['viz-load-error'])
    const nav = document.querySelector('[data-testid="showcase-sidebar"]')
    if (!nav) return [] as { category: string; storyId: string }[]
    return Array.from(nav.children)
      .filter(g => g.querySelector('[data-testid^="showcase-story-"]'))
      .map(g => {
        const header = g.querySelector('div')
        // first HEALTHY story button (skip intentional-error stories)
        const btn = Array.from(g.querySelectorAll('[data-testid^="showcase-story-"]')).find(
          b => !EXPECTED_ERROR.has((b.getAttribute('data-testid') ?? '').replace('showcase-story-', '')),
        )
        return {
          category: (header?.textContent ?? '').trim(),
          storyId: (btn?.getAttribute('data-testid') ?? '').replace('showcase-story-', ''),
        }
      })
      .filter(c => c.storyId !== '') // drop a category whose only story is an intentional-error one
  })

  expect(cats.length, 'the sidebar should list multiple category sections').toBeGreaterThanOrEqual(4)
  for (const c of cats) {
    expect(c.category, 'each section should have a category header').not.toBe('')
    expect(c.storyId, `category ${c.category} should have a representative story`).not.toBe('')
  }

  for (const themeName of ['light', 'dark'] as const) {
    // Fresh page per theme so the software-WebGL context budget resets.
    await page.goto(SHOWCASE_URL, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 20_000 })
    if (themeName === 'dark') {
      await page.click('[data-testid="showcase-theme-toggle"]')
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.vizTheme))
        .toBe('dark')
    }

    for (const { category, storyId } of cats) {
      const before = bag.errors.length
      await page.click(`[data-testid="showcase-story-${storyId}"]`, { timeout: 20_000 })
      await page.waitForTimeout(1300)

      const nb = await canvasNonBlank(page, 0)
      expect(nb, `[${themeName}] ${category}/${storyId} live demo should render non-blank`).toBeGreaterThan(0)

      const newErrors = bag.errors.slice(before)
      expect(
        newErrors,
        `[${themeName}] ${category}/${storyId} no console/page errors: ${newErrors.slice(0, 3).join(' | ')}`,
      ).toHaveLength(0)
    }
  }

  // The test-hook inspector is present: select a story that publishes it and assert the
  // `__VIZ_TEST__` bag is an object (the surface the render harness / e2e inspect state via).
  await page.click('[data-testid="showcase-story-chunked-scatter"]', { timeout: 20_000 })
  await page.waitForFunction(
    () => typeof (window as unknown as { __VIZ_TEST__?: unknown }).__VIZ_TEST__ === 'object',
    undefined,
    { timeout: 40_000 },
  )
  const hasHook = await page.evaluate(
    () => (window as unknown as { __VIZ_TEST__?: unknown }).__VIZ_TEST__ != null,
  )
  expect(hasHook, '__VIZ_TEST__ test-hook inspector should be present').toBe(true)
})
