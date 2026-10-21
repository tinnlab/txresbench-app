import { test, expect, type Page } from '@playwright/test'
import { installElementCounter, openPerfStory } from './_renderPerf'

// render-perf-legend.spec.ts — FIX_ROUND-1 / B1. THE PER-CELL MEMO BOUNDARY, MEASURED ON THE PATH
// THE APP ACTUALLY BINDS.
//
// THE MEASUREMENT GAP THIS CLOSES. Every existing counter spec drives `render-perf.story.tsx`, which
// renders `<Viz>` with NO `onRequestExportCell`, so the shell binds the `[]`-stable `openExportCell`;
// and no spec drove the legend / visual-map path at all. Both halves of `requestExportCell`'s
// identity defect were therefore structurally invisible to the gate:
//   * it was `useCallback(…, [onRequestExportCell, perCellLegend, perCellRange, perCellHiddenCodes])`
//     — three WHOLE-RECORD store reads, so ANY cell's legend/range/hidden change re-minted it;
//   * the shipping app passes `onRequestExportCell` as an INLINE ARROW whose setState calls re-render
//     the host (`ui/src/modules/visualization/adapter/VisualizationPage.tsx`), so it churned again.
// It descends as `onExportCell` into `GridPaneCell -> CellView -> PaneToolbar`, i.e. it is a prop AT
// the per-cell memo boundary — so one pane's legend click rebuilt every pane's chrome, defeating
// Split D/0b's isolation on exactly the paths those stores exist to serve.
//
// `#controls-export` is used because it is ALREADY app-shaped: its `<GridWorkspace>` takes an inline
// `onRequestExportCell` arrow with four setState calls, the same shape as the app's. Using it rather
// than adding a mode to `render-perf.story.tsx` keeps the MEASURED fixture (`render-perf`) byte-
// identical — a perf story that changes to accommodate a test stops being a baseline.
//
// The assertion is BOUNDED ON BOTH SIDES. The lower bound is the positive control: the clicked pane
// MUST rebuild its chrome (its legend changed), and without it a page where the click did nothing —
// or one where `CellView`'s display name is unpinned, making `byComponent.CellView` `undefined` —
// would read as a perfect score. The upper bound is the property: no OTHER pane may rebuild.

/** The per-cell hidden-code sets, from the grid's dev seam. The proof that a canvas coordinate click
 *  actually drove per-cell display state rather than landing on empty pixels. */
async function hiddenSets(page: Page): Promise<string> {
  return page.evaluate(() => {
    const h = (window as unknown as { __VIZ_INCELL__?: { hidden?: Record<string, Set<number>> } })
      .__VIZ_INCELL__?.hidden
    return JSON.stringify(Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k, [...v].sort()])))
  })
}

test('TEST-F5 a legend click rebuilds ONLY its own pane chrome (app-shaped export host)', async ({
  page,
}) => {
  test.setTimeout(220_000)
  const counter = await installElementCounter(page, { perCell: true })
  await openPerfStory(page, 'controls-export')
  counter.assertApplied()

  // The two dense panes of the story's Section A. Both must be present, or "no other pane rebuilt"
  // is a claim about an empty set.
  const cellIds = await page.$$eval('[data-viz-cell]', els =>
    els.map(e => e.getAttribute('data-viz-cell') ?? ''),
  )
  expect(cellIds.length, `the fixture must render >= 2 panes to have an "other pane" at all: ${JSON.stringify(cellIds)}`).toBeGreaterThanOrEqual(2)

  const hBefore = await hiddenSets(page)

  // PHASE 1 (UNCOUNTED) — locate a swatch that really toggles. The in-cell legend is a CANVAS
  // (hit-tested internally), so this is a real coordinate press walked down the rows until the
  // per-cell hidden set changes. Doing it BEFORE `begin()` keeps the measured window to exactly ONE
  // gesture: a walk of missed clicks inside the window would swamp the signal with re-renders that
  // are not the gesture under test.
  let target: string | null = null
  let aim: { x: number; y: number } | null = null
  for (const id of cellIds) {
    const canvas = await page.$(`[data-testid="viz-cell-legend-${id}"] [data-testid="viz-incell-legend"]`)
    const cb = canvas && (await canvas.boundingBox())
    if (!cb) continue
    for (let y = 12; y < cb.height - 4 && !target; y += 7) {
      await page.mouse.click(cb.x + 12, cb.y + y)
      await page.waitForTimeout(400)
      if ((await hiddenSets(page)) !== hBefore) {
        target = id
        aim = { x: cb.x + 12, y: cb.y + y }
      }
    }
    if (target) break
  }
  await page.waitForTimeout(2_000)
  const hMid = await hiddenSets(page)

  // PHASE 2 (COUNTED) — ONE click on the swatch just proven to toggle (it un-hides the category it
  // hid, so the drive is the same kind of per-cell display write in both directions).
  await counter.begin()
  if (aim) await page.mouse.click(aim.x, aim.y)
  await page.waitForTimeout(2_500)
  const r = await counter.end()

  expect(target, `a real legend-swatch click must have changed a pane hidden set (${hBefore} unchanged)`).not.toBeNull()
  // The MEASURED click drove per-cell display state too — not just the uncounted walk before it.
  expect(await hiddenSets(page), 'the COUNTED click must have moved the hidden set as well').not.toBe(hMid)
  console.log(
    `[TEST-F5] legend click on ${target} of ${cellIds.length} panes: ` +
      `CellView=${r.byComponent.CellView ?? 0} PaneToolbar=${r.byComponent.PaneToolbar ?? 0} ` +
      `GridPaneCell=${r.byComponent.GridPaneCell ?? 0} total=${r.total}`,
  )

  // POSITIVE CONTROL — the clicked pane's chrome DID rebuild. Also the standing proof that the
  // counter can still SEE these two names: an unpinned `displayName` makes `byComponent.X`
  // `undefined`, which every `?? 0` in this feature reads as a perfect score (FIX_ROUND-1 / C1).
  expect(r.byComponent.CellView ?? 0, 'the clicked pane must rebuild its own chrome — a 0 here means the drive, or the name pin, is broken; it does NOT mean the memo held').toBeGreaterThanOrEqual(1)
  expect(r.byComponent.PaneToolbar ?? 0, 'the clicked pane must rebuild its own toolbar').toBeGreaterThanOrEqual(1)
  expect(r.byComponent.GridPaneCell ?? 0, 'the pane layer must have rendered at least once — the denominator below is its element count').toBeGreaterThanOrEqual(cellIds.length)

  // THE PROPERTY, STATED PER PANE (FIX_ROUND-2). Round 1 stated it as a ratio over TOTALS —
  // `PaneToolbar <= 1.25 x (GridPaneCell / panes)` — because the counter was name-keyed and totals
  // are all a name-keyed counter can see. That ratio is not the property: totals cannot tell one
  // pane rebuilding twice from two panes rebuilding once each, and its denominator (the pane-layer
  // render count) is not a constant of the drive — it FELL from 6 to 2 when the churn was fixed,
  // which made the passing bound tighten below the (now better) measurement. So the counter grew an
  // opt-in per-cell tally (`perCell`, `_renderPerf.ts`) and the claim is now made directly:
  //
  //     for every pane that was NOT clicked: CellView#<id> === 0 and PaneToolbar#<id> === 0.
  //
  // `GridPaneCell#<id>` is deliberately NOT required to be 0 — the pane LAYER re-renders and creates
  // an element for every pane; the question this test exists to answer is whether the memo at that
  // element BAILS, i.e. whether the untouched pane's body ran. `CellView#<id>` is created by
  // `GridPaneCellImpl`'s body, so it IS that answer, and `GridPaneCell#<id> > 0` is the standing
  // proof that the untouched pane was offered to the boundary at all.
  const clicked = target as string
  const others = cellIds.filter(id => id !== clicked)
  console.log(
    `[TEST-F5] per-pane: ` +
      Object.entries(r.byComponent)
        .filter(([k]) => k.includes('#'))
        .sort()
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
  )

  // The clicked pane DID rebuild, per-cell (the positive control, now attributed).
  expect(r.byComponent[`CellView#${clicked}`] ?? 0, 'the clicked pane must rebuild its own chrome').toBeGreaterThanOrEqual(1)

  for (const id of others) {
    // The untouched pane was OFFERED to the memo boundary — otherwise "its body did not run" is a
    // claim about an element that was never created.
    expect(
      r.byComponent[`GridPaneCell#${id}`] ?? 0,
      `pane ${id} was never rendered by the pane layer, so "its chrome did not rebuild" is vacuous`,
    ).toBeGreaterThanOrEqual(1)
    expect(
      r.byComponent[`CellView#${id}`] ?? 0,
      `a legend click on ${clicked} rebuilt the chrome of UNTOUCHED pane ${id}. The per-cell ` +
        'boundary is defeated — either a prop at it changed identity, or (the FIX_ROUND-2 cause) a ' +
        "whole-record store write handed this cell a freshly-allocated but EQUAL value, waking its " +
        'subscription straight through the memo.',
    ).toBe(0)
    expect(r.byComponent[`PaneToolbar#${id}`] ?? 0, `untouched pane ${id} rebuilt its toolbar`).toBe(0)
  }

  // MEASURED, same drive, same fixture, three states of the code:
  //   pre-FIX_ROUND-1 (`requestExportCell` churn):  PaneToolbar=12 CellView=12 GridPaneCell=12 total=2674
  //   post-FIX_ROUND-1:                             PaneToolbar=6  CellView=10 GridPaneCell=12 total=1584
  //   post-FIX_ROUND-2 (whole-record merge):        PaneToolbar=4  CellView=4  GridPaneCell=4  total=978
  // The last line is the untouched pane dropping out of all three tallies AND the shell itself no
  // longer re-rendering, because the preserved record identity never reaches it either.
})
