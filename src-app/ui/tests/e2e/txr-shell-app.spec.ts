import { expect, test } from '@playwright/test'
import {
  authHeader,
  createRun,
  mintLocalSession,
  seedLocalSession,
  waitForTerminalRun,
} from './txr-results/helpers'

/**
 * TXRSHELL full-backend spec — TEST-AS-3's real-app half (app-shell ITEM-4).
 *
 * The gallery tier (`tests/gallery-e2e/txr-shell.spec.ts`) drives the audit's
 * section-4 checks over the seeded surfaces; THIS spec proves the bytes the
 * gallery cannot (DRIFT-1 ITEM-2 #6, ITEM-3 #2): the RAW document byte
 * (`document.documentElement.scrollHeight <= innerHeight` — the gallery's
 * host chrome sits above the story frame, so the raw byte is only honest
 * under the real app), the real browser Back button, and the real router's
 * history. The run the matrix needs is the all-cannot-run synthetic run
 * (the same `jm-mem-lq` fixture the results full-backend spec uses — no
 * sandbox, no env download, finishes in milliseconds, DEC-14's scope).
 *
 * Spec ↔ TESTS.md:
 *   · TEST-AS-3 — all 14 routes at 1440x900, 1280x720 and 1024x768: the
 *     document does not scroll, 1-2 regions, the header never moves while
 *     every region scrolls; at 390x844 the document scrolls and the header
 *     is sticky and one row; the browser Back button restores a region's
 *     scroll position (the /help article); keyboard Tab reaches the region
 *     and PageDown/Space/Home/End scroll it.
 *
 * The long-table (95/300-row) bytes and the per-route sticky-thead bytes
 * are the gallery tier's (seeded fixtures); the desktop-shape proof is the
 * dev-desktop screenshot leg of the ITEM-4 report.
 */

test.setTimeout(900_000)

/** The catalogue method the engine classifies cannot_run on this inventory. */
const CANNOT_RUN_METHOD = 'jm-mem-lq'

const SIZES = [
  // 1200x800 is the dev-desktop window's own size (the harness's
  // WindowConfig value the qa-hardening ITEM-5 verify measured) — the
  // desktop screenshot leg's geometry is covered here too.
  { width: 1200, height: 800 },
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
] as const

/** The 14 routes of the audit's matrix (the run id + method id of the fixture run). */
function routeList(runId: string): Array<{ path: string; label: string }> {
  return [
    { path: '/', label: 'Start' },
    { path: '/study', label: 'Study' },
    { path: '/files', label: 'Files' },
    { path: '/predict-files', label: 'Predict files' },
    { path: '/choose-methods', label: 'Choose methods' },
    { path: `/analysis/${runId}/running`, label: 'Running' },
    { path: `/analysis/${runId}/results`, label: 'Results' },
    { path: `/analysis/${runId}/results/compare`, label: 'Compare' },
    { path: `/analysis/${runId}/results/methods/${CANNOT_RUN_METHOD}`, label: 'Method' },
    { path: '/history', label: 'History' },
    { path: '/models', label: 'Models' },
    { path: '/saved-models', label: 'Saved models' },
    { path: '/pretrained-models', label: 'Pretrained models' },
    { path: '/help', label: 'Help' },
  ]
}

/** Mint the session, create the fixture run, seed the token — the matrix's setup. */
async function setupRun(page: import('@playwright/test').Page): Promise<string> {
  const token = await mintLocalSession(page)
  await seedLocalSession(page, token)
  const runId = await createRun(page, token, [CANNOT_RUN_METHOD])
  await waitForTerminalRun(page, token, runId)
  return runId
}

/** A region's scroll facts. */
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

async function regionLabels(page: import('@playwright/test').Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="region"]')).map(
      el => el.getAttribute('aria-label') ?? '',
    ),
  )
}

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

test.describe('txr-shell — the audit section-4 bytes under the real app (TEST-AS-3, ITEM-4)', () => {
  for (const size of SIZES) {
    test(`the 14 routes at ${size.width}x${size.height}: the raw document byte, 1-2 regions, the header never moves`, async ({
      page,
    }) => {
      await page.setViewportSize(size)
      const runId = await setupRun(page)
      const header = page.locator('.txr-shell-header')

      for (const route of routeList(runId)) {
        await page.goto(route.path, { waitUntil: 'domcontentloaded' })
        // The app mounts before ANY layout byte is meaningful: the shell
        // header is the mount marker (a loading/blank page would trivially
        // fit the viewport and read zero regions), then the route's OWN
        // data must arrive (the run's detail, the catalogue load) — the
        // pages' loading states are region-less, and the region count is a
        // page-content byte.
        await expect(header).toBeVisible({ timeout: 60_000 })
        await expect
          .poll(() => regionLabels(page).then(l => l.length), {
            timeout: 30_000,
            message: `${route.label} must mount its region(s)`,
          })
          .toBeGreaterThanOrEqual(1)
        // The raw byte: the document does not scroll in shell mode. The
        // pages settle asynchronously, so the byte is polled to its settle
        // — a page that would grow past the viewport stays failing.
        await expect
          .poll(
            () =>
              page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight),
            { timeout: 30_000, message: `${route.label} must fit the viewport` },
          )
          .toBeLessThanOrEqual(0)
        expect(
          await page.evaluate(() =>
            document.documentElement.classList.contains('txr-shell-mode-shell'),
          ),
          `${route.label} is in shell mode`,
        ).toBe(true)

        // One or two regions; the header never moves while EVERY region
        // scrolls.
        const labels = await regionLabels(page)
        expect(labels.length, `${route.label} region count`).toBeGreaterThanOrEqual(1)
        expect(labels.length, `${route.label} region count`).toBeLessThanOrEqual(2)
        const before = await header.boundingBox()
        expect(before, `${route.label} header`).not.toBeNull()
        for (const label of labels) {
          const facts = await regionScroll(page, label)
          if (!facts || !facts.overflow) continue
          await scrollRegionTo(page, label, 500)
          const moved = await regionScroll(page, label)
          expect(moved!.scrollTop, `${route.label} ${label} scrolled`).toBeGreaterThan(0)
          const after = await header.boundingBox()
          expect(
            Math.abs(after!.y - before!.y),
            `${route.label}: the header moved while ${label} scrolled`,
          ).toBeLessThanOrEqual(1)
        }

        // The raw horizontal byte: nothing extends past the viewport edge.
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
          `${route.label} horizontal overflow`,
        ).toBeLessThanOrEqual(1)
      }
    })
  }

  test('the 390x844 flow byte on the real app: the document scrolls, the header is sticky and one row', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await setupRun(page)
    await page.goto('/help', { waitUntil: 'domcontentloaded' })
    // The article must be mounted before the flow byte is measured (the
    // route's loading state trivially fits the viewport and reads scrollY 0).
    await expect(page.locator('[aria-label="Help content"]')).toBeVisible({ timeout: 60_000 })
    const flow = await page.evaluate(async () => {
      const html = document.documentElement
      const header = document.querySelector<HTMLElement>('.txr-shell-header')!
      window.scrollTo(0, 300)
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

  test('the browser Back button restores a region\'s scroll position', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await setupRun(page)

    await page.goto('/help', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[aria-label="Help content"]')).toBeVisible()
    await scrollRegionTo(page, 'Help content', 900)
    expect((await regionScroll(page, 'Help content'))!.scrollTop).toBe(900)

    // The nav link pushes a second entry; the browser Back returns to the
    // help page, and the region's scroll is restored from the per-route
    // cache (the audit's "Back button restores the scroll position").
    await page.locator('.txr-shell-nav .txr-nav-link', { hasText: 'Models' }).click()
    await expect(page).toHaveURL(/\/models$/)
    await page.goBack()
    await expect(page).toHaveURL(/\/help$/)
    await expect(page.locator('[aria-label="Help content"]')).toBeVisible()
    await expect
      .poll(() => regionScroll(page, 'Help content').then(s => s?.scrollTop ?? -1), {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(890)
  })

  test('keyboard on the real app: Tab reaches the region, PageDown/Space/Home/End scroll it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await setupRun(page)
    await page.goto('/help', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[aria-label="Help content"]')).toBeVisible()

    // Tab from the skip link until the article's region holds the focus.
    await page.evaluate(() => {
      ;(document.querySelector<HTMLElement>('.txr-shell-skip-link')!).focus({ preventScroll: true })
    })
    let reached = false
    for (let i = 0; i < 60; i += 1) {
      await page.keyboard.press('Tab')
      const isRegion = await page.evaluate(
        () => document.activeElement?.getAttribute('aria-label') === 'Help content',
      )
      if (isRegion) {
        reached = true
        break
      }
    }
    expect(reached, 'Tab reaches the help region').toBe(true)

    const top = () =>
      page.locator('[aria-label="Help content"]').evaluate(el => el.scrollTop)
    const max = () =>
      page.locator('[aria-label="Help content"]').evaluate(el => el.scrollHeight - el.clientHeight)

    const start = await top()
    await page.keyboard.press('PageDown')
    await page.waitForTimeout(120)
    expect(await top(), 'PageDown scrolls the region').toBeGreaterThan(start)

    await page.keyboard.press('Space')
    await page.waitForTimeout(120)
    const afterSpace = await top()
    expect(afterSpace, 'Space scrolls the region').toBeGreaterThan(start)

    await page.keyboard.press('End')
    await page.waitForTimeout(120)
    expect(Math.abs((await top()) - (await max())), 'End reaches the bottom').toBeLessThanOrEqual(2)

    await page.keyboard.press('Home')
    await page.waitForTimeout(120)
    expect(await top(), 'Home returns to the top').toBeLessThanOrEqual(2)

    // The raw document byte held through the key presses.
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight),
      'the document never scrolled',
    ).toBeLessThanOrEqual(0)
  })
})
