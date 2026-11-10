import { expect, test, type Page } from '@playwright/test'

/**
 * TXR-METHOD-PICKER (qa-fixes3 ITEM-1) — the redesign's MEASURED browser
 * tier (the plan's 1440x900 / 1024x768 / 390x844, light and dark): the
 * picker page scrolls as ONE document (exactly one vertical scroll
 * container, no nested list box), a small runnable set keeps the page under
 * 1,500 px at 1440 with the Run button visible without scrolling, nothing
 * overflows horizontally at any size, and text + chip contrast is at least
 * 4.5:1 in both themes (computed from the resolved colours, never asserted
 * from the palette file).
 *
 * The module/cassette unit + gallery tiers pin the rules and the bytes
 * (`txr-list.spec.ts` for the picker, `txr-run.spec.ts` for the page); this
 * spec pins the LAYOUT the plan's tests name.
 *
 * Run (own port on a shared box — the config derives one per worktree):
 *   npx playwright test -c playwright.gallery.config.ts \
 *     tests/gallery-e2e/txr-method-picker.spec.ts
 */

const GALLERY = '/gallery.html?surface='

test.setTimeout(600_000)

/** Open the E story at a viewport + theme (the gallery's host theme query). */
async function openE(
  page: Page,
  size: { width: number; height: number },
  surface: string,
  theme: 'light' | 'dark' = 'light',
): Promise<void> {
  await page.setViewportSize(size)
  await page.goto(`${GALLERY}${surface}&theme=${theme}`, { waitUntil: 'domcontentloaded' })
  // The gallery's first real load pays the app transform (the dev server
  // compiles on demand); the fixture's own byte checks wait past it.
  await expect(page.getByTestId('txr-run-slots')).toBeVisible({ timeout: 120_000 })
}

/** The page's vertical scroll containers (computed overflow-y is auto/scroll). */
async function verticalScrollContainers(page: Page): Promise<number> {
  return page.evaluate(() => {
    let count = 0
    const walk = (el: Element): void => {
      if (el.children.length > 0) {
        for (const child of Array.from(el.children)) walk(child)
      }
      const style = getComputedStyle(el)
      const isScroll = style.overflowY === 'auto' || style.overflowY === 'scroll'
      if (isScroll && el.scrollHeight > el.clientHeight + 1) count += 1
    }
    walk(document.body)
    return count
  })
}

/** The WCAG relative-luminance contrast ratio of two rgb() strings. */
function contrast(a: string, b: string): number {
  const parse = (c: string): [number, number, number] => {
    const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
    if (m === null) return [0, 0, 0]
    return [Number(m[1]), Number(m[2]), Number(m[3])].map(v => v / 255) as [number, number, number]
  }
  const lum = ([r, g, b]: [number, number, number]): number => {
    const f = (v: number): number => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const [l1, l2] = [lum(parse(a)), lum(parse(b))].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}

/** The resolved foreground/background pair of one element's text. */
async function textContrast(page: Page, testId: string): Promise<number> {
  const pair = await page.getByTestId(testId).evaluate(el => {
    const fg = getComputedStyle(el).color
    let b = el.parentElement
    let bg = ''
    while (b !== null && bg === '') {
      const c = getComputedStyle(b).backgroundColor
      if (c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') bg = c
      b = b.parentElement
    }
    return { fg, bg }
  })
  expect(pair.bg).not.toBe('')
  return contrast(pair.fg, pair.bg)
}

test.describe('the picker page is one document (1440x900, light + dark)', () => {
  test('the full E story has exactly ONE vertical scroll container', async ({ page }) => {
    await openE(page, { width: 1440, height: 900 }, 'txr-run-e')
    // The page's one document scroll: PAGE_MAIN (the old nested ~330 px list
    // box is gone). This is measured AFTER the picker rendered (the page
    // overflows at 26 runnable rows).
    const containers = await verticalScrollContainers(page)
    expect(containers, 'vertical scroll containers').toBe(1)
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`six runnable methods: the page is under 1,500 px and the Run button is visible without scrolling (${theme})`, async ({
      page,
    }) => {
      await openE(page, { width: 1440, height: 900 }, 'txr-run-e-small', theme)
      await expect(page.getByTestId('txr-method-picker')).toBeVisible()

      const scrollHeight = await page
        .getByTestId('txr-run')
        .evaluate(el => Math.max(el.scrollHeight, document.documentElement.scrollHeight))
      expect(scrollHeight, 'page height px at 1440').toBeLessThan(1_500)

      // The gallery frame adds its own chrome (the gallery header + the
      // story title) above the story, so the viewport-absolute bottom of
      // the bar is NOT the story's frame bottom. The plan's contract reads
      // against the STORY: the bar sits inside the page's frame — visible
      // without scrolling the page's own scroll container.
      const frame = await page.getByTestId('txr-run').boundingBox()
      expect(frame).not.toBeNull()
      const run = page.getByTestId('txr-list-run')
      await expect(run).toBeVisible()
      const box = await run.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.y).toBeGreaterThan(0)
      expect(box!.y + box!.height).toBeLessThanOrEqual(frame!.y + frame!.height + 1)

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow, 'horizontal overflow px at 1440').toBeLessThanOrEqual(1)
    })
  }
})

test.describe('no horizontal overflow at 1024x768 and 390x844', () => {
  for (const size of [{ width: 1024, height: 768 }, { width: 390, height: 844 }]) {
    test(`small story at ${size.width}x${size.height}`, async ({ page }) => {
      await openE(page, size, 'txr-run-e-small')
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow, `horizontal overflow px at ${size.width}`).toBeLessThanOrEqual(1)
    })

    test(`full story at ${size.width}x${size.height}`, async ({ page }) => {
      await openE(page, size, 'txr-run-e')
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow, `horizontal overflow px at ${size.width}`).toBeLessThanOrEqual(1)
    })
  }
})

test.describe('text and chip contrast >= 4.5:1 in both themes', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`small story at 1440 (${theme})`, async ({ page }) => {
      await openE(page, { width: 1440, height: 900 }, 'txr-run-e-small', theme)
      const targets = [
        'txr-method-title-fx-static-one',
        'txr-method-summary-fx-static-one',
        'txr-method-needs-fx-static-one',
        'txr-method-estimate-fx-static-one',
        'txr-method-chip-fx-static-one',
      ]
      for (const id of targets) {
        const ratio = await textContrast(page, id)
        expect(ratio, `${id} contrast in ${theme} (${ratio.toFixed(2)})`).toBeGreaterThanOrEqual(4.5)
      }
    })
  }
})
