import { test, expect } from '@playwright/test'
import { openStory } from './_helpers'

// The tool-rail testid VOCABULARY guard.
//
// Why this exists: four specs in this directory drove `viz-grid-select-toggle`,
// `viz-grid-sel-tool-rect`, `viz-grid-clear-selection` and `viz-grid-link-zoom` long after
// the viz shell redesign replaced the floating Select / Link-zoom pills with `VizToolRail`.
// The rail derives every testid from its `data-testid` prop (default `viz-tool-rail`) —
// `${testId}-tool-<key>` / `${testId}-sel-<key>` / `${testId}-toggle-link-zoom` — and
// `GridWorkspace` mounts it with NO override, so the live names are the `viz-tool-rail-*`
// ones below. The stale specs failed at their FIRST rail interaction, and one of the four
// controls (`toggle-link-zoom`) is only reached by a spec that fails earlier for an
// unrelated fixture reason — so nothing green covered it. This does.
//
// Deliberately only POSITIVE existence assertions: a `toHaveCount(0)` on a retired testid
// would be exactly the unfalsifiable shape this guard exists to prevent.
test('the grid tool rail mounts its controls under the viz-tool-rail vocabulary', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await openStory(page, 'grid-nonuniform')

  await expect(page.getByTestId('viz-tool-rail')).toBeVisible()
  await expect(page.getByTestId('viz-tool-rail-toggle-link-zoom')).toBeVisible()
  const select = page.getByTestId('viz-tool-rail-tool-select')
  await expect(select).toBeVisible()

  // The selection sub-tools are revealed only while Select is the active rail mode, so
  // this also proves the rail's expand path — not just that the buttons exist.
  await select.click()
  await expect(page.getByTestId('viz-tool-rail-sel-rect')).toBeVisible()
  await expect(page.getByTestId('viz-tool-rail-sel-clear')).toBeVisible()
})
