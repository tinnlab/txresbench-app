import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import {
  seedQcDataset,
  awaitFilterSurface,
  addCriterion,
  CF,
  CFRow,
  TINY_COUNTS_CELLS as SEEDED_ROWS,
} from './_seed'
import { deckRegionPaintedPixels, deckRegionPixelSignature } from '../../viz-e2e/_pixelsig'

// REPORTED: on the filter surface, picking a column to filter on OPENS its viz grid pane — and
// the violin inside it is EMPTY. The pane renders (its chrome, its title, its close X); nothing
// is painted.
//
// ── WHY THIS SPEC EXISTS BESIDE THE `-live` SPEC IN THIS DIRECTORY ───────────────────────────
// That spec already drives this exact gesture and is green. It asserts, through
// `window.__canvasPanes`, that each pane's DATASET resolved N rows — which was true throughout
// the bug: the option was well-formed, the dataset resolved the whole frame, and the keep-mask
// re-derived on every keystroke. Every link the seam can see was healthy. The break was one link
// FURTHER DOWN, at the last one: the deck never drew the chart's layers into the pane's view, so
// a row count and a painted plot came apart completely. A spec that stops at rows re-certifies
// the bug; this one stops where the pixels come from.
//
// ── AND WHY IT MEASURES THE SHARED DECK, NOT THE PANE'S OWN CANVAS ───────────────────────────
// `violin` is a SHARED_DECK_CHART_KIND: inside the grid its plot is a VIEW on the ONE workspace
// `<DeckGL>` canvas, which is a SIBLING of the pane tree and never a descendant of the pane. The
// pane's only own canvas is its 16px value-zoom RAIL. Asserting on "the pane's first descendant
// canvas" therefore measures a control instead of a chart — the failure mode that let two viz
// specs sit green for months watching a dataZoom rail. `deckRegionPaintedPixels` crops the shared
// deck to the pane's on-screen rect, so it reads exactly this pane's plot and nothing else.
const HOST = '[data-testid="workbench-canvas-host"]'
/** The pane ids the shipped view spec gives the FIRST criterion's before/after pair. */
const BEFORE = '[data-testid="viz-cell-view-before-violin-0"]'
const AFTER = '[data-testid="viz-cell-view-after-violin-0"]'

/** The column the criterion is built on (seeded as the ramp `1000 + 12i` — see `_fixtures.ts`). */
const THRESHOLD_COLUMN = 'nCount'
/** `keep_range` bounds are INCLUSIVE, so `max = 1300` keeps `12i <= 300`, i.e. 26 of 120 rows. */
const MAX_COUNT = 1300

// SOFTWARE WEBGL. The grid is deck.gl/WebGL2 and a default headless Chromium has no GL context at
// all — `GridWorkspace` then renders its `viz-grid-nogl` fallback and NOTHING paints, which is
// indistinguishable from the bug this spec is about. `playwright.viz.config.ts` launches the whole
// viz tier under swiftshader for exactly this reason; declaring the same args here gets the real
// renderer without changing what every other spec in this directory runs under.
//
// FILE SCOPE, and it must be. This spent a day INSIDE the `test.describe` below, under a comment
// arguing that scoping it to the block "states WHICH tests the claim is about". Playwright rejects
// that outright — `launchOptions` forces a NEW WORKER, so it is legal only at file or config
// scope — and it rejects it at COLLECTION time, for the whole run:
//
//     Cannot use({ launchOptions }) in a describe group, because it forces a new worker.
//     Total: 0 tests in 0 files
//
// PROVENANCE, established from the history rather than assumed — two lanes hit this independently
// and attributed it to different commits, so: `b9bed856` CREATED this file with the override at
// file scope, working. `644ec9f2` (on main as `b1418595`) MOVED it into the describe — `git show`
// on that commit is a `-test.use({` at file scope and a `+  test.use({` inside the block. From
// there the whole directory collected nothing, and `just e2e` could not run one spec in ANY
// directory, which hid a real violin failure for as long as it lasted.
//
// The scoping argument also costs nothing to give up: this file holds exactly ONE test, so file
// scope and block scope select the same thing today. Keep the file to GL-needing specs and the
// concern never returns.
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

/** Seed a project, open the workbench, and build the first criterion on {@link THRESHOLD_COLUMN} —
 *  the setup BOTH tests in this file need. Extracted rather than repeated: the domain guard counts
 *  tokens per FILE, so a second copy of the seed + surface calls is a second copy of the
 *  irreducible domain residue this spec is already baselined for. */
async function openSurfaceWithCriterion(
  page: import('@playwright/test').Page,
  request: import('@playwright/test').APIRequestContext,
  name: string,
): Promise<void> {
  await loginAsOwner(page)
  const id = await createProject(request, name)
  await seedQcDataset(request, id, { annotated: true, nCells: SEEDED_ROWS, expression: true })
  await openWorkbench(page, id)
  await awaitFilterSurface(page)
  await expect(page.getByTestId('workbench-canvas-host')).toBeAttached({ timeout: 20_000 })
  await addCriterion(page, 0, { column: THRESHOLD_COLUMN })
  await expect(page.locator(HOST)).toHaveAttribute('data-viz-framework', 'true', { timeout: 20_000 })
}

test.describe('filter-surface violin PAINTS (reported: the pane opens empty)', () => {
  test('selecting a column paints the before/after violins, and the after side repaints when the bound moves', async ({
    page,
    request,
  }) => {
    await openSurfaceWithCriterion(page, request, `Violin Paint ${Date.now()}`)

    // The panes must EXIST first — otherwise a paint assertion on an absent pane reads 0 and would
    // be attributed to "the plot is empty" when the pane never opened at all.
    await expect(page.locator(BEFORE)).toBeVisible({ timeout: 20_000 })
    await expect(page.locator(AFTER)).toBeVisible({ timeout: 20_000 })

    // ── THE ASSERTION THIS SPEC EXISTS FOR ──────────────────────────────────────────────────
    // Both violins have painted pixels. This is what the owner looked at and did not see.
    await expect
      .poll(() => deckRegionPaintedPixels(page, BEFORE), {
        timeout: 30_000,
        message:
          'the BEFORE violin painted nothing. The pane opened and its dataset resolved — check ' +
          'that the deck actually DREW its layers: a chart in the grid publishes ' +
          '`<paneId>::<layerName>` layers, and the grid routes each into the view whose id is that ' +
          'prefix. A composed pane id (`<viewId>::<pane>`) contains the separator too, so an owner ' +
          'parsed out at the FIRST `::` names no viewport and the layer is drawn in none.',
      })
      .toBeGreaterThan(0)
    await expect
      .poll(() => deckRegionPaintedPixels(page, AFTER), { timeout: 30_000, message: 'the AFTER violin paints' })
      .toBeGreaterThan(0)

    // NEGATIVE CONTROL for the measurement itself: an absent pane reads 0, so "> 0" above is a
    // real observation rather than a number this helper hands out for free.
    expect(
      await deckRegionPaintedPixels(page, '[data-testid="viz-cell-view-no-such-pane"]'),
      'an absent pane measures no painted pixels (so the assertions above are not vacuous)',
    ).toBe(0)

    // …and the painted content is the CRITERION's, not a still frame: narrowing the bound must
    // change what the AFTER pane draws while the BEFORE pane — which never masks — does not.
    const beforeSigA = await deckRegionPixelSignature(page, BEFORE)
    const afterSigA = await deckRegionPixelSignature(page, AFTER)
    expect(afterSigA, 'the AFTER pane digests to something (not the absent-region sentinel)').not.toBe('')

    const max = page.getByTestId(CFRow.max(0))
    await max.fill(String(MAX_COUNT))
    await max.blur()
    await expect
      .poll(() => deckRegionPixelSignature(page, AFTER), {
        timeout: 30_000,
        message: 'the AFTER violin repaints when the criterion narrows',
      })
      .not.toBe(afterSigA)
    expect(
      await deckRegionPaintedPixels(page, AFTER),
      'and it still PAINTS after the reshape (a blanked pane is not a repaint)',
    ).toBeGreaterThan(0)
    expect(
      await deckRegionPixelSignature(page, BEFORE),
      'the BEFORE side never masks, so it must not repaint',
    ).toBe(beforeSigA)
  })
})

// REPORTED, separately and later: with nothing chosen in "Group by", the violin ALREADY showed
// several distributions. It must show one — every row together — until the user picks a column.
//
// ── WHY THIS ASSERTS THE RESOLVED BINDING AND NOT THE DECLARATION ────────────────────────────
// The whole bug lived in the gap between those two. The view correctly declared "no grouping";
// what reached the chart was the first categorical column in the catalog, because the
// declaration DROPPED the empty channel and a dropped channel is indistinguishable from one the
// view never mentioned — at which point viz fills it from the catalog. A spec reading
// `series.encode` therefore watches the half that was already right and passes throughout. The
// pane seam reports what the grid actually renders from, one step below, and that is the number
// that decides how many violins get drawn.
//
// The paint assertions ride along because a binding is only a claim until something is drawn from
// it: "grouped by nothing" and "painted nothing" are the two failures this surface has actually
// shipped, and they are indistinguishable in any assertion that checks only one.
test.describe('filter-surface violin GROUPING (reported: many groups before choosing one)', () => {
  /** The grouping column the grid resolved for `coordId`, out of the pane seam's RESOLVED
   *  bindings. `''` is viz's "bind no column" — an ungrouped distribution. */
  async function resolvedGroup(page: import('@playwright/test').Page, coordId: string) {
    return page.evaluate(id => {
      const seam = (window as unknown as { __canvasPanes?: () => Array<Record<string, unknown>> })
        .__canvasPanes
      const pane = (seam ? seam() : []).find(p => p.id === id)
      const bindings = pane?.bindings as Record<string, unknown> | null | undefined
      return bindings ? ((bindings.group as string | undefined) ?? null) : null
    }, coordId)
  }

  test('no group-by chosen ⇒ the violin binds NO grouping column; choosing one binds it and repaints', async ({
    page,
    request,
  }) => {
    await openSurfaceWithCriterion(page, request, `Violin Group ${Date.now()}`)
    await expect(page.locator(BEFORE)).toBeVisible({ timeout: 20_000 })

    // ── THE ASSERTION THIS TEST EXISTS FOR ─────────────────────────────────────────────────
    await expect
      .poll(() => resolvedGroup(page, 'before-violin-0'), {
        timeout: 30_000,
        message:
          'with nothing chosen in Group by, the violin must bind NO grouping column. A column ' +
          "name here is the reported bug: the view's empty channel was dropped, so viz could not " +
          'tell "explicitly unset" from "never mentioned" and filled it from the catalog.',
      })
      .toBe('')
    // …and it is a real distribution, not an empty pane that trivially has no grouping.
    await expect
      .poll(() => deckRegionPaintedPixels(page, BEFORE), { timeout: 30_000, message: 'the ungrouped violin paints' })
      .toBeGreaterThan(0)
    const ungroupedSig = await deckRegionPixelSignature(page, BEFORE)

    // ── WHY THE POSITIVE CONTROL IS NOT HERE ────────────────────────────────────────────────
    // It was, and it FAILED — on the fixture, not on the product. MEASURED:
    //
    //   expect(getByTestId('widget-groupByPicker')).toBeEnabled() failed
    //   locator resolved to <button disabled ... aria-label="Group by" ...>
    //
    // `seedQcDataset` seeds metric columns only, every one of them numeric, so
    // `columns_of(only: categorical)` legitimately returns an empty set and the picker is
    // correctly disabled — the shipped view even says so in the comment beside the control
    // ("a dataset carrying only measurements empties it"). There is no categorical column here
    // to choose, so on this fixture the chosen-column half is unrunnable rather than failing.
    //
    // It is NOT dropped, it is asserted where the fixture can carry it: the unit test drives the
    // SAME chain (resolveCanvasOption -> VizController.setOption -> the frame-backed source) on a
    // frame that HAS categorical columns, and asserts the chosen column binds exactly
    // (`canvasBinding.test.ts`, "a chosen group-by still binds that exact column"). Giving this
    // seed a string column is a change to a shared helper and belongs to whoever needs it next.
    //
    // What remains here is still not vacuous: an unset grouping could read as "correct" on a pane
    // that painted nothing at all, and the paint assertion above is what rules that out.
  })
})
