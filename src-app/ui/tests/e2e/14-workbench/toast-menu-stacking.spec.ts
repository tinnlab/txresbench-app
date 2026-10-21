import { expect, test, type Locator, type Page } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from './_dock'
import { REAL_COMPUTE, REAL_COMPUTE_SKIP } from './_analysis'
import { seedRunnableMatrix } from './_seed'
import { runQcToCompletion } from '../14-declarative-qc/_seed'

// The toast layer must not obstruct an OPEN MENU.
//
// ── The defect ──────────────────────────────────────────────────────────────────────────────
//
// The sticky job ack (`statusBarJobsStore.fireJobToast`, DEC-16) never expires and parks
// bottom-right. The workbench's right-region "+" (add-a-pane) menu opens bottom-right too — the
// trigger sits at the bottom of the right activity strip and the popover is `align="end"` off it —
// so the two overlap. Sonner's layer is `z-index: 999999999`, which outranks every kit overlay
// (the popover positioner is `z-[70]`), so the toast won the overlap and the menu items under it
// were unclickable.
//
// Worse, the obstruction was SELF-SUSTAINING: sonner expands its stack while the pointer is over
// it (`onMouseEnter`/`onMouseMove` → `setExpanded(true)`), so a click aimed at a covered item
// holds the cursor exactly where it keeps the stack expanded, and the obstruction GROWS as you
// approach. Playwright's auto-retry cannot break out of that — measured at 1367 retries across
// 12.5 minutes on an item it reported visible, enabled and stable every single time
// (`tests/e2e/workstore/_artifacts.ts` records the episode and works around it by activating the
// item from the KEYBOARD, which is a harness mitigation, not the fix).
//
// ── Why the assertions are `elementFromPoint` + a real mouse, not a class ────────────────────
//
// "sonner has a huge z-index" and "the popover has z-70" were both true the whole time the bug
// existed. The question a user asks is which element is on top at the coordinates they are
// aiming at, and whether a POINTER gets there — so that is what is asked here. The keyboard path
// is deliberately not used: it is exactly the escape hatch that hid this.
//
// ── The positive control ────────────────────────────────────────────────────────────────────
//
// A menu that overlaps no toast passes trivially. So the spec asserts the overlap FIRST, and
// fails as a void premise if the toast is not actually over the menu.
//
// REAL-compute gated: the only permanent toast in the app is the job ack, and it takes a job that
// genuinely reaches a terminal status to raise one. A dismissible toast would auto-expire mid-test
// and make the assertion a timing accident, which is the property that let this ship.

interface Box {
  x: number
  y: number
  w: number
  h: number
}
const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** An element's CENTRE, in viewport coordinates. Fails LOUDLY when the element has no box —
 *  "there is nothing to aim at" is a different failure from "the click did not land". */
async function centreOf(locator: Locator, what: string): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox()
  expect(box, `${what} must have a box on screen to aim at`).toBeTruthy()
  const b = box as NonNullable<typeof box>
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

/** Open the right region's "+" menu and wait for its items. */
async function openAddPaneMenu(page: Page): Promise<void> {
  const add = page.getByTestId('region-add-pane-right')
  await expect(add).toBeVisible({ timeout: 30_000 })
  await add.click()
  await expect(page.getByTestId('region-add-pane-menu-right')).toBeVisible({ timeout: 20_000 })
}

/** Walk the pointer from the far side of the viewport to `(x, y)` in steps, so it crosses the
 *  toast layer on the way in — the approach is what makes the stack expand under the cursor. */
async function approach(page: Page, x: number, y: number): Promise<void> {
  const size = page.viewportSize() ?? { width: 1280, height: 720 }
  await page.mouse.move(size.width / 2, size.height / 2)
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(
      size.width / 2 + ((x - size.width / 2) * step) / 8,
      size.height / 2 + ((y - size.height / 2) * step) / 8,
    )
  }
}

test.describe('the toast layer sits UNDER an open menu', () => {
  test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)

  test('a permanent job toast does not cover the region "+" menu, even with the pointer on it', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `ToastMenu ${Date.now()}`)
    await seedRunnableMatrix(request, id)
    await openWorkbench(page, id)

    // A REAL completed run → the sticky ack. It never expires, so everything below observes a
    // stable layer rather than a lucky window.
    await runQcToCompletion(page)
    const toast = page.locator('[data-testid^="job-toast-"]').first()
    await expect(
      toast,
      'the completed run must raise its sticky ack — without a toast on screen this spec proves nothing',
    ).toBeVisible({ timeout: 30_000 })

    await openAddPaneMenu(page)

    // Park the pointer over the toast and leave it there: this is the state the bug lives in
    // (sonner expands while hovered), and the state a user reaches by aiming at the menu.
    const toastCentre = await centreOf(toast, 'the sticky job toast')
    await approach(page, toastCentre.x, toastCentre.y)

    const probe = await page.evaluate(() => {
      const box = (el: Element) => {
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height }
      }
      const menu = document.querySelector('[data-testid="region-add-pane-menu-right"]')
      // The TOASTS, not the `<ol>` that holds them: sonner absolutely-positions each toast inside
      // a zero-height list anchored at the viewport's bottom-right corner, so the list's own box
      // is degenerate (measured `h:0`) and overlaps nothing. What paints — and what a pointer
      // hits — is the toast.
      const toasts = Array.from(document.querySelectorAll('[data-sonner-toast]'))
      if (!menu || toasts.length === 0) return { error: 'menu or toast missing' as const }
      const items = Array.from(menu.querySelectorAll('[data-testid^="region-add-pane-item-"]'))
      const describe = (el: Element | null): string => {
        if (!el) return 'nothing'
        const e = el as HTMLElement
        const cs = getComputedStyle(e)
        const own = e.dataset.testid ? ` testid=${e.dataset.testid}` : ''
        const sonner = e.closest('[data-sonner-toast]') ? ' (inside a TOAST)' : ''
        return `<${e.tagName.toLowerCase()}${own}${sonner} z=${cs.zIndex}>`
      }
      // The two ROOT-CONTEXT layers being compared: the toast layer and the menu's.
      //
      // OUTERMOST, not nearest: both surfaces nest z-indexed boxes inside a fixed-position
      // wrapper (each toast `<li>` carries a small per-toast `--z-index`; the popover's content
      // carries `z-50` inside a `z-[70]` positioner), and it is the WRAPPER that competes in the
      // root stacking context — the inner values only order siblings within it. Reading the
      // nearest one compares 1 against 50 and calls the layering correct while the toast layer
      // is painting on top at 999999999. So walk to the root and keep the last non-zero.
      const outermostZ = (el: Element | null): number => {
        let found = 0
        for (let node = el as HTMLElement | null; node; node = node.parentElement) {
          const z = Number.parseInt(getComputedStyle(node).zIndex, 10)
          if (Number.isFinite(z) && z !== 0) found = z
        }
        return found
      }
      return {
        menuBox: box(menu),
        toastBoxes: toasts.map(box),
        toastZ: outermostZ(toasts[0]),
        menuZ: outermostZ(menu),
        items: items.map(o => {
          const r = o.getBoundingClientRect()
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          return {
            testid: (o as HTMLElement).dataset.testid ?? '(none)',
            covered: !(top && (top === o || o.contains(top))),
            topmost: describe(top),
          }
        }),
      }
    })

    expect(probe.error, 'the "+" menu and a toast must both be present').toBeUndefined()
    if ('error' in probe) return

    // POSITIVE CONTROL — the premise. No overlap ⇒ this test proves nothing, and says so.
    expect(
      probe.toastBoxes.some(t => overlaps(t, probe.menuBox)),
      `a toast must OVERLAP the open "+" menu for this test to be meaningful ` +
        `(menu=${JSON.stringify(probe.menuBox)}, toasts=${JSON.stringify(probe.toastBoxes)})`,
    ).toBe(true)

    // The INVARIANT: the notification layer is below the kit's overlay layer.
    expect(
      probe.toastZ,
      `the toast layer (z=${probe.toastZ}) must sit BELOW the open menu's layer (z=${probe.menuZ})`,
    ).toBeLessThan(probe.menuZ)

    // …and the behaviour that invariant exists for.
    expect(probe.items.length, 'the "+" menu must offer pane kinds').toBeGreaterThan(0)
    const covered = probe.items.filter(o => o.covered)
    expect(
      covered,
      'these "+" menu items are painted OVER by something else:\n' +
        covered.map(o => `  ${o.testid} → topmost ${o.topmost}`).join('\n'),
    ).toEqual([])

    // The user journey, driven by a real POINTER (never `focus()` + Enter — that keyboard path is
    // the harness mitigation this spec exists to make unnecessary). The item chosen is the one
    // lowest on screen, i.e. the one deepest inside the toast's footprint.
    const openPanes = () =>
      page.evaluate(
        () =>
          (window as unknown as { __workbenchPanes: { panes: () => string[] } }).__workbenchPanes.panes()
            .length,
      )
    const before = await openPanes()
    const lowest = probe.items[probe.items.length - 1].testid
    const item = page.getByTestId(lowest)
    const itemCentre = await centreOf(item, `the "+" menu item ${lowest}`)
    await approach(page, itemCentre.x, itemCentre.y)
    await item.click({ timeout: 20_000 })

    // The click LANDED — the "+" menu only offers kinds that are NOT open, so choosing one adds a
    // pane. Asserting the pane rather than the menu closing: a click that merely dismissed the
    // popover would satisfy the latter.
    await expect
      .poll(openPanes, {
        timeout: 20_000,
        message: `clicking "${lowest}" with the pointer must OPEN that pane`,
      })
      .toBe(before + 1)
  })
})
