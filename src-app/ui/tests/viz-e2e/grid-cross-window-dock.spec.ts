import { test, expect, type Page } from '@playwright/test'
import { openStory, trackErrors } from './_helpers'

// Cross-window pane DOCKING (docking P4). A pane is dragged by its chrome grip from ONE window and
// dropped into ANOTHER: main → an existing popup (the popup then holds 2+ panes), and popup → main
// (dragging the popup's LAST pane back closes the now-empty popup). Built on `@ziee/dock`'s cross-
// window `useGripDrag`: at pointerdown it attaches pointer listeners to EVERY open dock window; a
// release in whichever window the pointer is in resolves (via `resolveDrop`) to a MOVE into that
// container.
//
// Playwright can't drive a single POINTER drag across two OS windows, so we drive it the way the drag
// is actually built: a REAL trusted `pointerdown` in the SOURCE window (starting the drag + attaching
// the per-window native listeners), then the cross-window `pointermove`/`pointerup` dispatched onto the
// TARGET window's document — which is exactly where the drag's own listeners live (plain
// `addEventListener`, realm-agnostic), so this exercises the real handler path end-to-end.

/** A cell whose grip's center is actually the top element (a hittable, real drag source). */
async function pickHittableCell(page: Page): Promise<{ id: string; cx: number; cy: number } | null> {
  const grips = await page.locator('[data-testid^="viz-cell-grip-"]').all()
  for (const grip of grips) {
    const tid = await grip.getAttribute('data-testid')
    if (!tid) continue
    const id = tid.replace('viz-cell-grip-', '')
    const box = await grip.boundingBox()
    if (!box) continue
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    // Hittable = the element under the grip's centre really belongs to THAT pane's toolbar. This
    // used to close on the test id of the floating chrome PILL — the surface the occupied-space
    // toolbar replaced, which no longer renders anywhere, so the predicate was false for every
    // grip and this helper returned `null` on every run. The tests that called it had been failing
    // since (measured on origin/main: 4/4 in `grid-tearoff`, 1/2 here). The pill's component is
    // deleted now; this closes on the toolbar that actually ships.
    const ok = await page.evaluate(
      ([x, y, cid]) =>
        !!(document.elementFromPoint(x as number, y as number) as HTMLElement | null)?.closest(
          `[data-testid="viz-pane-toolbar-${cid}"]`,
        ),
      [cx, cy, id] as const,
    )
    if (ok) return { id, cx, cy }
  }
  return null
}

/** Dispatch a synthetic document-level pointer event in `target`'s realm (fires the drag's native
 *  listeners attached to that window's document from the main realm). */
async function docPointer(
  target: Page,
  type: 'pointermove' | 'pointerup',
  clientX: number,
  clientY: number,
) {
  await target.evaluate(
    ({ type, clientX, clientY }) => {
      document.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
          clientX,
          clientY,
          pointerId: 1,
        }),
      )
    },
    { type, clientX, clientY },
  )
}

/** A cross-window grip drag: a REAL pointerdown on `source`'s grip, then a cross-window move+up
 *  dispatched onto `target`'s document at `(tx, ty)` (that window's client coords). */
async function crossWindowDrag(
  source: { page: Page; cx: number; cy: number },
  target: { page: Page; tx: number; ty: number },
) {
  await source.page.mouse.move(source.cx, source.cy)
  await source.page.mouse.down()
  await docPointer(target.page, 'pointermove', target.tx, target.ty)
  await docPointer(target.page, 'pointerup', target.tx, target.ty)
  await source.page.mouse.up()
}

/** Center of a cell view in `page`'s client coords. */
async function cellCenter(page: Page, id: string): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId(`viz-cell-view-${id}`).boundingBox()
  if (!box) throw new Error(`no bounding box for ${id}`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

const realErrorsOf = (errs: string[]) =>
  errs.filter(e => !/context (lost|restored)|webglcontextlost|deck\.gl: assertion|deck: initialization/i.test(e))

/** Pop the first popout-capable cell into a real popup window; return the popped cell id + the popup. */
async function popOutFirst(page: Page, context: import('@playwright/test').BrowserContext) {
  const ids = await page.$$eval('[data-testid^="viz-cell-popout-"]', els =>
    els.map(e => e.getAttribute('data-testid')!.replace('viz-cell-popout-', '')),
  )
  expect(ids.length).toBeGreaterThan(0)
  const poppedId = ids[0]
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.locator(`[data-testid="viz-cell-popout-${poppedId}"]`).click({ force: true }),
  ])
  await popup.waitForLoadState('domcontentloaded')
  await expect(page.locator(`[data-testid="viz-cell-view-${poppedId}"]`)).toHaveCount(0, {
    timeout: 20_000,
  })
  await expect(popup.getByTestId(`viz-cell-view-${poppedId}`)).toBeVisible({ timeout: 20_000 })
  return { poppedId, popup }
}

test('drag a MAIN pane into an existing POPUP → it docks there (2 panes), main reflows', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000)
  const bag = trackErrors(page)
  await openStory(page, 'grid-nonuniform')
  await expect(page.getByTestId('viz-grid-workspace')).toBeVisible()

  // 1. Pop a cell out into its own popup window.
  const { poppedId, popup } = await popOutFirst(page, context)

  // 2. Pick a still-in-main cell as the drag SOURCE (grip on top), and a drop point over the popup's
  //    pane (docks BESIDE it → the popup ends with 2 panes).
  const src = await pickHittableCell(page)
  expect(src, 'a hittable main grip').toBeTruthy()
  if (!src) return
  expect(src.id).not.toBe(poppedId)
  const drop = await cellCenter(popup, poppedId)

  // 3. Cross-window drag: main grip → popup pane.
  await crossWindowDrag({ page, cx: src.cx, cy: src.cy }, { page: popup, tx: drop.x, ty: drop.y })

  // 4. The source pane MOVED out of the main window into the popup; the popup now holds 2 panes.
  await expect(page.locator(`[data-testid="viz-cell-view-${src.id}"]`)).toHaveCount(0, {
    timeout: 15_000,
  })
  await expect(popup.getByTestId(`viz-cell-view-${src.id}`)).toBeVisible({ timeout: 15_000 })
  await expect(popup.locator('[data-testid^="viz-cell-view-"]')).toHaveCount(2, { timeout: 15_000 })
  // The moved-in pane shows the popup's Return affordance (it's a popup-container cell now).
  await expect(popup.getByTestId(`viz-cell-return-${src.id}`)).toBeVisible({ timeout: 15_000 })
  expect(popup.isClosed()).toBe(false)

  const realErrors = realErrorsOf(bag.errors)
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})

test('drag a POPUP\'s last pane back to MAIN → it docks in main and the empty popup closes', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000)
  const bag = trackErrors(page)
  await openStory(page, 'grid-nonuniform')
  await expect(page.getByTestId('viz-grid-workspace')).toBeVisible()

  // 1. Pop a cell out — the popup now holds exactly ONE pane (the popped cell).
  const { poppedId, popup } = await popOutFirst(page, context)
  await expect(popup.locator('[data-testid^="viz-cell-view-"]')).toHaveCount(1)

  // 2. Drag the popup pane's grip (REAL input in the popup) and drop it over a MAIN pane. This is the
  //    LAST pane in the popup → the popup must close after it leaves.
  const gripBox = await popup.getByTestId(`viz-cell-grip-${poppedId}`).boundingBox()
  expect(gripBox).toBeTruthy()
  if (!gripBox) return
  const grip = { cx: gripBox.x + gripBox.width / 2, cy: gripBox.y + gripBox.height / 2 }

  // A main pane still in the grid to drop onto.
  const mainId = await page.$$eval('[data-testid^="viz-cell-view-"]', els =>
    els.map(e => e.getAttribute('data-testid')!.replace('viz-cell-view-', ''))[0],
  )
  expect(mainId).toBeTruthy()
  const drop = await cellCenter(page, mainId)

  await crossWindowDrag(
    { page: popup, cx: grip.cx, cy: grip.cy },
    { page, tx: drop.x, ty: drop.y },
  )

  // 3. The pane docked back into the MAIN grid; the emptied popup auto-closed (last-pane-out).
  await expect(page.locator(`[data-testid="viz-cell-view-${poppedId}"]`)).toHaveCount(1, {
    timeout: 15_000,
  })
  await expect.poll(() => popup.isClosed(), { timeout: 20_000 }).toBe(true)

  const realErrors = realErrorsOf(bag.errors)
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})
