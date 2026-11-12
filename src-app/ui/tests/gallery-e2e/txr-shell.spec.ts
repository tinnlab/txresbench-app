import { expect, test } from '@playwright/test'

/**
 * TEST-AS-3 (ITEM-4) — the audit's section 4 as a repo spec
 * (`qa-data/scroll-audit.mjs` becomes this file), driven over the fourteen
 * shell-wrapped route surfaces inside the real shell.
 *
 * The audit's section-4 list, measured:
 *  · the document does not scroll in shell mode — the raw
 *    `document.documentElement.scrollHeight <= innerHeight` byte is the
 *    REAL-APP tier's (`txr-shell-app.spec.ts`); here the harness
 *    substitution documented in DRIFT-1 ITEM-2 #6 is measured: the routed
 *    area (`#txr-main`) has nothing to scroll (the shell's document rules
 *    are the fixed ones, and the gallery host's own chrome sits above the
 *    story frame — see the ITEM-2/3 specs' note);
 *  · the header's bounding box is identical before and after scrolling
 *    EVERY region (not only the first scrollable one);
 *  · every route with more content than fits has at least one region and at
 *    most two;
 *  · nothing extends beyond the viewport (the story frame's horizontal
 *    scrollWidth byte + the routed area's own);
 *  · the run bar is visible at all times on `/choose-methods`;
 *  · keyboard: Tab reaches each region, PageDown/Space/Home/End scroll it;
 *  · the browser Back button restores a region's scroll — the in-memory
 *    per-route restore is the mechanism, proven on the restore story (and
 *    the true browser-Back leg is the real-app tier's
 *    `txr-shell-app.spec.ts`: the gallery mounts stories under a
 *    MemoryRouter, so the browser history is not the app's);
 *  · the long-table byte: after scrolling a table region by 500 px the
 *    thead top equals the region top — on the 300-row heatmap and the
 *    95-row compare / one-method fixtures (the four routes the audit
 *    measured holding long tables);
 *  · at 390x844 (flow mode) on all fourteen routes: the document scrolls
 *    normally, the header is sticky and ONE 56 px row.
 *
 * Run: npx playwright test -c playwright.gallery.config.ts
 *      tests/gallery-e2e/txr-shell.spec.ts
 */
const GALLERY = '/gallery.html?surface='

test.setTimeout(900_000)

/** The story's settle (the seeded store/cassette commit, the shared bound). */
const SETTLE = 2600

const ROUTES = [
  { slug: 'txr-shell-route-start', label: 'Start' },
  { slug: 'txr-shell-route-study', label: 'Study' },
  { slug: 'txr-shell-route-files', label: 'Files' },
  { slug: 'txr-shell-route-predict-files', label: 'Predict files' },
  { slug: 'txr-shell-route-choose-methods', label: 'Choose methods' },
  { slug: 'txr-shell-route-running', label: 'Running' },
  { slug: 'txr-shell-route-results', label: 'Results' },
  { slug: 'txr-shell-route-compare', label: 'Compare' },
  { slug: 'txr-shell-route-method', label: 'Method' },
  { slug: 'txr-shell-route-history', label: 'History' },
  { slug: 'txr-shell-route-models', label: 'Models' },
  { slug: 'txr-shell-route-saved-models', label: 'Saved models' },
  { slug: 'txr-shell-route-pretrained-models', label: 'Pretrained models' },
  { slug: 'txr-shell-route-help', label: 'Help' },
] as const

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
] as const

/** Give the gallery frame the test viewport's height (see ITEM-3's
 *  `sizeFrame`: the frame's height makes the shell's height chain definite;
 *  the wait is the REAL mount condition, not a fixed settle). */
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

/** The scrollable regions' labels (ES-capable in the DOM). */
function regionLabels(page: import('@playwright/test').Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="region"]')).map(
      el => el.getAttribute('aria-label') ?? '',
    ),
  )
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

/** The routed area's scroll facts (the page-fits byte). */
async function routedArea(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('#txr-main')
    if (main === null) return null
    return { scrollHeight: main.scrollHeight, clientHeight: main.clientHeight }
  })
}

/** A region's scroll facts (scrollable? scrolled to `top`?). */
async function regionScroll(page: import('@playwright/test').Page, label: string) {
  return page.evaluate(l => {
    const el = document.querySelector<HTMLElement>(`[aria-label="${l}"]`)
    if (el === null) return null
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflow: el.scrollHeight > el.clientHeight + 1,
    }
  }, label)
}

// ── TEST-AS-3: the section-4 matrix, one test per route ────────────────────

for (const route of ROUTES) {
  test(`route ${route.label}: the section-4 shell bytes at the three desktop sizes`, async ({
    page,
  }) => {
    for (const size of SIZES) {
      await page.setViewportSize(size)
      await page.goto(`${GALLERY}${route.slug}`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(SETTLE)
      await sizeFrame(page, size.height)

      // Shell mode + the routed area never scrolls (the harness substitution
      // for the raw document byte — the real byte is the real-app tier).
      const shell = await page.evaluate(() => ({
        shellClass: document.documentElement.classList.contains('txr-shell-mode-shell'),
        overflow: getComputedStyle(document.documentElement).overflow,
      }))
      expect(shell.shellClass, `${route.label}@${size.width}x${size.height} shell class`).toBe(true)
      expect(shell.overflow, `${route.label}@${size.width}x${size.height} doc overflow`).toBe('hidden')
      const routed = await routedArea(page)
      expect(routed, `${route.label} routed area`).not.toBeNull()
      expect(
        routed!.scrollHeight,
        `${route.label}@${size.width}x${size.height} routed-area overflow px`,
      ).toBeLessThanOrEqual(routed!.clientHeight + 1)

      // One or two regions (the audit's region-count byte).
      const labels = await regionLabels(page)
      expect(
        labels.length,
        `${route.label}@${size.width}x${size.height} region count`,
      ).toBeGreaterThanOrEqual(1)
      expect(
        labels.length,
        `${route.label}@${size.width}x${size.height} region count`,
      ).toBeLessThanOrEqual(2)

      // Nothing extends beyond the viewport: the story frame carries no
      // horizontal overflow and the routed area is not wider than its slot.
      const horizontal = await page.evaluate(() => {
        const frame = document.querySelector<HTMLElement>('[data-gallery-frame]')
        const main = document.querySelector<HTMLElement>('#txr-main')
        return {
          frameOverflow: frame === null ? -1 : frame.scrollWidth - frame.clientWidth,
          routedOverflow: main === null ? -1 : main.scrollWidth - main.clientWidth,
        }
      })
      expect(
        horizontal.frameOverflow,
        `${route.label}@${size.width}x${size.height} frame horizontal overflow`,
      ).toBeLessThanOrEqual(1)
      expect(
        horizontal.routedOverflow,
        `${route.label}@${size.width}x${size.height} routed-area horizontal overflow`,
      ).toBeLessThanOrEqual(1)

      // The header never moves while EVERY region scrolls (the audit says
      // "before and after scrolling every region", not only the first).
      const headerBefore = await page.locator('.txr-shell-header').boundingBox()
      expect(headerBefore).not.toBeNull()
      for (const label of labels) {
        const facts = await regionScroll(page, label)
        if (!facts || !facts.overflow) continue
        await scrollRegionTo(page, label, 500)
        const moved = await regionScroll(page, label)
        expect(moved!.scrollTop, `${route.label} ${label} scrolled`).toBeGreaterThan(0)
        const headerAfter = await page.locator('.txr-shell-header').boundingBox()
        expect(
          Math.abs(headerAfter!.y - headerBefore!.y),
          `${route.label}@${size.width}x${size.height} header moved while ${label} scrolled`,
        ).toBeLessThanOrEqual(1)
      }

      // The run bar never leaves the frame on the choose-methods route.
      if (route.slug === 'txr-shell-route-choose-methods') {
        const bar = await page.getByTestId('txr-run-bar').boundingBox()
        const frame = await page.locator('[data-gallery-frame]').boundingBox()
        expect(bar).not.toBeNull()
        expect(bar!.y, 'the run bar stays inside the frame').toBeGreaterThanOrEqual(frame!.y)
        expect(bar!.y + bar!.height, 'the run bar stays inside the frame').toBeLessThanOrEqual(
          frame!.y + frame!.height + 1,
        )
      }
    }
  })
}

// ── TEST-AS-3: the long-table byte (95 / 300 rows) ──────────────────────────

test('route Results: the 300-row heatmap — 500 px scroll, thead sticks to the region top', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${GALLERY}txr-shell-route-results-long`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)
  await sizeFrame(page, 900)

  const label = 'Patient predictions'
  const region = await regionScroll(page, label)
  expect(region, 'the region exists').not.toBeNull()
  expect(region!.overflow, 'the 300-row heatmap overflows the region').toBe(true)
  await scrollRegionTo(page, label, 500)
  const sticky = await page.evaluate(() => {
    const regionEl = document.querySelector<HTMLElement>('[aria-label="Patient predictions"]')!
    const table = regionEl.querySelector<HTMLElement>('[data-testid="txr-heatmap"]')!
    const regionTop = regionEl.getBoundingClientRect().top
    const headerCells = Array.from(table.querySelectorAll<HTMLElement>('thead th, thead td'))
    const rowHeader = table.querySelector<HTMLElement>('tbody th[scope="row"]')!
    return {
      scrollTop: regionEl.scrollTop,
      headerCells: headerCells.length,
      stuck: headerCells.filter(th => Math.abs(th.getBoundingClientRect().top - regionTop) <= 2).length,
      rowHeaderPosition: getComputedStyle(rowHeader).position,
    }
  })
  expect(sticky.scrollTop, 'the region scrolled 500').toBe(500)
  expect(sticky.headerCells, 'the heatmap has its header cells').toBeGreaterThan(0)
  expect(sticky.stuck, 'every header cell sticks to the region top').toBe(sticky.headerCells)
  expect(sticky.rowHeaderPosition, 'the patient column is the pinned one').toBe('sticky')
})

test('route Compare: the 95-row bars table — thead sticks to the region top after 500 px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${GALLERY}txr-shell-route-compare-long`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)
  await sizeFrame(page, 900)

  const label = 'Methods'
  expect((await regionScroll(page, label))!.overflow, 'the 95-row table overflows').toBe(true)
  await scrollRegionTo(page, label, 500)
  const sticky = await page.evaluate(() => {
    const regionEl = document.querySelector<HTMLElement>('[aria-label="Methods"]')!
    const table = regionEl.querySelector<HTMLElement>('[data-testid="txr-bars"]')!
    const regionTop = regionEl.getBoundingClientRect().top
    const headerCells = Array.from(table.querySelectorAll<HTMLElement>('thead th, thead td'))
    return {
      scrollTop: regionEl.scrollTop,
      headerCells: headerCells.length,
      stuck: headerCells.filter(th => Math.abs(th.getBoundingClientRect().top - regionTop) <= 2).length,
    }
  })
  expect(sticky.scrollTop).toBe(500)
  expect(sticky.headerCells).toBeGreaterThan(0)
  expect(sticky.stuck, 'the bars thead sticks to the region top').toBe(sticky.headerCells)
})

test('route Method: the 95-row one-method table — thead sticks to the region top after 500 px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${GALLERY}txr-shell-route-method-long`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)
  await sizeFrame(page, 900)

  const label = 'Methods'
  expect((await regionScroll(page, label))!.overflow, 'the 95-row table overflows').toBe(true)
  await scrollRegionTo(page, label, 500)
  const sticky = await page.evaluate(() => {
    const regionEl = document.querySelector<HTMLElement>('[aria-label="Methods"]')!
    const table = regionEl.querySelector<HTMLElement>('[data-testid="txr-bars"]')!
    const regionTop = regionEl.getBoundingClientRect().top
    const headerCells = Array.from(table.querySelectorAll<HTMLElement>('thead th, thead td'))
    return {
      scrollTop: regionEl.scrollTop,
      headerCells: headerCells.length,
      stuck: headerCells.filter(th => Math.abs(th.getBoundingClientRect().top - regionTop) <= 2).length,
    }
  })
  expect(sticky.scrollTop).toBe(500)
  expect(sticky.headerCells).toBeGreaterThan(0)
  expect(sticky.stuck, 'the bars thead sticks to the region top').toBe(sticky.headerCells)
})

// ── TEST-AS-3: the keyboard byte (Tab / PageDown / Space / Home / End) ──────

test('keyboard: Tab reaches the region, PageDown/Space/Home/End scroll it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${GALLERY}txr-shell-route-results-long`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)
  await sizeFrame(page, 900)

  // Tab from the shell's skip link until the first region holds the focus
  // (the audit's "Tab reaches each region").
  await page.evaluate(() => {
    ;(document.querySelector<HTMLElement>('.txr-shell-skip-link')!).focus({ preventScroll: true })
  })
  let reached = false
  for (let i = 0; i < 60; i += 1) {
    await page.keyboard.press('Tab')
    const isRegion = await page.evaluate(
      () => document.activeElement?.getAttribute('role') === 'region',
    )
    if (isRegion) {
      reached = true
      break
    }
  }
  expect(reached, 'Tab reaches a region').toBe(true)

  // The window never scrolls while the keys move the region (shell mode).
  const scrollY = () => page.evaluate(() => window.scrollY)
  const region = () => page.locator('[aria-label="Patient predictions"]')
  const top = () => region().evaluate(el => el.scrollTop)
  const max = () =>
    region().evaluate(el => el.scrollHeight - el.clientHeight)

  const start = await top()
  await page.keyboard.press('PageDown')
  await page.waitForTimeout(120)
  const afterPage = await top()
  expect(afterPage, 'PageDown scrolls the region').toBeGreaterThan(start)
  expect(await scrollY(), 'the document never moved').toBe(0)

  await page.keyboard.press('Space')
  await page.waitForTimeout(120)
  const afterSpace = await top()
  expect(afterSpace, 'Space scrolls the region').toBeGreaterThan(afterPage - 1)
  expect(await scrollY(), 'the document never moved').toBe(0)

  await page.keyboard.press('End')
  await page.waitForTimeout(120)
  const atEnd = await top()
  expect(Math.abs(atEnd - (await max())), 'End reaches the region bottom').toBeLessThanOrEqual(2)

  await page.keyboard.press('Home')
  await page.waitForTimeout(120)
  expect(await top(), 'Home returns to the region top').toBeLessThanOrEqual(2)
  expect(await scrollY(), 'the document never moved').toBe(0)
})

// ── TEST-AS-3: the Back-scroll-restore byte (the in-memory per-route cache) ──

test('Back: a region keeps its scroll position while the view is away and restores it on re-entry', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${GALLERY}txr-scroll-restore`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)

  await scrollRegionTo(page, 'Notes', 420)
  await page.getByText('Go to B', { exact: true }).click()
  await expect(page.locator('[aria-label="Other"]')).toBeVisible()
  await page.getByText('Back to A', { exact: true }).click()
  await expect(page.locator('[aria-label="Notes"]')).toBeVisible()
  const restored = await page.locator('[aria-label="Notes"]').evaluate(el => el.scrollTop)
  expect(Math.abs(restored - 420), 'the region restores its scroll').toBeLessThanOrEqual(2)
})

// ── TEST-AS-3: the flow-mode byte at 390x844 on every route ─────────────────

for (const route of ROUTES) {
  test(`route ${route.label}: the 390x844 flow byte — the document scrolls, the header is sticky and one row`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${GALLERY}${route.slug}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(SETTLE)

    const flow = await page.evaluate(() => {
      const html = document.documentElement
      const header = document.querySelector<HTMLElement>('.txr-shell-header')!
      window.scrollTo(0, 300)
      const frame = document.querySelector<HTMLElement>('[data-gallery-frame]')
      return {
        flowClass: html.classList.contains('txr-shell-mode-flow'),
        overflow: getComputedStyle(html).overflow,
        scrollY: window.scrollY,
        headerPosition: getComputedStyle(header).position,
        headerHeight: header.getBoundingClientRect().height,
        frameOverflow: frame === null ? -1 : frame.scrollWidth - frame.clientWidth,
      }
    })
    expect(flow.flowClass, `${route.label} flow class`).toBe(true)
    expect(flow.overflow, `${route.label} doc overflow is not hidden`).not.toBe('hidden')
    expect(flow.scrollY, `${route.label} document scrolls in flow mode`).toBeGreaterThan(0)
    expect(flow.headerPosition, `${route.label} header is sticky`).toBe('sticky')
    expect(flow.headerHeight, `${route.label} header is one 56 px row`).toBe(56)
    expect(flow.frameOverflow, `${route.label} no horizontal overflow at 390`).toBeLessThanOrEqual(1)
  })
}
