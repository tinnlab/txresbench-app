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

test.describe('txr-run-e — choose the methods and settings (TEST-RUN-24, qa-fixes3 ITEM-1)', () => {
  test('the page: files summary, settings, the picker (ready-only, recommended ticked), the run bar', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-run-e`)

    // ── the shell: the step line + the board title, then the ONE compact
    //    summary line (ITEM-2 a: the long multi-chip strip is gone) ──
    await expect(page.getByText('Step 4 of 4')).toBeVisible()
    await expect(
      page.getByRole('heading', { name: /^Choose the methods and settings$/ }),
    ).toBeVisible()
    const summary = page.getByTestId('txr-run-summary')
    await expect(summary).toBeVisible()
    // app-shell ITEM-2: the default 1280x720 window is SHORT — the two
    // cards answer the fixed-top byte by rendering COLLAPSED (the one-line
    // summary form), so open them for the expanded pins below.
    await expect(page.getByTestId('txr-run-summary-line')).toHaveCount(0)
    await page.getByTestId('txr-run-summary-toggle').click()
    await page.getByTestId('txr-run-settings-toggle').click()
    await expect(page.getByTestId('txr-run-summary-line')).toContainText('·')
    await expect(page.getByTestId('txr-run-summary-markers')).toContainText('Markers:')
    await page.getByTestId('txr-run-summary-details').click()
    await expect(page.getByTestId('txr-run-summary-details-patients')).toContainText(
      'fixture-patients.csv',
    )
    await expect(page.getByTestId('txr-run-summary-details-measurements')).toContainText(
      'fixture-measurements.csv',
    )
    await expect(page.getByTestId('txr-run-change-files')).toBeVisible()

    // ── the settings card: the ITEM-2 title + live sentence + the rows ──
    const settings = page.getByTestId('txr-run-settings')
    await expect(settings).toBeVisible()
    await expect(page.getByTestId('txr-run-settings-title')).toHaveText(
      'What do you want to predict?',
    )
    await expect(page.getByTestId('txr-run-settings-sentence')).toHaveText(
      'Progression or death within 238 days, from the blood draws up to day 56.',
    )
    for (const label of ['Predict', 'Decision day', 'Look ahead to', 'Extra inputs', 'More settings']) {
      await expect(settings).toContainText(label)
    }
    await expect(page.getByTestId('txr-run-settings-endpoint')).toContainText('Progression or death')
    await expect(page.getByTestId('txr-run-settings-decision-day')).toContainText('Day 56')
    await expect(page.getByTestId('txr-run-settings-look-ahead')).toContainText('Day 238')
    await expect(page.getByTestId('txr-run-settings-covariate-names')).toHaveText(
      'no extra inputs in your file',
    )

    // ── the picker over the catalogue cassette: the redesigned row bytes ──
    await expect(page.getByTestId('txr-method-picker')).toBeVisible()
    const row = await page.getByTestId('txr-method-card-direct-on').textContent()
    for (const needle of [
      'Direct on-treatment response rule',
      'direct-on',
      'Response probability',
      'Estimated about 2 min',
      'Benchmark score 0.74 (38 cohorts)',
    ]) {
      expect(row, `row direct-on must carry ${needle!}`).toContain(needle!)
    }
    const someRow = await page.getByTestId('txr-method-card-dynforest').textContent()
    for (const needle of ['Dynamic random forest', 'Runs on 120 of 151 patients', 'Estimated about 14 min']) {
      expect(someRow, `row dynforest must carry ${needle!}`).toContain(needle!)
    }
    // The default view is ready-to-run only — the cannot methods are in the
    // section; "Cannot run" is never printed.
    await expect(page.getByTestId('txr-method-ready-heading')).toHaveText('Ready to run (26)')
    expect(await page.locator('body').innerText()).not.toContain('Cannot run')
    await expect(page.getByTestId('txr-method-cannot-heading')).toHaveText(
      "12 methods can't run on this data",
    )

    // ── the recommended set is ticked on arrival; the ITEM-2 run bar reads it ──
    await expect(page.getByTestId('txr-run-bar-count')).toHaveText('8 methods selected')
    await expect(page.getByTestId('txr-run-bar-notice')).toHaveText(RESEARCH_NOTICE)

    // ── the in-place About disclosure shows the fixture method facts ──
    await page.getByTestId('txr-method-about-toggle-direct-on').click()
    const about = page.getByTestId('txr-method-about-direct-on')
    await expect(about).toBeVisible()
    await expect(about).toContainText(
      'A direct on-treatment response rule fixed in the paper that introduced it',
    )
    await expect(about).toContainText('Fictional Journal of Fixtures, 2021')
    await expect(page.getByTestId('txr-method-about-doi-direct-on')).toBeVisible()
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

    await expect(page.getByTestId('txr-run-summary')).toBeVisible()
    await expect(page.getByTestId('txr-method-error')).toBeVisible()
    await expect(page.getByTestId('txr-method-retry')).toBeVisible()
    await expect(page.getByTestId('txr-method-card-direct-on')).toHaveCount(0)
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

    await expect(page.getByTestId('txr-run-title')).toHaveText('Running 7 methods')
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
    // qa-fixes4 ITEM-3 (methods-r3 R3-methods-9): the env-missing row reads
    // the LIST's sentence ("no published environment available", CM-1's
    // plain reason) — the row's stored detail is the old pre-vocabulary
    // wording ("no published environment for method <id>"); same fact, one
    // wording across the list and the run rows.
    await expect(page.getByTestId('txr-run-state-jm-mem-lq')).toHaveText('cannot run')
    await expect(page.getByTestId('txr-run-detail-jm-mem-lq')).toContainText(
      'no published environment available',
    )
    await expect(page.getByTestId('txr-run-detail-jm-mem-lq')).not.toContainText(
      'no published environment for method',
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
    // A terminal run has no live-run controls and no leave-and-continue note
    // (qa-fixes4 ITEM-2d: HIDDEN, not disabled — the stale disabled pin is
    // the pre-ITEM-2d byte; the count-0 assertion is the truth).
    await expect(page.getByTestId('txr-run-stop-all')).toHaveCount(0)
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
    // qa-fixes4 ITEM-2e's not-found copy (the round-3 "This analysis run
    // could not be found" was the pre-ITEM-2e byte; the stale pin is
    // repaired here with the shipped words).
    await expect(missing).toContainText('We could not find this run')
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
    await expect(page.getByTestId('txr-run-summary')).toBeVisible()
    await expect(page.getByTestId('txr-method-picker')).toBeVisible()
    let overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, 'E page horizontal overflow px').toBeLessThanOrEqual(1)

    // qa-fixes4 ITEM-3 (methods-r3 R2-7): the run bar's Run button is IN
    // VIEW at 390x844 without scrolling — the report measured the old
    // position:static bar at y=1141; the frame's bottom slot is FIXED to
    // the viewport's bottom edge below 768 px (a sticky pin does not move
    // here — the flow shell's overflow-x-hidden document wrapper is the
    // scrollport, so the bar anchors to it and never sticks; index.css).
    const run = page.getByTestId('txr-run-bar-run')
    await expect(run).toBeVisible()
    const barBox = await run.boundingBox()
    expect(barBox, 'the Run button must be mounted').not.toBeNull()
    expect(barBox!.y, 'Run button top').toBeGreaterThanOrEqual(0)
    expect(barBox!.y + barBox!.height, 'Run button bottom').toBeLessThanOrEqual(844)

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

  test('the phone run cards: labels on one value column, the bar track visible (qa-fixes4 ITEM-3, methods-r3 R2-9)', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-run-f-narrow-390`)
    await expect(page.getByTestId('txr-run-header')).toBeVisible()
    // A running row's card: the State value, the bar and the Time value
    // start at ONE x (the report measured 131 for State/Time against 141
    // for Progress/Actions — the label column was auto-width; the 76 px
    // label basis pins every value to the same line).
    const state = await page.getByTestId('txr-run-state-dynforest').boundingBox()
    const track = await page.getByTestId('txr-run-bar-track-dynforest').boundingBox()
    const time = await page.getByTestId('txr-run-time-dynforest').boundingBox()
    expect(state, 'state value box').not.toBeNull()
    expect(track, 'progress track box').not.toBeNull()
    expect(time, 'time value box').not.toBeNull()
    expect(Math.abs(state!.x - time!.x), 'State and Time start at the same x').toBeLessThanOrEqual(1)
    expect(Math.abs(track!.x - time!.x), 'Progress and Time start at the same x').toBeLessThanOrEqual(1)
    // The report's "no bar at all" on the phone cards: the track must have
    // a real width — the stacked column's inline 26 % width shrank
    // the card column to 58 px and left the flexible track 0 px of
    // it; the phone rule makes the column the full row (index.css), so the
    // track takes the leftover after the 76 px label column.
    expect(track!.width, 'the grey track is visible').toBeGreaterThan(0)
    // The follow-up edge: the finished row's bar is full (the desktop and
    // phone read the same 100).
    const finishedTrack = await page
      .getByTestId('txr-run-bar-track-direct-on')
      .boundingBox()
    expect(finishedTrack, 'finished track box').not.toBeNull()
    expect(finishedTrack!.width).toBeGreaterThan(0)
    const finishedBar = await page.getByTestId('txr-run-bar-direct-on').boundingBox()
    expect(finishedBar!.width / finishedTrack!.width).toBeGreaterThan(0.99)
  })

  test('the log panel: the controls sit above the lines box and the panel is bounded (qa-fixes4 ITEM-3, methods-r3 R3-methods-6)', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-run-f-narrow-390`)
    await expect(page.getByTestId('txr-run-header')).toBeVisible()
    await page.getByTestId('txr-run-log-open').click()
    await expect(page.getByTestId('txr-run-log')).toBeVisible()
    const controls = await page.getByTestId('txr-run-log-controls').boundingBox()
    const lines = await page.getByTestId('txr-run-log-lines').boundingBox()
    expect(controls, 'controls box').not.toBeNull()
    expect(lines, 'lines box').not.toBeNull()
    // The round-3 report: the controls sat at y=8204 below a 9,100 px pre
    // — the row above the box is the reachability fix.
    expect(controls!.y + controls!.height, 'controls bottom above the lines top').toBeLessThanOrEqual(
      lines!.y + 1,
    )
    // The lines box itself is bounded (the panel's flex column: the pre
    // fills its slot and scrolls inside — never the 9,100 px report).
    expect(lines!.height, 'the lines box fits the viewport').toBeLessThanOrEqual(844)
  })
})

/** The table's mounted row count (the bounded tab render set). */
function rowCount(page: Page): Locator {
  return page.locator('tr[data-testid^="txr-run-row-"]')
}
