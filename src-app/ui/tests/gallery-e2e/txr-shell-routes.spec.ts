import { expect, test } from '@playwright/test'

/**
 * TEST-AS-2 (ITEM-2 half) — the app-shell route byte of the audit's
 * section 4, driven over the shell-wrapped route surfaces
 * (`txr-shell-route-*`): each of the six part-1 pages INSIDE the real
 * shell at 1440x900, 1280x720 and 1024x768.
 *
 * Measured legs (per route × size):
 *  · the document is in the shell-mode rules (the overflow-hidden byte the
 *    AppShell puts on <html>; the gallery host's own chrome sits above the
 *    frame, so the raw document scrollHeight is ITEM-4's real-app leg);
 *  · the page's frame fills the shell's routed area — `#txr-main` has
 *    nothing to scroll (the intermediate body scroller is unused by the
 *    pages, DEC-3's "the pages own their regions");
 *  · ONE OR TWO scroll regions (the audit's "no more than two");
 *  · a region scrolls, the 56 px header does NOT move, and the keyboard
 *    (Tab → region, PageDown) scrolls that region;
 *  · the sticky bytes: the E list's section headers stick to the region's
 *    top, the F method table's thead sticks, the C/N preview tables are
 *    bounded boxes with a sticky header;
 *  · the action bars stay in the frame (the E run bar and the F bottom bar
 *    never leave the page while the region scrolls — the audit's "the run
 *    bar is visible at all times" leg, asserted positionally since the
 *    gallery host clips the frame's bottom).
 *
 * The 390x844 flow-mode leg: the document scrolls, the header is sticky
 * and ONE 56 px row (the audit's flow byte).
 *
 * The full 14-route matrix with long-table fixtures (95 / 300 rows), the
 * Back-scroll-restore leg and the real desktop screenshots are ITEM-4's
 * spec (TEST-AS-3); this spec owns the six pages of ITEM-2.
 */
const GALLERY = '/gallery.html?surface='

test.setTimeout(900_000)

/** The story's settle (the seeded store/cassette commit, the shared bound). */
const SETTLE = 2600

const SURFACES = [
  { slug: 'txr-shell-route-start', label: 'Start', regions: 1 },
  { slug: 'txr-shell-route-study', label: 'Study', regions: 2 },
  { slug: 'txr-shell-route-files', label: 'Files', regions: 1 },
  { slug: 'txr-shell-route-predict-files', label: 'Predict files', regions: 1 },
  { slug: 'txr-shell-route-choose-methods', label: 'Choose methods', regions: 1 },
  { slug: 'txr-shell-route-running', label: 'Running', regions: 1 },
] as const

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
] as const

/** Give the gallery frame the test viewport's height (the default frame is
 *  720 px — bounded — so the shell's height chain is definite; resizing the
 *  frame to the size under test makes the measured layout the real one). */
async function sizeFrame(page: import('@playwright/test').Page, height: number) {
  await page.evaluate(h => {
    const frame = document.querySelector<HTMLElement>('[data-gallery-frame]')
    if (!frame) throw new Error('no gallery frame')
    frame.style.height = `${h}px`
  }, height)
  await page.waitForTimeout(200)
}

/** The routed area's scroll facts (the page-fits byte). */
async function routedArea(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('#txr-main')
    if (main === null) return null
    return { scrollHeight: main.scrollHeight, clientHeight: main.clientHeight }
  })
}

/** Set a region's scrollTop; the browser fires the scroll event. */
async function scrollRegionTo(
  page: import('@playwright/test').Page,
  label: string,
  top: number,
) {
  await page.evaluate(
    ({ label, top }) => {
      const el = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
      if (!el) throw new Error(`no region labelled ${label}`)
      el.scrollTop = top
    },
    { label, top },
  )
  await page.waitForTimeout(150)
}

/** The scrollable regions' labels ES-capable in the DOM. */
function regionLabels(page: import('@playwright/test').Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="region"]')).map(
      el => el.getAttribute('aria-label') ?? '',
    ),
  )
}

for (const route of SURFACES) {
  test(`route ${route.label}: the shell byte, the page fits the routed area, 1-2 regions, the header never moves`, async ({
    page,
  }) => {
    for (const size of SIZES) {
      await page.setViewportSize(size)
      await page.goto(`${GALLERY}${route.slug}`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(SETTLE)
      await sizeFrame(page, size.height)

      // Shell mode: the document rules are the fixed ones (DEC-1).
      const shell = await page.evaluate(() => ({
        shellClass: document.documentElement.classList.contains('txr-shell-mode-shell'),
        overflow: getComputedStyle(document.documentElement).overflow,
      }))
      expect(shell.shellClass, `${route.label}@${size.width}x${size.height} shell class`).toBe(true)
      expect(shell.overflow, `${route.label}@${size.width}x${size.height} doc overflow`).toBe('hidden')

      // The page fills the routed area — the body scroller is unused.
      const routed = await routedArea(page)
      expect(routed, `${route.label} routed area`).not.toBeNull()
      expect(
        routed!.scrollHeight,
        `${route.label}@${size.width}x${size.height} routed-area overflow px`,
      ).toBeLessThanOrEqual(routed!.clientHeight + 1)

      // The region count is the route's (1-2).
      const regions = await regionLabels(page)
      expect(
        regions.length,
        `${route.label}@${size.width}x${size.height} region count`,
      ).toBeGreaterThanOrEqual(1)
      expect(
        regions.length,
        `${route.label}@${size.width}x${size.height} region count`,
      ).toBeLessThanOrEqual(2)

      // A scrollable region scrolls; the header stays put.
      const headerBefore = await page.locator('.txr-shell-header').boundingBox()
      expect(headerBefore).not.toBeNull()
      const labels = await regionLabels(page)
      const scrollable: string[] = []
      for (const label of labels) {
        const overflow = await page.evaluate(l => {
          const el = document.querySelector<HTMLElement>(`[aria-label="${l}"]`)
          return el === null ? false : el.scrollHeight > el.clientHeight + 1
        }, label)
        if (overflow) scrollable.push(label)
      }
      if (scrollable.length > 0) {
        const label = scrollable[0]
        await scrollRegionTo(page, label, 500)
        const regionTop = await page.evaluate(l => {
          const el = document.querySelector<HTMLElement>(`[aria-label="${l}"]`)
          return el ? el.scrollTop : -1
        }, label)
        expect(regionTop, `${route.label}@${size.width}x${size.height} ${label} scrolled`).toBeGreaterThan(0)
        const headerAfter = await page.locator('.txr-shell-header').boundingBox()
        expect(
          Math.abs(headerAfter!.y - headerBefore!.y),
          `${route.label}@${size.width}x${size.height} header moved`,
        ).toBeLessThanOrEqual(1)
      }
    }
  })
}

test('route Choose methods: the toolbar is fixed, the section headers stick to the region top, the run bar stays in the frame, PageDown scrolls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${GALLERY}txr-shell-route-choose-methods`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)
  await sizeFrame(page, 900)

  const label = 'Methods to choose'
  await scrollRegionTo(page, label, 300)
  // The toolbar (in the fixed top) did not move with the region.
  const toolbar = await page.getByTestId('txr-method-toolbar').boundingBox()
  expect(toolbar).not.toBeNull()
  const regionBox = await page.locator(`[aria-label="${label}"]`).boundingBox()
  expect(regionBox).not.toBeNull()
  expect(toolbar!.y, 'the toolbar must sit ABOVE the region').toBeLessThan(regionBox!.y)
  // A visible section header sticks to the region's top.
  const sticky = await page.evaluate(() => {
    const region = document.querySelector<HTMLElement>('[aria-label="Methods to choose"]')!
    const top = region.getBoundingClientRect().top
    const headers = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="txr-method-section-header-"]'),
    )
    const stuck = headers
      .map(h => h.getBoundingClientRect().top)
      .filter(t => Math.abs(t - top) <= 2)
    return { headers: headers.length, stuck: stuck.length }
  })
  expect(sticky.headers).toBeGreaterThan(0)
  expect(sticky.stuck, 'a section header must stick to the region top').toBeGreaterThanOrEqual(1)
  // The run bar never leaves the frame while the region scrolls.
  const bar = await page.getByTestId('txr-run-bar').boundingBox()
  const frame = await page.locator('[data-gallery-frame]').boundingBox()
  expect(bar).not.toBeNull()
  expect(bar!.y, 'the run bar stays inside the frame').toBeGreaterThanOrEqual(frame!.y)
  expect(bar!.y + bar!.height, 'the run bar stays inside the frame').toBeLessThanOrEqual(
    frame!.y + frame!.height + 1,
  )
  // Keyboard: Tab reaches the region; PageDown scrolls it (the audit leg).
  await page.locator(`[aria-label="${label}"]`).focus()
  const before = await page.locator(`[aria-label="${label}"]`).evaluate(el => el.scrollTop)
  await page.keyboard.press('PageDown')
  await page.waitForTimeout(150)
  const after = await page.locator(`[aria-label="${label}"]`).evaluate(el => el.scrollTop)
  expect(after, 'PageDown scrolls the region').toBeGreaterThan(before)
})

test('route Running: the table thead sticks to the region top; the log is the second region with its own lines viewport; the bottom bar stays', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${GALLERY}txr-shell-route-running`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)
  await sizeFrame(page, 900)

  // Open the log — the second region appears beside the table region.
  await page.getByTestId('txr-run-log-open').click()
  await page.waitForTimeout(300)
  let regions = await regionLabels(page)
  expect(regions).toContain('Methods')
  expect(regions).toContain('Log')
  // The log's lines area is the panel's own bounded viewport (the ITEM-11
  // byte inside ITEM-2's region: the panel chrome stays, the lines scroll).
  const preOverflow = await page
    .getByTestId('txr-run-log-lines')
    .evaluate(el => getComputedStyle(el).overflowY)
  expect(preOverflow).toBe('auto')

  // The thead is sticky INSIDE the method region (per-cell, opaque surface).
  // At 900 the 6-row table fits the region exactly and sticky never engages,
  // so shrink the window to a 640-px shell (the 520 floor still holds) whose
  // region ACTUALLY overflows, then scroll — sticky engages only once the
  // header would leave the scrollport.
  await page.setViewportSize({ width: 1440, height: 640 })
  await sizeFrame(page, 640)
  await scrollRegionTo(page, 'Methods', 400)
  const stickyHead = await page.evaluate(() => {
    const region = document.querySelector<HTMLElement>('[aria-label="Methods"]')!
    const top = region.getBoundingClientRect().top
    const th = region.querySelector<HTMLElement>('thead th')!
    return {
      position: getComputedStyle(th).position,
      topDelta: Math.abs(th.getBoundingClientRect().top - top),
      scrollTop: region.scrollTop,
      overflow: region.scrollHeight > region.clientHeight + 1,
    }
  })
  expect(stickyHead.overflow, 'the 640-frame region scrolls').toBe(true)
  expect(stickyHead.scrollTop).toBeGreaterThan(0)
  expect(stickyHead.position).toBe('sticky')
  expect(stickyHead.topDelta, 'thead top equals the region top').toBeLessThanOrEqual(2)

  // The bottom bar (Stop all + See the results) stays inside the frame.
  const bar = await page.getByTestId('txr-run-stop-all').boundingBox()
  const frame = await page.locator('[data-gallery-frame]').boundingBox()
  expect(bar).not.toBeNull()
  expect(bar!.y + bar!.height).toBeLessThanOrEqual(frame!.y + frame!.height + 1)
  await expect(page.getByTestId('txr-run-see-results')).toBeVisible()
})

test('route Files: each preview table is a bounded box with the sticky header (the audit byte)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${GALLERY}txr-shell-route-files`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)
  await sizeFrame(page, 900)
  const specs = await page.evaluate(() => {
    const boxes = Array.from(
      document.querySelectorAll<HTMLElement>('.txr-intake-first-rows'),
    )
    return boxes.map(box => {
      const th = box.querySelector<HTMLElement>('thead th')
      return {
        overflow: getComputedStyle(box).overflow,
        maxHeight: parseFloat(getComputedStyle(box).maxHeight),
        thPosition: th ? getComputedStyle(th).position : 'none',
      }
    })
  })
  expect(specs.length).toBeGreaterThanOrEqual(1)
  for (const spec of specs) {
    expect(spec.overflow, 'the preview box is its own scrollport').toBe('auto')
    expect(spec.maxHeight, 'the preview box is bounded').toBeGreaterThan(0)
    expect(spec.thPosition, 'the preview header is sticky').toBe('sticky')
  }
})

test('route Start at 390x844 (flow): the document scrolls, the header is sticky and one row', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${GALLERY}txr-shell-route-start`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)
  const flow = await page.evaluate(() => {
    const html = document.documentElement
    const header = document.querySelector<HTMLElement>('.txr-shell-header')!
    window.scrollTo(0, 400)
    return {
      flowClass: html.classList.contains('txr-shell-mode-flow'),
      overflow: getComputedStyle(html).overflow,
      scrollY: window.scrollY,
      headerPosition: getComputedStyle(header).position,
      headerHeight: header.getBoundingClientRect().height,
    }
  })
  expect(flow.flowClass).toBe(true)
  expect(flow.overflow).not.toBe('hidden')
  expect(flow.scrollY, 'the document scrolls in flow mode').toBeGreaterThan(0)
  expect(flow.headerPosition).toBe('sticky')
  expect(flow.headerHeight).toBe(56)
})
