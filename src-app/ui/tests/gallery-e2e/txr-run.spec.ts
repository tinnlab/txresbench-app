import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * TXRRUN — the E/F screen real-browser guard (ITEM-12's gallery-e2e spec,
 * backend-free: the `txrrun/gallery.tsx` cassette + the id-scoped stream
 * route answer the screen-E reads, the shared method-catalogue keys come
 * from the `txrlist` cassette, the F run detail/logs via the mount-time
 * extension with the txrresults delegation, and every story drives the REAL
 * pages over the REAL store — the same surfaces a clinician sees).
 *
 * Spec ↔ TESTS.md enumeration:
 *   · TEST-RUN-24 (INV-3, `txr-run-e`) — the board layout: the slot lines,
 *     the four settings rows, the shared list's rows (mono id, "Paper 2021,
 *     R", group chip, Can run + "all 151 patients", time, About), the group
 *     chips, the estimate-driven bottom bar; selecting five rows updates
 *     the bar; the About dialog shows the fixture card; `txr-run-e-empty`
 *     and `txr-run-e-error` render their states — EXAMPLE-UI-RUN-1.
 *   · TEST-RUN-25 (INV-1/2, `txr-run-f` + `txr-run-f-working` +
 *     `txr-run-f-failed` + `txr-run-f-finished`) — the replayed SSE frames
 *     drive the page: the counts strip updates, a row flips waiting →
 *     downloading → running → finished with its progress text, the log
 *     panel appends the `log` frames, a `prediction` frame lights "See the
 *     results", the tabs filter by bucket and add up, and pressing Skip on a
 *     waiting row posts the mocked `Txr.skipMethod` (read through the story
 *     seam — the component is never probed); the failed story renders the
 *     reasons + Show log; the finished story the terminal snapshot —
 *     EXAMPLE-UI-RUN-2.
 *   · TEST-RUN-26 (INV-2) — `txr-run-e-narrow-390` and
 *     `txr-run-f-narrow-390` have no horizontal page overflow (the
 *     `entry-list-second-annotation-overflow` measurement idiom) and the
 *     header actions stay inside the viewport; `txr-run-f-not-found` renders
 *     the not-found state.
 *   · TEST-RUN-27 (INV-6) — the fixtures are synthetic (no real path / id
 *     shape) and the spec asserts counts structurally or from the cassette
 *     data, never the boards' example literals.
 *
 * What the fixtures FORCE (records in `fixtures.ts`'s header + DRIFT-1
 * ITEM-12): the E story's slot/settings facts come from the intake
 * provider's fixture bundle through its OWN inspect/validate builders; the
 * list rows/chips/estimate are the `txrlist` fixture bytes (the same
 * numbers the `txr-list` spec pins — the first five enabled rows'
 * [120, 120, 12, 840, 240] pack to exactly 840 s at 3 lanes); the F run's
 * method mix and the frame script are this module's own synthetic facts
 * (6 rows; the walk of `direct-on`; the fixture log lines' seq order).
 *
 * Run (own port on a shared box — the config derives one per worktree):
 *   npx playwright test -c playwright.gallery.config.ts \
 *     tests/gallery-e2e/txr-run.spec.ts
 */

const GALLERY = '/gallery.html?surface='

// The gallery's module graph is transformed ON DEMAND by Vite: the first
// test on a freshly booted server (every `test:e2e:gallery` run boots its
// own worktree server) pays the whole graph's transform — minutes on a
// loaded box at CAP_CPUS=4. This backend-free, dev-only spec opts into its
// own budget rather than inheriting the config's 120 s fast-loop cap.
test.setTimeout(600_000)

/** The fixture's first five ENABLED rows (the shared cassette's order). */
const E_FIRST_FIVE_KEYS = [
  'direct-on',
  'cox-timevarying-slope',
  'baseline-ctdna-detectability',
  'dynforest',
  'flirti',
]

/** The exact long-form total the fixture's LPT makespan serves (the txrlist cassette). */
const E_TOTAL_TEXT = 'about 14 minutes in total'

/** The board's research-use notice (DEC-11, both run screens). */
const RESEARCH_NOTICE = "For research. Not for deciding a patient's treatment."

test.describe('txr-run-e — choose the methods and settings (TEST-RUN-24)', () => {
  test('board layout, shared list rows, group chips, selection → estimate total, About', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-run-e`)

    // ── the shell: the step line + the board title, then the slot lines ──
    await expect(page.getByText('Step 4 of 4')).toBeVisible()
    // The gallery frame's own title is a sibling heading with the same words —
    // the anchor pins the page's own h1.
    await expect(
      page.getByRole('heading', { name: /^Choose the methods and settings$/ }),
    ).toBeVisible()
    await expect(page.getByTestId('txr-run-slots')).toBeVisible()
    const patients = page.getByTestId('txr-run-slots-patients')
    await expect(patients).toContainText('Patients')
    await expect(patients).toContainText('fixture-patients.csv')
    // The validated facts ride the slot line (the intake fixture's summary).
    await expect(patients).toContainText('·')
    const measurements = page.getByTestId('txr-run-slots-measurements')
    await expect(measurements).toContainText('Measurements')
    await expect(measurements).toContainText('fixture-measurements.csv')
    // The train-mode flow has no predict slot (a slot without a file is absent).
    await expect(page.getByTestId('txr-run-slots-predict')).toHaveCount(0)
    await expect(page.getByTestId('txr-run-change-files')).toBeVisible()

    // ── the four settings rows (the board's labels + the option sets) ──
    const settings = page.getByTestId('txr-run-settings')
    await expect(settings).toBeVisible()
    for (const label of ['Predict', 'Decision day', 'Look ahead to', 'Extra inputs', 'More settings']) {
      await expect(settings).toContainText(label)
    }
    await expect(page.getByTestId('txr-run-settings-endpoint')).toContainText('Progression or death')
    await expect(page.getByTestId('txr-run-settings-endpoint')).toContainText('Death only')
    await expect(page.getByTestId('txr-run-settings-decision-day')).toContainText('Day 56')
    await expect(page.getByTestId('txr-run-settings-look-ahead')).toContainText('Day 238')
    // The fixture patients file's inspection carries no covariate column:
    // the row names the honest absent line (the board's names are data, INV-6).
    await expect(page.getByTestId('txr-run-settings-covariate-names')).toHaveText(
      'no extra inputs in your file',
    )

    // ── the shared list over the catalogue cassette: the board's bytes ──
    await expect(page.getByTestId('txr-list')).toBeVisible()
    await expect(page.getByTestId('txr-list-row-direct-on')).toBeVisible()
    const row = await page.getByTestId('txr-list-row-direct-on').textContent()
    for (const needle of [
      'direct-on',
      'Paper 2021, R',
      'Response probability',
      'Can run',
      'all 151 patients',
      'about 2 min',
      'About',
    ]) {
      expect(row, `row direct-on must carry ${needle!}`).toContain(needle!)
    }
    const someRow = await page.getByTestId('txr-list-row-dynforest').textContent()
    for (const needle of ['Can run for some patients', 'needs 3 or more draws; 120 of 151 have them', 'about 14 min']) {
      expect(someRow, `row dynforest must carry ${needle!}`).toContain(needle!)
    }
    const cannotRow = await page.getByTestId('txr-list-row-cox-ctdna-status-rfs').textContent()
    expect(cannotRow).toContain('Cannot run')
    expect(cannotRow).toContain('needs LDH, not in your file')

    // ── the built-in count chips + the four group chips (one per group) ──
    await expect(page.getByTestId('txr-list-filter-all')).toHaveText('All 38')
    await expect(page.getByTestId('txr-list-filter-can-run')).toHaveText('Can run 26')
    for (const group of [
      'response-call',
      'response-probability',
      'static-risk',
      'dynamic-risk',
    ]) {
      await expect(page.getByTestId(`txr-list-filter-${group}`)).toBeVisible()
    }

    // ── the bottom bar: select five → the pinned estimate total ──
    for (const key of E_FIRST_FIVE_KEYS) {
      await page.getByTestId(`txr-list-checkbox-${key}`).click()
    }
    await expect(page.getByTestId('txr-list-selected-count')).toHaveText('5 methods selected')
    await expect(page.getByTestId('txr-list-total-time')).toContainText(E_TOTAL_TEXT)
    await expect(page.getByTestId('txr-list-run')).toHaveText('Run 5 methods')
    await expect(page.getByTestId('txr-list-bottom-bar')).toContainText(RESEARCH_NOTICE)

    // ── the About dialog shows the fixture method card ──
    await page.getByTestId('txr-list-row-direct-on-action').click()
    const about = page.getByTestId('txr-run-about-direct-on')
    await expect(about).toBeVisible()
    await expect(about).toContainText('direct-on')
    await expect(page.getByTestId('txr-run-about-description')).toContainText(
      'direct on-treatment response rule',
    )
    const facts = page.getByTestId('txr-run-about-facts')
    await expect(facts).toContainText('Software')
    await expect(facts).toContainText('R')
    await expect(facts).toContainText('Licence')
    await expect(facts).toContainText('MIT')
  })
})

test.describe('txr-run-e-empty / txr-run-e-error — the DEC-16 states (TEST-RUN-24)', () => {
  test('empty: the named-missing input + start-new CTA', async ({ page }) => {
    await page.goto(`${GALLERY}txr-run-e-empty`)

    const empty = page.getByTestId('txr-run-empty')
    await expect(empty).toBeVisible()
    await expect(empty).toContainText('patients')
    await expect(page.getByTestId('txr-run-empty-start')).toHaveText('Start a new analysis')
    await expect(page.getByTestId('txr-list')).toHaveCount(0)
  })

  test('error: the shared list\'s failure surface + Retry, slots still rendered', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-run-e-error`)

    await expect(page.getByTestId('txr-run-slots')).toBeVisible()
    await expect(page.getByTestId('txr-list-error')).toBeVisible()
    await expect(page.getByTestId('txr-list-retry')).toBeVisible()
    await expect(page.getByTestId('txr-list-row-direct-on')).toHaveCount(0)
  })
})

test.describe('txr-run-f — live frames drive the screen (TEST-RUN-25)', () => {
  test('frame walk: row flips, counts update, log appends, prediction lights results, Skip posts', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-run-f`)

    // ── the live board's stable facts (the fixture's run, derived counts) ──
    await expect(page.getByTestId('txr-run-header')).toBeVisible()
    await expect(page.getByTestId('txr-run-title')).toHaveText('Running 6 methods')
    await expect(page.getByTestId('txr-run-tabs')).toBeVisible()
    // No finished method at the opening: the results affordance is dark
    // (the validation below waits for the prediction frame to light it).
    await expect(page.getByTestId('txr-run-see-results')).toHaveCount(0)

    // ── the stream's frame script finishes direct-on: the row flips and the
    //    counts strip recomputes (WAIT — the mock replays with 350 ms gaps;
    //    the frame walk is ~3.5 s end to end) ──
    const row = page.getByTestId('txr-run-row-direct-on')
    await expect(page.getByTestId('txr-run-state-direct-on')).toHaveText('finished', {
      timeout: 30_000,
    })
    await expect(page.getByTestId('txr-run-counts-finished')).toHaveText('1 finished')
    await expect(page.getByTestId('txr-run-counts-running')).toHaveText('1 running')
    await expect(page.getByTestId('txr-run-counts-waiting')).toHaveText('1 waiting')
    await expect(page.getByTestId('txr-run-counts-failed')).toHaveText('1 failed')
    await expect(page.getByTestId('txr-run-action-direct-on')).toHaveText('View result')
    // A running row's time column reads its elapsed (the board's per-row time).
    await expect(page.getByTestId('txr-run-time-dynforest')).toHaveText('41 s')

    // ── the prediction frame lights the results affordance ──
    await expect(page.getByTestId('txr-run-see-results')).toBeVisible({ timeout: 30_000 })

    // ── the tabs' bucket partition adds up to the row set (RP-3: one
    //    bucket per engine state — the cannot-run row is its own tab) ──
    await expect(page.getByTestId('txr-run-tab-all')).toContainText('All 6')
    await expect(page.getByTestId('txr-run-tab-finished')).toContainText('Finished 1')
    await page.getByTestId('txr-run-tab-finished').click()
    await expect(page.getByTestId('txr-run-row-direct-on')).toBeVisible()
    await expect(page.getByTestId('txr-run-row-dynforest')).toHaveCount(0)
    await page.getByTestId('txr-run-tab-failed').click()
    await expect(page.getByTestId('txr-run-row-baseline-ctdna-detectability')).toBeVisible()
    await expect(page.getByTestId('txr-run-row-cox-ctdna-status-rfs')).toHaveCount(0)
    await expect(page.getByTestId('txr-run-row-direct-on')).toHaveCount(0)
    await page.getByTestId('txr-run-tab-cannot_run').click()
    await expect(page.getByTestId('txr-run-row-cox-ctdna-status-rfs')).toBeVisible()
    await page.getByTestId('txr-run-tab-all').click()

    // ── the log panel: the stream's lines + the backfill, All view ──
    await page.getByTestId('txr-run-action-cox-ctdna-status-rfs').click()
    await expect(page.getByTestId('txr-run-log')).toBeVisible()
    await expect(page.getByTestId('txr-run-log-filter')).toBeVisible()
    await expect(page.getByTestId('txr-run-log-filter')).toContainText('cox-ctdna-status-rfs')
    // The board's select: pick "All methods" for the whole-run view.
    await page.getByTestId('txr-run-log-filter').click()
    await expect(page.getByTestId('txr-run-log-filter-opt-all')).toBeVisible()
    await page.getByTestId('txr-run-log-filter-opt-all').click()
    await expect(page.getByTestId('txr-run-log-lines')).toContainText('run admitted; 6 methods queued')
    await expect(page.getByTestId('txr-run-log-lines')).toContainText('fitting on 132 patient rows')

    // ── Skip posts through the mocked control (the story seam's record) ──
    const skip = page.getByTestId('txr-run-action-flirti')
    await expect(skip).toHaveText('Skip')
    await skip.click()
    await expect
      .poll(async () => {
        const text = await page.getByTestId('txr-run-request-seam').textContent()
        return text ?? ''
      })
      .toContain('"Txr.skipMethod"')
    const seam = await page.getByTestId('txr-run-request-seam').textContent()
    expect(seam).toContain('"method_id":"flirti"')
    // The row keeps its state — the engine's frames own the transition; a
    // 409 would have landed as a row error, never a crash.
    await expect(page.getByTestId('txr-run-row-flirti')).toBeVisible()
  })
})

test.describe('txr-run-f-working — the mid-run mix (TEST-RUN-25)', () => {
  test('one row per engine state: all per-state actions rendered', async ({ page }) => {
    await page.goto(`${GALLERY}txr-run-f-working`)

    await expect(page.getByTestId('txr-run-title')).toHaveText('Running 6 methods')
    await expect(page.getByTestId('txr-run-counts-finished')).toHaveText('1 finished')
    await expect(page.getByTestId('txr-run-counts-running')).toHaveText('1 running')
    await expect(page.getByTestId('txr-run-counts-downloading')).toHaveText('1 downloading')
    await expect(page.getByTestId('txr-run-counts-waiting')).toHaveText('1 waiting')
    await expect(page.getByTestId('txr-run-counts-failed')).toHaveText('1 failed')
    await expect(page.getByTestId('txr-run-see-results')).toBeVisible()

    await expect(page.getByTestId('txr-run-action-direct-on')).toHaveText('Skip')
    await expect(page.getByTestId('txr-run-action-cox-timevarying-slope')).toHaveText('Skip')
    await expect(page.getByTestId('txr-run-action-dynforest')).toHaveText('Stop')
    await expect(page.getByTestId('txr-run-action-flirti')).toHaveText('View result')
    await expect(page.getByTestId('txr-run-action-baseline-ctdna-detectability')).toHaveText('Show log')
    await expect(page.getByTestId('txr-run-action-cox-ctdna-status-rfs')).toHaveText('Show log')
    // A downloading row's detail is the env bytes (the board's progress fact).
    await expect(page.getByTestId('txr-run-detail-cox-timevarying-slope')).toContainText('MB')
  })
})

test.describe('txr-run-f-failed — the failures kept with their reasons (TEST-RUN-25)', () => {
  test('reason lines in the Failed / Cannot run tabs, Show log opens the panel at the method', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-run-f-failed`)

    await expect(page.getByTestId('txr-run-title')).toHaveText('Running 6 methods')
    // A failed row's reason is never blank (the row's own chip — read on
    // the Failed tab, before the switch; the Cannot-run tab holds others).
    await expect(page.getByTestId('txr-run-state-cox-timevarying-slope')).toHaveText('failed')
    await page.getByTestId('txr-run-tab-failed').click()
    await expect(page.getByTestId('txr-run-detail-cox-timevarying-slope')).toContainText(
      'the fitting step returned no model',
    )
    await expect(page.getByTestId('txr-run-detail-baseline-ctdna-detectability')).toContainText(
      'the environment did not verify',
    )
    // The cannot-run row is NOT the Failed tab's (RP-3): its own tab.
    await expect(page.getByTestId('txr-run-detail-cox-ctdna-status-rfs')).toHaveCount(0)
    await page.getByTestId('txr-run-tab-cannot_run').click()
    await expect(page.getByTestId('txr-run-detail-cox-ctdna-status-rfs')).toContainText(
      'LDH is not in your measurements.',
    )

    await page.getByTestId('txr-run-action-cox-ctdna-status-rfs').click()
    await expect(page.getByTestId('txr-run-log')).toBeVisible()
    await expect(page.getByTestId('txr-run-log-lines')).toContainText(
      'no eligibility — LDH is not in your measurements.',
    )
    await expect(page.getByTestId('txr-run-log-filter')).toContainText('cox-ctdna-status-rfs')
  })
})

test.describe('txr-run-f-finished — the terminal snapshot (TEST-RUN-25)', () => {
  test('all rows finished, the results link live, tabs render the snapshot (RP-1: the run\'s own terminal title)', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-run-f-finished`)

    await expect(page.getByTestId('txr-run-title')).toHaveText('Finished 6 of 6 methods')
    await expect(page.getByTestId('txr-run-counts-finished')).toHaveText('6 finished')
    await expect(rowCount(page)).toHaveCount(6)
    await expect(page.getByTestId('txr-run-see-results')).toBeVisible()
    // A terminal run has no live-run controls and no leave-and-continue note.
    await expect(page.getByTestId('txr-run-stop-all')).toBeDisabled()
    await expect(page.getByTestId('txr-run-leave-note')).toHaveCount(0)
    await page.getByTestId('txr-run-tab-finished').click()
    await expect(rowCount(page)).toHaveCount(6)
    await page.getByTestId('txr-run-tab-working').click()
    await expect(page.getByTestId('txr-run-table-empty')).toBeVisible()
  })
})

test.describe('txr-run-f-not-found — the 404 state (TEST-RUN-26)', () => {
  test('the not-found line + the History link, no crash', async ({ page }) => {
    await page.goto(`${GALLERY}txr-run-f-not-found`)

    const missing = page.getByTestId('txr-run-not-found')
    await expect(missing).toBeVisible()
    await expect(missing).toContainText('This analysis run could not be found')
    await expect(page.getByTestId('txr-run-history')).toBeVisible()
    await expect(page.getByTestId('txr-run-load-error')).toHaveCount(0)
  })
})

test.describe('txr-run-e-narrow-390 / txr-run-f-narrow-390 — the mobile width (TEST-RUN-26)', () => {
  // The window IS the phone here (ITEM-8): the narrow-390 stories wrap the
  // page in a 390 px frame, but the ITEM-8 finding was that the frame alone
  // was not enough — at a desktop window the E screen's wrapped chrome
  // (~430 px of chips + bottom bar) collapsed the list's row body to 0
  // (the virtualizer's scroll area measured 0, so the story showed NO
  // methods), and the frame-floor media rule (the fix) keys on the WINDOW
  // width like every other phone rule. At a real 390 px window the story
  // is the real phone.
  test.use({ viewport: { width: 390, height: 844 } })
  test('no horizontal page overflow; the header/bar actions stay inside the viewport', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-run-e-narrow-390`)
    await expect(page.getByTestId('txr-run-slots')).toBeVisible()
    await expect(page.getByTestId('txr-list')).toBeVisible()
    await expect(page.getByTestId('txr-list-row-direct-on')).toBeVisible()
    let overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, 'E page horizontal overflow px').toBeLessThanOrEqual(1)

    await page.goto(`${GALLERY}txr-run-f-narrow-390`)
    await expect(page.getByTestId('txr-run-header')).toBeVisible()
    await expect(page.getByTestId('txr-run-counts')).toBeVisible()
    overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, 'F page horizontal overflow px').toBeLessThanOrEqual(1)
    // The header action stays reachable inside the viewport (a live run's
    // header carries the results link; the History link is the 404 state's).
    for (const id of ['txr-run-see-results']) {
      const el = page.getByTestId(id)
      await el.scrollIntoViewIfNeeded()
      const box = await el.boundingBox()
      expect(box, `${id} must be mounted`).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    }
  })
})

/** The table's mounted row count (the bounded tab render set). */
function rowCount(page: Page): Locator {
  return page.locator('tr[data-testid^="txr-run-row-"]')
}
