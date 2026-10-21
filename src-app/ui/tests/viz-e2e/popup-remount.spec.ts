import { test, expect, type Page } from '@playwright/test'
import { openStory, trackErrors } from './_helpers'

// Regression for the audit's dock HIGH-1: PopupContainer used to depend on a fresh inline
// `onWindowClosed` identity, so EVERY host re-render (a store tick, a drag-highlight change) tore down
// the mount + re-portaled → the whole popup workspace REMOUNTED (deck re-init, lost state, and
// bridgeStyles appended duplicate <style>/<link> clones — unbounded head growth). This drives many
// host re-renders (grip-drag ABORT cycles in the main tick the reactive drag state) and asserts the
// popup's workspace element is the SAME node throughout + its head-style count does not grow.

async function pickGrip(page: Page): Promise<{ cx: number; cy: number } | null> {
  const grips = await page.locator('[data-testid^="viz-cell-grip-"]').all()
  for (const grip of grips) {
    const box = await grip.boundingBox()
    if (box) return { cx: box.x + box.width / 2, cy: box.y + box.height / 2 }
  }
  return null
}

test('a popup workspace does NOT remount on host re-renders (deck stays, head-styles bounded)', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  const bag = trackErrors(page)
  await openStory(page, 'aim-to-place')
  await expect(page.getByTestId('viz-cell-view-p-1')).toBeVisible({ timeout: 20_000 })

  // Pop p-1 out into a real popup; p-2 stays in the main (a grip to drag there).
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.locator('[data-testid="viz-cell-popout-p-1"]').click({ force: true }),
  ])
  await popup.waitForLoadState('domcontentloaded')
  await expect(popup.getByTestId('viz-cell-view-p-1')).toBeVisible({ timeout: 20_000 })

  // Tag the popup's workspace node + baseline its <head> style/link count.
  const baseHeads = await popup.evaluate(() => {
    const el = document.querySelector('[data-testid="viz-grid-workspace"]') as HTMLElement | null
    if (el) (el as unknown as { __stable: string }).__stable = 'yes'
    return document.head.querySelectorAll('style,link').length
  })

  // Drive ~8 host re-renders: each grip-drag ABORT in the MAIN ticks the module drag state, which
  // re-renders the main GridWorkspace → ContainerWindows → (pre-fix) the popup would remount.
  const grip = await pickGrip(page)
  expect(grip, 'a main grip').toBeTruthy()
  if (!grip) return
  for (let i = 0; i < 8; i++) {
    await page.mouse.move(grip.cx, grip.cy)
    await page.mouse.down()
    await page.mouse.move(grip.cx + 50, grip.cy + 30, { steps: 3 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
  }

  // The popup workspace is the SAME node (mark survived → never remounted) and no duplicate styles grew.
  const after = await popup.evaluate(() => ({
    marked: (document.querySelector('[data-testid="viz-grid-workspace"]') as unknown as { __stable?: string } | null)
      ?.__stable === 'yes',
    heads: document.head.querySelectorAll('style,link').length,
  }))
  expect(after.marked, 'popup workspace node survived host re-renders (no remount)').toBe(true)
  expect(after.heads, `popup <head> style/link count stayed bounded (was ${baseHeads}, now ${after.heads})`).toBe(
    baseHeads,
  )
  expect(popup.isClosed()).toBe(false)

  const realErrors = bag.errors.filter(
    e => !/context (lost|restored)|webglcontextlost|deck\.gl: assertion|deck: initialization/i.test(e),
  )
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})
