import { expect, test } from '@playwright/test'

/**
 * SCROLLBAR-AT-BORDER (fix/scrollbar-at-border) — the entry_list overlay scrollbar must sit FLUSH
 * at the section card's inline-end border, not floating inset over each row's "Plot ▶".
 *
 * The bug: `SectionFrame` used to inset its whole content with one `paddingInline` on the card box,
 * which squeezed the accordion body inward by the inset. The entry_list's `ScrollArea` lives in the
 * accordion PANEL (`overflow:hidden`), so its overlay scrollbar rode the viewport's inline-end edge
 * ~9px (inset 8px + 1px border) INSIDE the card border — and two prior blind fixes (a `pe-3` gutter,
 * a clipped negative margin) never moved the scrollbar itself. The fix relocates the inline inset
 * off the card onto the header + body wrapper, then widens the scroll region back out to the card's
 * inner border (`width:calc(100% + --section-inset)`), so the scrollbar lands on the border while
 * the rows keep an inline-end gutter that clears the now-border-flush thumb.
 *
 * This is a MEASURED, real-browser guard: it reads `getBoundingClientRect()` for the section card,
 * the overlay scrollbar and a row's Plot button and asserts the geometry.
 *   · FAILS on origin/main (scrollbar ~9px inside the card border).
 *   · PASSES after the fix (scrollbar flush, within 2px = the 1px border).
 *
 * Run (own port on a shared box):
 *   GALLERY_E2E_PORT=1493 npx playwright test -c playwright.gallery.config.ts \
 *     tests/gallery-e2e/entry-list-scrollbar-at-border.spec.ts
 */

const SURFACE = '/gallery.html?surface=entry-list-collapse-repro'
const SECTION_ID = 'demo.viz.entries.section'

test.describe('entry_list overlay scrollbar sits flush at the card border', () => {
  test('the vertical scrollbar aligns with the card inline-end border and the Plot button clears it', async ({
    page,
  }) => {
    await page.goto(SURFACE)

    // Expand the (collapsed) § Items section — the shipped first-open gesture.
    await expect(page.getByTestId(`section-frame-${SECTION_ID}`)).toBeVisible()
    await page
      .getByTestId(`section-accordion-${SECTION_ID}`)
      .getByRole('button', { name: 'Items' })
      .first()
      .click()

    // The windowed list renders (60 entries overflow max-h-96 → the vertical scrollbar exists).
    await expect(page.getByTestId('widget-entries-grid')).toBeVisible()
    await expect(page.locator('[data-testid^="widget-entries-row-"]').first()).toBeVisible()

    // Reveal the overlay scrollbar (autoHide="leave") by moving the pointer into the list.
    await page.getByTestId('widget-entries-grid').hover()
    await page.mouse.wheel(0, 50)
    const scrollbarEl = page.locator('.os-scrollbar.os-scrollbar-vertical').first()
    await expect(scrollbarEl).toBeVisible()

    const rects = await page.evaluate(() => {
      const r = (el: Element | null) =>
        el ? (({ left, right }) => ({ left, right }))(el.getBoundingClientRect()) : null
      return {
        card: r(document.querySelector('[data-testid="section-frame-demo.viz.entries.section"]')),
        scrollbar: r(document.querySelector('.os-scrollbar.os-scrollbar-vertical')),
        searchInput: r(document.querySelector('[data-testid="widget-entries-search"]')),
        plotButton: r(
          document.querySelector('[data-testid^="widget-entries-row-"] button[data-testid*="plot" i]') ??
            document.querySelector('[data-testid^="widget-entries-row-"] button'),
        ),
      }
    })

    expect(rects.card, 'section card rect').not.toBeNull()
    expect(rects.scrollbar, 'overlay scrollbar rect').not.toBeNull()
    expect(rects.searchInput, 'search input rect').not.toBeNull()
    expect(rects.plotButton, 'Plot button rect').not.toBeNull()
    const card = rects.card!
    const scrollbar = rects.scrollbar!
    const searchInput = rects.searchInput!
    const plotButton = rects.plotButton!

    // (1) FLUSH: the scrollbar's inline-end edge aligns with the card's inline-end border. The
    // only permitted gap is the 1px card border, so ±2px. FAILS on the pre-scrollbar-fix tree.
    const insetFromBorder = card.right - scrollbar.right
    expect(
      Math.abs(insetFromBorder),
      `scrollbar.right (${scrollbar.right}) must be flush with card.right (${card.right}); inset was ${insetFromBorder}px`,
    ).toBeLessThanOrEqual(2)

    // (2) NO OVERLAP: the Plot button's inline-end edge is LEFT of the scrollbar's inline-start
    // edge, so the thumb never paints over the button.
    expect(
      plotButton.right,
      `Plot button.right (${plotButton.right}) must be left of scrollbar.left (${scrollbar.left})`,
    ).toBeLessThan(scrollbar.left)

    // (3) ALIGNED (owner: entrylist-align): the search box, the rows and the Plot buttons share
    // ONE right edge — the search Input's inline-end edge matches the Plot button's, within 2px.
    // FAILS on the scrollbar-only tree, where the rows were inset an extra `--section-inset` (8px)
    // past the search box (search.right ≈ button.right + 8).
    expect(
      Math.abs(searchInput.right - plotButton.right),
      `search Input.right (${searchInput.right}) must align with Plot button.right (${plotButton.right})`,
    ).toBeLessThanOrEqual(2)
  })
})
