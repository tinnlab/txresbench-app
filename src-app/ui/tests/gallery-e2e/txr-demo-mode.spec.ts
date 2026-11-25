import { expect, test, type Page } from '@playwright/test'

/**
 * TEST-DM-5 (browser half) — the demo notice bar + the header download
 * link, driven through the gallery tier (backend-free: the demo module's
 * cassette answers the boot mode read; `?demo=1` makes every surface boot
 * in demo mode — see the demo gallery's header comment).
 *
 * Legs (the plan's notice-bar test):
 *  · present on EVERY shell route in demo (the real shell-route surfaces
 *    walked with `?demo=1` — the bar is the shell's own child, the routes
 *    are content);
 *  · absent in desktop (the same surfaces without the flag);
 *  · link attributes (the primary → download_url, new tab, noopener; the
 *    secondary → /help#demo; the close button's accessible name);
 *  · closable, remembered for the browser session (sessionStorage), back in
 *    a new session (a fresh browser context);
 *  · no overlap with the header or the body at 1440 (bounding boxes);
 *  · at 390: the text wraps to at most three lines, the buttons sit below
 *    it, no horizontal overflow (the plan's phone byte).
 *
 * Run (own port on a shared box — the config derives one per worktree):
 *   npx playwright test -c playwright.gallery.config.ts \
 *     tests/gallery-e2e/txr-demo-mode.spec.ts
 */
const GALLERY = '/gallery.html'

test.setTimeout(900_000)

/** Every real shell-route surface (the shell + one route's content). */
const ROUTE_SURFACES = [
  'txr-shell-route-start',
  'txr-shell-route-study',
  'txr-shell-route-files',
  'txr-shell-route-predict-files',
  'txr-shell-route-choose-methods',
  'txr-shell-route-running',
  'txr-shell-route-results',
  'txr-shell-route-compare',
  'txr-shell-route-method',
  'txr-shell-route-history',
  'txr-shell-route-models',
  'txr-shell-route-choose-models',
  'txr-shell-route-help',
  'txr-shell-route-not-found',
  'txr-shell-route-results-long',
  'txr-shell-route-compare-long',
  'txr-shell-route-method-long',
]

/** The walk in thirds: each test carries its own long budget (the gallery
 *  transforms each surface's lazy chunks on demand on a loaded box). */
const ROUTE_GROUPS = [
  ROUTE_SURFACES.slice(0, 6),
  ROUTE_SURFACES.slice(6, 12),
  ROUTE_SURFACES.slice(12),
]

const NOTICE = '[data-testid="txr-demo-notice"]'
const HEADER_LINK = '[data-testid="txr-demo-header-download"]'
const SETTLE = 2200

function surfaceUrl(slug: string, extra: string): string {
  return `${GALLERY}?surface=${slug}${extra}`
}

async function openSurface(page: Page, slug: string, extra = ''): Promise<void> {
  await page.goto(surfaceUrl(slug, extra), { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(SETTLE)
}

function boxesOf(page: Page) {
  return page.evaluate(() => {
    const q = (sel: string) => document.querySelector<HTMLElement>(sel)
    const r = (el: HTMLElement | null) => (el ? el.getBoundingClientRect() : null)
    return {
      header: r(q('.txr-shell-header')),
      notice: r(q('[data-testid="txr-demo-notice"]')),
      text: r(q('[data-testid="txr-demo-notice"] .txr-demo-notice-text')),
      actions: r(q('[data-testid="txr-demo-notice"] .txr-demo-notice-actions')),
      body: r(q('.txr-app-shell-body')),
      link: r(q('[data-testid="txr-demo-header-download"]')),
    }
  })
}

test.describe('txr-demo-mode — notice bar (TEST-DM-5)', () => {
  // The FIRST load of a freshly booted gallery server pays the whole
  // module-graph transform (thousands of on-demand modules on a loaded box —
  // measured beyond the 15-minute mark in the first attempts). Warming it
  // here, with its own generous budget, keeps the routes walk's budgets
  // honest — it is ALSO a real assertion (the notice bar on the wide shell
  // surface, cold).
  test('warmup: the first load — notice bar on the wide shell surface (cold transform)', async ({ page }) => {
    test.setTimeout(1_800_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(surfaceUrl('txr-demo-notice', ''), { waitUntil: 'domcontentloaded' })
    await expect(page.locator(NOTICE)).toHaveCount(1, { timeout: 120_000 })
  })

  for (const [index, group] of ROUTE_GROUPS.entries()) {
    test(`demo: the notice bar + the header download link are present on every shell route (${index + 1}/${ROUTE_GROUPS.length})`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 })
      const failures: string[] = []
      for (const slug of group) {
        try {
          await page.goto(surfaceUrl(slug, '&demo=1'), { waitUntil: 'domcontentloaded' })
          await expect(page.locator(NOTICE), `notice on ${slug}`).toHaveCount(1, { timeout: 30_000 })
          await expect(page.locator(HEADER_LINK), `header link on ${slug}`).toHaveCount(1, { timeout: 5_000 })
        } catch (error) {
          failures.push(`${slug}: ${String(error).split('\n')[0]}`)
        }
      }
      expect(failures, 'the notice bar and the header link on every shell route').toEqual([])
    })
  }

  test('desktop: the notice bar and the header link are absent', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    for (const slug of ['txr-shell-route-start', 'txr-shell-route-history']) {
      await openSurface(page, slug)
      await expect(page.locator(NOTICE)).toHaveCount(0)
      await expect(page.locator(HEADER_LINK)).toHaveCount(0)
    }
  })

  test('1440: the bar sits under the header, the body starts below it — no overlap; the links carry their attributes', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openSurface(page, 'txr-demo-notice')

    await expect(page.locator(NOTICE)).toBeVisible()
    const boxes = await boxesOf(page)
    expect(boxes.header).not.toBeNull()
    expect(boxes.notice).not.toBeNull()
    expect(boxes.body).not.toBeNull()
    // The three column children stack, touching, never intersecting.
    expect(boxes.notice!.top).toBeGreaterThanOrEqual(boxes.header!.bottom - 1)
    expect(boxes.body!.top).toBeGreaterThanOrEqual(boxes.notice!.bottom - 1)

    const primary = page.getByTestId('txr-demo-notice-download')
    await expect(primary).toBeVisible()
    await expect(primary).toHaveAttribute('href', 'https://downloads.example.test/txresbench')
    await expect(primary).toHaveAttribute('target', '_blank')
    await expect(primary).toHaveAttribute('rel', 'noopener noreferrer')
    const secondary = page.getByTestId('txr-demo-notice-help')
    await expect(secondary).toHaveAttribute('href', '/help#demo')
    const close = page.getByTestId('txr-demo-notice-close')
    await expect(close).toHaveAttribute('aria-label', 'Close the demo notice')

    // The header download link sits inside the 56 px header row, before the
    // nav (the actions row's own order), and inside the viewport.
    const headerBox = boxes.header!
    const linkBox = boxes.link!
    expect(linkBox).not.toBeNull()
    expect(linkBox.top).toBeGreaterThanOrEqual(headerBox.top)
    expect(linkBox.bottom).toBeLessThanOrEqual(headerBox.bottom + 1)
    expect(linkBox.right).toBeLessThanOrEqual(1440)
    expect(linkBox.left).toBeGreaterThanOrEqual(0)
  })

  test('closing hides it for the browser session; a new session brings it back', async ({ page, browser }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openSurface(page, 'txr-demo-notice')
    await expect(page.locator(NOTICE)).toBeVisible()

    await page.getByTestId('txr-demo-notice-close').click()
    await expect(page.locator(NOTICE)).toHaveCount(0)

    // Same browser session: a reload re-boots the app, the store reads the
    // sessionStorage close at birth — the bar stays hidden.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(SETTLE)
    await expect(page.locator(NOTICE)).toHaveCount(0)

    // A NEW browser session: the bar returns.
    const ctx = await browser.newContext()
    const fresh = await ctx.newPage()
    try {
      await fresh.goto(surfaceUrl('txr-demo-notice', ''), { waitUntil: 'domcontentloaded' })
      await fresh.waitForTimeout(SETTLE)
      await expect(fresh.locator(NOTICE)).toBeVisible()
    } finally {
      await ctx.close()
    }
  })

  test('390: the text wraps to at most three lines, the buttons sit below it, no horizontal overflow', async ({ page }) => {
    // The gallery host leaves its own chrome beside the frame (~82 px on
    // this box — the phone spec's measured number); a viewport of 474 makes
    // the 390 story render at exactly 390.
    await page.setViewportSize({ width: 474, height: 900 })
    await openSurface(page, 'txr-demo-notice-narrow')

    const narrow = page.getByTestId('txr-demo-notice-narrow')
    await expect(narrow).toBeVisible()
    const width = Math.round((await narrow.boundingBox())!.width)
    expect(width, 'the 390 frame').toBeGreaterThanOrEqual(360)
    expect(width, 'the 390 frame').toBeLessThanOrEqual(410)

    const m = await page.evaluate(() => {
      const notice = document.querySelector<HTMLElement>('[data-testid="txr-demo-notice"]')!
      const text = notice.querySelector<HTMLElement>('.txr-demo-notice-text')!
      const actions = notice.querySelector<HTMLElement>('.txr-demo-notice-actions')!
      const header = document.querySelector<HTMLElement>('.txr-shell-header')!
      const body = document.querySelector<HTMLElement>('.txr-app-shell-body')!
      const style = getComputedStyle(text)
      const lineHeight = parseFloat(style.lineHeight)
      const r = (el: Element) => el.getBoundingClientRect()
      return {
        font: style.fontSize,
        lineHeight,
        text: r(text),
        actions: r(actions),
        notice: r(notice),
        header: r(header),
        body: r(body),
        overflow: notice.scrollWidth - notice.clientWidth,
        contents: notice.scrollHeight - notice.clientHeight,
      }
    })

    // The narrow byte (container query <=700) applies: the smaller font.
    expect(m.font).toBe('11.5px')
    // At most THREE text lines (the plan's byte).
    expect(m.text.height, 'text wraps to at most three lines').toBeLessThanOrEqual(
      3 * m.lineHeight + 2,
    )
    // The buttons sit BELOW the text.
    expect(m.actions.top, 'buttons below the text').toBeGreaterThanOrEqual(m.text.bottom - 2)
    // No horizontal overflow, and the bar keeps its own height (no overlap).
    expect(m.overflow, 'no horizontal overflow').toBeLessThanOrEqual(1)
    expect(m.notice.top).toBeGreaterThanOrEqual(m.header.bottom - 1)
    expect(m.body.top).toBeGreaterThanOrEqual(m.notice.bottom - 1)
    expect(m.contents).toBeLessThanOrEqual(1)
  })
})
