import { expect, test } from '@playwright/test'

/**
 * A bottom Sheet at a PHONE width keeps its content on screen and gives it a scroll track.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────────
 *
 * `shadcn/sheet.tsx` gave `data-[side=bottom]` (and `top`) `h-auto`, while only left/right got
 * `h-full`. The panel is a flex COLUMN whose body is `flex-1 overflow-y-auto` — and `flex-1` is
 * inert under an auto-height parent, because there is no definite height to take a remainder of.
 * So a tall bottom sheet did not scroll: it GREW, upward, past the top of the screen, taking
 * whatever was at the top of its content with it. `MobileShell`'s bottom "Analysis" sheet hosts
 * `BottomArtifactsDock`, so this is the shipped path, not a hypothetical one.
 *
 * The fix is NOT `h-full`. That would make every bottom sheet full-screen — a visible regression
 * for every consumer, including short ones that are correct today. It is a `max-h-[…svh]` cap
 * plus the flex-column contract, so a short sheet still sizes to its content and only a tall one
 * is bounded (and therefore scrolls).
 *
 * ── WHY MEASURED HERE ─────────────────────────────────────────────────────────
 *
 * `sdk/packages/kit/src/kit/sheet-bottom-track.test.tsx` pins the CLASS contract, which is the
 * mechanism; jsdom has no layout engine, so it cannot see whether the mechanism works. This is the
 * geometry: a real browser, a real 390px viewport, the real `MobileShell` bottom sheet.
 *
 * The tall content is INJECTED into the live sheet body rather than seeded through the dock.
 * Deliberately: the claim is about the SHEET's box chain, and seeding it through whatever
 * `BottomArtifactsDock` happens to render today would make the test's precondition depend on a
 * pane it is not about — the first content change that shortened that pane would turn this green
 * while the sheet stayed broken. Injecting states the precondition directly: given content taller
 * than the screen, the sheet bounds it and offers a track.
 *
 * Run:
 *   GALLERY_E2E_PORT=1481 npx playwright test -c playwright.gallery.config.ts \
 *     tests/gallery-e2e/sheet-bottom-track.spec.ts
 */

/** A phone. Below the 768px `useIsMobile` breakpoint, so the workbench really is `MobileShell`. */
test.use({ viewport: { width: 390, height: 800 } })

const BOTTOM_SHEET = '[data-slot="sheet-content"][data-side="bottom"]'

interface Measured {
  top: number
  height: number
  viewport: number
  maxHeight: string
  /** The nearest y-scroll container inside the sheet, if any. */
  track: { scrollHeight: number; clientHeight: number } | null
  chain: string[]
}

async function openBottomSheetAndMeasure(page: import('@playwright/test').Page): Promise<Measured> {
  await page.goto('/gallery.html?surface=workbench-narrow')

  // PRECONDITION: this is the mobile shell. Without it the test silently measures nothing.
  await expect(
    page.locator('[data-testid="workbench-shell"][data-workbench-mobile="true"]'),
    'below 768px the workbench must be MobileShell — otherwise there is no bottom sheet here',
  ).toBeVisible({ timeout: 60_000 })

  await page.getByTestId('workbench-mobile-open-bottom').click()
  await expect(page.locator(BOTTOM_SHEET)).toBeVisible()

  return page.locator(BOTTOM_SHEET).evaluate((popup: HTMLElement): Measured => {
    // The tall pane, stated directly (see the header). It goes into the sheet's own scrolling
    // body — the element the kit `Sheet` marks `overflow-y-auto` — which is where a pane lives.
    const body = popup.querySelector<HTMLElement>(':scope > [class*="overflow-y-auto"]') ?? popup
    const tall = document.createElement('div')
    tall.style.height = '3000px'
    tall.setAttribute('data-testid', 'tall-probe')
    body.appendChild(tall)

    const rect = popup.getBoundingClientRect()
    let track: { scrollHeight: number; clientHeight: number } | null = null
    for (let p: Element | null = tall; p && p !== document.body; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) {
        track = { scrollHeight: p.scrollHeight, clientHeight: p.clientHeight }
        break
      }
    }
    const chain: string[] = []
    for (let p: Element | null = tall; p; p = p.parentElement) {
      const cs = getComputedStyle(p)
      chain.push(
        `  ${p.tagName.toLowerCase()}[${p.getAttribute('data-slot') ?? p.getAttribute('data-testid') ?? ''}] ` +
          `h=${Math.round(p.getBoundingClientRect().height)} scrollH=${p.scrollHeight} ` +
          `display=${cs.display} maxH=${cs.maxHeight} flex=${cs.flexGrow}/${cs.flexShrink}/${cs.flexBasis} ` +
          `minH=${cs.minHeight} overflowY=${cs.overflowY}`,
      )
      if (p.tagName === 'BODY') break
    }
    return {
      top: Math.round(rect.top),
      height: Math.round(rect.height),
      viewport: window.innerHeight,
      maxHeight: getComputedStyle(popup).maxHeight,
      track,
      chain,
    }
  })
}

test.describe('the bottom sheet bounds tall content instead of growing off screen', () => {
  test('the panel stays within the viewport', async ({ page }) => {
    const m = await openBottomSheetAndMeasure(page)
    expect(
      m.top,
      `the bottom sheet grew past the TOP of the screen (top=${m.top}, height=${m.height}, ` +
        `viewport=${m.viewport}, computed max-height=${m.maxHeight}). ` +
        `With no height cap its \`flex-1\` body cannot resolve, so it sizes to its content and ` +
        `the content above the fold is unreachable — not merely below it.\nBox chain:\n` +
        m.chain.join('\n'),
    ).toBeGreaterThanOrEqual(0)
  })

  test('and offers a scroll track for what does not fit', async ({ page }) => {
    const m = await openBottomSheetAndMeasure(page)
    expect(
      m.track,
      `nothing inside the bottom sheet scrolls (viewport=${m.viewport}, panel height=${m.height}). ` +
        `A bounded panel with no track is the WORSE failure of the two: the content is clipped ` +
        `rather than merely off screen.\nBox chain:\n${m.chain.join('\n')}`,
    ).not.toBeNull()
  })

  test('a SHORT bottom sheet still sizes to its content — the cap must not become h-full', async ({
    page,
  }) => {
    // The negative control for the fix. `h-full` on `data-[side=bottom]` would also stop the
    // overflow, by making every bottom sheet full-screen; that is a different bug, visible to
    // every consumer, and it is the reason the fix is a max-height.
    await page.goto('/gallery.html?surface=workbench-narrow')
    await expect(page.locator('[data-testid="workbench-shell"][data-workbench-mobile="true"]')).toBeVisible({
      timeout: 60_000,
    })
    await page.getByTestId('workbench-mobile-open-bottom').click()
    await expect(page.locator(BOTTOM_SHEET)).toBeVisible()

    const { height, viewport } = await page
      .locator(BOTTOM_SHEET)
      .evaluate((el: HTMLElement) => ({
        height: Math.round(el.getBoundingClientRect().height),
        viewport: window.innerHeight,
      }))
    expect(
      height,
      `the un-injected bottom sheet fills the screen (${height} of ${viewport}) — the cap became ` +
        'a fixed height and every bottom sheet is now full-screen',
    ).toBeLessThan(viewport)
  })
})
