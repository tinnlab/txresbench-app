import { expect, test } from '@playwright/test'

/**
 * SECOND-ANNOTATION OVERFLOW (fix/visualize-entrylist-bugs) — a row's inline SECONDARY annotation
 * must never destroy the entry NAME or push the row's "Plot ▶" off-screen when the displayed
 * annotation is a long value.
 *
 * The bug: the secondary-annotation `<span>` (`EntryListWidget.tsx`, the "other name" slot —
 * the mockup's `CD3E   ENSG…98851`) was `shrink-0 truncate`. `shrink-0` forbids the flex item
 * from shrinking, so `truncate` was INERT — a long value (any free-text `metadata-column` chosen
 * via `Show:`, e.g. a long free-text note) took its full intrinsic width, collapsing the
 * `flex-1 min-w-0` name to ZERO width and shoving the count + "Plot ▶" beyond the row's
 * inline-end edge, off-screen and horizontally overflowing the pane. The fix makes the secondary
 * shrink-and-truncate with an inline-size cap so it YIELDS to the name.
 *
 * MEASURED, real-browser guard (reads `getBoundingClientRect`):
 *   · FAILS on the pre-fix tree (name width 0; Plot button.right past the grid's right edge).
 *   · PASSES after the fix (name visible; secondary truncated within the grid; Plot on-screen).
 *
 * The fixture's `e-2` carries a long "Description" annotation; every other entry carries a short
 * id, so this asserts the LONG row specifically and leaves the short rows as the control.
 *
 * Run (own port on a shared box):
 *   GALLERY_E2E_PORT=1493 npx playwright test -c playwright.gallery.config.ts \
 *     tests/gallery-e2e/entry-list-second-annotation-overflow.spec.ts
 */

const SURFACE = '/gallery.html?surface=entry-list-collapse-repro'
const SECTION_ID = 'demo.viz.entries.section'

test.describe('entry_list secondary annotation must not overflow the row', () => {
  test('a long shown annotation keeps the name visible and the Plot button on-screen', async ({
    page,
  }) => {
    await page.goto(SURFACE)

    await expect(page.getByTestId(`section-frame-${SECTION_ID}`)).toBeVisible()
    await page
      .getByTestId(`section-accordion-${SECTION_ID}`)
      .getByRole('button', { name: 'Items' })
      .first()
      .click()

    await expect(page.getByTestId('widget-entries-grid')).toBeVisible()
    // e-2 is the long-annotation row; it is in the first window (rows e-0…).
    await expect(page.getByTestId('widget-entries-second-e-2')).toBeVisible()

    const rects = await page.evaluate(() => {
      const r = (el: Element | null) =>
        el ? (({ left, right, width }) => ({ left, right, width }))(el.getBoundingClientRect()) : null
      return {
        grid: r(document.querySelector('[data-testid="widget-entries-grid"]')),
        name: r(document.querySelector('[data-testid="widget-entries-label-e-2"]')),
        second: r(document.querySelector('[data-testid="widget-entries-second-e-2"]')),
        plot: r(
          document.querySelector('[data-testid^="widget-entries-plot-e-2"]') ??
            document.querySelector('[data-testid="widget-entries-row-e-2"] button'),
        ),
      }
    })

    expect(rects.grid, 'grid rect').not.toBeNull()
    expect(rects.name, 'name rect').not.toBeNull()
    expect(rects.second, 'secondary rect').not.toBeNull()
    expect(rects.plot, 'Plot button rect').not.toBeNull()
    const grid = rects.grid!
    const name = rects.name!
    const second = rects.second!
    const plot = rects.plot!

    // (1) THE NAME SURVIVES: it is not collapsed to zero width by the secondary. FAILS on the
    // pre-fix tree, where the `shrink-0` secondary drove the name to width 0.
    expect(name.width, `entry name width (${name.width}) must be > 0`).toBeGreaterThan(8)

    // (2) THE SECONDARY IS TRUNCATED WITHIN THE ROW: its inline-end edge stays within the grid.
    expect(
      second.right,
      `secondary.right (${second.right}) must stay within grid.right (${grid.right})`,
    ).toBeLessThanOrEqual(grid.right + 1)

    // (3) THE PLOT BUTTON IS ON-SCREEN: its inline-end edge is within the grid, not shoved past
    // it. FAILS on the pre-fix tree, where the button was pushed hundreds of px past grid.right.
    expect(
      plot.right,
      `Plot button.right (${plot.right}) must stay within grid.right (${grid.right})`,
    ).toBeLessThanOrEqual(grid.right + 1)
  })
})
