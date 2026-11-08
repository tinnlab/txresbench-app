import { expect, test } from '@playwright/test'

/**
 * TXRHELP — the Help page's real-browser guard (ITEM-4's gallery-e2e spec,
 * TEST-QA-4, backend-free: the `txrhelp/gallery.tsx` stories mount the REAL
 * `HelpPage` — the page reads no provider, its content is the module's own
 * typed data, so no cassette is needed).
 *
 * Spec ↔ TESTS.md enumeration:
 *   · TEST-QA-4 — every section renders; the TOC links every anchor and
 *     every anchor resolves; one entry per closed validator code; the deep
 *     link scrolls its entry into view; light AND dark both render
 *     correctly (the measured page background follows the token theme);
 *     the 390 px story has no horizontal overflow and the TOC/tables wrap
 *     inside the pane.
 *
 * The host theme query (`?theme=light|dark`) is the command-palette
 * spec's convention; the page's colours are the kit token layer's vars, so
 * the same story renders both themes without a theme-switch control.
 *
 * Run (own port on a shared box — the config derives one per worktree):
 *   npx playwright test -c playwright.gallery.config.ts \
 *     tests/gallery-e2e/txr-help.spec.ts
 */

const GALLERY = '/gallery.html?surface='

// The gallery's module graph is transformed ON DEMAND by Vite: the first
// test on a freshly booted server pays the whole graph's transform AND the
// first-load dependency optimizer — measured on this box at ~14 min with
// the machine at load 250-300, and the first load alone was still past a
// 10-min cap (the txr-history spec's convention, with a wider clock: the
// optimizer + transform both land on the FIRST test; every later test in
// this worker reuses the warm server).
test.setTimeout(2_400_000)

/** The section anchors the page owns (content.ts order). */
const SECTIONS = [
  'overview',
  'steps',
  'files',
  'choosing-methods',
  'results',
  'models',
  'history',
  'privacy',
  'data-location',
  'troubleshooting',
]

/** Every problem-code entry's anchor (the closed 28-code set). */
const PROBLEM_ANCHORS = [
  'problem-r01',
  'problem-r02',
  'problem-r03',
  'problem-r04',
  'problem-r05',
  'problem-r06',
  'problem-r07',
  'problem-r08',
  'problem-r09',
  'problem-r10',
  'problem-r11',
  'problem-r12',
  'problem-r13',
  'problem-r14',
  'problem-r15',
  'problem-r16',
  'problem-r17',
  'problem-r18',
  'problem-r19',
  'problem-r20',
  'problem-r21',
  'problem-a01',
  'problem-a02',
  'problem-a03',
  'problem-a04',
  'problem-a05',
  'problem-a06',
  'problem-a07',
]

test.describe('txr-help — the full page (TEST-QA-4)', () => {
  test('every section and every closed code entry renders; the TOC links every anchor', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-help`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('txr-help')).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: 'Help' })).toBeVisible()

    for (const id of SECTIONS) {
      await expect(page.getByTestId(`txr-help-section-${id}`)).toBeVisible()
      const link = page.getByTestId(`txr-help-toc-${id}`)
      await expect(link).toBeVisible()
      await expect(link).toHaveAttribute('href', new RegExp(`#${id}$`))
    }

    for (const anchor of PROBLEM_ANCHORS) {
      await expect(page.getByTestId(`txr-help-problem-${anchor}`)).toBeVisible()
    }
    // Every anchor id exists in the document (the deep-link target).
    const missing = await page.evaluate(anchors => {
      return anchors.filter(anchor => document.getElementById(anchor) === null)
    }, PROBLEM_ANCHORS)
    expect(missing).toEqual([])
    const missingSections = await page.evaluate(anchors => {
      return anchors.filter(anchor => document.getElementById(anchor) === null)
    }, SECTIONS)
    expect(missingSections).toEqual([])
  })

  test('a TOC click scrolls the section into view (anchor navigation)', async ({ page }) => {
    await page.goto(`${GALLERY}txr-help`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('txr-help-section-troubleshooting')).toBeVisible()

    await page.getByTestId('txr-help-toc-troubleshooting').click()
    // The scroll target lands near the top of the scrollport (the page's
    // scrollMarginTop is 16 px; allow the harness chrome).
    const top = await page
      .getByTestId('txr-help-section-troubleshooting')
      .evaluate(el => el.getBoundingClientRect().top)
    expect(top).toBeGreaterThanOrEqual(-5)
    expect(top).toBeLessThanOrEqual(80)
  })
})

test.describe('txr-help — light and dark (TEST-QA-4)', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`[${theme}] the page background follows the token theme and stays readable`, async ({
      page,
    }) => {
      await page.goto(`${GALLERY}txr-help&theme=${theme}`, { waitUntil: 'domcontentloaded' })
      await expect(page.getByTestId('txr-help')).toBeVisible()
      const measured = await page
        .getByTestId('txr-help')
        .evaluate(el => ({
          background: getComputedStyle(el).backgroundColor,
          color: getComputedStyle(el).color,
        }))
      expect(measured.background, 'the page must render an opaque background').not.toBe(
        'rgba(0, 0, 0, 0)',
      )
      // The token layer's colours are oklch; parse the LIGHTNESS channel
      // (the first number): 1 = white, 0 = black. The theme tokens are
      // `--background: oklch(1 0 0)` light / `oklch(0.145 0 0)` dark and
      // the foreground is the inverse, so lightness alone proves the page
      // follows the theme in both directions.
      const lightness = (value: string): number => {
        const oklch = value.match(/oklch\(([\d.]+)/)
        if (oklch) return parseFloat(oklch[1])
        const rgb = (value.match(/\d+/g) ?? []).map(Number)
        return rgb.length >= 3 ? (rgb[0] + rgb[1] + rgb[2]) / (3 * 255) : NaN
      }
      const bgLight = lightness(measured.background)
      const fgLight = lightness(measured.color)
      expect(Number.isFinite(bgLight), `unparsed background ${measured.background}`).toBe(true)
      if (theme === 'dark') {
        expect(bgLight, `dark background ${measured.background}`).toBeLessThan(0.3)
        expect(fgLight, `dark text color ${measured.color}`).toBeGreaterThan(0.6)
      } else {
        expect(bgLight, `light background ${measured.background}`).toBeGreaterThan(0.9)
        expect(fgLight, `light text color ${measured.color}`).toBeLessThan(0.3)
      }
    })
  }
})

test.describe('txr-help-narrow-390 — the mobile width (TEST-QA-4)', () => {
  test('no horizontal overflow; the TOC and the tables wrap inside the pane', async ({ page }) => {
    await page.goto(`${GALLERY}txr-help-narrow-390`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('txr-help')).toBeVisible()

    const pageOverflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(pageOverflow, 'page horizontal overflow px').toBeLessThanOrEqual(1)

    // The pane itself (the 390 frame) scrolls nothing sideways.
    const paneOverflow = await page
      .getByTestId('txr-help')
      .evaluate(el => el.scrollWidth - el.clientWidth)
    expect(paneOverflow, 'pane horizontal overflow px').toBeLessThanOrEqual(1)

    // The TOC stacks above the sections at narrow widths.
    const tocBox = await page
      .getByRole('navigation', { name: 'On this page' })
      .boundingBox()
    const firstBox = await page.getByTestId('txr-help-section-overview').boundingBox()
    expect(tocBox, 'the TOC must be mounted').not.toBeNull()
    expect(firstBox, 'the first section must be mounted').not.toBeNull()
    expect(tocBox!.x + tocBox!.width, 'the TOC fits the pane').toBeLessThanOrEqual(390 + 1)

    // A table stays reachable (its own wrapper scrolls, the page does not).
    await page.getByTestId('txr-help-toc-files').click()
    await expect(page.locator('table').first()).toBeVisible()
    const tableWrap = await page
      .locator('table')
      .first()
      .evaluate(el => {
        const wrapper = el.parentElement
        const page = document.querySelector('[data-testid="txr-help"]')
        const w = wrapper!.getBoundingClientRect()
        const p = page!.getBoundingClientRect()
        return {
          scrollable: wrapper!.scrollWidth - wrapper!.clientWidth,
          // The wrapper must stay inside the page's own box (the harness
          // chrome around the story may offset it, so the frame-absolute
          // measure is the page's, not the viewport's).
          fits: w.right - p.right,
          pageWidth: p.width,
        }
      })
    expect(tableWrap.scrollable, 'the table wraps and scrolls inside its pane').toBeGreaterThan(0)
    expect(tableWrap.fits, 'the table wrapper stays inside the 390 frame').toBeLessThanOrEqual(1)
  })
})
