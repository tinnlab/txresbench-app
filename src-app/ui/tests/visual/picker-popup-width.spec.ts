/**
 * The OPTION-LIST POPUP WIDTH contract, measured.
 *
 * Reported: "the container/popup that renders the options to choose from select/combo does not
 * have to have the same width with the selection itself, it can be bigger if needed."
 *
 * Three properties, and all three are needed — each of the first two is satisfiable by a bug
 * that the other one does not see:
 *
 *   GROWS    an option wider than the trigger renders in FULL, not clipped to the trigger.
 *   FLOOR    the popup is never NARROWER than its trigger. (A popup that merely sized to its
 *            content would satisfy GROWS and then shrink under a wide control, which reads as
 *            a rendering fault.)
 *   CEILING  the popup never exceeds the space available. Unbounded growth trades a truncated
 *            popup for one that runs off the window — strictly worse, because the part that
 *            left the screen cannot be reached at all.
 *
 * Measured in a BROWSER because the contract is a layout one. Tailwind is not compiled under
 * jsdom and jsdom performs no layout, so a jsdom test could only re-read the class string the
 * component wrote — which passes whatever the class means. This repo has rejected source-text
 * guards twice for the same reason.
 *
 * Run standalone (backend-free; use a dedicated port on a shared box):
 *   GALLERY_PORT=1487 npx playwright test -c playwright.visual.config.ts picker-popup-width
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openGallery } from './_gallery'
import { POPUP_W, openWorkbench, popOutPane } from './_popout'

const SURFACE = 'picker-popup-width'

/** The readable-line cap an option-list popup is bounded by, in px — `32rem`, the same width
 *  this design system already caps a form column at. Stated here as the number the assertions
 *  are anchored to; a change to the kit's constant must move this literal with it. */
const POPUP_MAX_W = 512

/** Sub-pixel tolerance for a box-vs-box comparison. */
const TOL = 1

/** The popup a `data-testid` names. Both kit arms stamp `${testid}-popup` on their popup. */
const popupOf = (page: Page, testid: string): Locator => page.getByTestId(`${testid}-popup`)

/**
 * An element's box, measured AFTER its entrance animation has finished.
 *
 * Every kit popup enters with `zoom-in-95`, i.e. a transform that scales it from 0.95. A
 * `boundingBox()` taken while that is in flight reports ~96% of the real width — enough to make
 * a 520px popup measure 500px and a correct FLOOR assertion fail. Measured this way the number
 * is the settled layout, not a frame of the animation.
 */
async function box(loc: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  await loc.evaluate(async el => {
    await Promise.all(
      el.getAnimations({ subtree: false }).map(a => a.finished.catch(() => undefined)),
    )
  })
  const b = await loc.boundingBox()
  expect(b, 'element has no layout box').not.toBeNull()
  return b!
}

/** Open a picker by clicking its trigger, and return the trigger + popup boxes. */
async function openAndMeasure(
  page: Page,
  testid: string,
  popupTestid = `${testid}-popup`,
): Promise<{
  trigger: { width: number }
  popup: { x: number; width: number }
}> {
  const trigger = page.getByTestId(testid)
  await expect(trigger).toBeVisible()
  const t = await box(trigger)
  await trigger.click()
  const popup = page.getByTestId(popupTestid)
  await expect(popup).toBeVisible()
  const p = await box(popup)
  return { trigger: { width: t.width }, popup: { x: p.x, width: p.width } }
}

/** The `--available-width` Base UI publishes on the positioner that owns `popup` — the space
 *  the popup may occupy IN ITS OWN DOCUMENT. Read off the live element rather than recomputed,
 *  because the whole point of the ceiling is that it is the browser's number, not ours. */
async function availableWidthOf(popup: Locator): Promise<number> {
  return popup.evaluate(el => {
    const positioner = el.parentElement
    const raw = positioner ? getComputedStyle(positioner).getPropertyValue('--available-width') : ''
    return parseFloat(raw)
  })
}

test.describe('option-list popups size to their content, not to their trigger', () => {
  test('an option wider than the trigger renders in full (GROWS)', async ({ page }) => {
    await openGallery(page, { surface: SURFACE })
    const { trigger, popup } = await openAndMeasure(page, 'pw-long-narrow')

    // It grew past the control it dropped out of — the reported defect, directly.
    expect(
      popup.width,
      `popup (${popup.width}px) did not outgrow its ${trigger.width}px trigger`,
    ).toBeGreaterThan(trigger.width + TOL)

    // …and it grew ENOUGH: the longest row is not overflowing its own popup. A popup that
    // grew by ten pixels and still clipped the label would pass the comparison above.
    const row = page.getByTestId('pw-long-narrow-opt-c')
    const fit = await row.evaluate(el => ({
      scroll: el.scrollWidth,
      client: el.clientWidth,
    }))
    expect(
      fit.scroll,
      `the longest option is still clipped (${fit.scroll}px of content in ${fit.client}px)`,
    ).toBeLessThanOrEqual(fit.client + TOL)
  })

  test('the SEARCHABLE arm grows too (GROWS)', async ({ page }) => {
    await openGallery(page, { surface: SURFACE })
    const { trigger, popup } = await openAndMeasure(page, 'pw-long-search')
    expect(
      popup.width,
      `searchable popup (${popup.width}px) did not outgrow its ${trigger.width}px trigger`,
    ).toBeGreaterThan(trigger.width + TOL)

    const row = page.getByTestId('pw-long-search-opt-c')
    const fit = await row.evaluate(el => ({
      scroll: el.scrollWidth,
      client: el.clientWidth,
    }))
    expect(fit.scroll, 'the longest searchable option is still clipped').toBeLessThanOrEqual(
      fit.client + TOL,
    )
  })

  test('the MULTIPLE arm grows too (GROWS)', async ({ page }) => {
    await openGallery(page, { surface: SURFACE })
    const trigger = page.getByTestId('pw-long-multi')
    const t = await box(trigger)
    await trigger.click()
    const popup = page.locator('[data-slot="popover-content"]').first()
    await expect(popup).toBeVisible()
    const p = await box(popup)
    expect(
      p.width,
      `multiple popup (${p.width}px) did not outgrow its ${t.width}px trigger`,
    ).toBeGreaterThan(t.width + TOL)

    const row = page.getByTestId('pw-long-multi-opt-c')
    await expect(row).toBeVisible()
    // The row's own text node is what must be readable; the row is a flex line with a check
    // mark beside it, so the label span is measured rather than the row.
    const fit = await row.evaluate(el => {
      const span = el.querySelector('span')
      return { scroll: span?.scrollWidth ?? 0, client: span?.clientWidth ?? 0 }
    })
    expect(fit.scroll, 'the longest multiple option is still clipped').toBeLessThanOrEqual(
      fit.client + TOL,
    )
  })

  test('a dropdown MENU grows to its widest item (GROWS)', async ({ page }) => {
    await openGallery(page, { surface: SURFACE })
    const trigger = page.getByTestId('pw-long-menu-trigger')
    const t = await box(trigger)
    await trigger.click()
    const menu = page.getByTestId('pw-long-menu')
    await expect(menu).toBeVisible()
    const m = await box(menu)
    expect(m.width, `menu (${m.width}px) did not outgrow its ${t.width}px trigger`).toBeGreaterThan(
      t.width + TOL,
    )

    // …and the long item still reads as ONE LINE. A menu carries an absolute `min-w` floor of
    // its own, so "wider than a 57px trigger" only proves the floor exists. And a menu item
    // WRAPS rather than overflowing, so a pinned menu reports a perfectly contained item that
    // happens to be five lines tall — width comparisons on the item see nothing. Its height
    // against a short sibling's is what actually distinguishes "the menu grew" from "the label
    // was folded up to fit".
    const short = await box(page.getByTestId('pw-long-menu-item-a'))
    const long = await box(page.getByTestId('pw-long-menu-item-b'))
    expect(
      long.height,
      `the long menu item wrapped (${long.height}px tall vs a short item's ${short.height}px) — the menu did not grow to hold it`,
    ).toBeLessThanOrEqual(short.height + TOL)
  })

  test('a popup is never NARROWER than its trigger (FLOOR)', async ({ page }) => {
    await openGallery(page, { surface: SURFACE })

    // A trigger far wider than anything it offers: the popup must hold the trigger's width
    // rather than shrink to three short words.
    const wide = await openAndMeasure(page, 'pw-wide-trigger')
    expect(
      wide.popup.width,
      `popup (${wide.popup.width}px) is narrower than its ${wide.trigger.width}px trigger`,
    ).toBeGreaterThanOrEqual(wide.trigger.width - TOL)

    // …and the same holds when every option already fits: a narrow control whose options are
    // short must still not produce a popup narrower than itself.
    await openGallery(page, { surface: SURFACE })
    const short = await openAndMeasure(page, 'pw-short-narrow')
    expect(
      short.popup.width,
      `popup (${short.popup.width}px) is narrower than its ${short.trigger.width}px trigger`,
    ).toBeGreaterThanOrEqual(short.trigger.width - TOL)
  })

  // Both arms, because they are supposed to be indistinguishable to a reader — and a claim
  // proved on only one of them is exactly how they stop being.
  for (const testid of ['pw-runaway', 'pw-runaway-search'] as const) {
    test(`a runaway label does not make a runaway popup — ${testid} (CEILING)`, async ({
      page,
    }) => {
      await openGallery(page, { surface: SURFACE })
      const { popup } = await openAndMeasure(page, testid)

      expect(
        popup.width,
        `popup (${popup.width}px) grew past the readable cap of ${POPUP_MAX_W}px`,
      ).toBeLessThanOrEqual(POPUP_MAX_W + TOL)

      const viewport = page.viewportSize()!
      expect(popup.x).toBeGreaterThanOrEqual(-TOL)
      expect(
        popup.x + popup.width,
        'the popup runs off the right of the window',
      ).toBeLessThanOrEqual(viewport.width + TOL)

      // The row TRUNCATES at the cap rather than the popup growing to hold it. Both halves are
      // asserted: content that fits would make the cap unfalsifiable here.
      const row = page.getByTestId(`${testid}-opt-b`)
      const fit = await row.evaluate(el => ({
        scroll: el.scrollWidth,
        client: el.clientWidth,
      }))
      expect(fit.scroll, 'the runaway option was not long enough to test the cap').toBeGreaterThan(
        fit.client + TOL,
      )
    })
  }

  for (const testid of ['pw-runaway-truncating', 'pw-runaway-truncating-search'] as const) {
    test(`a caller's own truncation engages at the cap — ${testid}`, async ({ page }) => {
      // The kit imposes NO truncation of its own — a two-line option node must keep both of its
      // lines — so what gives at the cap is the caller's to decide. That decision was previously
      // unenforceable: the row's text node was `shrink-0`, so a `truncate` a call site asked for
      // never engaged and the row simply ran past the popup's clip, mid-word.
      await openGallery(page, { surface: SURFACE })
      const { popup } = await openAndMeasure(page, testid)
      expect(popup.width).toBeLessThanOrEqual(POPUP_MAX_W + TOL)

      const row = page.getByTestId(`${testid}-opt-b`)
      const fit = await row.evaluate(el => {
        const span = el.querySelector<HTMLElement>('span.truncate')
        return {
          rowScroll: el.scrollWidth,
          rowClient: el.clientWidth,
          spanClient: span?.clientWidth ?? -1,
        }
      })
      expect(
        fit.rowScroll,
        `the caller's truncate did not engage — the row holds ${fit.rowScroll}px of content in ${fit.rowClient}px`,
      ).toBeLessThanOrEqual(fit.rowClient + TOL)
      expect(fit.spanClient, 'no truncating span was rendered').toBeGreaterThan(0)
      expect(
        fit.spanClient,
        `the truncating span (${fit.spanClient}px) is wider than the ${popup.width}px popup holding it`,
      ).toBeLessThanOrEqual(popup.width)
    })
  }

  test('the ceiling is the window, not a fixed number (CEILING)', async ({ page }) => {
    // A viewport NARROWER than the readable cap. The cap alone cannot save the popup here —
    // only a bound derived from the space actually available can, which is the property this
    // asserts. (`shift` re-positions a popup that is merely misplaced; it cannot rescue one
    // that is wider than the window.)
    await page.setViewportSize({ width: 360, height: 720 })
    await openGallery(page, { surface: SURFACE })
    const { popup } = await openAndMeasure(page, 'pw-runaway')

    expect(
      popup.width,
      `popup (${popup.width}px) is wider than the 360px window it opened in`,
    ).toBeLessThanOrEqual(360 + TOL)

    const available = await availableWidthOf(popupOf(page, 'pw-runaway'))
    expect(available, 'Base UI published no --available-width to bound against').toBeGreaterThan(0)
    expect(
      popup.width,
      `popup (${popup.width}px) exceeds the ${available}px the browser says is available`,
    ).toBeLessThanOrEqual(available + TOL)

    // The page itself must not gain a horizontal scroll because of it.
    const overflow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }))
    expect(overflow.scroll, 'the popup pushed the document sideways').toBeLessThanOrEqual(
      overflow.client + TOL,
    )
  })
})

// The SECOND document. A popup opened from a popped-out pane is laid out against THAT window,
// so the rule has to reach it and be bounded by it — not by the 1280px opener behind it.
//
// `test.slow()` because it drives a real `window.open` popup through the dock: three real
// navigations before the first measurement, and this file runs fully parallel. It is a budget,
// not a flake-suppressant — every assertion below is a synchronous measurement.
test.slow()
test('the rule reaches a popped-out window and is bounded by it', async ({ page }) => {
  await openWorkbench(page)
  const { popup, paneId } = await popOutPane(page, 'compare')

  const trigger = popup.getByTestId(`workbench-compare-add-${paneId}`)
  await trigger.waitFor({ state: 'visible', timeout: 20_000 })
  const t = await box(trigger)
  await trigger.click({ force: true })

  const list = popup.locator('[data-slot="select-content"]').first()
  await expect(list).toBeVisible({ timeout: 10_000 })
  const p = await box(list)

  // GROWS — in the popped-out window too. Measured on the ROW rather than on the popup: this
  // popup carries a `min-w-36` floor, so a popup merely WIDER than its small trigger proves
  // nothing. Whether the option it holds is legible does.
  const row = popup.locator('[role="option"]').first()
  await expect(row).toBeVisible()
  const fit = await row.evaluate(el => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }))
  expect(
    fit.scroll,
    `the option is clipped in the popped-out window (${fit.scroll}px of content in ${fit.client}px)`,
  ).toBeLessThanOrEqual(fit.client + TOL)

  // FLOOR — still holds over there.
  expect(
    p.width,
    `popup (${p.width}px) is narrower than its ${t.width}px trigger in the popped-out window`,
  ).toBeGreaterThanOrEqual(t.width - TOL)

  // CEILING — against the popped-out window's own viewport, not the opener's.
  const available = await availableWidthOf(list)
  expect(
    available,
    'Base UI published no --available-width in the popped-out window',
  ).toBeGreaterThan(0)
  expect(
    available,
    `--available-width (${available}px) exceeds the ${POPUP_W}px popped-out window — it was measured against the opener`,
  ).toBeLessThanOrEqual(POPUP_W + TOL)
  expect(p.width).toBeLessThanOrEqual(available + TOL)
  expect(p.x + p.width, 'the popup runs off the popped-out window').toBeLessThanOrEqual(
    POPUP_W + TOL,
  )
})
