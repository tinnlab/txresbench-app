import { test, expect } from '@playwright/test'
import {
  expectKitSelected,
  kitSelectOptionValues,
  openStory,
  selectKitOption,
  trackErrors,
  vizTest,
} from './_helpers'

// The DATA-SHAPE-AWARE kind switcher: a `group`+`value` cell (violin) offers ONLY the chart types
// its data can satisfy (violin / box / bar / dotplot / heatmap) — never the dense scatter/image,
// the nested grid, or a candlestick — and switching violin→box PRESERVES the bound value/group
// columns (the data-shape-aware preserve in `setCellKind`).
test('kind switcher offers only compatible types for a group×value cell and preserves bindings on switch', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const bag = trackErrors(page)
  await openStory(page, 'kind-switcher-compat')

  await expect(page.getByTestId('viz-kind-switcher-compat')).toBeVisible()
  await expect(page.getByTestId('viz-grid-workspace')).toBeVisible()

  const KIND_SWITCHER = 'viz-cell-kind-cell-1'
  const kindSelect = page.getByTestId(KIND_SWITCHER)
  await expect(kindSelect).toBeVisible()
  await expectKitSelected(page, KIND_SWITCHER, 'violin')

  // The switcher offers ONLY the compatible (group×value) chart types.
  const options = await kitSelectOptionValues(page, KIND_SWITCHER)
  expect(options.length, 'the switcher offered its options at all').toBeGreaterThan(0)
  for (const t of ['violin', 'box', 'bar', 'dotplot']) {
    expect(options, `compatible type "${t}" is offered`).toContain(t)
  }
  // …and NOT the bindingless (dense / nested) kinds, nor an OHLC-only candlestick.
  for (const t of ['scatter', 'image', 'grid', 'candlestick']) {
    expect(options, `incompatible/cross-family type "${t}" is NOT offered`).not.toContain(t)
  }

  // The seed bound value 'Feature B' + group 'group' (mirrored onto the test hook).
  const before = await vizTest<{ value?: string; group?: string } | null>(page, 'cellBindings')
  expect(before?.value).toBe('Feature B')
  expect(before?.group).toBe('group')

  // Switch violin → box (a COMPATIBLE switch: both declare value + group channels).
  await selectKitOption(page, KIND_SWITCHER, 'box')
  await page.waitForTimeout(1200)
  await expectKitSelected(page, KIND_SWITCHER, 'box')

  // The bound value/group columns are PRESERVED across the switch (not reset to catalog defaults).
  await expect
    .poll(async () => (await vizTest<string | null>(page, 'cellKind')), {
      message: 'the store reflects the box kind',
    })
    .toBe('box')
  const after = await vizTest<{ value?: string; group?: string } | null>(page, 'cellBindings')
  expect(after?.value, 'value column preserved across violin→box').toBe('Feature B')
  expect(after?.group, 'group column preserved across violin→box').toBe('group')

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
