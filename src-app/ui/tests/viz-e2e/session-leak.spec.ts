import { test, expect, type Page, type CDPSession } from '@playwright/test'
import { openStory, trackErrors } from './_helpers'

// SESSION LEAK GUARD for the two module-level cross-window sessions added by docking P4/P5:
//   • the DRAG session (`useGripDrag` / `beginGripDrag`) — a grip pointerdown attaches
//     pointermove/pointerup/pointercancel/keydown/blur listeners to EVERY dock window + creates a
//     re-homed ghost DOM node; must fully tear down on every end (drop / Escape / cancel).
//   • the PLACEMENT session (`startGripPlacement`, aim-to-place) — attaches pointermove/click/keydown
//     to every window + its own ghost; must tear down on place / Escape / discard / host-unmount.
// A leak here (a stuck listener set, an orphaned ghost, a latched module session) is exactly what the
// blind audits flagged (F1 ghost-removeChild latch, the placement unmount leak). This drives N
// begin→ABORT cycles of each — the abort path is pure create/destroy with NO layout mutation, so it
// isolates the session lifecycle — and asserts, post-GC, that net window-listeners, orphan ghost nodes,
// open pages, and JS heap all return to baseline (bounded == no leak).
//
// Configurable: SESSION_LEAK_CYCLES (default 12).

const CYCLES = Number(process.env.SESSION_LEAK_CYCLES ?? 12)
const WARMUP = 2
const HEAP_BAND = 1.6 // JS heap is noisy; the tell is the flat TREND, not an absolute
// Net session-listeners must return EXACTLY to baseline (the sessions add + remove in matched pairs);
// a tiny slack absorbs an unrelated one-time app listener that lands mid-measurement.
const LISTENER_SLACK = 2

/** Event types the drag + placement sessions register on `document` / `window`. */
const SESSION_EVENTS = ['pointermove', 'pointerup', 'pointercancel', 'keydown', 'click', 'blur']

/** Instrument add/removeEventListener on the MAIN document + window to count NET session listeners. */
async function installListenerProbe(page: Page): Promise<void> {
  await page.evaluate(events => {
    const w = window as unknown as { __leakNet: () => number }
    const counts: Record<string, number> = {}
    for (const target of [document, window] as EventTarget[]) {
      const add = target.addEventListener.bind(target)
      const remove = target.removeEventListener.bind(target)
      target.addEventListener = (t: string, ...a: unknown[]) => {
        if (events.includes(t)) counts[t] = (counts[t] ?? 0) + 1
        return (add as (...x: unknown[]) => void)(t, ...a)
      }
      target.removeEventListener = (t: string, ...a: unknown[]) => {
        if (events.includes(t)) counts[t] = (counts[t] ?? 0) - 1
        return (remove as (...x: unknown[]) => void)(t, ...a)
      }
    }
    w.__leakNet = () => Object.values(counts).reduce((s, n) => s + n, 0)
  }, SESSION_EVENTS)
}

async function netListeners(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __leakNet: () => number }).__leakNet())
}

async function orphanGhosts(page: Page): Promise<number> {
  // Across the main + every popup: any leftover drag or placement ghost node.
  let n = 0
  for (const p of page.context().pages()) {
    try {
      n += await p.evaluate(
        () =>
          document.querySelectorAll('[data-testid^="viz-cell-dragghost-"]').length +
          document.querySelectorAll('[data-testid="viz-placement-ghost"]').length,
      )
    } catch {
      /* page mid-close */
    }
  }
  return n
}

async function forceGc(cdp: CDPSession): Promise<void> {
  await cdp.send('HeapProfiler.collectGarbage')
  await cdp.send('HeapProfiler.collectGarbage')
}
async function heapUsed(cdp: CDPSession): Promise<number> {
  const r = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number }
  return r.usedSize
}

/** A grip whose center is the top element (a hittable drag source). */
async function pickGrip(page: Page): Promise<{ cx: number; cy: number } | null> {
  const grips = await page.locator('[data-testid^="viz-cell-grip-"]').all()
  for (const grip of grips) {
    const box = await grip.boundingBox()
    if (box) return { cx: box.x + box.width / 2, cy: box.y + box.height / 2 }
  }
  return null
}

/** One DRAG-session cycle: grip pointerdown → move → Escape (abort) → up. No layout change. */
async function dragAbortCycle(page: Page, grip: { cx: number; cy: number }): Promise<void> {
  await page.mouse.move(grip.cx, grip.cy)
  await page.mouse.down()
  await page.mouse.move(grip.cx + 60, grip.cy + 40, { steps: 4 })
  await page.keyboard.press('Escape')
  await page.mouse.up()
}

/** One PLACEMENT-session cycle: add plot (aim engages, a popup is open) → aim → Escape (discard). */
async function placementAbortCycle(page: Page, aimX: number, aimY: number): Promise<void> {
  await page.getByTestId('viz-aim-add').click()
  await expect(page.getByTestId('viz-placement-hint-main')).toBeVisible({ timeout: 10_000 })
  await page.mouse.move(aimX, aimY, { steps: 3 })
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('viz-placement-hint-main')).toHaveCount(0, { timeout: 10_000 })
}

test('sessions do not leak listeners / ghosts / heap across begin→abort cycles (drag + placement)', async ({
  page,
  context,
}) => {
  test.setTimeout(600_000)
  const bag = trackErrors(page)
  const cdp = await context.newCDPSession(page)
  await cdp.send('HeapProfiler.enable')

  await openStory(page, 'aim-to-place')
  await expect(page.getByTestId('viz-cell-view-p-1')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('viz-cell-view-p-2')).toBeVisible()
  await installListenerProbe(page)

  // ── Phase A — DRAG session (single window) ─────────────────────────────────────────────────────
  const grip = await pickGrip(page)
  expect(grip, 'a hittable grip').toBeTruthy()
  if (!grip) return
  for (let i = 0; i < WARMUP; i++) await dragAbortCycle(page, grip)
  await forceGc(cdp)
  const dragBaseNet = await netListeners(page)
  const dragBaseHeap = await heapUsed(cdp)
  for (let i = 0; i < CYCLES; i++) await dragAbortCycle(page, grip)
  await forceGc(cdp)
  const dragNet = await netListeners(page)
  const dragGhosts = await orphanGhosts(page)
  const dragHeap = await heapUsed(cdp)

  expect(dragGhosts, 'no orphan drag ghosts after N drag aborts').toBe(0)
  expect(
    dragNet,
    `net drag-session listeners returned to baseline (was ${dragBaseNet}, now ${dragNet})`,
  ).toBeLessThanOrEqual(dragBaseNet + LISTENER_SLACK)
  expect(await page.context().pages().length, 'no leaked windows in phase A').toBe(1)

  // ── Phase B — PLACEMENT session (a popup open so aim-to-place engages) ──────────────────────────
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.locator('[data-testid="viz-cell-popout-p-1"]').click({ force: true }),
  ])
  await popup.waitForLoadState('domcontentloaded')
  await expect(page.locator('[data-testid^="viz-cell-view-"]')).toHaveCount(1) // p-2 stays in the main
  const p2 = await page.getByTestId('viz-cell-view-p-2').boundingBox()
  expect(p2).toBeTruthy()
  if (!p2) return
  const aimX = p2.x + p2.width / 2
  const aimY = p2.y + p2.height / 2

  for (let i = 0; i < WARMUP; i++) await placementAbortCycle(page, aimX, aimY)
  await forceGc(cdp)
  const placeBaseNet = await netListeners(page)
  for (let i = 0; i < CYCLES; i++) await placementAbortCycle(page, aimX, aimY)
  await forceGc(cdp)
  const placeNet = await netListeners(page)
  const placeGhosts = await orphanGhosts(page)
  const finalHeap = await heapUsed(cdp)

  expect(placeGhosts, 'no orphan placement ghosts after N discards').toBe(0)
  expect(
    placeNet,
    `net placement-session listeners returned to baseline (was ${placeBaseNet}, now ${placeNet})`,
  ).toBeLessThanOrEqual(placeBaseNet + LISTENER_SLACK)
  // The one intentional popup is still open; no discard placed or leaked a window.
  expect(page.context().pages().length, 'phase B kept exactly the one popup').toBe(2)
  // No plot was actually placed (every cycle discarded) — the main still holds only p-2.
  await expect(page.locator('[data-testid^="viz-cell-view-"]')).toHaveCount(1)

  // Heap flat across the whole run (soft; the hard signals are listeners + ghosts + pages).
  const mb = (n: number) => (n / 1_048_576).toFixed(1)
  // eslint-disable-next-line no-console
  console.log(
    `session-leak: dragNet ${dragBaseNet}→${dragNet}, placeNet ${placeBaseNet}→${placeNet}, heap ${mb(
      dragBaseHeap,
    )}→${mb(finalHeap)}MB over ${CYCLES}×2 cycles`,
  )
  expect(finalHeap, 'JS heap not runaway').toBeLessThanOrEqual(Math.ceil(dragBaseHeap * HEAP_BAND))

  const realErrors = bag.errors.filter(
    e => !/ResizeObserver loop|context (lost|restored)|webglcontextlost|deck\.gl: assertion|deck: initialization/i.test(e),
  )
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})
