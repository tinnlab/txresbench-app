import { test, expect } from '@playwright/test'
import { openStory, expectSomeCanvasRendered, trackErrors, vizTest } from './_helpers'

// Categorical color-override layer (COLOR_PALETTE_PLAN): the `color-overrides` story renders a
// categorical scatter + a violin (categorical axis) + a Legend, all fed the same override bundle.
// A mode toggle cycles default / palette / byName / labels / autoextend. We assert:
//   • the render is non-blank with no console errors in every mode;
//   • a BY-NAME override reflects in the legend swatch (DOM computed color) AND the resolver hook;
//   • a `categoryLabels` rename reflects in the legend LABEL (DOM) AND the resolver hook (which is
//     what the violin's group AXIS ticks render from — same resolver);
//   • a category count GREATER than the (short) custom palette AUTO-EXTENDS to DISTINCT colors
//     (no two identical), never a silent cycle.

type Hook = {
  mode: string
  swatchHexes: string[]
  displayedLabels: string[]
  distinctSwatchCount: number
  categoryCount: number
}

async function readHook(page: import('@playwright/test').Page): Promise<Hook> {
  return vizTest<Hook>(page, 'colorOverrides')
}

async function setMode(page: import('@playwright/test').Page, mode: string) {
  await page.click(`[data-testid="viz-color-overrides-mode-${mode}"]`)
  await page.waitForTimeout(400)
}

/** Normalize a CSS color string to lowercase hex (rgb(255,0,0) → #ff0000). */
function toHex(css: string): string {
  const m = css.match(/\d+/g)
  if (!m || m.length < 3) return css
  return '#' + m.slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('')
}

test('color overrides — default mode renders non-blank with raw labels + no errors', async ({ page }) => {
  const bag = trackErrors(page)
  await openStory(page, 'color-overrides')
  await expectSomeCanvasRendered(page)

  const hook = await readHook(page)
  expect(hook.categoryCount).toBe(8)
  expect(hook.displayedLabels[0]).toBe('Group 1') // raw name, no override
  // built-in palette + 8 groups ≤ 20 → all distinct
  expect(hook.distinctSwatchCount).toBe(8)
  // legend DOM shows the raw label
  await expect(page.locator('[data-testid="viz-color-overrides-legend-item-0"]')).toContainText('Group 1')

  expect(bag.errors, `console errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})

test('color overrides — by-name override reflects in the legend swatch (DOM + hook)', async ({ page }) => {
  await openStory(page, 'color-overrides')
  await setMode(page, 'byName')

  const hook = await readHook(page)
  // "Group 1" (code 0) mapped to #ff0000 in the story
  expect(hook.swatchHexes[0].toLowerCase()).toBe('#ff0000')

  // DOM: the legend item-0 swatch span carries the overridden background color.
  const swatchBg = await page.evaluate(() => {
    const item = document.querySelector('[data-testid="viz-color-overrides-legend-item-0"]')
    const swatch = item?.querySelector('span') as HTMLElement | null
    return swatch ? getComputedStyle(swatch).backgroundColor : ''
  })
  expect(toHex(swatchBg)).toBe('#ff0000')

  await expectSomeCanvasRendered(page)
})

test('color overrides — categoryLabels renames the group in the legend + axis resolver', async ({ page }) => {
  await openStory(page, 'color-overrides')
  await setMode(page, 'labels')

  const hook = await readHook(page)
  // "Group 1" → "T cells", "Group 3" → "B cells" (the resolver the violin axis ticks use)
  expect(hook.displayedLabels[0]).toBe('T cells')
  expect(hook.displayedLabels[2]).toBe('B cells')
  // untouched group keeps its raw name
  expect(hook.displayedLabels[1]).toBe('Group 2')

  // legend DOM shows the renamed label
  await expect(page.locator('[data-testid="viz-color-overrides-legend-item-0"]')).toContainText('T cells')

  await expectSomeCanvasRendered(page)
})

test('color overrides — a >palette-size category count auto-extends to DISTINCT colors', async ({ page }) => {
  const bag = trackErrors(page)
  await openStory(page, 'color-overrides')
  await setMode(page, 'autoextend')

  const hook = await readHook(page)
  // a 2-color custom palette over 8 groups → 8 DISTINCT resolved colors (no cycle back)
  expect(hook.categoryCount).toBe(8)
  expect(hook.distinctSwatchCount).toBe(8)
  // and no two swatch hexes are identical
  expect(new Set(hook.swatchHexes).size).toBe(hook.swatchHexes.length)

  await expectSomeCanvasRendered(page)
  expect(bag.errors, `console errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
