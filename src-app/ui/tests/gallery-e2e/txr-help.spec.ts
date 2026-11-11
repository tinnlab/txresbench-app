import { expect, test, type Page } from '@playwright/test'

/**
 * TXRHELP — the Help page's real-browser guard (qa-fixes2 ITEM-3, TEST-QF2-2,
 * backend-free: the `txrhelp/gallery.tsx` stories mount the REAL `HelpPage` —
 * the page reads no provider, its content is the module's own typed data, so
 * no cassette is needed; the template/copy buttons need the real backend and
 * are present but inert here).
 *
 * Spec ↔ TESTS.md enumeration:
 *   · TEST-QF2-2 — the problem-code list equals the validator's emitted
 *     codes + severities (the drift half is the server's catalogue pin + the
 *     unit-tier catalogue check; here the page renders one entry per code);
 *     the rail never overlaps the content; every contents anchor lands with
 *     its heading fully visible below the header; the phone tables scroll.
 *   · The plan's measured layout: 1440x900 / 1024x768 / 768x1024 / 390x844,
 *     light and dark — no two text boxes overlap (the rail, the heading, the
 *     first paragraph), the content column is 600-760 px at 1440, the page
 *     height at 1440 is under 5,500 px, no horizontal overflow, tables
 *     scroll inside their own box, contrast of body text / chips / callouts
 *     >= 4.5:1 (computed from the resolved colours), the search filters and
 *     restores, each `#problem-<code>` link opens and expands its entry.
 *
 * The host theme query (`?theme=light|dark`) is the command-palette spec's
 * convention; the page colours are the app's `--txr-*` tokens.
 *
 * Run (own port on a shared box — the config derives one per worktree):
 *   npx playwright test -c playwright.gallery.config.ts \
 *     tests/gallery-e2e/txr-help.spec.ts
 */

const GALLERY = '/gallery.html?surface='

// The gallery's module graph is transformed ON DEMAND by Vite: the first
// test on a freshly booted server pays the whole graph's transform AND the
// first-load dependency optimizer — measured on this box at ~14 min with
// the machine at load 250-300 (the txr-history spec's convention, with a
// wider clock: the optimizer + transform both land on the FIRST test; every
// later test in this worker reuses the warm server).
test.setTimeout(2_400_000)

/** The section anchors the page owns (content.ts order). */
const SECTIONS = [
  'overview',
  'steps',
  'files',
  'choosing-methods',
  'statuses',
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

/** Load the story at a viewport, with deterministic (instant) scrolling. */
async function openHelp(page: Page, size: { width: number; height: number }, surface = 'txr-help', theme = 'light') {
  await page.setViewportSize(size)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`${GALLERY}${surface}&theme=${theme}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('txr-help')).toBeVisible()
}

/** Two boxes overlap when their rects intersect (a shared edge is not an overlap). */
function overlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** Relative luminance per WCAG 2.1 (srgb). */
function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map(v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(fg: [number, number, number], bg: [number, number, number]): number {
  const l1 = luminance(fg)
  const l2 = luminance(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

test.describe('txr-help — the full page (TEST-QA-4 shape, kept)', () => {
  test('every section and every closed code entry renders; the TOC links every anchor', async ({ page }) => {
    await openHelp(page, { width: 1440, height: 900 })
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
    const missing = await page.evaluate(anchors => anchors.filter(anchor => document.getElementById(anchor) === null), PROBLEM_ANCHORS)
    expect(missing).toEqual([])
    const missingSections = await page.evaluate(anchors => anchors.filter(anchor => document.getElementById(anchor) === null), SECTIONS)
    expect(missingSections).toEqual([])
  })
})

test.describe('txr-help — the measured layout at 1440x900', () => {
  test('the grid is two real columns: rail 240, content 600-760 px, no overlap, page under 5,500 px', async ({ page }) => {
    await openHelp(page, { width: 1440, height: 900 })
    const m = await page.evaluate(() => {
      const rail = document.querySelector<HTMLElement>('[data-testid="txr-help-rail"]')!
      const column = document.querySelector<HTMLElement>('.txr-help-content-column')!
      const h1 = document.querySelector<HTMLElement>('[data-testid="txr-help"] h1')!
      const first = document.querySelector<HTMLElement>('[data-testid="txr-help-section-overview"] p')!
      const main = document.querySelector<HTMLElement>('[data-testid="txr-help"]')!
      const rect = (el: Element) => {
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y + window.scrollY, width: r.width, height: r.height, bottom: r.height + r.y }
      }
      return {
        rail: rect(rail),
        column: rect(column),
        h1: rect(h1),
        first: rect(first),
        pageHeight: main.scrollHeight,
        bodyWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
      }
    })
    // The rail is the left column (240 px); the content is the right.
    expect(Math.round(m.rail.width)).toBe(240)
    expect(m.column.width).toBeGreaterThanOrEqual(600)
    expect(m.column.width).toBeLessThanOrEqual(760)
    // The rail never overlaps the content (the two columns are disjoint).
    expect(overlap(m.rail, m.column)).toBe(false)
    // The page height target: under 5,500 px (the plan's measure; the old
    // page measured 9,850 px / 13,250 px at phone width).
    expect(m.pageHeight).toBeLessThan(5500)
    // No horizontal overflow at 1440.
    expect(m.bodyWidth - m.viewportWidth).toBeLessThanOrEqual(1)
    // The rail and the headings never draw over the first paragraph.
    expect(overlap(m.rail, m.h1)).toBe(false)
    expect(overlap(m.rail, m.first)).toBe(false)
  })

  test('every contents anchor lands with its heading fully visible below the header', async ({ page }) => {
    await openHelp(page, { width: 1440, height: 900 })
    for (const id of SECTIONS) {
      await page.getByTestId(`txr-help-toc-${id}`).click()
      await expect
        .poll(async () =>
          page.getByTestId(`txr-help-section-${id}`).evaluate(el => el.getBoundingClientRect().top),
        )
        .toBeGreaterThanOrEqual(0)
      const top = await page.getByTestId(`txr-help-section-${id}`).evaluate(el => el.getBoundingClientRect().top)
      expect(top, `heading ${id} lands clear of the header`).toBeGreaterThanOrEqual(0)
      expect(top, `heading ${id} is fully visible`).toBeLessThan(140)
    }
  })

  test('the rail highlight follows the scroll — anchor, keyboard and wheel (ITEM-6 b)', async ({ page }) => {
    await openHelp(page, { width: 1440, height: 900 })
    const active = (id: string) => page.getByTestId(`txr-help-toc-${id}`)
    // ANCHOR: clicking each contents link lands the rail on the same section
    // (the owner-side defect: the rail stuck on "What TxResBench does").
    for (const id of SECTIONS) {
      await page.getByTestId(`txr-help-toc-${id}`).click()
      await expect(active(id), `anchor scroll to ${id}`).toHaveAttribute('aria-current', 'true')
    }
    // KEYBOARD: End jumps to the bottom — the rail lands on the last section
    // (a jump no intermediate heading passes).
    await page.keyboard.press('End')
    await expect(active('troubleshooting')).toHaveAttribute('aria-current', 'true')
    // KEYBOARD: Home back to the top — the rail lands on the first section.
    await page.keyboard.press('Home')
    await expect(active('overview')).toHaveAttribute('aria-current', 'true')
    // WHEEL: a continuous wheel scroll follows the sections as they pass the
    // header line — wheel down until a mid-page section is the current one,
    // then all the way to the bottom.
    await page.mouse.move(720, 500)
    await page.mouse.wheel(0, 400)
    await page.mouse.wheel(0, 400)
    await expect(active('files')).toHaveAttribute('aria-current', 'true')
    await page.mouse.wheel(0, 30000)
    await expect(active('troubleshooting')).toHaveAttribute('aria-current', 'true')
  })

  test('the quick-start row shares the grid\'s edges on desktop (ITEM-6 e)', async ({ page }) => {
    await openHelp(page, { width: 1440, height: 900 })
    const m = await page.evaluate(() => {
      const quickstart = document.querySelector<HTMLElement>('[data-testid="txr-help-quickstart"]')!
      const grid = document.querySelector<HTMLElement>('.txr-help-grid')!
      const q = quickstart.getBoundingClientRect()
      const g = grid.getBoundingClientRect()
      return {
        leftDelta: q.left - g.left,
        rightDelta: q.right - g.right,
      }
    })
    // The cards' row is capped at the grid's width and centred like it — the
    // old row ran the page's full 1096 px and stuck out 48 px past the
    // grid's edges.
    expect(Math.abs(m.leftDelta)).toBeLessThanOrEqual(1)
    expect(Math.abs(m.rightDelta)).toBeLessThanOrEqual(1)
  })

  test('the file tables scroll inside their own box (they never widen the column)', async ({ page }) => {
    await openHelp(page, { width: 1440, height: 900 })
    for (const kind of ['patients', 'measurements']) {
      const m = await page
        .getByTestId(`txr-help-filetable-${kind}`)
        .evaluate(el => {
          const wrapper = el
          const table = el.querySelector('table')!
          const column = document.querySelector<HTMLElement>('.txr-help-content-column')!
          return {
            wrapperWidth: wrapper.clientWidth,
            tableWidth: table.getBoundingClientRect().width,
            columnWidth: column.getBoundingClientRect().width,
            scrollable: wrapper.scrollWidth - wrapper.clientWidth,
            overflowX: getComputedStyle(wrapper).overflowX,
          }
        })
      // The wrapper fits inside the content column, and the table either
      // fits or scrolls INSIDE it (never outside; the page does not scroll).
      expect(m.wrapperWidth).toBeLessThanOrEqual(m.columnWidth + 1)
      expect(m.overflowX).toBe('auto')
      expect(m.tableWidth).toBeLessThanOrEqual(m.columnWidth + 1)
      expect(m.scrollable).toBeGreaterThanOrEqual(0)
    }
  })

  test('the search filters sections and entries, highlights and restores; the no-results state clears', async ({ page }) => {
    await openHelp(page, { width: 1440, height: 900 })
    const input = page.getByTestId('txr-help-search-input')
    await input.fill('duplicate')
    await expect(page.getByTestId('txr-help-section-troubleshooting')).toBeVisible()
    await expect(page.getByTestId('txr-help-problem-problem-r07')).toBeVisible()
    await expect(page.getByTestId('txr-help-section-models')).toHaveCount(0)
    // A match highlights (a mark element carries the query).
    await expect(page.locator('[data-testid="txr-help-section-troubleshooting"] mark').first()).toBeVisible()
    await input.fill('zzzzzz')
    await expect(page.getByTestId('txr-help-no-results')).toBeVisible()
    await page.getByTestId('txr-help-clear-search').click()
    await expect(page.getByTestId('txr-help-no-results')).toHaveCount(0)
    await expect(page.getByTestId('txr-help-section-models')).toBeVisible()
  })

  test('a #problem-<code> deep link opens the entry, expands it and lands clear of the header', async ({ page }) => {
    // The intake problems list deep-links /help#problem-r07 the same way.
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(`${GALLERY}txr-help#problem-r07`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('txr-help')).toBeVisible()
    await expect(page.getByTestId('txr-help-accordion-trigger-R07')).toHaveAttribute('aria-expanded', 'true')
    const top = await page.getByTestId('txr-help-problem-problem-r07').evaluate(el => el.getBoundingClientRect().top)
    expect(top).toBeGreaterThanOrEqual(0)
    expect(top).toBeLessThan(140)
    // Its meaning is visible (the panel is open).
    await expect(page.getByTestId('txr-help-problem-problem-r07').getByText(/patient_id repeats in the patients table/i)).toBeVisible()
  })
})

test.describe('txr-help — the breakpoints', () => {
  test('[1024x768] the two-column grid still holds (rail + content, no overlap)', async ({ page }) => {
    await openHelp(page, { width: 1024, height: 768 })
    const m = await page.evaluate(() => {
      const rail = document.querySelector<HTMLElement>('[data-testid="txr-help-rail"]')!
      const column = document.querySelector<HTMLElement>('.txr-help-content-column')!
      const r = rail.getBoundingClientRect()
      const c = column.getBoundingClientRect()
      const main = document.querySelector<HTMLElement>('[data-testid="txr-help"]')!
      return { rail: { x: r.x, y: r.y, width: r.width, height: r.height }, column: { x: c.x, y: c.y, width: c.width }, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, height: main.scrollHeight }
    })
    expect(m.rail.width).toBe(240)
    expect(overlap(m.rail as never, m.column as never)).toBe(false)
    expect(m.overflow).toBeLessThanOrEqual(1)
  })

  test('[768x1024] no rail: the Contents disclosure replaces it, no overlap, no overflow', async ({ page }) => {
    await openHelp(page, { width: 768, height: 1024 })
    await expect(page.getByTestId('txr-help-rail')).toHaveCount(0)
    await expect(page.getByTestId('txr-help-contents-toggle')).toBeVisible()
    // Open it, click a link: the section lands below the header.
    await page.getByTestId('txr-help-contents-toggle').click()
    await expect(page.getByTestId('txr-help-contents-link-troubleshooting')).toBeVisible()
    await page.getByTestId('txr-help-contents-link-troubleshooting').click()
    const top = await page.getByTestId('txr-help-section-troubleshooting').evaluate(el => el.getBoundingClientRect().top)
    expect(top).toBeGreaterThanOrEqual(0)
    expect(top).toBeLessThan(140)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
  })

  test('[390x844] no horizontal overflow; the stepper and quick-start stack; the tables scroll inside the pane', async ({ page }) => {
    await openHelp(page, { width: 390, height: 844 }, 'txr-help-narrow-390')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    const paneOverflow = await page
      .getByTestId('txr-help')
      .evaluate(el => el.scrollWidth - el.clientWidth)
    expect(paneOverflow).toBeLessThanOrEqual(1)
    // The stepper stacks into one column (the trigger testids differ per card).
    const step1 = await page.getByTestId('txr-help-step-1').boundingBox()
    const step2 = await page.getByTestId('txr-help-step-2').boundingBox()
    expect(step1).not.toBeNull()
    expect(step2).not.toBeNull()
    expect(step2!.y).toBeGreaterThan(step1!.y + step1!.height - 1)
    // A table stays reachable: its own wrapper scrolls, the page does not.
    // The rail does not exist at 390 — the Contents disclosure is the TOC.
    await page.getByTestId('txr-help-contents-toggle').click()
    await expect(page.getByTestId('txr-help-contents-link-files')).toBeVisible()
    await page.getByTestId('txr-help-contents-link-files').click()
    await expect(page.getByTestId('txr-help-filetable-patients')).toBeVisible()
    const tableWrap = await page
      .getByTestId('txr-help-filetable-patients')
      .evaluate(el => {
        const wrapper = el
        const pane = document.querySelector('[data-testid="txr-help"]')!
        const w = wrapper.getBoundingClientRect()
        const p = pane.getBoundingClientRect()
        return {
          scrollable: wrapper.scrollWidth - wrapper.clientWidth,
          fits: w.right - p.right,
          minWidth: (wrapper.querySelector('table') as HTMLElement).style.minWidth,
        }
      })
    expect(tableWrap.scrollable, 'the table wraps and scrolls inside its pane').toBeGreaterThan(0)
    expect(tableWrap.fits, 'the table wrapper stays inside the 390 frame').toBeLessThanOrEqual(1)
    // Back to top appears after scrolling — the real scroller is the pane
    // that actually scrolls (the app-shell area, or here the document), not
    // the window by default.
    await page.evaluate(() => {
      const isScrollable = (el: Element): boolean => {
        const ov = getComputedStyle(el).overflowY
        return (ov === 'auto' || ov === 'scroll' || ov === 'hidden') && el.scrollHeight - el.clientHeight > 1
      }
      const root = document.querySelector('[data-testid="txr-help"]')!
      let node: Element | null = root
      while (node !== null && !isScrollable(node)) node = node.parentElement
      const scroller = node ?? document.scrollingElement ?? document.documentElement
      scroller.scrollTop = 2500
    })
    await expect(page.getByTestId('txr-help-backtop')).toBeVisible()
  })
})

test.describe('txr-help — the quick-start example actions (qa-fixes3 ITEM-5)', () => {
  test('each card carries its one-line "Try it with example data" action with the path\'s accessible name', async ({ page }) => {
    await openHelp(page, { width: 1440, height: 900 })
    const cards: Array<{ id: string; path: string; name: string }> = [
      { id: 'pretrained', path: 'pretrained', name: 'Use example data: predict with a pretrained model' },
      { id: 'learn', path: 'train', name: 'Use example data: learn from my data' },
      { id: 'saved', path: 'reuse', name: 'Use example data: use a model I saved' },
    ]
    for (const card of cards) {
      const frame = page.getByTestId(`txr-help-quickstart-${card.id}`)
      await expect(frame.getByText('Try it with example data')).toBeVisible()
      await expect(frame.getByRole('button', { name: card.name })).toBeVisible()
      await expect(frame.getByTestId(`txr-use-example-${card.path}`)).toBeVisible()
    }
    // The example actions never widen the one-document page. The page-height
    // pin (under 5,500 px) is NOT repeated here: it already fails on this
    // branch's base — qa-fixes3 ITEM-2's help-content growth pushed the page
    // past the qa-fixes2 ITEM-3 target without a browser-tier run noticing
    // (recorded in DRIFT-1 ITEM-5 as the pre-existing condition). The new
    // action adds ~32 px to that page.
    const m = await page.evaluate(() => {
      return {
        bodyWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
      }
    })
    expect(m.bodyWidth - m.viewportWidth).toBeLessThanOrEqual(1)
  })
})

test.describe('txr-help — light and dark', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`[${theme}] body text, chips and callouts keep >= 4.5:1 contrast against their real backgrounds`, async ({
      page,
    }) => {
      await openHelp(page, { width: 1440, height: 900 }, 'txr-help', theme)
      const measured = await page.evaluate(() => {
        /** Parse a computed colour with its alpha (chromium returns rgba()). */
        const parse = (value: string): { rgb: [number, number, number]; alpha: number } | null => {
          const m = value.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)/)
          if (!m) return null
          return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: m[4] === undefined ? 1 : Number(m[4]) }
        }
        /** The effective background: walk up to the first opaque ancestor,
         *  compositing translucent fills over it (the dark tints). */
        const bgOf = (el: Element): [number, number, number] => {
          let node: Element | null = el
          const fills: { rgb: [number, number, number]; alpha: number }[] = []
          while (node) {
            const bg = parse(getComputedStyle(node).backgroundColor)
            if (bg && bg.alpha > 0.01) fills.push(bg)
            node = node.parentElement
          }
          if (fills.length === 0) return [255, 255, 255]
          let [r, g, b] = fills[fills.length - 1].rgb
          for (let i = fills.length - 2; i >= 0; i--) {
            const { rgb, alpha } = fills[i]
            r = rgb[0] * alpha + r * (1 - alpha)
            g = rgb[1] * alpha + g * (1 - alpha)
            b = rgb[2] * alpha + b * (1 - alpha)
          }
          return [r, g, b]
        }
        const sample = (selector: string, index: number) => {
          const els = document.querySelectorAll(selector)
          const el = els[index]
          if (!el) return null
          const bg = bgOf(el)
          const fg = parse(getComputedStyle(el).color)
          if (!fg) return { fg: null, bg }
          // A translucent text colour sits on the effective background.
          const a = fg.alpha
          return {
            fg: [
              fg.rgb[0] * a + bg[0] * (1 - a),
              fg.rgb[1] * a + bg[1] * (1 - a),
              fg.rgb[2] * a + bg[2] * (1 - a),
            ] as [number, number, number],
            bg,
          }
        }
        return {
          body: sample('[data-testid="txr-help"] p', 0),
          muted: sample('[data-testid="txr-help-purpose"]', 0),
          pill: sample('[data-testid^="txr-help-status-eligibility-"]', 0),
          pillWarning: sample('[data-testid="txr-help-status-eligibility-some"]', 0),
          calloutTip: sample('[data-testid="txr-help-callout-tip"]', 0),
          calloutWatch: sample('[data-testid="txr-help-callout-watch"]', 0),
          codeChip: sample('[data-testid^="txr-help-code-chip-"]', 0),
        }
      })
      const assertContrast = (name: string, sample: { fg: [number, number, number] | null; bg: [number, number, number] } | null): void => {
        expect(sample, name).not.toBeNull()
        expect(sample!.fg, `${name} fg parsed`).not.toBeNull()
        const ratio = contrast(sample!.fg as [number, number, number], sample!.bg)
        expect(ratio, `${name} contrast ${ratio}`).toBeGreaterThanOrEqual(4.5)
      }
      assertContrast('body', measured.body)
      assertContrast('purpose', measured.muted)
      assertContrast('can-run pill', measured.pill)
      assertContrast('some pill', measured.pillWarning)
      assertContrast('tip callout', measured.calloutTip)
      assertContrast('watch callout', measured.calloutWatch)
      assertContrast('code chip', measured.codeChip)
    })
  }
})
