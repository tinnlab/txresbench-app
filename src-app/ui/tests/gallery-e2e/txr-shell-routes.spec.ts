import { expect, test } from '@playwright/test'

/**
 * TEST-AS-2 (ITEM-2 half + app-shell ITEM-3's half) — the app-shell route
 * byte of the audit's section 4, driven over the shell-wrapped route
 * surfaces (`txr-shell-route-*`): each of the fourteen shell pages INSIDE
 * the real shell at 1440x900, 1280x720 and 1024x768.
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
 * ITEM-3's half (the part-2 pages): the results heatmap's pinned patient
 * column + sticky header ride the region, the H bars table's sticky thead,
 * the J inventory table's sticky thead, the D/I shared-list frames (toolbar
 * fixed above the region, counters + Run pinned), the history list frame
 * (its footer bar pinned), and the help article — the rail's spy follows
 * the region, an anchor lands flush at its top (scroll-margin 0 in shell
 * mode) and the print byte prints the whole article.
 *
 * The 390x844 flow-mode leg: the document scrolls, the header is sticky
 * and ONE 56 px row (the audit's flow byte).
 *
 * The full 14-route matrix with long-table fixtures (95 / 300 rows), the
 * Back-scroll-restore leg and the real desktop screenshots are ITEM-4's
 * spec (TEST-AS-3); this spec owns the part-1 pages of ITEM-2 and the
 * part-2 pages of ITEM-3.
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
  { slug: 'txr-shell-route-results', label: 'Results', regions: 1 },
  { slug: 'txr-shell-route-compare', label: 'Compare', regions: 1 },
  { slug: 'txr-shell-route-method', label: 'Method', regions: 1 },
  { slug: 'txr-shell-route-history', label: 'History', regions: 1 },
  { slug: 'txr-shell-route-models', label: 'Models', regions: 1 },
  { slug: 'txr-shell-route-saved-models', label: 'Saved models', regions: 1 },
  { slug: 'txr-shell-route-pretrained-models', label: 'Pretrained models', regions: 1 },
  { slug: 'txr-shell-route-help', label: 'Help', regions: 1 },
] as const

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
] as const

/** Give the gallery frame the test viewport's height (the default frame is
 *  720 px — bounded — so the shell's height chain is definite; resizing the
 *  frame to the size under test makes the measured layout the real one).
 *  The wait is the REAL condition — the gallery's cold transform can mount
 *  the surface after the fixed settle, so the frame + shell are polled for
 *  before sizing (a settle-then-throw made the first leg of a cold run a
 *  load-timing flake: `no gallery frame`). */
async function sizeFrame(page: import('@playwright/test').Page, height: number) {
  await page.waitForFunction(
    () => document.querySelector('[data-gallery-frame]') !== null && document.querySelector('#txr-main') !== null,
    undefined,
    { timeout: 90_000 },
  )
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

  // The thead is sticky INSIDE the method region (per-th, opaque surface).
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

/** A long failure line for the example family fetch. */
const LONG_EXAMPLE_ERROR =
  'No method with a published environment can run on the example data on this computer, so the ' +
  'example models could not be prepared. Check the method catalogue and try again.'

/** Make every example-file fetch fail with the long line: wraps the gallery
 *  mock's own fetch (the mock answers in the page, so `page.route` never
 *  sees the request). The body is `{ error }`, the shape the API client reads. */
async function failExampleFetch(page: import('@playwright/test').Page) {
  await page.evaluate(message => {
    const original = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (new URL(url, window.location.origin).pathname.startsWith('/api/file-validation/examples/')) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }
      return original(input, init)
    }
  }, LONG_EXAMPLE_ERROR)
}

test('route Start: a Use example error is the card\'s last row, under the buttons, across the card', async ({
  page,
}) => {
  const paths = ['pretrained', 'train', 'reuse'] as const
  for (const size of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size)
    await page.goto(`${GALLERY}txr-shell-route-start`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(SETTLE)
    if (size.width > 640) await sizeFrame(page, size.height)
    await failExampleFetch(page)
    for (const path of paths) await page.getByTestId(`txr-use-example-${path}`).click()
    for (const path of paths) {
      await expect(page.getByTestId(`txr-use-example-error-${path}`)).toHaveText(LONG_EXAMPLE_ERROR)
    }

    const cards = await page.evaluate(
      ids =>
        ids.map(path => {
          const box = (id: string) =>
            document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.getBoundingClientRect()
          const card = document.querySelector<HTMLElement>(`[data-testid="txr-intake-start-card-${path}"]`)!
          const style = getComputedStyle(card)
          const outer = card.getBoundingClientRect()
          const left = outer.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)
          const right = outer.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight)
          const error = box(`txr-use-example-error-${path}`)
          const primary = box(`txr-intake-start-card-${path}-cta`)
          const retry = box(`txr-use-example-${path}`)
          return {
            path,
            contentLeft: left,
            contentWidth: right - left,
            cardWidth: outer.width,
            error: { left: error.left, width: error.width, top: error.top },
            primary: { top: primary.top, bottom: primary.bottom },
            retry: { top: retry.top, bottom: retry.bottom, width: retry.width },
          }
        }),
      [...paths],
    )
    for (const card of cards) {
      const at = `${card.path}@${size.width}`
      expect(Math.abs(card.error.left - card.contentLeft), `${at} error left = card content left`).toBeLessThanOrEqual(1)
      expect(Math.abs(card.error.width - card.contentWidth), `${at} error width = card content width`).toBeLessThanOrEqual(1)
      expect(card.error.top, `${at} error below the buttons`).toBeGreaterThanOrEqual(
        Math.max(card.primary.bottom, card.retry.bottom),
      )
      expect(Math.abs(card.primary.top - card.retry.top), `${at} the two buttons share one row`).toBeLessThanOrEqual(1)
      expect(card.retry.width, `${at} Try again keeps its own width`).toBeLessThan(card.cardWidth / 2)
    }
  }
})

// ── ITEM-3: the part-2 route bytes ──────────────────────────────────────────

test('route Results: the heatmap corner header sticks to the region, the patient column pins while the table scrolls horizontally, the count + actions stay in the fixed bottom bar', async ({
  page,
}) => {
  // 768x768 (the shell floor's width): the ten-column table (773 px) is
  // wider than the region here — the only shell size where the patient
  // column's pin actually engages (the vertical case is the corner
  // header's top pin, measured after a 400 px scroll).
  await page.setViewportSize({ width: 768, height: 768 })
  await page.goto(`${GALLERY}txr-shell-route-results`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)
  await sizeFrame(page, 768)

  const label = 'Patient predictions'
  await scrollRegionTo(page, label, 400)
  const sticky = await page.evaluate(() => {
    const region = document.querySelector<HTMLElement>('[aria-label="Patient predictions"]')!
    const table = region.querySelector<HTMLElement>('[data-testid="txr-heatmap"]')!
    const corner = table.querySelector<HTMLElement>('thead th')!
    const anyValue = table.querySelector<HTMLElement>('tbody td')!
    const regionTop = region.getBoundingClientRect().top
    return {
      cornerPosition: getComputedStyle(corner).position,
      cornerDelta: Math.abs(corner.getBoundingClientRect().top - regionTop),
      valuePosition: getComputedStyle(anyValue).position,
      scrollTop: region.scrollTop,
    }
  })
  expect(sticky.scrollTop).toBeGreaterThan(0)
  expect(sticky.cornerPosition, 'the corner header is sticky').toBe('sticky')
  expect(sticky.cornerDelta, 'the corner header sticks to the region top').toBeLessThanOrEqual(2)
  expect(sticky.valuePosition, 'the row values never stick').not.toBe('sticky')

  // The pinned patient column: while the table scrolls 200 px right, the
  // patient column pins at the REGION's left edge (sticky left:0 against the
  // scrollport — it leaves the card's edge behind) and a method value
  // travels with the table.
  const pin = await page.evaluate(() => {
    const region = document.querySelector<HTMLElement>('[aria-label="Patient predictions"]')!
    const card = region.querySelector<HTMLElement>('[data-testid="txr-heatmap"]')!
    const table = card.querySelector<HTMLElement>('table')!
    const patientCol = table.querySelector<HTMLElement>('tbody th[scope="row"]')!
    const value = table.querySelector<HTMLElement>('td[data-testid$="-direct-on"]')!
    const valueX = value.getBoundingClientRect().left
    region.scrollLeft = 200
    return {
      hOverflow: region.scrollWidth > region.clientWidth,
      scrollLeft: region.scrollLeft,
      pinDelta: Math.abs(patientCol.getBoundingClientRect().left - region.getBoundingClientRect().left),
      valueMoved: value.getBoundingClientRect().left - valueX,
    }
  })
  expect(pin.hOverflow, 'at 768 the heatmap overflows horizontally').toBe(true)
  expect(pin.scrollLeft).toBeGreaterThan(0)
  expect(pin.pinDelta, 'the patient column pins at the region left').toBeLessThanOrEqual(3)
  expect(pin.valueMoved, 'the method columns travel with the table').toBeLessThan(-50)

  // The count/Show-all + actions never leave the frame while the region
  // scrolls (the audit's "Showing n of N" + download + save byte).
  const bar = await page.getByTestId('txr-results-bar').boundingBox()
  const frame = await page.locator('[data-gallery-frame]').boundingBox()
  expect(bar).not.toBeNull()
  expect(bar!.y, 'the bar stays inside the frame').toBeGreaterThanOrEqual(frame!.y)
  expect(bar!.y + bar!.height, 'the bar stays inside the frame').toBeLessThanOrEqual(
    frame!.y + frame!.height + 1,
  )
  expect(await page.getByTestId('txr-heatmap-count').textContent()).toContain('Showing')
})

test('route Compare: the bars table thead sticks to the region top, the actions stay pinned', async ({
  page,
}) => {
  // 640 px of shell height (the 520 floor still holds): the region actually
  // overflows, so the thead pin engages (900 fits the fixture table).
  await page.setViewportSize({ width: 1440, height: 640 })
  await page.goto(`${GALLERY}txr-shell-route-compare`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)
  await sizeFrame(page, 640)

  await scrollRegionTo(page, 'Methods', 400)
  const sticky = await page.evaluate(() => {
    const region = document.querySelector<HTMLElement>('[aria-label="Methods"]')!
    const table = region.querySelector<HTMLElement>('[data-testid="txr-bars"]')!
    const th = table.querySelector<HTMLElement>('thead th')!
    const anyValue = table.querySelector<HTMLElement>('tbody td')!
    const regionTop = region.getBoundingClientRect().top
    return {
      overflow: table.scrollHeight > region.clientHeight,
      thPosition: getComputedStyle(th).position,
      thDelta: Math.abs(th.getBoundingClientRect().top - regionTop),
      valuePosition: getComputedStyle(anyValue).position,
    }
  })
  expect(sticky.overflow, 'the 640-frame region scrolls').toBe(true)
  expect(sticky.thPosition, 'the bars thead is sticky').toBe('sticky')
  expect(sticky.thDelta, 'the thead sticks to the region top').toBeLessThanOrEqual(2)
  expect(sticky.valuePosition).not.toBe('sticky')

  const bar = await page.getByTestId('txr-results-bar').boundingBox()
  const frame = await page.locator('[data-gallery-frame]').boundingBox()
  expect(bar).not.toBeNull()
  expect(bar!.y + bar!.height).toBeLessThanOrEqual(frame!.y + frame!.height + 1)
})

test('route Method: the one-method frame pins its Heading in the fixed top and Save this model in the bar', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 640 })
  await page.goto(`${GALLERY}txr-shell-route-method`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)
  await sizeFrame(page, 640)

  await scrollRegionTo(page, 'Methods', 300)
  const heading = await page.getByTestId('txr-results-method-heading').boundingBox()
  const region = await page.locator('[aria-label="Methods"]').boundingBox()
  expect(heading).not.toBeNull()
  expect(heading!.y, 'the method heading sits ABOVE the region').toBeLessThan(region!.y)
  const save = await page.getByTestId('txr-results-save-one-model')
  await expect(save).toBeVisible()
})

test('route History: the toolbar stays above the region, the list scrolls inside it, the footer bar never leaves the frame', async ({
  page,
}) => {
  // 640: the fixture family is six runs; the industry rows page + the
  // running row + the copy-cleared row page the region past 640.
  await page.setViewportSize({ width: 1440, height: 640 })
  await page.goto(`${GALLERY}txr-shell-route-history`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)
  await sizeFrame(page, 640)

  await scrollRegionTo(page, 'History', 300)
  const toolbar = await page.getByTestId('txr-history-toolbar').boundingBox()
  const region = await page.locator('[aria-label="History"]').boundingBox()
  expect(toolbar).not.toBeNull()
  expect(toolbar!.y, 'the toolbar sits ABOVE the region').toBeLessThan(region!.y)
  const scrollTop = await page
    .locator('[aria-label="History"]')
    .evaluate(el => el.scrollTop)
  expect(scrollTop, 'the history list scrolls inside the region').toBeGreaterThan(0)
  const bar = await page.getByTestId('txr-history-footer-bar').boundingBox()
  const frame = await page.locator('[data-gallery-frame]').boundingBox()
  expect(bar).not.toBeNull()
  expect(bar!.y + bar!.height).toBeLessThanOrEqual(frame!.y + frame!.height + 1)
})

test('route Models: the inventory table thead sticks to the region top, the footnotes stay pinned', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 640 })
  await page.goto(`${GALLERY}txr-shell-route-models`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)
  await sizeFrame(page, 640)

  await scrollRegionTo(page, 'Your models', 300)
  const sticky = await page.evaluate(() => {
    const region = document.querySelector<HTMLElement>('[aria-label="Your models"]')!
    const th = region.querySelector<HTMLElement>('thead th')!
    const regionTop = region.getBoundingClientRect().top
    return {
      overflow: region.scrollHeight > region.clientHeight,
      thPosition: getComputedStyle(th).position,
      thDelta: Math.abs(th.getBoundingClientRect().top - regionTop),
    }
  })
  expect(sticky.overflow, 'the inventory region scrolls').toBe(true)
  expect(sticky.thPosition, 'the inventory thead is sticky').toBe('sticky')
  expect(sticky.thDelta, 'the thead sticks to the region top').toBeLessThanOrEqual(2)
  const bar = await page.getByTestId('txr-models-j-footer-bar').boundingBox()
  const frame = await page.locator('[data-gallery-frame]').boundingBox()
  expect(bar).not.toBeNull()
  expect(bar!.y + bar!.height).toBeLessThanOrEqual(frame!.y + frame!.height + 1)
})

/** The shared list's bottom bar spans its page frame: same left edge, same
 *  width. Checked at the test's viewport and again at 1920 px wide (inside a
 *  flex row the bar kept its content's width at the left of a wide window). */
async function expectBarSpansFrame(page: import('@playwright/test').Page, frameTestId: string, label: string) {
  const check = async () => {
    const at = `${label}@${page.viewportSize()!.width}`
    const bar = await page.getByTestId('txr-list-bottom-bar').boundingBox()
    const frame = await page.getByTestId(frameTestId).boundingBox()
    expect(bar, `${at} bar`).not.toBeNull()
    expect(frame, `${at} frame`).not.toBeNull()
    expect(Math.abs(bar!.x - frame!.x), `${at} bar left edge = frame left edge`).toBeLessThanOrEqual(1)
    expect(Math.abs(bar!.width - frame!.width), `${at} bar width = frame width`).toBeLessThanOrEqual(1)
    return frame!.width
  }
  await check()
  await page.setViewportSize({ width: 1920, height: page.viewportSize()!.height })
  await page.waitForTimeout(300)
  expect(await check(), `${label}@1920 the frame grew with the window`).toBeGreaterThan(1700)
}

test('route Saved models: the toolbar is fixed above the region, the rows render, the counters + Run stay pinned', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${GALLERY}txr-shell-route-saved-models`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)
  await sizeFrame(page, 900)
  // The shared list's rows render inside the region (the virtualizer's
  // scrollport is the region — the split works end to end).
  const rows = await page.locator('[data-testid^="txr-list-row-"]').count()
  expect(rows, 'the saved-model rows render').toBeGreaterThan(0)
  const toolbar = await page.getByTestId('txr-models-i-toolbar').boundingBox()
  const region = await page.locator('[aria-label="Saved models"]').boundingBox()
  expect(toolbar).not.toBeNull()
  expect(toolbar!.y, 'the toolbar sits ABOVE the region').toBeLessThan(region!.y)
  const bar = await page.getByTestId('txr-models-i-bar').boundingBox()
  const frame = await page.locator('[data-gallery-frame]').boundingBox()
  expect(bar).not.toBeNull()
  expect(bar!.y + bar!.height).toBeLessThanOrEqual(frame!.y + frame!.height + 1)
  await expect(page.getByTestId('txr-list-run')).toHaveText('Run 0 models')
  await expectBarSpansFrame(page, 'txr-models-i-frame', 'Saved models')
})

test('route Pretrained models: the list frame pins its toolbar above the region and the counters + Run in the bar', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 640 })
  await page.goto(`${GALLERY}txr-shell-route-pretrained-models`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)
  await sizeFrame(page, 640)

  const rows = await page.locator('[data-testid^="txr-list-row-"]').count()
  expect(rows, 'the catalogue rows render').toBeGreaterThan(0)
  await scrollRegionTo(page, 'Models to choose', 200)
  const toolbar = await page.getByTestId('txr-models-d-toolbar').boundingBox()
  const region = await page.locator('[aria-label="Models to choose"]').boundingBox()
  expect(toolbar).not.toBeNull()
  expect(toolbar!.y, 'the toolbar sits ABOVE the region').toBeLessThan(region!.y)
  const bar = await page.getByTestId('txr-models-d-bar').boundingBox()
  const frame = await page.locator('[data-gallery-frame]').boundingBox()
  expect(bar).not.toBeNull()
  expect(bar!.y + bar!.height).toBeLessThanOrEqual(frame!.y + frame!.height + 1)
  await expectBarSpansFrame(page, 'txr-models-d-frame', 'Pretrained models')
})

test('route Help: the rail follows the region, an anchor lands flush at its top, the print byte prints the article', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${GALLERY}txr-shell-route-help`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)
  await sizeFrame(page, 900)

  // The spy: with the scrollport at the top the FIRST section is current;
  // scrolled to the last section (its heading at the 96 px line) the rail
  // follows — the intersection observer's root is the region itself. The
  // scroll event is rAF-throttled, so the read comes AFTER the spy's tick.
  const atRest = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.txr-help-rail [aria-current="true"]')
    return el?.getAttribute('data-testid') ?? null
  })
  expect(atRest, 'at rest the first section is current').toBe('txr-help-toc-overview')
  const scrolled = await page.evaluate(() => {
    const region = document.querySelector<HTMLElement>('[aria-label="Help content"]')!
    const last = document.getElementById('troubleshooting')!
    region.scrollTop = last.offsetTop - 40
    return region.scrollTop
  })
  expect(scrolled, 'the region scrolled').toBeGreaterThan(0)
  await page.waitForTimeout(400)
  const afterScroll = await page.evaluate(() =>
    document
      .querySelector<HTMLElement>('.txr-help-rail [aria-current="true"]')!
      .getAttribute('data-testid')!,
  )
  expect(afterScroll, 'the rail follows the scrolled-to section').toBe(
    'txr-help-toc-troubleshooting',
  )

  // The anchor: a rail link scrolls its section flush to the region's top
  // (scroll-margin 0 in shell mode — the fixed top sits ABOVE the region).
  // The scroll is SMOOTH, so the position is polled to its settle.
  await page.getByTestId('txr-help-toc-files').click()
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const region = document.querySelector<HTMLElement>('[aria-label="Help content"]')!
          const section = document.getElementById('files')!
          return Math.abs(
            section.getBoundingClientRect().top - region.getBoundingClientRect().top,
          )
        }),
      { timeout: 15_000 },
    )
    .toBeLessThanOrEqual(2)
  const anchor = await page.evaluate(() => {
    const section = document.getElementById('files')!
    return { scrollMargin: getComputedStyle(section).scrollMarginTop }
  })
  expect(anchor.scrollMargin, 'shell-mode anchors have no scroll margin').toBe('0px')

  // The print byte: the shell's fixed document and the region's inline
  // height/overflow yield — the full article prints.
  await page.emulateMedia({ media: 'print' })
  const print = await page.evaluate(() => {
    const region = document.querySelector<HTMLElement>('[aria-label="Help content"]')!
    return {
      htmlOverflow: getComputedStyle(document.documentElement).overflow,
      regionOverflow: getComputedStyle(region).overflowY,
      regionHeight: region.getBoundingClientRect().height,
      regionScrollHeight: region.scrollHeight,
    }
  })
  expect(print.htmlOverflow, 'the document is not clipped in print').toBe('visible')
  expect(print.regionOverflow, 'the region does not clip in print').toBe('visible')
  expect(print.regionHeight, 'the printed region is the full article').toBeGreaterThanOrEqual(
    print.regionScrollHeight - 1,
  )
  await page.emulateMedia({ media: 'screen' })
})

// ── ITEM-3's closing surfaces: the catch-all and the dialogs ────────────────

test('route Not found: the catch-all is the frame byte — no fixed chrome, ONE region, the header never moves', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${GALLERY}txr-shell-route-not-found`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)
  await sizeFrame(page, 900)

  const shell = await page.evaluate(() => ({
    shellClass: document.documentElement.classList.contains('txr-shell-mode-shell'),
    overflow: getComputedStyle(document.documentElement).overflow,
  }))
  expect(shell.shellClass).toBe(true)
  expect(shell.overflow).toBe('hidden')

  // The catch-all renders NO fixed top/bottom chrome — the audit's row is
  // "none / body / none", and the page's ONE region is the body.
  const chrome = await page.evaluate(() => ({
    top: document.querySelectorAll('[class*="txr-page-frame-top"]').length,
    bottom: document.querySelectorAll('[class*="txr-page-frame-bottom"]').length,
    regions: Array.from(document.querySelectorAll<HTMLElement>('[role="region"]')).map(
      el => el.getAttribute('aria-label') ?? '',
    ),
  }))
  expect(chrome.top, 'no fixed top on the catch-all').toBe(0)
  expect(chrome.bottom, 'no fixed bottom on the catch-all').toBe(0)
  expect(chrome.regions).toEqual(['Not found'])

  // The block is centred within the region and the shell body scroller is
  // unused (the region owns the scroll).
  const routed = await routedArea(page)
  expect(routed!.scrollHeight, 'the routed area has nothing to scroll').toBeLessThanOrEqual(
    routed!.clientHeight + 1,
  )
  const block = await page.getByTestId('txr-not-found-text').boundingBox()
  const regionBox = await page.locator('[aria-label="Not found"]').boundingBox()
  expect(block).not.toBeNull()
  expect(regionBox).not.toBeNull()
  expect(block!.x, 'the block is horizontally centred').toBeGreaterThan(regionBox!.x)

  // The header stays put; the one region has focus support (the shell byte).
  // `focus({ preventScroll: true })` — the shell document cannot scroll, so
  // plain focus() would only scroll the GALLERY HOST's own document (its
  // chrome sits above the frame, 207 px taller than the test window), which
  // is not the shell's byte.
  const headerBefore = await page.locator('.txr-shell-header').boundingBox()
  await page
    .locator('[aria-label="Not found"]')
    .evaluate(el => (el as HTMLElement).focus({ preventScroll: true }))
  expect(
    await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
    'the region accepts focus',
  ).toBe('Not found')
  const headerAfter = await page.locator('.txr-shell-header').boundingBox()
  expect(Math.abs(headerAfter!.y - headerBefore!.y)).toBeLessThanOrEqual(1)
})

test('the dialogs: title and footer stay fixed while the body scrolls (the audit\'s dialog byte)', async ({
  page,
}) => {
  // The kit Dialog's byte: the popup caps itself to the viewport
  // (`max-h-[calc(100dvh-2rem)]`) and its grid rows are auto /
  // minmax(0, 1fr) / auto — the title and footer rows keep their size and
  // position while the middle row is the scrollport. The models save-set
  // checklist is the tall dialog. At the board's window (1280x520) the cap
  // leaves it room, so the leg shrinks the window until the cap cuts the
  // natural height — the "a tall dialog on a short screen scrolls instead
  // of overflowing off-screen" case the byte exists for. The popup's byte
  // is viewport-relative (it is portaled to the document body), so shell
  // mode or flow mode is irrelevant to it.
  await page.setViewportSize({ width: 1280, height: 520 })
  await page.goto(`${GALLERY}txr-models-l`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)
  await page.getByTestId('txr-models-open-l').click()
  const dialog = page.getByTestId('txr-models-save')
  await expect(dialog).toBeVisible()

  const readByte = () =>
    dialog.evaluate(el => {
      const style = getComputedStyle(el)
      return {
        rows: style.gridTemplateRows.trim().split(/\s+/).map(track => parseFloat(track)),
        maxHeight: style.maxHeight,
        boxHeight: el.getBoundingClientRect().height,
        viewport: window.innerHeight,
      }
    })

  const byte = await readByte()
  // The three rows of the dialog grid: title / body / footer. Chromium
  // serialises the RESOLVED tracks (the `grid-rows-[auto_minmax(0,1fr)_auto]`
  // byte has actually sized the dialog), so the pin is the shape: exactly
  // three definite tracks, the middle one the body's.
  expect(byte.rows, 'the dialog grid has three rows').toHaveLength(3)
  expect(byte.rows.every(Number.isFinite), 'the tracks are resolved').toBe(true)
  // The dialog caps to the viewport: max-height is 100dvh − 2rem.
  const capPx = byte.viewport - 32
  expect(Math.abs(parseFloat(byte.maxHeight) - capPx), 'capped to the viewport').toBeLessThanOrEqual(
    2,
  )
  expect(byte.boxHeight, 'never taller than the cap').toBeLessThanOrEqual(capPx + 2)

  // Shrink the window past the checklist's natural height: the cap now cuts
  // the middle row — it absorbs the shrink while the title/footer rows keep
  // their size, and it becomes the dialog's scrollport.
  await page.setViewportSize({ width: 1280, height: 400 })
  await page.waitForTimeout(300)
  const shrunk = await readByte()
  expect(shrunk.boxHeight, 'the shortened cap is honoured').toBeLessThanOrEqual(shrunk.viewport - 32 + 2)
  expect(shrunk.rows).toHaveLength(3)
  expect(Math.abs(shrunk.rows[0] - byte.rows[0]), 'the title row keeps its size').toBeLessThanOrEqual(
    1,
  )
  expect(Math.abs(shrunk.rows[2] - byte.rows[2]), 'the footer row keeps its size').toBeLessThanOrEqual(
    1,
  )
  expect(shrunk.rows[1], 'the body row is the one that absorbed the cap').toBeLessThan(byte.rows[1])

  // The middle row owns the scroll: the DivScrollY host (grid item) has
  // `overflow: hidden` (the overlayscrollbars byte) and its
  // `data-overlayscrollbars-viewport` child is the scroll container —
  // the checklist inside it is taller than the row, so the viewport is
  // scrollable and the title/footer rows keep their y while it scrolls.
  const before = await dialog.evaluate(el => ({
    titleY: el.querySelector('[data-slot="dialog-title"]')?.getBoundingClientRect().top ?? -1,
    footerY: el.querySelector('[data-slot="dialog-footer"]')?.getBoundingClientRect().top ?? -1,
  }))
  const probe = await dialog.evaluate(el => {
    const viewport = el.querySelector<HTMLElement>('[data-overlayscrollbars-viewport]')
    const title = el.querySelector('[data-slot="dialog-title"]')
    const footer = el.querySelector('[data-slot="dialog-footer"]')
    const found = viewport !== null
    const scrollable = viewport === null ? 0 : viewport.scrollHeight - viewport.clientHeight
    if (viewport !== null) viewport.scrollTop = 200
    return {
      found,
      scrollable,
      scrollTop: viewport?.scrollTop ?? 0,
      titleY: title?.getBoundingClientRect().top ?? -1,
      footerY: footer?.getBoundingClientRect().top ?? -1,
    }
  })
  expect(probe.found, 'the body row carries the scrollport').toBe(true)
  expect(probe.scrollable, 'the checklist overflows the body row').toBeGreaterThan(0)
  expect(probe.scrollTop, 'the body row scrolled').toBeGreaterThan(0)
  expect(Math.abs(probe.titleY - before.titleY), 'the title row never moved').toBeLessThanOrEqual(1)
  expect(Math.abs(probe.footerY - before.footerY), 'the footer row never moved').toBeLessThanOrEqual(1)
})
