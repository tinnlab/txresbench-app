import { test, expect } from '@playwright/test'
import { openStory, expectSomeCanvasRendered, trackErrors, vizTest } from './_helpers'

// Interactive per-group color + label editing (COLOR_PALETTE_PLAN "interactive editing"): the
// `color-editor` story renders a categorical scatter + a violin (categorical axis) + an INTERACTIVE
// Legend (per-swatch `<input type="color">` + click-to-rename), all wired through the runtime
// `colorOverride.store`. We assert that a legend edit reaches the render + the by-name override:
//   • setting a group's COLOR via the picker changes the legend swatch DOM color AND the resolved
//     point color (the hook exposes `resolveEffectivePalette`, the SAME map the scatter marks use);
//   • renaming a group's LABEL changes the legend label text AND the displayed-label resolver (what
//     the violin group AXIS ticks render from) — untouched groups keep their raw name;
//   • no console errors throughout.
// Export-carry is inherent: the overrides live on the RENDERED legend/marks/axis.

type Hook = {
  swatchHexes: string[]
  displayedLabels: string[]
  distinctSwatchCount: number
  categoryCount: number
}

async function readHook(page: import('@playwright/test').Page): Promise<Hook> {
  return vizTest<Hook>(page, 'colorEditor')
}

/** Normalize a CSS color string to lowercase hex (rgb(255,0,0) → #ff0000). */
function toHex(css: string): string {
  const m = css.match(/\d+/g)
  if (!m || m.length < 3) return css
  return '#' + m.slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('')
}

/** Set a native `<input type="color">` value + fire the events React's onChange listens for. */
async function setColorInput(page: import('@playwright/test').Page, testid: string, hex: string) {
  await page.locator(`[data-testid="${testid}"]`).evaluate((el, value) => {
    const input = el as HTMLInputElement
    // Bypass React's patched `value` setter (it updates React's internal value-tracker, which
    // would make React see "no change" and skip onChange). Setting via the native prototype
    // setter leaves the tracker at the OLD value, so React detects the change and fires onChange —
    // exactly as a real color-picker selection does.
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set
    nativeSetter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, hex)
  await page.waitForTimeout(400)
}

test('color editor — renders non-blank with the built-in palette + raw labels and no errors', async ({ page }) => {
  const bag = trackErrors(page)
  await openStory(page, 'color-editor')
  await expectSomeCanvasRendered(page)

  const hook = await readHook(page)
  expect(hook.categoryCount).toBe(8)
  expect(hook.displayedLabels[0]).toBe('Group 1') // raw name, no edit yet
  expect(hook.distinctSwatchCount).toBe(8) // 8 groups ≤ 20-palette → all distinct

  // the interactive legend renders the color-picker + label editor affordances
  await expect(page.locator('[data-testid="viz-color-editor-legend-color-0"]')).toHaveCount(1)
  await expect(page.locator('[data-testid="viz-color-editor-legend-label-0"]')).toContainText('Group 1')

  expect(bag.errors, `console errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})

test('color editor — picking a swatch color changes the swatch + the resolved point color', async ({ page }) => {
  const bag = trackErrors(page)
  await openStory(page, 'color-editor')
  await expectSomeCanvasRendered(page)

  const before = await readHook(page)
  expect(before.swatchHexes[0].toLowerCase()).not.toBe('#ff0000')

  await setColorInput(page, 'viz-color-editor-legend-color-0', '#ff0000')

  // the resolver hook (== the scatter's point-color source) now reports the edited color for Group 1
  const after = await readHook(page)
  expect(after.swatchHexes[0].toLowerCase()).toBe('#ff0000')
  // stable identity is by-NAME: other groups untouched
  expect(after.swatchHexes[1]).toBe(before.swatchHexes[1])

  // DOM: the color input now carries the new value
  const inputVal = await page
    .locator('[data-testid="viz-color-editor-legend-color-0"]')
    .evaluate(el => (el as HTMLInputElement).value.toLowerCase())
  expect(inputVal).toBe('#ff0000')

  await expectSomeCanvasRendered(page)
  expect(bag.errors, `console errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})

test('color editor — renaming a group updates the legend label + the axis resolver', async ({ page }) => {
  await openStory(page, 'color-editor')
  await expectSomeCanvasRendered(page)

  // click the label to enter edit mode, type a new name, commit with Enter
  await page.click('[data-testid="viz-color-editor-legend-label-0"]')
  const input = page.locator('[data-testid="viz-color-editor-legend-label-input-0"]')
  await expect(input).toBeVisible()
  await input.fill('T cells')
  await input.press('Enter')
  await page.waitForTimeout(300)

  const hook = await readHook(page)
  // "Group 1" (code 0) → "T cells"; the resolver the violin axis ticks read from
  expect(hook.displayedLabels[0]).toBe('T cells')
  // untouched group keeps its raw name
  expect(hook.displayedLabels[1]).toBe('Group 2')

  // legend DOM shows the renamed label
  await expect(page.locator('[data-testid="viz-color-editor-legend-label-0"]')).toContainText('T cells')
})
