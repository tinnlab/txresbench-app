import { expect, test } from '@playwright/test'

/**
 * TEST-AS-1 (browser half) — the app-shell primitives, driven through the
 * gallery tier (backend-free; the seeded stories answer the real
 * components). This is the ITEM-1 leg of the audit's section 4, on the
 * primitives themselves: the document never scrolls in shell mode, the
 * header stays put while a region scrolls, the table header sticks, the
 * scroll position restores, the mode switches at the breakpoints (the
 * window is resized in the test), and the focus order (skip link first,
 * each region reachable).
 *
 * The per-route checks over all 14 routes (the audit section-4 matrix) are
 * ITEM-4's spec (`txr-shell.spec.ts`); this spec owns the primitives the
 * routes will be built from.
 *
 * Run: npx playwright test -c playwright.gallery.config.ts
 *      tests/gallery-e2e/txr-shell-primitives.spec.ts
 */
const GALLERY = '/gallery.html'

// The gallery's module graph is transformed on demand by Vite — the first
// surfaces pay the whole graph on a loaded box. The three tests are grouped
// to load each surface once; the shared budget covers the cold start (the
// theme-phone spec's precedent).
test.setTimeout(900_000)

function surfaceUrl(slug: string): string {
  return `${GALLERY}?surface=${slug}`
}

/** The seeded stories settle after their mount-time store seed. */
const SETTLE = 2600

/** Set a region's scrollTop and let the browser fire the scroll event. */
async function scrollRegionTo(page: import('@playwright/test').Page, label: string, top: number) {
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

test('shell mode: the document never scrolls, the header stays put while a region scrolls, the focus order', async ({
  page,
}) => {
  await page.goto(surfaceUrl('txr-app-shell'), { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)

  // The shell put its mode class on the document and the document rules
  // are the fixed ones (DEC-1).
  const doc = await page.evaluate(() => ({
    classShell: document.documentElement.classList.contains('txr-shell-mode-shell'),
    overflow: getComputedStyle(document.documentElement).overflow,
  }))
  expect(doc.classShell).toBe(true)
  expect(doc.overflow).toBe('hidden')

  // The document itself cannot scroll — a scrollTo on the window leaves
  // scrollY at zero.
  const scrollY = await page.evaluate(() => {
    window.scrollTo(0, 600)
    return window.scrollY
  })
  expect(scrollY).toBe(0)

  // The header's top does not move when the body region scrolls.
  const before = await page.locator('.txr-shell-header').boundingBox()
  expect(before).not.toBeNull()
  await scrollRegionTo(page, 'Body region', 500)
  const regionTop = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[aria-label="Body region"]')
    return el ? el.scrollTop : -1
  })
  expect(regionTop).toBeGreaterThan(0)
  const after = await page.locator('.txr-shell-header').boundingBox()
  expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1)
  // The bottom bar (fixed) stays visible below the region.
  const bar = await page.locator('.txr-page-footer-bar').boundingBox()
  expect(bar).not.toBeNull()

  // Focus order: the skip link is the FIRST focusable element of the shell
  // (DOM order is the tab order) and precedes the brand; Tab from it
  // reaches the brand, never a header control first, and Tab onwards
  // reaches the region. (The gallery host has its own chrome before the
  // story frame, so the "first tab stop of the DOCUMENT" byte belongs to
  // the real-app tier — the shell-global spec; here the shell's own order
  // is proved.)
  const order = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>('.txr-shell')!
    const skip = shell.querySelector<HTMLElement>('[data-testid="txr-shell-skip-link"]')!
    const focusables = Array.from(
      shell.querySelectorAll<HTMLElement>('a[href], button, [tabindex="0"], [role="region"]'),
    )
    return {
      skipFirst: focusables[0]?.getAttribute('data-testid') ?? null,
      skipBeforeBrand: Boolean(
        skip.compareDocumentPosition(
          shell.querySelector<HTMLElement>('.txr-shell-brand')!,
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    }
  })
  expect(order.skipFirst).toBe('txr-shell-skip-link')
  expect(order.skipBeforeBrand).toBe(true)
  await page.evaluate(() => {
    ;(document.querySelector<HTMLElement>('.txr-shell-skip-link')!).focus()
  })
  await page.keyboard.press('Tab')
  const second = await page.evaluate(() => document.activeElement?.className ?? null)
  expect(second).toContain('txr-shell-brand')

  let reachedRegion = false
  for (let i = 0; i < 14; i += 1) {
    const isRegion = await page.evaluate(
      () => document.activeElement?.getAttribute('role') === 'region',
    )
    if (isRegion) {
      reachedRegion = true
      break
    }
    await page.keyboard.press('Tab')
  }
  expect(reachedRegion).toBe(true)
})

test('the table header sticks inside the region, the first column sticks left, the virtualised body keeps it, scroll restores', async ({
  page,
}) => {
  // The plain table: sticky header + sticky first column under a real
  // horizontal scroll.
  await page.goto(surfaceUrl('txr-data-table'), { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)
  const regionBox = await page.locator('[data-testid="txr-scroll-region"]').boundingBox()
  expect(regionBox).not.toBeNull()
  await scrollRegionTo(page, 'People and markers', 500)
  const headTop = await page
    .locator('thead th', { hasText: 'Patient' })
    .evaluate(el => el.getBoundingClientRect().top)
  expect(Math.abs(headTop - regionBox!.y)).toBeLessThanOrEqual(1.5)
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[aria-label="People and markers"]')
    if (!el) throw new Error('no region')
    el.scrollLeft = 120
  })
  await page.waitForTimeout(150)
  const firstLeft = await page
    .locator('td.txr-data-table-first-cell', { hasText: 'P0001' })
    .evaluate(el => el.getBoundingClientRect().left)
  expect(Math.abs(firstLeft - regionBox!.x)).toBeLessThanOrEqual(1.5)

  // The virtualised path keeps the sticky header and the full row count.
  await page.goto(surfaceUrl('txr-data-table-virtual'), { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)
  const info = await page.evaluate(() => {
    const t = document.querySelector<HTMLElement>('[data-testid="txr-data-table"]')
    return {
      virtualized: t?.getAttribute('data-virtualized'),
      rowcount: t?.getAttribute('aria-rowcount'),
      rows: t?.querySelectorAll('[role="row"]').length ?? 0,
    }
  })
  expect(info.virtualized).toBe('true')
  expect(info.rowcount).toBe('301')
  expect(info.rows).toBeGreaterThan(0)
  expect(info.rows).toBeLessThan(300)
  const virtualBox = await page.locator('[data-testid="txr-scroll-region"]').boundingBox()
  expect(virtualBox).not.toBeNull()
  await scrollRegionTo(page, 'People and markers', 500)
  const virtualHead = await page
    .locator('[role="columnheader"]', { hasText: 'Patient' })
    .first()
    .evaluate(el => el.getBoundingClientRect().top)
  expect(Math.abs(virtualHead - virtualBox!.y)).toBeLessThanOrEqual(1.5)

  // The scroll position restores on Back (kept per route in memory).
  await page.goto(surfaceUrl('txr-scroll-restore'), { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)
  await scrollRegionTo(page, 'Notes', 420)
  await page.getByText('Go to B', { exact: true }).click()
  await expect(page.locator('[aria-label="Other"]')).toBeVisible()
  await page.getByText('Back to A', { exact: true }).click()
  await expect(page.locator('[aria-label="Notes"]')).toBeVisible()
  const restored = await page.locator('[aria-label="Notes"]').evaluate(el => el.scrollTop)
  expect(Math.abs(restored - 420)).toBeLessThanOrEqual(2)
})

test('the mode switches at the breakpoints when the window is resized, and the nav is a menu below 700 px', async ({
  page,
}) => {
  await page.goto(surfaceUrl('txr-app-shell'), { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)

  const modeAt = async (width: number, height: number) => {
    await page.setViewportSize({ width, height })
    await page.waitForTimeout(250)
    return page.evaluate(() => document.documentElement.className)
  }

  // 768x520 is the inclusive bound (shell); one axis below is flow.
  expect(await modeAt(768, 520)).toContain('txr-shell-mode-shell')
  expect(await modeAt(767, 520)).toContain('txr-shell-mode-flow')
  expect(await modeAt(768, 519)).toContain('txr-shell-mode-flow')
  expect(await modeAt(390, 844)).toContain('txr-shell-mode-flow')

  // Flow mode: the document scrolls. Shell mode: it does not.
  const flow = await page.evaluate(() => {
    window.scrollTo(0, 400)
    return window.scrollY
  })
  expect(flow).toBeGreaterThan(0)
  await modeAt(1024, 768)
  const shellScroll = await page.evaluate(() => {
    window.scrollTo(0, 400)
    return window.scrollY
  })
  expect(shellScroll).toBe(0)

  // The nav collapses to a menu button below 700 px and the row returns
  // above; the theme switch is icon-only below.
  const narrow = await page.evaluate(() => ({
    nav: getComputedStyle(document.querySelector<HTMLElement>('.txr-shell-nav')!).display,
    menu: getComputedStyle(
      document.querySelector<HTMLElement>('.txr-shell-nav-menu')!,
    ).display,
    label: getComputedStyle(
      document.querySelector<HTMLElement>('.txr-theme-toggle .txr-theme-toggle-label')!,
    ).display,
  }))
  await page.setViewportSize({ width: 699, height: 800 })
  await page.waitForTimeout(250)
  const narrowNow = await page.evaluate(() => ({
    nav: getComputedStyle(document.querySelector<HTMLElement>('.txr-shell-nav')!).display,
    menu: getComputedStyle(
      document.querySelector<HTMLElement>('.txr-shell-nav-menu')!,
    ).display,
    label: getComputedStyle(
      document.querySelector<HTMLElement>('.txr-theme-toggle .txr-theme-toggle-label')!,
    ).display,
  }))
  expect(narrowNow.nav).toBe('none')
  expect(narrowNow.menu).not.toBe('none')
  expect(narrowNow.label).toBe('none')

  // The menu is complete: open it with the keyboard, four destinations
  // inside, Escape closes and returns focus.
  const trigger = page.getByTestId('txr-shell-nav-menu-trigger')
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.txr-shell-nav-menu-item')).toHaveCount(4)
  for (const label of ['New analysis', 'Models', 'History', 'Help']) {
    await expect(page.locator('.txr-shell-nav-menu-item', { hasText: label })).toBeVisible()
  }
  await page.keyboard.press('Escape')
  await expect(page.locator('.txr-shell-nav-menu-item')).toHaveCount(0)
  const focusBack = await page.evaluate(
    () => document.activeElement?.getAttribute('data-testid') ?? null,
  )
  expect(focusBack).toBe('txr-shell-nav-menu-trigger')

  await page.setViewportSize({ width: 701, height: 800 })
  await page.waitForTimeout(250)
  const wide = await page.evaluate(() => ({
    nav: getComputedStyle(document.querySelector<HTMLElement>('.txr-shell-nav')!).display,
    menu: getComputedStyle(
      document.querySelector<HTMLElement>('.txr-shell-nav-menu')!,
    ).display,
  }))
  expect(wide.nav).not.toBe('none')
  expect(wide.menu).toBe('none')
  void narrow
})
