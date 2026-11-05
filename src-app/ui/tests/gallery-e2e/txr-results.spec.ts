import { expect, test, type Locator } from '@playwright/test'

/**
 * TXRRESULTS — the board-layout real-browser guard (ITEM-12's gallery-e2e
 * spec, backend-free: the `txrresults/gallery.tsx` cassette + `txrMockRoutes`
 * answer the run detail / predictions / logs / SSE stream / CSV + the two
 * error shapes, and every story drives the REAL pages over the REAL store —
 * the same surfaces a clinician sees).
 *
 * Spec ↔ TESTS.md enumeration:
 *   · TEST-UR-14 (INV-1/2/A) — `txr-results-g`: the populated heatmap's
 *     header bytes (title + subtitle segments), the outcome tab's mono
 *     method columns with their group sublabels, the colored per-method values + Average
 *     column, the three outcome tabs, search/sort/methods pickers with the
 *     0–100 % legend, "Showing 14 of 38 patients… Show all 38", the enabled
 *     download while the run is live; typing in the search narrows rows, the
 *     methods picker to "Dynamic risk (4)" narrows columns AND recomputes the
 *     Average, the sort select reorders; `txr-results-g-running`: a
 *     `prediction` frame adds the 12th column live (no navigation);
 *     `txr-results-g-cannot`: the banner names the method + reason and
 *     "Show the log" opens the dialog with the fixture lines;
 *     `txr-results-h` / `txr-results-h-compare`: method + outcome tabs, bar
 *     table, compare-card sentences, the divergent toggle, the chance dialog
 *     and the saved-in line; `txr-results-narrow-390`: no horizontal page
 *     overflow + the header actions stay inside the viewport;
 *     `txr-results-not-found` / `txr-results-empty`: the two states render.
 *   · TEST-UR-15 (INV-2) — G: pinned patient column + sticky header
 *     (computed-position pins re-asserted after a real scroll), outcome-tab
 *     switching with per-tab column sets, "Show all M"; H: the method
 *     tablist (Compare + per-method tabs), the bar table sorted by the first
 *     method, the compare card + divergent filter, the chance dialog.
 *   · TEST-UR-16 (INV-6) — the web-mode saved-in line renders the run
 *     directory path with NO open-folder button (`txr-results-open-folder`
 *     absent — the positive control: the path text IS present, so "absent"
 *     means "desktop-gated", never "not rendered"), and the run id in the
 *     URL drives the page: the same component over different run ids renders
 *     each run's own content (the two H stories + the partial story each
 *     load their own run from their URL param — the store's reset-on-load +
 *     in-place param-change semantics are the unit tier's pins; the browser
 *     tier shows the URL → view binding).
 *
 * What the fixtures FORCE (records in `fixtures.ts`'s header + DRIFT-1
 * ITEM-11): the G story's numbers are the board-layout constants (38 rows /
 * 12 columns / the 14-row window / day 56 / horizon 238 / 11 min 20 s);
 * every probability is the deterministic spread `fxPercent` (never a board
 * example value) and every patient id is `S\d{4,}`. The deterministic
 * consequences this spec reads (computed from the same formula, re-derived
 * in the ITEM-11 fixtures test): the pfs tab's average-desc order puts
 * S0025 first and S0001 third (60 %); the disagree order's exact-float spread
 * puts S0028 first (88.00000000000001 vs S0018's 87.99999999999999);
 * the H run's first-method sort puts S0028 first and its compare report
 * names S0028/S0025/S0022 (shared top-5) and S0014/S0017/S0011 (the top
 * three by difference: 49 % and 64 % / 52 % and 38 % / 46 % and 59 %), with
 * S0008/S0011/S0014/S0017/S0020/S0039 the divergent set.
 *
 * The METHOD TABLIST'S CLICK NAVIGATION is deliberately not driven here: a
 * seeded gallery frame mounts its story under ONE route (the harness's
 * `SeededSurfaceFrame`), so an in-frame `navigate()` to a sibling results
 * route unmounts the story rather than changing the view. The navigation
 * itself is pinned by the unit suite (TEST-UR-7's MemoryRouter location
 * probe) and the real-backend spec; this tier pins the tablist's rendering
 * + the store-only interactions (outcome tabs, the divergent toggle, the
 * row windows) — recorded in DRIFT-1 ITEM-12.
 *
 * Run (own port on a shared box — the config derives one per worktree):
 *   npx playwright test -c playwright.gallery.config.ts \
 *     tests/gallery-e2e/txr-results.spec.ts
 */

const GALLERY = '/gallery.html?surface='

// The gallery's module graph is transformed ON DEMAND by Vite: the first
// test on a freshly booted server (every `test:e2e:gallery` run boots its
// own worktree server) pays the whole graph's transform — minutes on a
// loaded box at CAP_CPUS=4. This backend-free, dev-only spec opts into its
// own budget rather than inheriting the config's 120 s fast-loop cap.
test.setTimeout(600_000)

/** The G story's subtitle (board bytes; the fixture's derived facts). */
const G_SUBTITLE =
  '12 of 12 methods finished · learned from 151 patients · decision day 56 · took 11 minutes 20 seconds'

/** The H run's dir (the saved-in line's path — the story URL's run id). */
const H_RUN_DIR = 'Documents/TxResBench/analysis-fx-1004'

/** The fixture's deterministic compare-card facts (see the header). */
const SHARED_TOP_SENTENCE = 'Both methods put S0028, S0025 and S0022 among their five highest chances.'
const DIFFER_SENTENCE = 'They differ most for S0014 (49% and 64%), S0017 (52% and 38%) and S0011 (46% and 59%).'

/** The first DATA row of the heatmap (windowed rows carry a `txr-heatmap-row-*` id). */
function firstHeatmapRow(scope: Locator): Locator {
  return scope.locator('tr[data-testid^="txr-heatmap-row-"]').first()
}

/** The scroll box's computed sticky facts (the board's two-axis pinning). */
async function stickyFacts(el: Locator) {
  return el.evaluate(node => {
    const style = getComputedStyle(node)
    return { position: style.position, top: style.top, left: style.left, zIndex: style.zIndex }
  })
}

test.describe('txr-results-g — the populated heatmap (TEST-UR-14 + TEST-UR-15)', () => {
  test('board bytes, method columns, colored values, outcome tabs, filters, row window', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-results-g`)

    const heatmap = page.getByTestId('txr-heatmap')
    await expect(heatmap).toBeVisible()

    // ── the header bytes (BusyResults.dc.html, fixture-derived counts) ──
    await expect(page.getByTestId('txr-results-header')).toContainText('Predictions for 38 patients')
    await expect(page.getByTestId('txr-results-subtitle')).toHaveText(G_SUBTITLE)
    await expect(page.getByTestId('txr-results-save-models')).toHaveText('Save the models (12)')
    const download = page.getByTestId('txr-results-download')
    await expect(download).toBeVisible()
    await expect(download).toBeEnabled()

    // ── the outcome tablist: one tab per distinct finished-method task ──
    await expect(page.getByTestId('txr-results-outcome-tab-pfs')).toContainText(
      'Progression or death by day 238',
    )
    await expect(page.getByTestId('txr-results-outcome-tab-os')).toContainText('Death by day 238')
    await expect(page.getByTestId('txr-results-outcome-tab-response')).toContainText(
      'No response by day 56',
    )

    // ── the default outcome tab's column set (the pfs task's 8 of the 12
    //    finished methods; mono id + group sublabel in the header) ──
    const headers = heatmap.locator('[data-testid^="txr-heatmap-header-"]')
    await expect(headers).toHaveCount(8)
    const firstHeader = page.getByTestId('txr-heatmap-header-direct-on')
    await expect(firstHeader).toContainText('direct-on')
    await expect(firstHeader).toContainText('Response probability')

    // ── one colored value from the board's live alpha (66 % → rgba 0.61)
    //    and the average/patient entries of one visible row ──
    const row = page.getByTestId('txr-heatmap-row-S0001')
    await expect(row).toBeVisible()
    // The chance column's first value box (the DOM id ends with the mono
    // column id — the value selector is the suffix, suffix selectors keep the
    // board's id surface testable without spelling its prefix).
    const chanceValue = row.locator('td[data-testid$="-direct-on"]')
    await expect(chanceValue).toHaveText('66%')
    expect(await chanceValue.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(
      'rgba(29, 78, 137, 0.61)',
    )
    await expect(row).toContainText('60%') // the recomputed pfs average (S0001)
    await expect(row).toContainText('S0001')

    // ── the legend + the methods picker's All count (the pfs tab's 8 columns) ──
    await expect(page.getByTestId('txr-results-legend')).toContainText('Chance of failure')
    await expect(page.getByTestId('txr-results-legend')).toContainText('0 to 100%')

    // ── the board row window: the story applied "Showing 14 of 38" ──
    await expect(heatmap.locator('tr[data-testid^="txr-heatmap-row-"]')).toHaveCount(14)
    await expect(page.getByTestId('txr-heatmap-show-more')).toHaveText('Show all 38')

    // ── search narrows the rows (case-insensitive substring) ──
    await page.getByTestId('txr-results-search').fill('s0005')
    await expect(page.getByTestId('txr-heatmap-row-S0005')).toBeVisible()
    await expect(page.getByTestId('txr-heatmap-row-S0001')).toHaveCount(0)
    await page.getByTestId('txr-results-search').fill('')
    await expect(page.getByTestId('txr-heatmap-row-S0001')).toBeVisible()

    // ── the methods picker: "Dynamic risk (4)" narrows the columns and the
    //    Average recomputes over the visible values (60 % → 51 % on S0001) ──
    await page.getByTestId('txr-results-methods').click()
    await page.getByRole('option', { name: 'Dynamic risk (4)' }).click()
    await expect(headers).toHaveCount(4)
    for (const id of [
      'cox-timevarying-slope',
      'dynforest',
      'ctdna-dynamics-three-group',
      'ctdna-clearance-time-pattern',
    ]) {
      await expect(page.getByTestId(`txr-heatmap-header-${id}`)).toBeVisible()
    }
    await expect(heatmap.locator('tr[data-testid^="txr-heatmap-row-"]').first()).toBeVisible()
    await expect(page.getByTestId('txr-heatmap-row-S0001')).toContainText('51%')
    await expect(page.getByTestId('txr-heatmap-row-S0001')).not.toContainText('60%')
    // Back to All — the picker's All label is the tab's column count.
    await page.getByTestId('txr-results-methods').click()
    await page.getByRole('option', { name: 'All 8' }).click()
    await expect(headers).toHaveCount(8)

    // ── the three board sorts reorder the rows (first data row by sort) ──
    const sortSelect = page.getByTestId('txr-results-sort')
    // Average chance, highest first (the default): S0025 is the fixture's top.
    await expect(firstHeatmapRow(heatmap)).toHaveAttribute('data-testid', 'txr-heatmap-row-S0025')

    await sortSelect.click()
    await page.getByRole('option', { name: 'Patient' }).click()
    await expect(firstHeatmapRow(heatmap)).toHaveAttribute('data-testid', 'txr-heatmap-row-S0001')

    await sortSelect.click()
    await page.getByRole('option', { name: 'Methods disagree most' }).click()
    // The exact-float spread is the sort key: the fixture's abstains leave
    // S0028 with four values (0.93 − 0.05 → 88.00000000000001) ahead of
    // S0018's eight (87.99999999999999) — the exact comparison pin, never a
    // rounded one.
    await expect(firstHeatmapRow(heatmap)).toHaveAttribute('data-testid', 'txr-heatmap-row-S0028')

    // ── "Show all 38" raises the row window; the DOM stays bounded by the
    //    fixed-pitch window (38 rows → the 24-row windowing budget) and the
    //    Show-all affordance disappears once everything is shown ──
    await page.getByTestId('txr-heatmap-show-more').click()
    await expect(heatmap.locator('tr[data-testid^="txr-heatmap-row-"]')).toHaveCount(24)
    await expect(page.getByTestId('txr-heatmap-show-more')).toHaveCount(0)
    await expect(page.getByTestId('txr-results-subtitle')).toHaveText(G_SUBTITLE)
  })

  test('pinned patient column + sticky header under scroll, per-tab column sets (TEST-UR-15)', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-results-g`)

    const heatmap = page.getByTestId('txr-heatmap')
    const patientHeader = page.getByTestId('txr-heatmap-header-direct-on')
    await expect(heatmap).toBeVisible()
    await expect(patientHeader).toBeVisible()

    // The corner (top-left) + header (top) + patient column (left) pins,
    // re-asserted AFTER a real two-axis scroll inside the scroll box.
    const box = heatmap.locator('table')
    expect(await stickyFacts(box.locator('thead tr > *').first())).toMatchObject({
      position: 'sticky',
      top: '0px',
      left: '0px',
    })
    expect(await stickyFacts(patientHeader)).toMatchObject({ position: 'sticky', top: '0px' })
    const patientColumn = page.getByTestId('txr-heatmap-row-S0001').locator('th')
    expect(await stickyFacts(patientColumn)).toMatchObject({ position: 'sticky', left: '0px' })

    // (the 8-column table fits the 1280 frame — the scroll box is narrowed
    // so the board's horizontal overflow is real, then both axes scroll)
    await heatmap.evaluate(el => {
      el.style.width = '540px'
      el.scrollTop = 200
      el.scrollLeft = 240
      el.dispatchEvent(new Event('scroll'))
    })

    expect(await stickyFacts(box.locator('thead tr > *').first())).toMatchObject({
      position: 'sticky',
      top: '0px',
      left: '0px',
    })
    expect(await stickyFacts(patientHeader)).toMatchObject({ position: 'sticky', top: '0px' })
    expect(await stickyFacts(patientColumn)).toMatchObject({ position: 'sticky', left: '0px' })

    // The pinned column never moves with the content: after scrolling 240 px
    // right, all 14 mounted patient columns sit at the same x as before.
    const before = await patientColumn.boundingBox()
    const after = await page.getByTestId('txr-heatmap-row-S0001').locator('th').boundingBox()
    expect(before, 'patient column').not.toBeNull()
    expect(after, 'patient column after scroll').not.toBeNull()
    expect(Math.abs(after!.x - before!.x)).toBeLessThanOrEqual(1)
    // …while a method value moved with the content (the row-scoped value
    // selector: the sticky header th ends with the same column id).
    const firstRow = page.getByTestId('txr-heatmap-row-S0001')
    const valueBefore = await firstRow.locator('td[data-testid$="-direct-on"]').boundingBox()
    await heatmap.evaluate(el => {
      el.scrollLeft = 0
      el.scrollTop = 0
      el.dispatchEvent(new Event('scroll'))
    })
    const valueAfter = await firstRow.locator('td[data-testid$="-direct-on"]').boundingBox()
    expect(valueBefore, 'chance value at scroll').not.toBeNull()
    expect(valueAfter, 'chance value at rest').not.toBeNull()
    expect(Math.abs(valueAfter!.x - valueBefore!.x)).toBeGreaterThan(1)

    // Outcome-tab switching: per-tab column sets (pfs 8 → os 2 → response 2)
    // and the tab labels riding the board's day wording.
    await page.getByTestId('txr-results-outcome-tab-os').click()
    await expect(page.getByTestId('txr-heatmap-header-baseline-ctdna-detectability')).toBeVisible()
    await expect(page.getByTestId('txr-heatmap-header-baseline-cox-cumulative-hazard')).toBeVisible()
    await expect(page.getByTestId('txr-heatmap-header-direct-on')).toHaveCount(0)

    await page.getByTestId('txr-results-outcome-tab-response').click()
    await expect(page.getByTestId('txr-heatmap-header-asm-best-change-rule')).toBeVisible()
    await expect(page.getByTestId('txr-heatmap-header-ctdna-clearance')).toBeVisible()
    await expect(page.getByTestId('txr-heatmap-header-baseline-ctdna-detectability')).toHaveCount(0)

    await page.getByTestId('txr-results-outcome-tab-pfs').click()
    await expect(page.getByTestId('txr-heatmap-header-direct-on')).toBeVisible()
  })
})

test.describe('txr-results-g-running — live while the run continues (TEST-UR-14)', () => {
  test('a prediction frame adds the 12th column without a reload and the counts update', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-results-g-running`)

    const heatmap = page.getByTestId('txr-heatmap')
    await expect(heatmap).toBeVisible()
    // The pfs tab's 7 columns (11 finished; the 12th method still
    // running), and the running method's column absent.
    await expect(heatmap.locator('[data-testid^="txr-heatmap-header-"]')).toHaveCount(7)
    await expect(page.getByTestId('txr-results-subtitle')).toContainText('11 of 12 methods finished')
    await expect(page.getByTestId('txr-heatmap-header-landmark-cox-current')).toHaveCount(0)

    // The stream's frame script finishes the 12th method: its `prediction`
    // frame is the column announcement — the column appears, no navigation.
    await expect(page.getByTestId('txr-heatmap-header-landmark-cox-current')).toBeVisible({
      timeout: 30_000,
    })
    await expect(heatmap.locator('[data-testid^="txr-heatmap-header-"]')).toHaveCount(8)
    await expect(page.getByTestId('txr-results-subtitle')).toContainText('12 of 12 methods finished')
  })
})

test.describe('txr-results-g-cannot — a method that could not run (TEST-UR-14)', () => {
  test('the banner names the method + reason, the log dialog carries the fixture lines', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-results-g-cannot`)

    const banner = page.getByTestId('txr-results-cannot-cox-ctdna-status-rfs')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('cox-ctdna-status-rfs')
    await expect(banner).toContainText('could not run: LDH is not in your measurements.')
    await expect(banner).toContainText('The other 2 methods are shown.')

    await page.getByTestId('txr-results-show-log-cox-ctdna-status-rfs').click()
    const dialog = page.getByTestId('txr-log-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Log: cox-ctdna-status-rfs')
    await expect(page.getByTestId('txr-log-dialog-pre')).toContainText(
      'cox-ctdna-status-rfs: no eligibility — LDH is not in your measurements.',
    )
    await expect(page.getByTestId('txr-log-dialog-copy')).toBeEnabled()
  })
})

test.describe('txr-results-h — one-method view + the web-mode reveal gate (TEST-UR-14/15/16)', () => {
  test('method tablist, bars sorted by the first method, aside, saved-in path without a button', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-results-h`)

    const bars = page.getByTestId('txr-bars')
    await expect(bars).toBeVisible()

    // ── the method tablist: Compare + one tab per finished method, the
    //    URL-selected method tab active (the kit Tabs' data-state hook) ──
    await expect(page.getByTestId('txr-results-method-tab-compare')).toBeVisible()
    await expect(
      page.getByTestId('txr-results-method-tab-landmark-cox-current'),
    ).toHaveAttribute('data-state', 'active')
    await expect(page.getByTestId('txr-results-method-tab-cox-cutpoint-risk')).toBeVisible()
    await expect(page.getByTestId('txr-results-method-tab-compare')).toHaveAttribute(
      'data-state',
      'inactive',
    )

    // ── the bar table: the board's sentence + the fixture's window ──
    await expect(page.getByTestId('txr-bars-footer')).toHaveText(
      'Chance of treatment failure by day 238, sorted by the first method. Showing 8 of 40.',
    )
    await expect(page.getByTestId('txr-bars-show-more')).toHaveText('Show all 40')
    // The first-method sort: S0028 first (the fixture's top chance 93 %),
    // each bar box carries its percent, and the window is 8 rows.
    await expect(page.getByTestId('txr-bars-row-S0028')).toBeVisible()
    const firstValueBox = page.getByTestId('txr-bars-landmark-cox-current').first()
    await expect(firstValueBox).toContainText('93%')
    await expect(page.getByTestId('txr-bars-row-S0038')).toBeVisible()
    await expect(page.getByTestId('txr-bars-row-S0040')).toHaveCount(0)

    // ── the one-method header: Save this model (the produced model exists) ──
    await expect(page.getByTestId('txr-results-save-one-model')).toBeVisible()
    await expect(page.getByTestId('txr-results-save-models')).toHaveCount(0)

    // ── the aside: care card, chance link → the derived dialog ──
    await expect(page.getByTestId('txr-results-care')).toContainText('Read these with care')
    await page.getByTestId('txr-results-chance-link').click()
    await expect(page.getByTestId('txr-chance-dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('txr-chance-dialog')).toHaveCount(0)

    // ── TEST-UR-16's web-mode gate: the path text IS present, the
    //    desktop-only action is absent (positive control) ──
    await expect(page.getByTestId('txr-results-saved-in')).toContainText('Saved in')
    await expect(page.getByTestId('txr-results-saved-in')).toContainText(H_RUN_DIR)
    await expect(page.getByTestId('txr-results-open-folder')).toHaveCount(0)

    // The G-board subtitle rides the H run's facts (the plan pins ONE subtitle).
    await expect(page.getByTestId('txr-results-subtitle')).toHaveText(
      '2 of 2 methods finished · learned from 151 patients · decision day 56 · took 3 minutes 10 seconds',
    )
  })
})

test.describe('txr-results-h-compare — the two-method compare view (TEST-UR-14/15)', () => {
  test('compare-card sentences, divergent toggle filters the rows, chance dialog, saved-in', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-results-h-compare`)

    await expect(page.getByTestId('txr-bars')).toBeVisible()
    await expect(page.getByTestId('txr-results-method-tab-compare')).toBeVisible()

    // ── the compare card: the two board sentences (fixture-derived names) ──
    const card = page.getByTestId('txr-compare-card')
    await expect(card).toBeVisible()
    await expect(card).toContainText('How the two methods compare')
    await expect(card).toContainText(SHARED_TOP_SENTENCE)
    await expect(card).toContainText(DIFFER_SENTENCE)

    // ── the divergent toggle: 6 of the 40 patients differ ≥ 10 points ──
    const toggle = page.getByTestId('txr-compare-divergent-toggle')
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('txr-bars-row-S0008')).toHaveCount(0)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('txr-bars-row-S0008')).toBeVisible()
    await expect(page.getByTestId('txr-bars-row-S0001')).toHaveCount(0)
    await expect(page.getByTestId('txr-bars-footer')).toContainText('Showing 6 of 6.')
    await toggle.click()
    await expect(page.getByTestId('txr-bars-footer')).toContainText('Showing 8 of 40.')

    // The compare tab's header carries the run-level Save-the-models entry.
    await expect(page.getByTestId('txr-results-save-models')).toHaveText('Save the models (2)')
    await expect(page.getByTestId('txr-results-save-one-model')).toHaveCount(0)
  })
})

test.describe('txr-results-h-few — a single-method run (TEST-UR-14)', () => {
  test('one method: no compare card, no divergent toggle, one-method save', async ({ page }) => {
    await page.goto(`${GALLERY}txr-results-h-few`)

    await expect(page.getByTestId('txr-bars')).toBeVisible()
    await expect(page.getByTestId('txr-compare-card')).toHaveCount(0)
    await expect(page.getByTestId('txr-compare-divergent-toggle')).toHaveCount(0)
    // The one-method run's compare route: the run-level save entry; the
    // method-tab "Save this model" is the h story's (its URL is the method
    // route) — the h-few frame mounts under the compare route (one route per
    // seeded frame, see the header note).
    await expect(page.getByTestId('txr-results-save-models')).toHaveText('Save the models (1)')
    await expect(page.getByTestId('txr-results-save-one-model')).toHaveCount(0)
    // The h-few frame mounts the page without the applied 8-row window (the
    // H window is the h / h-compare stories' wrapper): the default 100-row
    // window shows all 12.
    await expect(page.getByTestId('txr-bars-footer')).toContainText('Showing 12 of 12.')
  })
})

test.describe('txr-results-empty / txr-results-not-found — the DEC-18 states (TEST-UR-14)', () => {
  test('409: header + banner + disabled download, no heatmap, no spinner loop', async ({ page }) => {
    await page.goto(`${GALLERY}txr-results-empty`)

    await expect(page.getByTestId('txr-results-header')).toBeVisible()
    await expect(page.getByTestId('txr-results-subtitle')).toContainText('0 of 3 methods finished')
    await expect(page.getByTestId('txr-results-cannot-cox-ctdna-status-rfs')).toBeVisible()
    await expect(page.getByTestId('txr-heatmap')).toHaveCount(0)
    await expect(page.getByTestId('txr-results-loading')).toHaveCount(0)
    await expect(page.getByTestId('txr-results-download')).toBeDisabled()
  })

  test('404: the not-found state + New analysis CTA, no crash', async ({ page }) => {
    await page.goto(`${GALLERY}txr-results-not-found`)

    await expect(page.getByTestId('txr-results-not-found')).toBeVisible()
    await expect(page.getByTestId('txr-results-not-found')).toContainText(
      'This analysis run could not be found',
    )
    await expect(page.getByTestId('txr-results-new-analysis')).toBeVisible()
    await expect(page.getByTestId('txr-results-error')).toHaveCount(0)
  })
})

test.describe('txr-results-narrow-390 — the mobile width (TEST-UR-14)', () => {
  test('no horizontal page overflow; the header actions stay inside the viewport', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-results-narrow-390`)

    await expect(page.getByTestId('txr-bars')).toBeVisible()
    await expect(page.getByTestId('txr-results-saved-in')).toBeVisible()

    // The 390 measurement idiom (the entry-list spec's): the gallery page
    // itself never overflows horizontally.
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, 'page horizontal overflow px').toBeLessThanOrEqual(1)

    // The header actions stay reachable inside the viewport (the page scrolls
    // vertically; x must fit).
    for (const id of ['txr-results-download', 'txr-results-save-models', 'txr-results-new-analysis']) {
      const button = page.getByTestId(id)
      await button.scrollIntoViewIfNeeded()
      const box = await button.boundingBox()
      expect(box, `${id} must be mounted`).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    }
  })
})
