import { test, expect } from '@playwright/test'
import { canvasNonBlank, openStory, readAttrs, trackErrors, vizTest } from './_helpers'

async function canvasCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('canvas').length)
}

/** The grid's per-pane MODEL facts, read off the attributes each pane publishes
 *  (`ATTR_ID` / `ATTR_KIND`) rather than off a control's `.value` — the kind switcher is a
 *  kit `<Select>` BUTTON, and a button has no `.value`, so the old read returned `undefined`
 *  for every kind and every `.find(r => r.kind === …)` on it silently found nothing.
 *  `id` addresses a pane's TOOLBAR buttons; `testId` addresses its BODY. */
const ATTR_ID = 'data-cell-id'
const ATTR_KIND = 'data-cell-kind'
const VIEW_PREFIX = 'viz-cell-view-'
async function gridPanes(page: import('@playwright/test').Page) {
  const rows = await readAttrs(page, `[${ATTR_KIND}]`, [ATTR_ID, ATTR_KIND, 'data-testid'])
  return rows.map(a => ({
    id: a[ATTR_ID] ?? '',
    testId: (a['data-testid'] ?? '').replace(VIEW_PREFIX, ''),
    kind: a[ATTR_KIND] ?? '',
  }))
}

/** Wheel-zoom over the CENTRE of a specific dense pane (by its measured rect). */
async function wheelOverPane(page: import('@playwright/test').Page, paneId: string, dy: number) {
  const box = await page.locator(`[data-testid="${VIEW_PREFIX}${paneId}"]`).boundingBox()
  expect(box, `pane ${paneId} has a measured rect`).not.toBeNull()
  if (!box) return
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5)
  await page.mouse.wheel(0, dy)
  await page.waitForTimeout(400)
}

// TEST-17 (covers ITEM-12): link-zoom is a real COORDINATION toggle, not two co-mounted
// canvases. With link ON, all dense cells share the Coordination `GRID_SCOPE` view state, so
// a wheel-zoom over ONE dense cell MOVES the shared linked view (⇒ every linked cell moves
// together). With link OFF, a wheel-zoom writes only that cell's own local view state, so the
// shared/coordinated state is UNTOUCHED (cells are independent). We read the shared view state
// through the story's `__VIZ_TEST__.gridSharedZoom` hook (the shared GRID_SCOPE zoom) — the
// exact state every linked cell re-reads — so each assertion fails if coordination were inert
// (ON not linking) or stuck-on (OFF still linking).
test('TEST-17 link-zoom ON moves the shared linked view; OFF leaves it independent', async ({
  page,
}) => {
  // The heterogeneous grid drives a 150k-point deck + several chart canvases under headless
  // swiftshader — the heaviest viz surface — so it needs a wide budget.
  test.setTimeout(180_000)
  const bag = trackErrors(page)
  await openStory(page, 'grid-nonuniform')

  await expect(page.getByTestId('viz-grid-heterogeneous')).toBeVisible()
  await expect(page.getByTestId('viz-grid-workspace')).toBeVisible()

  // A dense scatter cell to drive the wheel over.
  const rows = await gridPanes(page)
  // `wheelOverPane` addresses the pane BODY → the DOM identity.
  const scatterId = rows.find(r => r.kind === 'scatter')?.testId
  expect(scatterId, 'seed layout has a dense scatter cell').toBeTruthy()

  // Baseline structure: shared deck + chart cells.
  const canvasesBefore = await canvasCount(page)
  expect(canvasesBefore, 'shared deck + chart cells').toBeGreaterThan(1)

  // ── link ON ────────────────────────────────────────────────────────────────
  // The in-canvas toggle SEEDS the shared GRID_SCOPE view state on enter, so the hook
  // becomes a real number.
  const linkBtn = page.getByTestId('viz-tool-rail-toggle-link-zoom')
  await expect(linkBtn).toBeVisible()
  // ASSERT the precondition; do NOT adapt to it. The seed below only runs on the ENTER
  // transition (`toggleLinked`), so a grid that arrives already-linked has an unseeded shared
  // scope and every assertion after this point is measuring a state no click produced. The old
  // `if (aria-pressed !== 'true') click()` silently swallowed exactly that: the Showcase's
  // LANDING story used to hydrate `gridLinked: true` into the module-singleton coordination
  // store (see `00-capabilities.story.tsx`), so this grid mounted linked, the click never fired,
  // and the null `gridSharedZoom` read as "the product never seeds" rather than "the test never
  // toggled". Asserting OFF-then-click turns that class of cross-story residue into a red test.
  await expect(linkBtn, 'link-zoom starts OFF (no cross-story coordination residue)').toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await linkBtn.click()
  await expect(linkBtn).toHaveAttribute('aria-pressed', 'true')

  await expect
    .poll(() => vizTest<number | null>(page, 'gridSharedZoom'), {
      message: 'entering link mode seeds the shared GRID_SCOPE view state',
      timeout: 15_000,
    })
    .not.toBeNull()
  const sharedZoomBefore = (await vizTest<number>(page, 'gridSharedZoom')) ?? 0

  // Wheel-zoom (gentle zoom-OUT) over the dense cell. LINKED ⇒ this drives `setGridViewState`
  // → the SHARED scope zoom changes → every linked cell re-reads it (they move together).
  // Zoom OUT (positive deltaY) keeps the fixture points inside the viewport, so the deck
  // stays non-blank (an aggressive zoom-IN can push past the points and blank the frame).
  await wheelOverPane(page, scatterId!, 200)
  await wheelOverPane(page, scatterId!, 200)

  await expect
    .poll(() => vizTest<number>(page, 'gridSharedZoom'), {
      message: 'link ON: wheel-zoom over one cell MOVES the shared linked view (all cells track)',
      timeout: 15_000,
    })
    .not.toBe(sharedZoomBefore)

  // Structure is preserved through the interaction (no cell remount/crash) and the deck
  // still paints (poll to tolerate a transient mid-zoom frame under software WebGL).
  expect(await canvasCount(page), 'chart cells intact through the linked zoom').toBe(canvasesBefore)
  await expect
    .poll(() => canvasNonBlank(page, 0), {
      message: 'shared deck still non-blank after linked zoom',
      timeout: 15_000,
    })
    .toBeGreaterThan(0)

  // ── link OFF ─────────────────────────────────────────────────────────────
  // Turn link OFF; the shared scope value now FREEZES — a subsequent wheel writes only the
  // cell's OWN local view state, never the coordinated GRID_SCOPE state.
  await linkBtn.click()
  await expect(linkBtn).toHaveAttribute('aria-pressed', 'false')
  const sharedZoomFrozen = await vizTest<number>(page, 'gridSharedZoom')

  await wheelOverPane(page, scatterId!, -500)
  await wheelOverPane(page, scatterId!, -300)
  await page.waitForTimeout(600)

  // Independent: the coordinated/shared view state did NOT move on the unlinked wheel.
  expect(
    await vizTest<number>(page, 'gridSharedZoom'),
    'link OFF: an unlinked wheel-zoom does NOT touch the shared/coordinated view (cells independent)',
  ).toBe(sharedZoomFrozen)

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})

// TEST-17c — the LANDING story must not leak coordination state into the next story.
//
// WHY THIS LIVES HERE. The Showcase mounts `stories[0]` at landing, before any spec clicks
// anything, and that story is `00-capabilities` — which drives a real
// `VizController.setOption({ replace: true })`. `setOption` HYDRATES the coordination store,
// including the option's resolved `gridLinked`, which `option/parse.ts` auto-derives as TRUE for
// that option (two `scatter` series over layout `primary` ⇒ ≥2 world2d series in ONE coordinate
// space). While that controller ran on the MODULE-SINGLETON store set, the write was
// process-global and survived the story switch, so every later story in the same page load
// inherited `gridLinked: true` and the capabilities grid's layout.
//
// That is not cosmetic: it silently inverted TEST-17's precondition above. The "turn link ON"
// step used to be a CONDITIONAL click, the toggle already read `aria-pressed=true`, so
// `GridWorkspace.toggleLinked` — the ONLY place that seeds a coordinate space's shared
// GRID_SCOPE view state — never ran. TEST-17 then failed on a null `gridSharedZoom` and read as
// a product defect in the seed. It was not; the seed was never invoked. The fix is
// `00-capabilities.story.tsx` taking its own `createVizStores()` set (what `<Viz>` does for every
// app mount), and this is the regression fence around it.
test('TEST-17c the landing story is store-isolated: it renders its own grid and leaves no coordination residue', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const bag = trackErrors(page)

  // ── 1. the LANDING story renders ITS OWN option-defined layout ──────────────
  // The capabilities story's panes come from its controller's `setOption`, so they only reach the
  // `GridWorkspace` under it if that grid resolves the SAME (isolated) store set — i.e. if the
  // story is wrapped in `<VizStoresProvider>`. Drop the provider and the grid falls back to the
  // singleton's default single-pane layout, which is exactly the silent half-fix this asserts
  // against. Ten kinds, one per built-in plot type.
  await openStory(page, 'capabilities')
  await expect(page.getByTestId('viz-capabilities')).toBeVisible()
  const landingKinds = (await gridPanes(page)).map(r => r.kind).sort()
  expect(landingKinds, 'the landing story renders its own option-defined 10-pane matrix').toEqual([
    'bar', 'box', 'dotplot', 'heatmap', 'histogram', 'image', 'scatter', 'scatter', 'violin', 'volcano',
  ])

  // ── 2. switching stories leaves the next grid's coordination state PRISTINE ──
  // Read through the product's own surface: the tool rail's link-zoom toggle renders straight off
  // `coordination.gridLinked`, so `aria-pressed=false` IS "no residue". A grid that arrives
  // already-linked has an unseeded shared scope, because the seed only runs on the ENTER
  // transition.
  await openStory(page, 'grid-nonuniform')
  await expect(page.getByTestId('viz-grid-workspace')).toBeVisible()
  const linkBtn = page.getByTestId('viz-tool-rail-toggle-link-zoom')
  await expect(linkBtn).toBeVisible()
  await expect(
    linkBtn,
    'link-zoom is OFF on a freshly opened grid (the landing story did not write the shared store)',
  ).toHaveAttribute('aria-pressed', 'false')

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
