import { expect, test, type Page } from '@playwright/test'

/**
 * TXRHISTORY — the history screen's real-browser guard (ITEM-7's
 * gallery-e2e spec, backend-free: the `txrhistory/gallery.tsx` cassette +
 * the per-story id-scoped extensions answer the module's own reads over the
 * synthetic `fixtures.ts`, and every story drives the REAL `HistoryPage`
 * over the REAL store — the same surface a clinician sees).
 *
 * Spec ↔ TESTS.md enumeration:
 *   · TEST-HIST-11 (INV-1/3, `txr-history-populated` +
 *     `txr-history-detail-expanded` + `txr-history-running`) — the fixture
 *     family's six cards newest-first (title/subtitle/chip/status/date),
 *     the expanded train block's five dl rows (Your files + the copies
 *     note, Settings, Methods with per-method version/time, Took with the
 *     estimated counterpart, Made with the two-model tail), the
 *     collapse/expand `getHistory` count (bounded — exactly one per
 *     expand), and the two open paths through the builders: "Open the
 *     results" lands `/analysis/<id>/results`, a running row's "Open the
 *     running run" lands `/analysis/<id>/running`.
 *   · TEST-HIST-12 (INV-1, `txr-history-many` + `txr-history-search` +
 *     `txr-history-filter-stopped-failed`) — the 25-run family's 20-row
 *     page + the Load-more continuation (two calls, each ≤ 20 — no
 *     fetch-all), the debounced single `q` call narrowing the list, the
 *     filter's ONE multi-value status call (the grown GAP-HIST-3 path —
 *     never a client-side sieve) and the `kind=learned` call (the four
 *     train-mode family rows — the failed row is a train run too), the
 *     running card's "Running" status and the failed row's red reason
 *     line (the fixture's detail verbatim).
 *   · TEST-HIST-13 (INV-2/3, `txr-history-populated` +
 *     `txr-history-copies-cleared` + `txr-history-clear-all-confirm` +
 *     `txr-history-log-dialog`) — "Run again with the same settings" POSTs
 *     `rerunRun` and lands on the new run's running path; the copy-cleared
 *     row's "Use these settings again" PUTs the DEC-6 body and lands
 *     `/choose-methods` with NO `rerunRun` call; the clear-all dialog's
 *     `clearRuns` fires only after a choice (Cancel → zero calls); the
 *     copies-off flow PUTs the preference THEN POSTs `clearAllCopies`
 *     (the seam order); the log dialog lists the cassette's lines, the
 *     method filter backfills the per-method view and "Copy the log"
 *     writes the clipboard.
 *   · TEST-HIST-14 (INV-1, `txr-history-narrow-390`) — at 390×844 no
 *     horizontal overflow (page and pane), the toolbar stacks (search
 *     above the filter), the card header wraps, and the footer's
 *     retention links remain visible and reachable.
 *
 * What the fixtures FORCE (records in `fixtures.ts`'s header + DRIFT-1
 * ITEM-6): every value is the module fixture family's own — the six-run
 * inventory (the four board row shapes + the running row + the
 * copy-cleared row, ids `e0000000-…-<k>`, the fixed 46/13/48 patient
 * facts, the 289 MiB usage figure, the module's own durations) — never a
 * board example number (INV-6). The run ids below are the same stable
 * generator the fixture file owns.
 *
 * Run (own port on a shared box — the config derives one per worktree):
 *   npx playwright test -c playwright.gallery.config.ts \
 *     tests/gallery-e2e/txr-history.spec.ts
 */

const GALLERY = '/gallery.html?surface='

// The gallery's module graph is transformed ON DEMAND by Vite: the first
// test on a freshly booted server (every `test:e2e:gallery` run boots its
// own worktree server) pays the whole graph's transform — minutes on a
// loaded box. This backend-free, dev-only spec opts into its own budget
// rather than inheriting the config's 120 s fast-loop cap.
test.setTimeout(600_000)

/** The fixture run-id name space (`fixtureRunId(k)` — the module's own). */
const FX_ID = (k: number): string =>
  `e0000000-0000-4000-8000-${k.toString(16).padStart(12, '0')}`

/** The six-run family's rows, newest first (the inventory's own order). */
const FAMILY = [FX_ID(1), FX_ID(2), FX_ID(3), FX_ID(4), FX_ID(5), FX_ID(6)]

/** The board row-1 run's title (the fixture's three files). */
const ROW1_TITLE = '3 methods on patients.csv + measurements.csv + new_measurements.csv'

/** The board row-1 subtitle (methods joined + the facts sentence). */
const ROW1_SUBTITLE =
  'landmark-cox-current, cox-cutpoint-risk, relchange-threshold · learned from 46 patients, predicted 13 · decision day 60 · progression, death by day 210'

/** The board row-1 "Made" sentence (fixture facts, the two-model tail). */
const ROW1_MADE = '2 models (Cohort A, day 60 and one more) and the predictions of both'

/** The board row-1 "Took" line (the fixture's 175 s + the 245 s estimate). */
const ROW1_TOOK = '2 minutes 55 seconds (estimated 4 minutes)'

/** The board row-1 "Methods" line (per-method version + compact duration). */
const ROW1_METHODS =
  'landmark-cox-current 1.0 (2 min), cox-cutpoint-risk 1.0 (1 min), relchange-threshold 0.9 (under a minute)'

/** The board row-1 settings line (the fixture's detail settings — R2-09:
 *  the invented memory figure is gone; the run config has no memory field). */
const ROW1_SETTINGS = 'landmark 60, horizon 210, covariates on, seed 7, 4 CPUs'

/** The DEC-6 settings-again body (the copy-cleared run's detail settings). */
const DEC6_BODY = {
  config: {
    endpoint: 'pfs',
    decision_day: 60,
    look_ahead_day: 210,
    covariates: false,
    at_a_time: 1,
    cpus: 4,
    save_models: false,
    label_day: null,
  },
  last_input_summary: null,
}

/** The story seam's recorded requests (the cassette's one write each). */
interface SeamRecord {
  key: string
  method: string
  query: Record<string, string>
  body: unknown
}

/** Parse the story's request seam (the specs read the seam, never the
 *  components — the txr-models convention). */
async function seam(page: Page): Promise<SeamRecord[]> {
  const raw = await page.getByTestId('txr-history-request-seam').textContent()
  expect(raw, 'the request seam must be present').not.toBeNull()
  return JSON.parse(raw ?? '[]') as SeamRecord[]
}

/** The seam records of one operation, in call order. */
async function operatorRecords(
  page: Page,
  operator: string,
): Promise<SeamRecord[]> {
  const records = await seam(page)
  return records.filter(record => record.key === operator)
}

/** The list rows' test ids in DOM order (the server's newest-first order). */
async function rowOrder(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="txr-history-row-"]')
    .evaluateAll(elements =>
      elements.map(element => element.getAttribute('data-testid') ?? ''),
    )
}

test.describe('txr-history-populated — the family list + the expanded block (TEST-HIST-11)', () => {
  test('six cards newest-first; the train block; one getHistory per expand; open the results', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-history-populated`)

    await expect(page.getByTestId('txr-history')).toBeVisible()
    await expect(page.getByTestId('txr-history-list')).toBeVisible()

    // ── the six cards, newest first (the server's own order, INV-1) ──
    await expect(page.getByTestId(`txr-history-row-${FAMILY[0]}`)).toBeVisible()
    expect(await rowOrder(page)).toEqual(
      FAMILY.map(id => `txr-history-row-${id}`),
    )

    // ── the four board row shapes' header bytes (synthetic facts) ──
    const row1 = page.getByTestId(`txr-history-row-${FAMILY[0]}`)
    await expect(row1).toContainText(ROW1_TITLE)
    await expect(page.getByTestId(`txr-history-subtitle-${FAMILY[0]}`)).toHaveText(
      ROW1_SUBTITLE,
    )
    await expect(page.getByTestId(`txr-history-chip-${FAMILY[0]}`)).toHaveText(
      'Learned and predicted',
    )
    await expect(page.getByTestId(`txr-history-status-${FAMILY[0]}`)).toHaveText('Done')

    // The reuse row: R2-04 — the consumed models' NAMES (the record's
    // `models_used[].model_name`, never the model ids' raw uuids) + the
    // capital-P "Predicted N patients" (the distinct-patient count, never
    // the row count) + the endpoint line; no methods/decision-day segment,
    // the saved-model chip.
    const row3 = page.getByTestId(`txr-history-row-${FAMILY[2]}`)
    await expect(row3).toContainText('Model Cohort A, day 60 on march_new.csv')
    await expect(page.getByTestId(`txr-history-subtitle-${FAMILY[2]}`)).toHaveText(
      'cohort-a-day-60 · Predicted 9 patients · progression, death by day 210',
    )
    await expect(page.getByTestId(`txr-history-chip-${FAMILY[2]}`)).toHaveText('Saved model')

    // The one-method learned row: no methods segment, no predicted segment.
    await expect(page.getByTestId(`txr-history-subtitle-${FAMILY[3]}`)).toHaveText(
      'learned from 48 patients · decision day 42 · progression, death by day 224',
    )

    // The running row: Running, never a fake Done/Failed (INV-2).
    await expect(page.getByTestId(`txr-history-status-${FAMILY[1]}`)).toHaveText('Running')

    // The failed row: the reason detail VERBATIM (the fixture's own bytes).
    await expect(page.getByTestId(`txr-history-subtitle-${FAMILY[4]}`)).toHaveText(
      'Failed: marker LDH is missing from the measurements',
    )
    await expect(page.getByTestId(`txr-history-status-${FAMILY[4]}`)).toHaveText('Failed')
    await expect(page.getByTestId(`txr-history-status-${FAMILY[4]}`)).toHaveCSS(
      'color',
      'rgb(179, 38, 30)',
    )

    // Every card carries a date (the fixture stamps; the board's shape —
    // the header's third span, after the chip and the status).
    for (const id of FAMILY) {
      const date = page.getByTestId(`txr-history-row-${id}`).locator('span').nth(2)
      await expect(date).toHaveText(/^(Today \d{2}:\d{2}|\d{1,2} \w{3} \d{2}:\d{2})$/)
    }

    // ── the pre-expanded train row's five dl rows (synthetic facts) ──
    const detail1 = page.getByTestId(`txr-history-detail-${FAMILY[0]}`)
    await expect(detail1).toBeVisible()
    await expect(detail1).toContainText('Your files')
    await expect(detail1).toContainText('patients.csv, measurements.csv, new_measurements.csv')
    await expect(detail1).toContainText(
      'Copies are kept with this run so it can be repeated.',
    )
    await expect(detail1).toContainText('Settings')
    await expect(detail1).toContainText(ROW1_SETTINGS)
    await expect(detail1).toContainText('Methods')
    await expect(detail1).toContainText(ROW1_METHODS)
    await expect(detail1).toContainText('Took')
    await expect(detail1).toContainText(ROW1_TOOK)
    await expect(detail1).toContainText('Made')
    await expect(detail1).toContainText(ROW1_MADE)

    // The actions column: the two buttons + the links the capability
    // resolution offers (web mode hides Open the folder).
    const actions1 = page.getByTestId(`txr-history-actions-${FAMILY[0]}`)
    await expect(actions1.getByTestId(`txr-history-open-results-${FAMILY[0]}`)).toBeVisible()
    await expect(actions1.getByTestId(`txr-history-rerun-${FAMILY[0]}`)).toHaveText(
      'Run again with the same settings',
    )
    await expect(actions1.getByTestId(`txr-history-download-${FAMILY[0]}`)).toBeVisible()
    await expect(actions1.getByTestId(`txr-history-open-folder-${FAMILY[0]}`)).toHaveCount(0)
    await expect(actions1.getByTestId(`txr-history-log-${FAMILY[0]}`)).toBeVisible()

    // ── expand/collapse: getHistory exactly once per expand (INV-1) ──
    const getHistoryCalls = (): Promise<SeamRecord[]> =>
      operatorRecords(page, 'History.getHistory')
    expect(await getHistoryCalls()).toHaveLength(1)

    // Collapse the first row: no additional call.
    await page.getByTestId(`txr-history-toggle-${FAMILY[0]}`).click()
    await expect(detail1).toHaveCount(0)
    expect(await getHistoryCalls()).toHaveLength(1)

    // Expand the reuse row: ONE more call (and the expanded block swaps).
    await page.getByTestId(`txr-history-toggle-${FAMILY[2]}`).click()
    const detail3 = page.getByTestId(`txr-history-detail-${FAMILY[2]}`)
    await expect(detail3).toBeVisible()
    expect(await getHistoryCalls()).toHaveLength(2)
    await expect(detail3).toContainText('Copies are kept with this run so it can be repeated.')

    // Collapse it again: still two.
    await page.getByTestId(`txr-history-toggle-${FAMILY[2]}`).click()
    await expect(detail3).toHaveCount(0)
    expect(await getHistoryCalls()).toHaveLength(2)

    // ── "Open the results" through the provider builder (INV-3) ──
    await page.getByTestId(`txr-history-toggle-${FAMILY[0]}`).click()
    await expect(detail1).toBeVisible()
    await page.getByTestId(`txr-history-open-results-${FAMILY[0]}`).click()
    await expect(page.getByTestId('txr-history-landed')).toContainText(
      `/analysis/${FAMILY[0]}/results`,
    )
    await expect(page.getByTestId('txr-history-landed')).toHaveText(
      `navigated to /analysis/${FAMILY[0]}/results`,
    )
  })
})

test.describe("txr-history-running — the running row's action (TEST-HIST-11)", () => {
  test('"Open the running run" lands on the running path through the builder', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-history-running`)

    await expect(page.getByTestId(`txr-history-row-${FAMILY[1]}`)).toBeVisible()
    await expect(page.getByTestId(`txr-history-status-${FAMILY[1]}`)).toHaveText('Running')

    // The running row's action set: the running-run open, never the
    // results/rerun controls of a terminal row.
    const actions = page.getByTestId(`txr-history-actions-${FAMILY[1]}`)
    await expect(actions.getByTestId(`txr-history-open-running-${FAMILY[1]}`)).toBeVisible()
    await expect(actions.getByTestId(`txr-history-open-results-${FAMILY[1]}`)).toHaveCount(0)
    await expect(actions.getByTestId(`txr-history-rerun-${FAMILY[1]}`)).toHaveCount(0)
    await expect(actions.getByTestId(`txr-history-settings-again-${FAMILY[1]}`)).toHaveCount(0)
    await expect(actions.getByTestId(`txr-history-download-${FAMILY[1]}`)).toHaveCount(0)

    await page.getByTestId(`txr-history-open-running-${FAMILY[1]}`).click()
    await expect(page.getByTestId('txr-history-landed')).toHaveText(
      `navigated to /analysis/${FAMILY[1]}/running`,
    )
  })
})

test.describe('txr-history-detail-expanded — the reuse block (TEST-HIST-11)', () => {
  test('the reuse row\'s expanded block renders its own bytes', async ({ page }) => {
    await page.goto(`${GALLERY}txr-history-detail-expanded`)

    const detail = page.getByTestId(`txr-history-detail-${FAMILY[2]}`)
    await expect(detail).toBeVisible()
    await expect(detail).toContainText('march_new.csv')
    await expect(detail).toContainText('Copies are kept with this run so it can be repeated.')
    await expect(detail).toContainText('relchange-threshold 0.9 (under a minute)')

    // The reuse run's settings line (the fixture's detail settings:
    // covariates off, the machine's CPU facts, no decision-day tricks —
    // the at-a-time count is not a settings segment). R2-09: the memory
    // figure is GONE — the run config has no memory field, so the old
    // "16 GB" was a fabricated fact; the line reads only the config's own
    // segments.
    await expect(detail).toContainText('covariates off')
    await expect(detail).toContainText('4 CPUs')
    await expect(detail).toContainText('seed 7')
    await expect(detail).not.toContainText('16 GB')
    await expect(detail).not.toContainText('GB')
    // No produced models → the Made row omits entirely.
    await expect(detail.getByText('Made')).toHaveCount(0)

    // The model-set link in the Made slot is absent (no models made); the
    // reuse row's consumed-model facts live in the title, not the block.
    await expect(detail.getByTestId(`txr-history-model-set-set-k-1`)).toHaveCount(0)

    const actions = page.getByTestId(`txr-history-actions-${FAMILY[2]}`)
    await expect(actions.getByTestId(`txr-history-open-results-${FAMILY[2]}`)).toBeVisible()
  })
})

test.describe('txr-history-many — the paged list (TEST-HIST-12)', () => {
  test('20-row page, Load-more continuation at offset 20, two calls no bigger than 20', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-history-many`)

    await expect(page.getByTestId('txr-history-list')).toBeVisible()
    await expect(page.locator('[data-testid^="txr-history-row-"]')).toHaveCount(20)
    await expect(page.getByTestId('txr-history-load-more')).toBeVisible()

    await page.getByTestId('txr-history-load-more').click()
    await expect(page.locator('[data-testid^="txr-history-row-"]')).toHaveCount(25)
    await expect(page.getByTestId('txr-history-load-more')).toHaveCount(0)

    // The bound (INV-1): two page calls, each ≤ 20, offsets 0 and 20 — the
    // crate is server-paged, never a fetch-all (the seam's records).
    const listCalls = await operatorRecords(page, 'History.listHistory')
    expect(listCalls).toHaveLength(2)
    expect(listCalls[0]!.query.limit).toBe('20')
    expect(listCalls[0]!.query.offset).toBe('0')
    expect(listCalls[1]!.query.limit).toBe('20')
    expect(listCalls[1]!.query.offset).toBe('20')
  })
})

test.describe('txr-history-search — the debounced server query (TEST-HIST-12)', () => {
  test('one debounced q call, the list narrows to the provider\'s matches', async ({ page }) => {
    await page.goto(`${GALLERY}txr-history-search`)

    await expect(page.getByTestId('txr-history-list')).toBeVisible()
    await expect(page.locator('[data-testid^="txr-history-row-"]')).toHaveCount(6)

    await page.getByTestId('txr-history-search').fill('cox-cutpoint')

    // The provider's own q semantics over the fixture family: the method
    // id's substring — the four rows that run it (runs 1, 2, 4, 6).
    await expect(page.locator('[data-testid^="txr-history-row-"]')).toHaveCount(4)
    await expect(page.getByTestId(`txr-history-row-${FAMILY[5]}`)).toBeVisible()
    await expect(page.getByTestId(`txr-history-row-${FAMILY[2]}`)).toHaveCount(0)

    // ONE debounced call carries the q; the mount's call carried none.
    const listCalls = await operatorRecords(page, 'History.listHistory')
    expect(listCalls).toHaveLength(2)
    expect(listCalls[0]!.query.q).toBeUndefined()
    expect(listCalls[1]!.query.q).toBe('cox-cutpoint')

    // Clearing the query restores the family (one more debounced call).
    await page.getByTestId('txr-history-search').fill('')
    await expect(page.locator('[data-testid^="txr-history-row-"]')).toHaveCount(6)
    expect(await operatorRecords(page, 'History.listHistory')).toHaveLength(3)
  })
})

test.describe('txr-history-filter-stopped-failed — the filter options (TEST-HIST-12)', () => {
  test('ONE multi-value status call for the fourth option; the kind call for the second', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-history-filter-stopped-failed`)

    // The story seeds the fourth option: ONE call with the grown
    // multi-value status (GAP-HIST-3 — never a client-side sieve, never a
    // pair of calls).
    await expect(page.locator('[data-testid^="txr-history-row-"]')).toHaveCount(1)
    await expect(page.getByTestId(`txr-history-row-${FAMILY[4]}`)).toBeVisible()
    await expect(page.getByTestId(`txr-history-subtitle-${FAMILY[4]}`)).toHaveText(
      'Failed: marker LDH is missing from the measurements',
    )
    let listCalls = await operatorRecords(page, 'History.listHistory')
    const statusCall = listCalls[listCalls.length - 1]!
    expect(statusCall.query.status).toBe('stopped,failed')
    expect(statusCall.query.kind).toBeUndefined()

    // The second option: the kind=learned call (the family's four
    // train-mode runs — 1, 2, 4 and the failed row 5, whose run is a
    // train-mode run too).
    await page.getByTestId('txr-history-filter').click()
    await page.getByRole('option', { name: 'Learned and predicted' }).click()
    await expect(page.locator('[data-testid^="txr-history-row-"]')).toHaveCount(4)
    listCalls = await operatorRecords(page, 'History.listHistory')
    const learnedCall = listCalls[listCalls.length - 1]!
    expect(learnedCall.query.kind).toBe('learned')
    expect(learnedCall.query.status).toBeUndefined()

    // The fourth option through the real select (the board's verbatim label).
    await page.getByTestId('txr-history-filter').click()
    await page.getByRole('option', { name: 'Stopped or failed' }).click()
    await expect(page.locator('[data-testid^="txr-history-row-"]')).toHaveCount(1)
  })
})

test.describe('txr-history-populated — the rerun path (TEST-HIST-13)', () => {
  test('"Run again with the same settings" POSTs rerunRun and lands on the new run', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-history-populated`)
    await expect(page.getByTestId(`txr-history-detail-${FAMILY[0]}`)).toBeVisible()

    await page.getByTestId(`txr-history-rerun-${FAMILY[0]}`).click()

    // The replay's summary is the NEW fixture run (id 7) — the page lands
    // on its running path (INV-3: through the builder, never a literal).
    await expect(page.getByTestId('txr-history-landed')).toHaveText(
      `navigated to /analysis/${FX_ID(7)}/running`,
    )
    const rerunCalls = await operatorRecords(page, 'Txr.rerunRun')
    expect(rerunCalls).toHaveLength(1)
    expect(rerunCalls[0]!.method).toBe('POST')
  })
})

test.describe('txr-history-copies-cleared — the settings-again path (TEST-HIST-13)', () => {
  test('the DEC-6 PUT body, the /choose-methods landing, and NO rerunRun call', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-history-copies-cleared`)

    await expect(page.getByTestId(`txr-history-detail-${FAMILY[5]}`)).toBeVisible()
    await expect(page.getByTestId(`txr-history-rerun-${FAMILY[5]}`)).toHaveCount(0)
    await expect(page.getByTestId(`txr-history-settings-again-${FAMILY[5]}`)).toBeVisible()
    await expect(page.getByTestId(`txr-history-detail-${FAMILY[5]}`)).toContainText(
      'Copies are not kept with this run.',
    )

    await page.getByTestId(`txr-history-settings-again-${FAMILY[5]}`).click()

    // The DEC-6 contract body, byte for byte (the spec asserts the PUT
    // body through the seam), and the E screen's path — never a rerun.
    await expect(page.getByTestId('txr-history-landed')).toHaveText(
      'navigated to /choose-methods',
    )
    const updateCalls = await operatorRecords(page, 'Txr.updateAnalysisConfig')
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0]!.body).toEqual(DEC6_BODY)
    expect(await operatorRecords(page, 'Txr.rerunRun')).toHaveLength(0)
  })
})

test.describe('txr-history-clear-all-confirm — the destructive gate (TEST-HIST-13)', () => {
  test('clearRuns fires only after a choice; Cancel fires nothing', async ({ page }) => {
    await page.goto(`${GALLERY}txr-history-clear-all-confirm`)

    // The dialog is open (the story's seed): the two choices + Cancel.
    await expect(page.getByTestId('txr-history-confirm')).toBeVisible()
    await expect(page.getByTestId('txr-history-confirm-clear-files')).toHaveText(
      'Clear history and remove files',
    )
    await expect(page.getByTestId('txr-history-confirm-keep-files')).toHaveText(
      'Clear history, keep files',
    )

    // Cancel: zero clearRuns calls (INV-2's gate).
    await page.getByTestId('txr-history-confirm-cancel').click()
    await expect(page.getByTestId('txr-history-confirm')).toHaveCount(0)
    expect(await operatorRecords(page, 'Txr.clearRuns')).toHaveLength(0)

    // Re-open from the footer and choose the files-with-rows default.
    await page.getByTestId('txr-history-clear-all').click()
    await expect(page.getByTestId('txr-history-confirm-clear-files')).toBeVisible()
    await page.getByTestId('txr-history-confirm-clear-files').click()

    const clearCalls = await operatorRecords(page, 'Txr.clearRuns')
    expect(clearCalls).toHaveLength(1)
    expect(clearCalls[0]!.method).toBe('DELETE')
    // The wire carries no query on the DELETE: the generated client's
    // transport sends body params for POST/PUT/PATCH and query params for
    // GET only, so the `delete_files` choice reaches the generated client
    // and never the URL (DRIFT-1 ITEM-7 — a framework-level finding, the
    // store's own call shape is pinned by TEST-HIST-4; the server's
    // `TxrDeleteQuery` default keeps the record-clearing half honest).
    expect(
      clearCalls[0]!.query.delete_files,
      'the DELETE query is transport-dropped (framework callAsync) — record the finding',
    ).toBeUndefined()
    // The confirmed transition reloads the list (the honest refresh —
    // the reload's call lands after the DELETE, so the count is polled).
    await expect
      .poll(async () => (await operatorRecords(page, 'History.listHistory')).length)
      .toBe(2)
  })
})

test.describe('txr-history-populated — the copies-off flow (TEST-HIST-13)', () => {
  test('the confirm gate, the PUT-then-POST order, the link flips', async ({ page }) => {
    await page.goto(`${GALLERY}txr-history-populated`)
    await expect(page.getByTestId('txr-history-copies-off')).toBeVisible()

    // The dialog opens; nothing destructive happens without the confirm.
    await page.getByTestId('txr-history-copies-off').click()
    await expect(page.getByTestId('txr-history-confirm-copies-off')).toBeVisible()
    expect(await operatorRecords(page, 'History.clearAllCopies')).toHaveLength(0)
    expect(await operatorRecords(page, 'History.updatePreferences')).toHaveLength(0)

    // The confirmed CTA: PUT then POST (the order TEST-HIST-13 pins).
    await page.getByTestId('txr-history-confirm-copies-off').click()
    await page.waitForFunction(
      () => document.querySelector('[data-testid="txr-history-copies-on"]') !== null,
    )
    await expect(page.getByTestId('txr-history-copies-on')).toBeVisible()

    const updateCalls = await operatorRecords(page, 'History.updatePreferences')
    const clearCalls = await operatorRecords(page, 'History.clearAllCopies')
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0]!.body).toEqual({ keep_file_copies: false })
    expect(clearCalls).toHaveLength(1)
    const records = await seam(page)
    const updateIndex = records.findIndex(
      record => record.key === 'History.updatePreferences',
    )
    const clearIndex = records.findIndex(record => record.key === 'History.clearAllCopies')
    expect(updateIndex, 'the PUT must precede the POST').toBeLessThan(clearIndex)
  })
})

test.describe('txr-history-log-dialog — the terminal snapshot (TEST-HIST-13)', () => {
  test('the cassette lines, the method-filter backfill, Copy writes the clipboard', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-history-log-dialog`)
    await expect(page.getByTestId(`txr-history-detail-${FAMILY[0]}`)).toBeVisible()

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.getByTestId(`txr-history-log-${FAMILY[0]}`).click()

    await expect(page.getByTestId('txr-history-log-dialog')).toBeVisible()
    // R2-10: the dialog names its content ("Show the log of") — the old
    // dialog opened with an unlabeled empty dropdown and no accessible name.
    await expect(page.getByTestId('txr-history-log-dialog')).toContainText(
      'Show the log of',
    )
    await expect(page.getByTestId('txr-history-log-dialog')).toContainText(
      'Show technical output',
    )
    await expect(page.getByTestId('txr-history-log-count')).toHaveText('Showing 6 of 6 lines')
    const lines = page.getByTestId('txr-history-log-lines')
    await expect(lines).toContainText('[landmark-cox-current] environment ready')
    await expect(lines).toContainText('[cox-cutpoint-risk] wrote predictions.csv')
    await expect(lines).toContainText('[relchange-threshold] 3 patients marked cannot-decide')
    await expect(lines).toContainText('first patient: S0001')

    // The method filter backfills the per-method view (fresh cursor).
    await page.getByTestId('txr-history-log-filter').click()
    await page.getByRole('option', { name: 'landmark-cox-current' }).click()
    await expect(page.getByTestId('txr-history-log-count')).toHaveText('Showing 2 of 2 lines')
    await expect(lines).toContainText('[landmark-cox-current] 46 eligible patients, 13 predicted')
    await expect(lines).toContainText('[landmark-cox-current] first patient: S0001')
    await expect(lines).not.toContainText('wrote predictions.csv')

    // Copy the log: the clipboard holds the visible lines (never a no-op).
    await page.getByTestId('txr-history-log-copy').click()
    const clipboard = await page.evaluate(() => navigator.clipboard.readText())
    expect(clipboard).toContain('[landmark-cox-current] 46 eligible patients, 13 predicted')
    expect(clipboard.split('\n')).toHaveLength(2)
  })
})

test.describe('txr-history-narrow-390 — the mobile width (TEST-HIST-14)', () => {
  // qa-fixes2 ITEM-7 recorded that this story measured the 1280 page (the
  // pane was 390 but the page's phone media rules answer the WINDOW width) —
  // ITEM-8's fix is the real 390 viewport, the models story's rule. The pane
  // stays (the story's bounded frame); the window IS the phone now.
  test.use({ viewport: { width: 390, height: 844 } })
  test('no horizontal overflow, the toolbar stacks, the footer links reachable', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-history-narrow-390`)
    await expect(page.getByTestId('txr-history')).toBeVisible()
    await expect(page.getByTestId(`txr-history-row-${FAMILY[0]}`)).toBeVisible()

    // No horizontal page overflow (the measured pattern).
    const pageOverflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(pageOverflow, 'page horizontal overflow px').toBeLessThanOrEqual(1)

    // The pane itself (the 390 frame) scrolls nothing sideways.
    const paneOverflow = await page
      .getByTestId('txr-history')
      .evaluate(element => element.scrollWidth - element.clientWidth)
    expect(paneOverflow, 'pane horizontal overflow px').toBeLessThanOrEqual(1)

    // The toolbar stacks: the search field above the filter (the board's
    // wrap layout at narrow widths).
    const searchBox = await page.getByTestId('txr-history-search').boundingBox()
    const filterBox = await page.getByTestId('txr-history-filter').boundingBox()
    expect(searchBox, 'the search must be mounted').not.toBeNull()
    expect(filterBox, 'the filter must be mounted').not.toBeNull()
    expect(
      filterBox!.y,
      'the filter must sit below the search at 390 px',
    ).toBeGreaterThanOrEqual(searchBox!.y + searchBox!.height - 1)

    // The card header wraps: the toggle stays inside the pane's width.
    const toggleBox = await page.getByTestId(`txr-history-toggle-${FAMILY[0]}`).boundingBox()
    expect(toggleBox, 'the toggle must be mounted').not.toBeNull()
    expect(toggleBox!.x + toggleBox!.width).toBeLessThanOrEqual(390 + 1)

    // The footer's retention links stay visible + reachable (scroll + tap).
    const copiesOff = page.getByTestId('txr-history-copies-off')
    await copiesOff.scrollIntoViewIfNeeded()
    await expect(copiesOff).toBeVisible()
    const clearAll = page.getByTestId('txr-history-clear-all')
    await clearAll.scrollIntoViewIfNeeded()
    await expect(clearAll).toBeVisible()
    const clearBox = await clearAll.boundingBox()
    expect(clearBox, 'the clear-all link must be mounted').not.toBeNull()
    expect(clearBox!.x + clearBox!.width, 'the clear-all fits the pane').toBeLessThanOrEqual(
      390 + 1,
    )
    // The board's quiet 13.5 px link renders ~21 px tall (measured); the
    // tappable area is the link's own — a 44 px target would need the
    // kit's tap-area padding, a framework-level change (DRIFT-1 ITEM-7).
    expect(clearBox!.height, 'the clear-all is reachable').toBeGreaterThanOrEqual(20)

    // The dialog's confirm channel opens over the narrow pane intact.
    await clearAll.click()
    await expect(page.getByTestId('txr-history-confirm-clear-files')).toBeVisible()
    // R2-01 (qa-fixes2 ITEM-7): the kit Dialog portals its content to
    // document.body — outside the shell subtree that used to declare the app
    // face, so every dialog fell back to the browser default. The face at the
    // html base layer means the portalled dialog inherits the app's stack.
    const dialogFont = await page
      .getByTestId('txr-history-confirm-clear-files')
      .evaluate(el => getComputedStyle(el).fontFamily)
    expect(dialogFont, 'the portalled dialog carries the app face').toContain('Source Sans 3')
  })
})
