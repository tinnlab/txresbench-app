import { test, expect, type Page } from '@playwright/test'
import { openPerfStory } from './_renderPerf'

// grid-selection-tool-switch.spec.ts — FIX_ROUND-1 / DEC-47. LEAVING THE SELECT TOOL ENDS THE
// IN-PROGRESS LASSO GESTURE COMPLETELY, including its committed-slot pointer.
//
// A polygon lasso AUTO-COMMITS from its third vertex on, and `polySlotRef` remembers WHICH slot of
// `committedByCell[cell]` that in-progress polygon occupies so each further vertex REPLACES the same
// region instead of appending a new one. `finishPolygon` and `cancelPolygon` both null it when the
// gesture ends.
//
// Leaving the Select tool also ends the gesture — it drops the draft and clears `activeCellRef` — but
// on origin/main it did NOT null the slot. The slot is a GLOBAL index, not cell-keyed, so it survived
// into the NEXT gesture: the next lasso wrote `areas[slot]`, silently REPLACING an already-committed
// region (and, since the next lasso may be drawn in a DIFFERENT pane, replacing a region of a pane
// that had nothing to do with the abandoned gesture).
//
// This branch routes the leaving-Select cleanup through `clearDrafts()`, which nulls the slot. That
// is a BEHAVIOUR CHANGE inside a mechanical-move split, and DEC-47 records it as an intentional fix
// rather than reverting it. This test is the pin: it is RED on the new semantics being lost.
//
// Observable: `window.__VIZ_PROV__.ops()` records ONE op per COMMITTED REGION per pane, derived from
// the same `areas` list the fold produces — so the op count for the pane IS the region count.

/** The number of committed selection regions the given pane has published. */
async function regionCount(page: Page, pane: string): Promise<number> {
  return page.evaluate(p => {
    const w = window as unknown as { __VIZ_PROV__?: { ops?: () => { pane: string }[] | null } }
    const ops = w.__VIZ_PROV__?.ops?.()
    if (!ops) throw new Error('window.__VIZ_PROV__.ops is absent — the region count cannot be read')
    return ops.filter(o => o.pane === p).length
  }, pane)
}

/** Drop a 3-vertex lasso inside pane `p0`, anchored at the given fractional origin. Three vertices is
 *  the AUTO-COMMIT threshold, so this leaves an in-progress-but-committed polygon and NO Finish. */
async function drawLasso(page: Page, fx: number, fy: number): Promise<void> {
  const box = await page.locator('[data-viz-cell="p0"]').boundingBox()
  if (!box) throw new Error('pane p0 has no bounding box')
  for (const [x, y] of [
    [fx, fy],
    [fx + 0.12, fy],
    [fx + 0.12, fy + 0.12],
  ]) {
    await page.mouse.click(box.x + box.width * x, box.y + box.height * y)
    await page.waitForTimeout(150)
  }
  await page.waitForTimeout(600)
}

test('TEST-F4 leaving Select mid-lasso ends the gesture: the next lasso ADDS a region, never overwrites one', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await openPerfStory(page, 'render-perf', { panes: 2, points: 3_000 })
  await expect(page.locator('[data-viz-cell]')).toHaveCount(2)

  // Select tool → MULTI regions → polygon shape.
  await page.getByTestId('viz-tool-rail-tool-select').click()
  await page.getByTestId('viz-tool-rail-sel-multi').click()
  await expect(page.getByTestId('viz-tool-rail-sel-multi')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('viz-tool-rail-sel-polygon').click()
  await expect(page.getByTestId('viz-tool-rail-sel-polygon')).toHaveAttribute('aria-pressed', 'true')

  // Lasso #1 — auto-committed at the third vertex, deliberately NOT finished.
  await drawLasso(page, 0.2, 0.3)
  expect(await regionCount(page, 'p0'), 'the first lasso must commit exactly one region — without it the rest of this test asserts nothing').toBe(1)

  // Leave Select (rail → Pan) WITHOUT pressing Finish, then come back to Select.
  await page.getByTestId('viz-tool-rail-tool-pan').click()
  await page.waitForTimeout(400)
  expect(await regionCount(page, 'p0'), 'leaving Select must keep the COMMITTED region (only the draft is dropped)').toBe(1)
  await page.getByTestId('viz-tool-rail-tool-select').click()
  await page.waitForTimeout(400)

  // Lasso #2, elsewhere in the same pane. It is a NEW gesture, so in MULTI mode it must ADD.
  await drawLasso(page, 0.55, 0.55)
  const after = await regionCount(page, 'p0')
  console.log(`[TEST-F4] regions after the second lasso: ${after} (1 = the abandoned gesture's slot was reused)`)
  expect(
    after,
    'the second lasso must be a NEW region — reusing the abandoned gesture slot silently overwrites an already-committed one',
  ).toBe(2)
})
