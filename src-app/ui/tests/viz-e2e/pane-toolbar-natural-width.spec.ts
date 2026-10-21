import { test, expect } from '@playwright/test'
import { openPerfStory } from './_renderPerf'

// pane-toolbar-natural-width.spec.ts — TEST-F6 (FIX_ROUND-2). THE MEASUREMENT THAT DECIDES LEDGER A's
// SUSPECTED `leftContentRef` RESIDUAL.
//
// DRIFT-1's fix moved the priority+ natural-width learn off the flex-GROWN `leftRef` wrapper (whose
// `scrollWidth` reported the space AVAILABLE — 2072px on a 2304px toolbar — so one item folded at
// every width on every pane) onto the `configGroup` CONTENT node. Ledger A flagged a residual and
// marked it SUSPECTED, explicitly because it could not be settled without a browser:
//
//   "The span is itself `flex min-w-0` inside an `overflow-hidden` flex parent, so at pane widths
//    where its Selects are already flex-SHRINKING (but before `configCollapsed` flips) its
//    `scrollWidth` reports the SHRUNK width, not the natural one — `leftNaturalRef` under-reports,
//    `availFull` over-reports, and fewer items fold than should."
//
// MEASURED, 2 panes, viewports 1900 → 700 (the sweep is in this test):
//
//   vw    p0 scrollWidth / clientWidth   p1 scrollWidth / clientWidth
//   1900  254 / 254 (expanded)           166 / 166 (expanded)
//   1280  254 / 254                      166 / 166
//   1100  254 / 254                      166 / 166
//    820   66 /  66 (collapsed)          166 / 163  ← the box HAS shrunk; scrollWidth has NOT
//    760   66 /  66                       66 /  66 (collapsed)
//
// The mechanism does not hold: `scrollWidth` on an overflowing flex container reports the CONTENT's
// scroll extent, not the shrunk border box, so at vw=820 the group's box is 163px while its
// scrollWidth still reads its natural 166px. The learned figure is width-INVARIANT for the whole
// expanded range, which is exactly what `leftNaturalRef` needs it to be. Recorded as a test rather
// than as a paragraph, because the next round would otherwise re-derive the same suspicion.
test('TEST-F6 the pinned group’s learned natural width does not shrink with the pane', async ({ page }) => {
  test.setTimeout(220_000)
  const measure = async () =>
    page.$$eval('[data-testid^="viz-cell-config-"]', els =>
      els.map(el => ({
        id: el.getAttribute('data-testid') ?? '',
        collapsed: el.getAttribute('data-collapsed') === '1',
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      })),
    )

  const natural = new Map<string, number>()
  let sawShrink = false
  // THE CONSEQUENCE the residual predicts, which IS falsifiable: an under-reported natural width
  // makes `availFull` over-report, fewer items fold, and the right group is clipped by the strip's
  // `overflow-hidden`. Measured directly — no toolbar's content may exceed its own strip.
  let overflowed = ''
  for (const width of [1900, 1280, 1100, 820, 760]) {
    await page.setViewportSize({ width, height: 900 })
    await openPerfStory(page, 'render-perf', { panes: 2, points: 20_000 }, { settleMs: 3500 })
    const rows = await measure()
    expect(rows.length, 'the fixture must render its panes, or every width below measures nothing').toBe(2)
    for (const r of rows) {
      console.log(`[TEST-F6] vw=${width} ${r.id} collapsed=${r.collapsed} scrollWidth=${r.scrollWidth} clientWidth=${r.clientWidth}`)
      if (r.collapsed) continue
      // THE PROPERTY. While the group is expanded, its measured content width is the same at every
      // pane width — a value that fell as the pane narrowed would be the under-report Ledger A
      // suspected, and would make `availFull` over-report and fold too few items.
      const first = natural.get(r.id)
      if (first === undefined) natural.set(r.id, r.scrollWidth)
      else
        expect(
          r.scrollWidth,
          `${r.id}: the learned natural width moved from ${first} to ${r.scrollWidth} at vw=${width} — ` +
            'the pinned group is being measured in its SHRUNK form, which is DRIFT-1 one level down',
        ).toBe(first)
      if (r.clientWidth < r.scrollWidth) sawShrink = true
    }
    const clipped = await page.$$eval('[data-testid^="viz-pane-toolbar-"]', els =>
      els
        .filter(el => el.scrollWidth > el.clientWidth + 1)
        .map(el => `${el.getAttribute('data-testid')} (content ${el.scrollWidth} > strip ${el.clientWidth})`),
    )
    if (clipped.length > 0) overflowed += `vw=${width}: ${clipped.join(', ')}; `
  }
  expect(natural.size, 'at least one pane must have been measured EXPANDED').toBeGreaterThan(0)
  expect(overflowed, `the toolbar strip clipped its own content at: ${overflowed}`).toBe('')
  // THE NON-VACUITY PREMISE, and the reason this sweep goes down to 820: the property is only
  // interesting at a width where the group's BOX has actually shrunk below its content. Without
  // this, a sweep that never reached shrink would assert "constant" over a range where nothing
  // could have changed it.
  expect(
    sawShrink,
    'the sweep never reached a width where the expanded group is squeezed (clientWidth < scrollWidth), ' +
      'so "the natural width did not move" is a claim about a range where it could not have',
  ).toBe(true)
})
