import { test, expect } from '@playwright/test'
import { openStory, expectSomeCanvasRendered, trackErrors, vizTest } from './_helpers'

// VIZ_ISOLATION W2/W3: two independent `<Viz>` grids on one page must be FULLY isolated — a
// selection or grid-edit in instance A must NOT change instance B (and vice-versa), while BOTH stay
// active. Before the per-instance store-factory + context refactor, both grids shared the four
// module-singleton coordination stores, so this spec would fail (A's selection would light up B and
// an addCell would clobber the other). Drives each instance's OWN controller via its buttons and
// reads the namespaced `window.__VIZ_TEST__` slots.
test('two <Viz> instances are isolated — a selection/grid-edit in A does not affect B', async ({ page }) => {
  test.setTimeout(300_000)
  const bag = trackErrors(page)
  await openStory(page, 'viz-multi-instance')

  // Both instances mounted (controllers handed out) and rendering.
  await expect.poll(() => vizTest<boolean>(page, 'multiReady'), { timeout: 30_000 }).toBe(true)
  await expectSomeCanvasRendered(page)

  // Baseline: each grid has exactly its one primary cell, no selection.
  expect(await vizTest<number>(page, 'multiA_cells')).toBe(1)
  expect(await vizTest<number>(page, 'multiB_cells')).toBe(1)
  expect(await vizTest<number>(page, 'multiA_sel')).toBe(0)
  expect(await vizTest<number>(page, 'multiB_sel')).toBe(0)

  // ── selection in A must NOT reach B ─────────────────────────────────────────
  await page.click('[data-testid="multi-a-select"]')
  await expect
    .poll(() => vizTest<number>(page, 'multiA_sel'), {
      message: "A's selection should update A",
      timeout: 10_000,
    })
    .toBe(4)
  // B is untouched — the isolation guarantee (a shared singleton would have fanned to B).
  expect(await vizTest<number>(page, 'multiB_sel'), "B's selection must stay empty").toBe(0)

  // ── an independent selection in B must NOT change A ─────────────────────────
  await page.click('[data-testid="multi-b-select"]')
  await expect
    .poll(() => vizTest<number>(page, 'multiB_sel'), { timeout: 10_000 })
    .toBe(2)
  expect(await vizTest<number>(page, 'multiA_sel'), "A's selection must be unchanged by B").toBe(4)

  // ── a grid-edit (addCell) in B must NOT change A's grid ─────────────────────
  await page.click('[data-testid="multi-b-addcell"]')
  await expect
    .poll(() => vizTest<number>(page, 'multiB_cells'), { timeout: 10_000 })
    .toBe(2)
  expect(await vizTest<number>(page, 'multiA_cells'), "A's grid must be unchanged by B's addCell").toBe(1)

  // ── a grid-edit in A must NOT change B's grid ───────────────────────────────
  await page.click('[data-testid="multi-a-addcell"]')
  await expect
    .poll(() => vizTest<number>(page, 'multiA_cells'), { timeout: 10_000 })
    .toBe(2)
  expect(await vizTest<number>(page, 'multiB_cells'), "B's grid must be unchanged by A's addCell").toBe(2)

  // Both instances still active + rendering.
  await expectSomeCanvasRendered(page)
  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
