import { expect, test } from '@playwright/test'

/**
 * declarative-rendering-hardening — the BEHAVIOURAL e2e over the declarative-engine gallery
 * fixtures (Slices 2 + 3). Backend-free: each surface mounts the REAL `DeclarativeRegion`
 * inside the REAL `WorkbenchProvider` over a seeded fake host, so the resolver, the
 * per-instance store, the widget host, the error boundary and every renderer are the
 * production code path. Only the host (the external boundary) is faked.
 *
 * The INVARIANT proofs live in `tests/visual/declarative-layout.spec.ts`, which `npm run
 * gate:ui` actually runs. THIS file is the wider behavioural sweep — scale, long content, and
 * the recovery path — run explicitly (see below) rather than by a repo-wide gate.
 *
 * Run (own port on a shared box — the committed default 1487 is shared):
 *   GALLERY_E2E_PORT=1481 npx playwright test -c playwright.gallery.config.ts \
 *     tests/gallery-e2e/declarative-hardening.spec.ts
 */

const surface = (slug: string) => `/gallery.html?surface=${slug}`
const bodyOf = (slug: string) => `[data-testid="declarative-region-body-gallery-${slug}"]`

// TEST-5 / TEST-11 — the parts of the behavioural sweep the GATED Layer-A spec
// (`tests/visual/declarative-layout.spec.ts`) does NOT cover. The error/empty/loaded
// vocabulary, the options-less affordance and the named placeholder all live THERE now, so
// they are gated; duplicating them here would just create two copies that drift.
test.describe('recovery (F3 / INV-1)', () => {
  test('Try-again RE-RUNS the resolver (observed via a second host rejection), not a no-op', async ({
    page,
  }) => {
    const slug = 'declarative-error-data-narrow'
    // The fixture host rejects EVERY time, and `readSliceFromApi` logs each failure — so the
    // number of those logs is a direct, discriminating observation of the resolver re-running.
    // A no-op click (or a Try-again that never reaches `retryViewData`) leaves the count flat.
    const resolverFailures: string[] = []
    page.on('console', m => {
      if (m.type() === 'error' && m.text().includes('viewData: artifacts.query failed'))
        resolverFailures.push(m.text())
    })

    await page.goto(surface(slug))
    await expect(page.getByTestId(`declarative-status-error-gallery-${slug}`)).toBeVisible()
    const before = resolverFailures.length
    expect(before).toBeGreaterThan(0)

    await page.getByRole('button', { name: /try again/i }).click()
    await expect
      .poll(() => resolverFailures.length, { message: 'Try-again did not re-run the resolver' })
      .toBeGreaterThan(before)

    // It rejects again, so the surface correctly returns to the error state.
    await expect(page.getByTestId(`declarative-status-error-gallery-${slug}`)).toBeVisible()
  })
})

// TEST-17 — the F2 degrade-don't-crash behaviours, proven on a RENDERED surface rather than
// only in unit tests.
test.describe('scale + long content (F2 / F4)', () => {
  test('the 50-criteria for_each stress renders every row inside one scrollable column', async ({
    page,
  }) => {
    const slug = 'declarative-foreach-stress-wide'
    const pageErrors: string[] = []
    page.on('pageerror', e => pageErrors.push(e.message))

    await page.goto(surface(slug))
    const body = page.locator(bodyOf(slug))
    await expect(body).toBeVisible()
    await expect(page.getByTestId('widget-criterionRow')).toHaveCount(50)
    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toHaveLength(0)

    // The column scrolls INSIDE the region instead of blowing the pane out horizontally.
    const box = await body.evaluate(el => ({
      sw: el.scrollWidth,
      cw: el.clientWidth,
      sh: el.scrollHeight,
      ch: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    }))
    expect(box.sw, 'the column must not scroll horizontally').toBeLessThanOrEqual(box.cw + 1)
    // 50 groups cannot fit a 720px pane, so the column MUST be taller than its viewport and
    // own the vertical scroll itself (rather than blowing the pane out).
    expect(box.sh, 'the 50-row column should overflow its own height').toBeGreaterThan(box.ch)
    expect(box.overflowY).toBe('auto')
  })

  test('a 180-character label wraps inside the form column at ~390px', async ({ page }) => {
    const slug = 'declarative-long-label-narrow'
    await page.goto(surface(slug))

    const body = page.locator(bodyOf(slug))
    await expect(body).toBeVisible()
    const label = page.getByText(/Minimum number of detected features per cell/i).first()
    await expect(label).toBeVisible()

    // WRAPPED, specifically: a 180-char label on one line would be far wider than a 390px
    // column, so the discriminating assertion is that it is MULTI-LINE and fits the column.
    const geom = await label.evaluate(el => {
      const cs = getComputedStyle(el)
      const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2
      return { height: el.getBoundingClientRect().height, width: el.scrollWidth, lineHeight }
    })
    expect(
      geom.height / geom.lineHeight,
      'the long label did not wrap — it is still on one line',
    ).toBeGreaterThan(1.5)
    const col = await body.evaluate(el => el.clientWidth)
    expect(geom.width, 'the wrapped label still exceeds the form column').toBeLessThanOrEqual(col)
  })
})
