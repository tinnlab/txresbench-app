import { expect, test, type Page } from '@playwright/test'

/**
 * TXR-METHOD-PICKER (qa-fixes3 ITEM-1, re-pinned by app-shell ITEM-2) —
 * the redesign's MEASURED browser tier (the plan's 1440x900 / 1024x768 /
 * 390x844, light and dark). ITEM-2 made the E page a frame page, so the
 * layout byte moved to the shell-wrapped surface (`txr-shell-route-*`,
 * the app's real composition): the routed area fills the shell window
 * (the page never scrolls), the ONE scroll container is the method-list
 * ScrollRegion, the run bar is pinned in the bottom slot. The story
 * surfaces without the shell remain the CONTENT walk host — a frame page
 * there flows with the document and keeps no inner scroll box, which is
 * exactly what the content walk needs. Nothing overflows horizontally at
 * any size, and text + chip contrast is at least 4.5:1 in both themes
 * (computed from the resolved colours, never asserted from the palette
 * file).
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
  await expect(page.getByTestId('txr-run-summary')).toBeVisible({ timeout: 120_000 })
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

/** Give the gallery frame the test viewport's height (the shell's chain). */
async function sizeFrame(page: Page, height: number): Promise<void> {
  await page.evaluate(h => {
    const frame = document.querySelector<HTMLElement>('[data-gallery-frame]')
    if (!frame) throw new Error('no gallery frame')
    frame.style.height = `${h}px`
  }, height)
  await page.waitForTimeout(200)
}

test.describe('the picker page inside the shell (1440x900, light + dark)', () => {
  test('the shell-less story host stays a flowing page: NO inner scroll box, the document scrolls', async ({
    page,
  }) => {
    await openE(page, { width: 1440, height: 900 }, 'txr-run-e')
    // The story surface renders the page WITHOUT the shell (the content walk
    // host); a frame page there flows in the document — the ONE scroll the
    // qa-fixes3 contract named is the document itself, never a nested box.
    const containers = await verticalScrollContainers(page)
    expect(containers, 'inner vertical scroll containers').toBe(0)
    const doc = await page.evaluate(
      () => document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
    )
    expect(doc, 'the document scrolls (26 rows)').toBe(true)
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`the route byte: the routed area fills the shell window and the Run button is pinned (${theme})`, async ({
      page,
    }) => {
      await openE(page, { width: 1440, height: 900 }, 'txr-shell-route-choose-methods', theme)
      await sizeFrame(page, 900)
      await expect(page.getByTestId('txr-method-picker')).toBeVisible()

      // ITEM-2: the page never scrolls — the routed area's height is the
      // shell window's and its content stays inside it.
      const routed = await page
        .getByTestId('txr-run')
        .evaluate(el => ({
          scroll: el.scrollHeight,
          client: el.clientHeight,
          doc: document.documentElement.scrollHeight,
        }))
      expect(routed.scroll, 'the routed area does not overflow').toBeLessThanOrEqual(
        routed.client + 1,
      )
      // The document byte (the shell-mode overflow hidden, the gallery
      // host's chrome sits above the frame — the raw byte is TEST-AS-3's).
      expect(routed.doc, 'the document does not grow past the shell window').toBeLessThan(1_500)

      // The gallery frame adds its own chrome (the gallery header + the
      // story title) above the story, so the viewport-absolute bottom of
      // the bar is NOT the story's frame bottom. The plan's contract reads
      // against the STORY: the bar sits inside the page's frame — visible
      // without scrolling the page's own scroll container.
      const frame = await page.getByTestId('txr-run').boundingBox()
      expect(frame).not.toBeNull()
      const run = page.getByTestId('txr-run-bar-run')
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

test.describe('ITEM-2 — the settings sentence, the recompute + untick toast (the re-check story)', () => {
  test('the sentence matches the selection; changing the decision day re-checks, unticks and toasts', async ({
    page,
  }) => {
    await openE(page, { width: 1440, height: 900 }, 'txr-run-e-recheck')

    // The settings card's live sentence (the plan's words, the fixture's
    // values: decision day 56, horizon 238).
    await expect(page.getByTestId('txr-run-settings-sentence')).toHaveText(
      'Progression or death within 238 days, from the blood draws up to day 56.',
    )
    // The small set: all six runnable, the recommendation ticks them.
    await expect(page.getByTestId('txr-run-bar-count')).toHaveText('6 methods selected')
    await expect(page.getByTestId('txr-run-bar-time')).toContainText('3 at a time')

    // Pick day 28: the story's eligibility changes (fx-prob-one becomes
    // cannot-run), the page re-checks with the re-check line, unticks the
    // method and shows the toast (the kit Toaster, mounted by the gallery's
    // ThemeProvider).
    await page.getByTestId('txr-run-settings-decision-day-opt-28').click()
    await expect(page.getByTestId('txr-run-bar-count')).toHaveText('5 methods selected', {
      timeout: 30_000,
    })
    await expect(page.locator('[data-sonner-toast]')).toContainText(
      '1 method no longer fits these settings',
    )
    // The unticked method left the ready list and sits in the can't-run
    // section, counted honestly.
    await expect(page.getByTestId('txr-method-card-fx-prob-one')).toHaveCount(0)
    await expect(page.getByTestId('txr-method-cannot-heading')).toHaveText(
      "1 method can't run on this data",
    )
  })
})

test.describe('ITEM-2 — the run bar never overlaps the last row', () => {
  test('at the end of the page the bar sits below the last row (1440x900)', async ({ page }) => {
    await openE(page, { width: 1440, height: 900 }, 'txr-run-e-small')
    await expect(page.getByTestId('txr-method-picker')).toBeVisible()

    // Scroll the page's one scroll container to its end, then compare the
    // viewport boxes of the last row and the bar.
    await page
      .getByTestId('txr-run')
      .evaluate(el => {
        const scroll = el.querySelector('div') // PAGE_MAIN (the one scroll container)
        if (scroll !== null) scroll.scrollTop = scroll.scrollHeight
      })
    const rows = page.locator('[data-testid^="txr-method-card-"]')
    const lastRow = rows.last()
    await lastRow.scrollIntoViewIfNeeded()
    const rowBox = await lastRow.boundingBox()
    const barBox = await page.getByTestId('txr-run-bar').boundingBox()
    expect(rowBox).not.toBeNull()
    expect(barBox).not.toBeNull()
    expect(barBox!.y, 'bar must start below the last row').toBeGreaterThanOrEqual(
      rowBox!.y + rowBox!.height - 1,
    )
  })
})

test.describe('ITEM-2 — phone (390x844): nothing clipped, 44 px touch targets', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('every interactive element fits inside the viewport width', async ({ page }) => {
    await openE(page, { width: 390, height: 844 }, 'txr-run-e-small')
    await expect(page.getByTestId('txr-method-picker')).toBeVisible()

    // The summary and settings cards are COLLAPSED by default at the phone
    // width (the ITEM-2 layout); open both so "nothing is clipped" covers
    // the expanded content.
    const summaryToggle = page.getByTestId('txr-run-summary-toggle')
    await summaryToggle.click()
    await expect(page.getByTestId('txr-run-summary-line')).toBeVisible()
    const settingsToggle = page.getByTestId('txr-run-settings-toggle')
    await settingsToggle.click()
    await expect(page.getByTestId('txr-run-settings-sentence')).toBeVisible()

    const targets = [
      'txr-run-summary',
      'txr-run-summary-line',
      'txr-run-summary-markers',
      'txr-run-settings',
      'txr-run-settings-sentence',
      'txr-method-presets',
      'txr-method-search',
      'txr-method-card-fx-call-one',
      'txr-method-title-fx-call-one',
      'txr-run-bar',
      'txr-run-bar-count',
    ]
    for (const id of targets) {
      const el = page.getByTestId(id)
      await el.scrollIntoViewIfNeeded()
      const box = await el.boundingBox()
      expect(box, `${id} must be mounted`).not.toBeNull()
      expect(box!.x, `${id} left edge`).toBeGreaterThanOrEqual(-1)
      expect(box!.x + box!.width, `${id} right edge at 390`).toBeLessThanOrEqual(391)
    }
  })

  test('the bar Run button and the rows are at least 44 px tall', async ({ page }) => {
    await openE(page, { width: 390, height: 844 }, 'txr-run-e-small')
    await expect(page.getByTestId('txr-method-picker')).toBeVisible()
    const run = page.getByTestId('txr-run-bar-run')
    await run.scrollIntoViewIfNeeded()
    const runBox = await run.boundingBox()
    expect(runBox).not.toBeNull()
    expect(runBox!.height, 'Run button height').toBeGreaterThanOrEqual(44)
    const row = page.getByTestId('txr-method-card-fx-call-one')
    const rowBox = await row.boundingBox()
    expect(rowBox).not.toBeNull()
    expect(rowBox!.height, 'row height').toBeGreaterThanOrEqual(44)
  })
})

test.describe('ITEM-2 — keyboard-only completion: summary, settings, presets, search, list, run bar', () => {
  test('the tab order walks the page in the plan\'s order', async ({ page }) => {
    await openE(page, { width: 1440, height: 900 }, 'txr-run-e-small')
    await expect(page.getByTestId('txr-method-picker')).toBeVisible()

    // The active element's page group, resolved in the page (the plan's six
    // stops, in DOM order).
    const groupOf = (): string | null => {
      const el = document.activeElement as Element | null
      if (el === null) return null
      const find = (id: string): boolean =>
        el.closest(`[data-testid^="${id}"]`) !== null || el.matches(`[data-testid^="${id}"]`)
      if (find('txr-run-summary')) return 'summary'
      if (find('txr-run-settings')) return 'settings'
      if (find('txr-method-preset-')) return 'presets'
      if (find('txr-method-search')) return 'search'
      if (find('txr-method-card-')) return 'list'
      if (find('txr-run-bar')) return 'bar'
      return null
    }

    const seen: string[] = []
    for (let i = 0; i < 60; i += 1) {
      await page.keyboard.press('Tab')
      const group = await page.evaluate(groupOf)
      if (group !== null && seen[seen.length - 1] !== group) seen.push(group)
      if (group === 'bar') break
    }
    expect(seen).toEqual(['summary', 'settings', 'presets', 'search', 'list', 'bar'])
  })
})
