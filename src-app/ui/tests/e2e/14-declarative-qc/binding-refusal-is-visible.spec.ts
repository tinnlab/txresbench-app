import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import {
  seedQcDataset,
  awaitFilterSurface,
  addCriterion,
  TINY_COUNTS_CELLS as SEEDED_ROWS,
} from './_seed'
import { deckRegionPaintedPixels } from '../../viz-e2e/_pixelsig'

// TEST-20 — the real-stack leg of the binding-refusal change.
//
// ── WHAT THIS ASSERTS, AND WHY IT IS NOT WHAT WAS FIRST ENUMERATED ──────────────────────────
//
// TESTS.md enumerated this as "a canvas pane whose grouping cannot be decided shows the named
// refusal". Writing it established that **that state is not reachable from any shipped view
// spec**: every canvas series in the tree DECLARES its columns —
// `cell-filter.yaml:825` is `encode: { valueKey: "$c.column", groupKey: "$state.groupBy" }`,
// and its bar panes declare `groupKey` likewise — so a required channel never arrives at the
// resolver undecided. `ChartUnbound` is correct, proven, and currently unreachable in
// production; it becomes reachable the day a contributor ships an under-declared series, which
// is exactly the case that previously drew a confident chart from a guess. That reachability
// finding is reported rather than papered over, and the refusal surface itself is proven at
// the tier that CAN reach it — `viz-core/grid/cellRefusalRender.test.tsx` (TEST-3/TEST-5),
// which mounts the real `ChartBody` dispatch.
//
// So this spec asserts the thing the branch actually risks in production, which the component
// tier cannot: **the shipped canvas still paints.** The change replaced the resolver that EVERY
// chart pane render goes through, on the real path
// (`resolveCanvasOption` → `VizController.setOption` → `parseOption` → `resolveBindingChannel`
// → `CellView.ChartBody` → the View → the shared deck). A resolver that refuses too eagerly
// produces exactly one symptom — a pane that renders its chrome and paints nothing — and that
// symptom is invisible to every unit test in the diff. Two such over-refusals were in fact
// shipped into this branch and caught by blind review (`useGridData`'s `effectiveCatalog` and
// its ≥2-layouts refusal, both of which blanked real surfaces); this is the gate that would
// have caught them by running.
//
// ── WHY IT MEASURES THE SHARED DECK, NOT THE PANE'S OWN CANVAS ──────────────────────────────
// `violin` is a SHARED_DECK_CHART_KIND: inside the grid its plot is a VIEW on the ONE workspace
// `<DeckGL>` canvas, a SIBLING of the pane tree and never its descendant. The pane's only own
// canvas is its 16px value-zoom RAIL, so "the pane's first descendant canvas" measures a
// control instead of a chart — the failure mode that let two viz specs sit green for months
// watching a dataZoom rail. `deckRegionPaintedPixels` crops the shared deck to this pane's
// on-screen rect. (Same reasoning, same helper, as `cell-filter-violin-paints.spec.ts`.)

const HOST = '[data-testid="workbench-canvas-host"]'
const BEFORE = '[data-testid="viz-cell-view-before-violin-0"]'
const AFTER = '[data-testid="viz-cell-view-after-violin-0"]'

/** The column the criterion is built on (seeded as the ramp `1000 + 12i` — see `_fixtures.ts`). */
const THRESHOLD_COLUMN = 'nCount'

// SOFTWARE WEBGL, at FILE SCOPE. The grid is deck.gl/WebGL2 and a default headless Chromium has
// no GL context at all — `GridWorkspace` then renders its `viz-grid-nogl` fallback and NOTHING
// paints, which is INDISTINGUISHABLE from the over-refusal this spec exists to detect. Playwright
// rejects `launchOptions` inside a `describe` at COLLECTION time ("forces a new worker"), and
// doing so once zeroed this whole directory's collection for as long as it lasted.
test.use({
  launchOptions: {
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  },
})

test.describe('TEST-20 — the resolver change does not blank the shipped canvas', () => {
  test('a declared canvas still paints its panes, at desktop and at 390px', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Binding Refusal ${Date.now()}`)
    await seedQcDataset(request, id, { annotated: true, nCells: SEEDED_ROWS, expression: true })
    await openWorkbench(page, id)
    await awaitFilterSurface(page)
    await expect(page.getByTestId('workbench-canvas-host')).toBeAttached({ timeout: 20_000 })
    await addCriterion(page, 0, { column: THRESHOLD_COLUMN })
    await expect(page.locator(HOST)).toHaveAttribute('data-viz-framework', 'true', {
      timeout: 20_000,
    })

    // The panes must EXIST first — a paint assertion on an absent pane reads 0 and would be
    // attributed to "the resolver refused" when the pane never opened at all.
    await expect(page.locator(BEFORE)).toBeVisible({ timeout: 20_000 })
    await expect(page.locator(AFTER)).toBeVisible({ timeout: 20_000 })

    // ── THE ASSERTION ───────────────────────────────────────────────────────────────────────
    // Both declared panes PAINT. An over-refusing resolver leaves the pane, its chrome and its
    // title intact and paints nothing, so pixels are the only thing that can tell the two apart.
    const beforePx = await deckRegionPaintedPixels(page, BEFORE)
    const afterPx = await deckRegionPaintedPixels(page, AFTER)
    expect(beforePx, 'the declared "before" violin painted nothing').toBeGreaterThan(0)
    expect(afterPx, 'the declared "after" violin painted nothing').toBeGreaterThan(0)

    // …and NO refusal is shown, because every one of these series declares its columns. This is
    // the negative half: it fails if the resolver started refusing a fully-declared encode.
    await expect(page.getByTestId('viz-chart-unbound')).toHaveCount(0)

    // ── NARROW VIEWPORT ─────────────────────────────────────────────────────────────────────
    // The UI-surface checklist requires a ~390px state, and it is not cosmetic here: the pane
    // rect is what `deckRegionPaintedPixels` crops to, so a pane that collapses to zero width at
    // mobile paints nothing for a reason that has nothing to do with binding — and would read as
    // this branch's defect.
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator(HOST)).toBeVisible()
    const noHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    )
    expect(noHorizontalScroll, 'the page scrolls horizontally at 390px').toBe(true)
    await expect(page.getByTestId('viz-chart-unbound')).toHaveCount(0)
  })
})
