import { expect, test } from '@playwright/test'

/**
 * BUG 1 (fix/visualize-entrylist-bugs) — the § Items collapse→reopen invariant.
 *
 * `SectionFrame`'s `keepMounted` accordion keeps a collapsed panel mounted under `display:none`,
 * and a shipped viz § Items ships `collapsed: true` — so its `entry_list`
 * widget mounts hidden and is opened from that state. The risk the fix removes is a tanstack
 * virtualiser measuring a zero-height, un-laid-out viewport while hidden and then re-measuring on
 * re-show. The fix makes it STRUCTURAL: the windowed body (the virtualiser) is not mounted while
 * the panel is hidden — it mounts FRESH against a laid-out viewport on expand.
 *
 * This mounts the REAL production path (`SectionStack` → `SectionFrame` → `DeclarativeRegion` →
 * `entry_list`), starts collapsed like that § Items, resolves the offer asynchronously after mount
 * (as the real host does), then expands. Expanding must render the list, NOT the
 * `WidgetErrorBoundary` fallback (`"entries" (entry_list) failed to render`), and must log no
 * widget-render throw and no page error.
 *
 * Run (own port on a shared box):
 *   GALLERY_E2E_PORT=1493 npx playwright test -c playwright.gallery.config.ts \
 *     tests/gallery-e2e/entry-list-collapse.spec.ts
 */

const SURFACE = '/gallery.html?surface=entry-list-collapse-repro'
const SECTION_ID = 'demo.viz.entries.section'

test.describe('entry_list collapse→reopen (BUG 1)', () => {
  test('expanding a collapsed § Items section renders the list and never crashes the widget', async ({
    page,
  }) => {
    // The WidgetErrorBoundary logs the real throw here (`componentDidCatch`); capturing it proves
    // the invariant behaviourally rather than only by the absent fallback.
    const widgetFailures: string[] = []
    const pageErrors: string[] = []
    page.on('console', m => {
      if (m.type() === 'error' && m.text().includes('[declarative] widget render failed')) {
        widgetFailures.push(m.text())
      }
    })
    page.on('pageerror', e => pageErrors.push(`${e.message}\n${e.stack ?? ''}`))

    await page.goto(SURFACE)

    // The section frame is present (collapsed) — the widget is mounted under display:none.
    await expect(page.getByTestId(`section-frame-${SECTION_ID}`)).toBeVisible()

    // THE STRUCTURAL INVARIANT (fails on main, passes after the fix): while the section is
    // collapsed, the windowed body — and therefore the tanstack virtualiser — must NOT be
    // mounted. The offer has landed (the async host arrival), so on the unfixed widget the grid
    // is present in the DOM (merely `display:none`); the fix replaces it with a placeholder so
    // the virtualiser never measures a hidden viewport. Poll: the placeholder appears once the
    // offer lands and visibility resolves to hidden.
    await expect(page.getByTestId('widget-entries-collapsed-placeholder')).toHaveCount(1)
    await expect(page.getByTestId('widget-entries-grid')).toHaveCount(0)

    // Expand it via the accordion trigger — the exact gesture § Items makes on first open.
    await page
      .getByTestId(`section-accordion-${SECTION_ID}`)
      .getByRole('button', { name: 'Items' })
      .first()
      .click()

    // The list renders: its search box + grid appear, with real windowed rows (proving the
    // virtualiser mounted fresh against a laid-out viewport).
    await expect(page.getByTestId('widget-entries-search')).toBeVisible()
    await expect(page.getByTestId('widget-entries-grid')).toBeVisible()
    await expect(page.locator('[data-testid^="widget-entries-row-"]').first()).toBeVisible()

    // And the widget-error fallback must be ABSENT — no boundary catch, no "failed to render".
    await expect(page.getByTestId('widget-error-entries')).toHaveCount(0)
    await expect(page.getByText(/"entries" \(entry_list\) failed to render/)).toHaveCount(0)

    expect(
      widgetFailures,
      `widget render throw(s):\n${widgetFailures.join('\n---\n')}`,
    ).toHaveLength(0)
    expect(pageErrors, `page errors:\n${pageErrors.join('\n---\n')}`).toHaveLength(0)
  })
})
