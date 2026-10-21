import { test, expect } from '@playwright/test'
import {
  canvasNonBlank,
  clickPossiblyFolded,
  expectKitSelected,
  openStory,
  readAttrs,
  selectKitOption,
  trackErrors,
} from './_helpers'

/** Count the number of mounted <canvas> elements. */
async function canvasCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('canvas').length)
}

/** Read every leaf pane's on-screen rect (rounded). The deck builds ONE OrthographicView
 *  per pane measured from exactly these elements (GridWorkspace `measure()`), so a change
 *  in a pane's rect IS a change in that cell's deck viewport bounds. */
type PaneRect = { id: string; x: number; y: number; w: number; h: number }
async function paneRects(page: import('@playwright/test').Page): Promise<PaneRect[]> {
  return page.$$eval('[data-testid^="viz-grid-cell-"]', els =>
    els.map(e => {
      const r = e.getBoundingClientRect()
      return {
        id: e.getAttribute('data-testid')!.replace('viz-grid-cell-', ''),
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      }
    }),
  )
}

// TEST-33 (covers ITEM-12/22/23): the heterogeneous GridWorkspace renders MULTIPLE
// canvases (one shared Deck for the dense scatter cells + one ChartCanvas per chart
// cell), exposes a per-cell view-kind <select> on every cell's chrome, survives a
// live kind switch, an add + reset, and a divider drag — with no console error.
/** The grid's per-pane MODEL facts, read off the attributes each pane publishes
 *  (`ATTR_ID` / `ATTR_KIND`) rather than off a control's `.value` — the kind switcher is a
 *  kit `<Select>` BUTTON, and a button has no `.value`, so the old read returned `undefined`
 *  for every kind and every `.find(r => r.kind === …)` on it silently found nothing.
 *  `id` addresses a pane's TOOLBAR buttons; `testId` addresses its BODY. */
const ATTR_ID = 'data-cell-id'
const ATTR_KIND = 'data-cell-kind'
const VIEW_PREFIX = 'viz-cell-view-'
const KIND_PREFIX = 'viz-cell-kind-'
async function gridPanes(page: import('@playwright/test').Page) {
  const rows = await readAttrs(page, `[${ATTR_KIND}]`, [ATTR_ID, ATTR_KIND, 'data-testid'])
  return rows.map(a => ({
    id: a[ATTR_ID] ?? '',
    testId: (a['data-testid'] ?? '').replace(VIEW_PREFIX, ''),
    kind: a[ATTR_KIND] ?? '',
  }))
}

/** Click one of a pane's toolbar actions, unfolding the overflow menu if it is folded there. */
async function clickPaneAction(page: import('@playwright/test').Page, paneId: string, key: string) {
  await clickPossiblyFolded(page, `viz-cell-${key}-${paneId}`, {
    trigger: `viz-cell-overflow-${paneId}`,
    panel: `viz-cell-overflow-panel-${paneId}`,
  })
}

test('TEST-33 heterogeneous grid renders, switches cell kind, adds/resets, drags a divider', async ({
  page,
}) => {
  // The heterogeneous grid drives one 150k-point deck + several chart canvases and the
  // most interactions of any viz spec; deck.gl redraws under headless swiftshader are
  // slow, so this surface needs a wider budget than the 60s default.
  test.setTimeout(150_000)
  const bag = trackErrors(page)
  await openStory(page, 'grid-nonuniform')

  // The story container + the workspace both mount.
  await expect(page.getByTestId('viz-grid-heterogeneous')).toBeVisible()
  await expect(page.getByTestId('viz-grid-workspace')).toBeVisible()

  // MULTIPLE canvases: the shared deck (dense scatter cells) + a ChartCanvas per chart
  // cell (violin / heatmap / box / bar). The seed layout has several, so > 1.
  const initialCanvases = await canvasCount(page)
  expect(initialCanvases, 'shared deck + chart cells → multiple canvases').toBeGreaterThan(1)
  // The shared deck canvas (DOM-first) rendered non-blank content.
  expect(await canvasNonBlank(page, 0), 'shared deck canvas is non-blank').toBeGreaterThan(0)

  // Per-cell kind switchers exist — one per cell. (They are kit `Select` buttons, not
  // native `<select>`s; only their PRESENCE is asserted here.)
  const kindSelects = page.locator(`[data-testid^="${KIND_PREFIX}"]`)
  const kindCount = await kindSelects.count()
  expect(kindCount, 'every cell carries a view-kind switcher').toBeGreaterThan(1)

  // Drag a pane divider (react-resizable-panels Separator → role="separator") on the
  // pristine seed layout. A GENTLE drag (no pane collapses) so the stable seed charts
  // are never redrawn at a degenerate size. The layout must survive: the workspace
  // stays mounted and the canvases keep rendering.
  const separator = page.locator('[role="separator"]').first()
  await expect(separator).toBeVisible()
  const orientation = await separator.getAttribute('aria-orientation')
  const sepBox = await separator.boundingBox()
  expect(sepBox).not.toBeNull()
  // Capture the pane rects (= deck viewport bounds) BEFORE the drag so we can prove the
  // viewports TRACK the resize, not merely that N canvases survive.
  const rectsBefore = await paneRects(page)
  expect(rectsBefore.length, 'panes are measured before the drag').toBeGreaterThan(1)
  const draggedAxis = orientation === 'horizontal' ? 'y' : 'x'
  if (sepBox) {
    const cx = sepBox.x + sepBox.width / 2
    const cy = sepBox.y + sepBox.height / 2
    // A 'vertical' separator sits between side-by-side panes → drag along X; a
    // 'horizontal' one sits between stacked panes → drag along Y. Small delta = gentle.
    const dx = orientation === 'horizontal' ? 0 : 28
    const dy = orientation === 'horizontal' ? 28 : 0
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + dx, cy + dy, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(700)
  }
  await expect(page.getByTestId('viz-grid-workspace')).toBeVisible()
  expect(await canvasCount(page), 'canvases survive the divider drag').toBeGreaterThan(1)

  // The REAL downstream effect: dragging the divider MOVED a pane boundary, so at least one
  // cell's rect — and therefore its deck OrthographicView bounds — changed along the drag
  // axis. This fails if the divider drag were cosmetic (viewports NOT tracking the resize).
  const rectsAfter = await paneRects(page)
  const movedAlongAxis = rectsAfter.some(a => {
    const b = rectsBefore.find(r => r.id === a.id)
    if (!b) return false
    // The boundary shift shows up as a changed position and/or size on the drag axis.
    return draggedAxis === 'x'
      ? Math.abs(a.x - b.x) > 6 || Math.abs(a.w - b.w) > 6
      : Math.abs(a.y - b.y) > 6 || Math.abs(a.h - b.h) > 6
  })
  expect(
    movedAlongAxis,
    `a pane boundary moved along ${draggedAxis} → deck viewports tracked the divider drag`,
  ).toBe(true)

  // Add a pane, then remove that same pane — neither grid mutation should crash. We add
  // by SPLITTING a dense (scatter) pane via its ⊞ action: splitLeaf halves that
  // leaf's own space in place, so sibling CHART panes keep their exact pixel size and are
  // never remounted. (The top-toolbar "Add pane" splits the LAST leaf — a chart — whose
  // ChartCanvas keys its DeckGL by size and re-inits its layers on remount, which the
  // headless-swiftshader deck backend cannot do; a dense split is the assert-free path.)
  const panes = () => gridPanes(page)
  const rowsBefore = await panes()
  const densePane = rowsBefore.find(r => r.kind === 'scatter')
  expect(densePane, 'the seed has a dense scatter pane to split').toBeTruthy()
  await clickPaneAction(page, densePane!.id, 'split')
  await page.waitForTimeout(700)
  const rowsAfter = await panes()
  expect(rowsAfter.length, 'grid survives Add pane (dense split)').toBe(rowsBefore.length + 1)
  expect(await canvasCount(page), 'canvases persist after Add pane').toBeGreaterThan(0)

  const newId = rowsAfter.find(r => !rowsBefore.some(b => b.id === r.id))?.id
  expect(newId, 'the newly-added pane id is discoverable').toBeTruthy()
  // The split makes a narrow (~160px) pane: its remove button may be FOLDED into the
  // pane's overflow menu, and even inline its chrome pill overlaps the neighbour's so a
  // POINTER click is intercepted. `clickPaneAction` handles both — it unfolds if needed
  // and dispatches the click straight at the button, exercising the real remove handler.
  await clickPaneAction(page, newId!, 'remove')
  await page.waitForTimeout(700)
  await expect(page.getByTestId('viz-grid-heterogeneous')).toBeVisible()
  await expect(page.locator(`[data-testid^="${KIND_PREFIX}"]`)).toHaveCount(rowsBefore.length)
  expect(await canvasCount(page), 'grid survives pane removal').toBeGreaterThan(0)

  // Switch one pane's kind LAST — at its full rect, with no subsequent resize — and
  // assert it re-renders (value updates, canvases still present). Switching the scatter
  // anchor → violin exercises the dense→chart transition end-to-end.
  const firstPaneId = (await panes())[0].id
  const firstKindTestId = `${KIND_PREFIX}${firstPaneId}`
  const current = (await panes())[0].kind
  const target = current === 'violin' ? 'box' : 'violin'
  await selectKitOption(page, firstKindTestId, target)
  await page.waitForTimeout(1000)
  await expectKitSelected(page, firstKindTestId, target)
  await expect
    .poll(
      async () => {
        const n = await canvasCount(page)
        for (let i = 0; i < n; i++) if ((await canvasNonBlank(page, i)) > 0) return true
        return false
      },
      { message: 'grid still renders after the kind switch' },
    )
    .toBe(true)

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
