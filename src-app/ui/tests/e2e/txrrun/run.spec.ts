import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import {
  authHeader,
  cannotRunRunBody,
  createRun,
  dropCsv,
  fetchCsv,
  mintLocalSession,
  seedLocalSession,
  waitForTerminalRun,
} from './helpers'

/**
 * TXRRUN full-backend spec — TEST-RUN-28/29 (INV-1, INV-2, [acceptance]).
 *
 * The gallery tier (`tests/gallery-e2e/txr-run.spec.ts`) proves the E/F
 * surfaces against the module's cassette; THIS spec proves the two
 * deterministic real-backend paths DEC-20 scopes this node to:
 *
 *  (a) a run created through `POST /api/txr/runs` whose method the engine
 *      classifies `cannot_run` (a catalogue method with no published
 *      environment — no sandbox, no env download) renders on
 *      `/analysis/<id>/running` the row state, the engine reason, the
 *      Failed tab and the engine-authored log lines;
 *  (c) reloading that URL reconnects to the same run and the terminal
 *      snapshot renders (leave-and-continue);
 *  (d) an unknown run id renders `txr-run-not-found`;
 *  (b) the E→F creation path: the provider's example CSVs through the real
 *      file flow, Continue → `/choose-methods`, one runnable method
 *      selected, Run → `/analysis/<new-id>/running`, then the deterministic
 *      terminal handling (row reason + engine log lines + the stop-all
 *      error surface) — no leg waits for an environment download or a full
 *      method completion (DEC-20);
 *  (29) the engine's one-active-run 409 contract: a second create while one
 *      run is live is refused and creates no second run.
 *
 * A note on the env phase: a runnable method's environment is resolved by
 * the engine before any download. On this tree the method env manifests'
 * `oci_ref` refs carry a bare digest, so every env resolution is refused at
 * the OCI grammar boundary within the first ~200 ms of the run — a
 * deterministic, host-independent terminal outcome with NO download and NO
 * sandbox. The failing legs therefore pin "the row is terminal with the
 * engine's reason" + the engine's log lines (never one failure code — a
 * provider regen could move the failure to the download tool), and the live
 * downloading→stopped/skipped transitions stay the unit tier's and the
 * gallery SSE story's pins (the store's frame machine), as this item's
 * DRIFT-1 entry records.
 *
 * Run surface: this spec runs under the full-backend config
 * (`playwright.config.ts`; the config boots the backend + the preview on
 * derived ports). It never self-skips.
 */

test.setTimeout(420_000)

/** The catalogue method the engine classifies cannot_run on this inventory
 *  (no published env layer — the engine's own HTTP suite's reason). */
const CANNOT_RUN_METHOD = 'jm-mem-lq'
/** A catalogue method WITH a published environment (the engine hands it to
 *  the drive: `waiting` → `downloading` → the env phase's refusal). */
const RUNNABLE_METHOD = 'landmark-cox-current'

/** Collect page errors + console errors — a crash anywhere fails the test.
 *  The two lists are separate: an UNCAUGHT exception is a real defect in
 *  every leg, while the console can legitimately carry the app's own
 *  error-path logging (the endpoint client logs the refusal the (b) leg's
 *  Stop-all deliberately provokes) — a leg that asks the engine to refuse
 *  must not also demand a silent console. */
function watchPage(page: Page): { pageErrors: string[]; consoleErrors: string[] } {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(`pageerror: ${error.message}`))
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`)
  })
  return { pageErrors, consoleErrors }
}

/** The engine's run creation body for the spec's synthetic cohort (the
 *  txr-results helpers' shape — one shared source for the run-screen
 *  suites). */
function cohortRunBody(methodIds: string[]): Record<string, unknown> {
  return cannotRunRunBody(methodIds)
}

/** The C-flow setup both runnable-method legs need: the example CSVs
 *  through the real inspect/validate path, Continue → `/choose-methods`. */
async function driveToChooseMethods(page: Page): Promise<void> {
  await page.goto('/files')

  const patients = await fetchCsv(page, '/api/file-validation/examples/patients')
  const measurements = await fetchCsv(page, '/api/file-validation/examples/measurements')
  await dropCsv(page, 'txr-intake-file-drop-patients', 'patients.csv', patients)
  await dropCsv(page, 'txr-intake-file-drop-measurements', 'measurements.csv', measurements)

  const patientsStatus = page.getByTestId('txr-intake-file-status-patients')
  await expect(patientsStatus).toContainText('300 rows read', { timeout: 120_000 })
  const measurementsStatus = page.getByTestId('txr-intake-file-status-measurements')
  await expect(measurementsStatus).toContainText('3,848 rows', { timeout: 120_000 })
  await expect(page.getByTestId('txr-intake-continue')).toBeEnabled()
  await page.getByTestId('txr-intake-continue').click()
  await page.waitForURL('**/choose-methods')
}

/** Bring one specific method's row into view and select it. The list
 *  renders in the PAGE's scroll context (the E board is one document; the
 *  kit's ScrollArea wraps the whole list, 359 real catalogue rows), so the
 *  row's own `scrollIntoViewIfNeeded` is the scroll — never a pin on the
 *  row's index (the catalogue order is the provider's). */
async function selectMethod(page: Page, methodId: string): Promise<void> {
  const checkbox = page.getByTestId(`txr-list-checkbox-${methodId}`)
  await checkbox.scrollIntoViewIfNeeded()
  await expect(checkbox).toBeVisible({ timeout: 120_000 })
  await expect(checkbox).toBeEnabled()
  await checkbox.click()
  await expect(page.getByTestId('txr-list-selected-count')).toContainText('1 method selected', {
    timeout: 15_000,
  })
}

/** Poll the F page's counters until the run has no live method rows (every
 *  state the engine drives: waiting / downloading / running all zero). */
async function expectNoLiveRows(page: Page): Promise<void> {
  await expect
    .poll(
      async () => (await page.getByTestId('txr-run-counts').textContent()) ?? '',
      { timeout: 180_000 },
    )
    .toMatch(/0 waiting/)
  for (const state of ['running', 'downloading']) {
    await expect(page.getByTestId(`txr-run-counts-${state}`)).toContainText(`0 ${state}`)
  }
}

/** The ledger's run ids (the list's `runs[].id`), in engine order. */
async function runLedgerIds(page: Page, token: string): Promise<string[]> {
  const runs = await (
    await page.request.get('/api/txr/runs', { headers: authHeader(token) })
  ).json()
  return (runs as { runs: Array<{ id: string }> }).runs.map(row => row.id)
}

test.describe('txr-run — the real backend (TEST-RUN-28/29)', () => {
  test('(a) a cannot-run run through the API: F rows, engine reason, Failed tab, engine log lines', async ({
    page,
  }) => {
    const errors = watchPage(page)
    const token = await mintLocalSession(page)
    const runId = await createRun(page, token, [CANNOT_RUN_METHOD])
    const detail = await waitForTerminalRun(page, token, runId)

    // The engine's own facts: the run finished with exactly one cannot-run
    // method and no finished one (predictions unavailable).
    const methods = detail.methods as Array<Record<string, unknown>>
    expect(methods).toHaveLength(1)
    expect(methods[0].method_id).toBe(CANNOT_RUN_METHOD)
    expect(methods[0].state).toBe('cannot_run')
    expect((methods[0].reason as Record<string, unknown>).code).toBe('ENV_UNKNOWN')

    // The F page's own session is the seeded one.
    await seedLocalSession(page, token)
    await page.goto(`/analysis/${runId}/running`)

    // The header: the run's own row count, the leave-and-continue note and
    // the research notice — the board's F surface, never a blank.
    await expect(page.getByTestId('txr-run-header')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('txr-run-title')).toHaveText('Running 1 method')
    await expect(page.getByTestId('txr-run-leave-note')).toBeVisible()
    await expect(page.getByTestId('txr-run-notice')).toContainText(
      "For research. Not for deciding a patient's treatment.",
    )
    // No prediction finished → the results affordance stays hidden.
    await expect(page.getByTestId('txr-run-see-results')).toHaveCount(0)

    // The row: cannot-run state + the engine's reason (never blank), the
    // counts strip (the run's real counts — the strip's five counters are
    // zero for an all-cannot-run run), the tabs' complete partition.
    const row = page.getByTestId(`txr-run-row-${CANNOT_RUN_METHOD}`)
    await expect(row).toBeVisible()
    await expect(page.getByTestId(`txr-run-state-${CANNOT_RUN_METHOD}`)).toHaveText('cannot run')
    await expect(page.getByTestId(`txr-run-detail-${CANNOT_RUN_METHOD}`)).toContainText(
      'no published environment',
    )
    await expect(page.getByTestId('txr-run-counts')).toBeVisible()
    for (const state of ['finished', 'running', 'downloading', 'waiting', 'failed']) {
      await expect(page.getByTestId(`txr-run-counts-${state}`)).toContainText(`0 ${state}`)
    }
    await expect(page.getByTestId('txr-run-tab-all')).toContainText('All 1')

    // The Failed tab shows it (cannot_run is this node's complete-partition
    // bucket, DEC-2); the Working tab is empty.
    await page.getByTestId('txr-run-tab-failed').click()
    await expect(row).toBeVisible()
    await expect(page.getByTestId('txr-run-tab-working')).toContainText('Working 0')
    await page.getByTestId('txr-run-tab-all').click()

    // "Show the log": the panel opens at the method; the engine-authored
    // lines belong to the All view (run-level lines never carry a
    // method_id — the panel's filter rule), so flip to All and assert the
    // run-level start line + the finalize line naming the cannot-run count.
    await page.getByTestId(`txr-run-action-${CANNOT_RUN_METHOD}`).click()
    const panel = page.getByTestId('txr-run-log')
    await expect(panel).toBeVisible()
    await page.getByTestId('txr-run-log-filter-all').click()
    const lines = page.getByTestId('txr-run-log-lines')
    await expect(lines).toContainText('run ', { timeout: 30_000 })
    await expect(lines).toContainText('1 cannot run')

    // The header stayed green: neither the network-error state nor the
    // not-found state, and no page error was observed.
    await expect(page.getByTestId('txr-run-load-error')).toHaveCount(0)
    await expect(page.getByTestId('txr-run-not-found')).toHaveCount(0)
    expect(errors.pageErrors).toEqual([])
    expect(errors.consoleErrors).toEqual([])
  })

  test('(c) reloading the F URL reconnects to the same run; the terminal snapshot renders', async ({
    page,
  }) => {
    const token = await mintLocalSession(page)
    const runId = await createRun(page, token, [CANNOT_RUN_METHOD])
    await waitForTerminalRun(page, token, runId)

    await seedLocalSession(page, token)
    await page.goto(`/analysis/${runId}/running`)
    await expect(page.getByTestId(`txr-run-row-${CANNOT_RUN_METHOD}`)).toBeVisible({
      timeout: 60_000,
    })

    // Leave-and-continue: the same URL reloaded binds the same run (the
    // replay-then-close stream + the detail snapshot; the terminal run
    // never renders blank). The count strip + the row stay.
    await page.reload()
    await expect(page.getByTestId(`txr-run-row-${CANNOT_RUN_METHOD}`)).toBeVisible({
      timeout: 60_000,
    })
    await expect(page.getByTestId('txr-run-title')).toHaveText('Running 1 method')
    await expect(page.getByTestId('txr-run-counts-finished')).toContainText('0 finished')
    await expect(page.getByTestId('txr-run-leave-note')).toBeVisible()
    await expect(page.getByTestId('txr-run-load-error')).toHaveCount(0)
    await expect(page.getByTestId('txr-run-not-found')).toHaveCount(0)
  })

  test('(d) an unknown run id renders the not-found state with the History link', async ({ page }) => {
    await seedLocalSession(page, await mintLocalSession(page))
    await page.goto(`/analysis/${randomUUID()}/running`)

    await expect(page.getByTestId('txr-run-not-found')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('txr-run-not-found')).toContainText(
      'This analysis run could not be found',
    )
    await expect(page.getByTestId('txr-run-history')).toBeVisible()
    await expect(page.getByTestId('txr-run-load-error')).toHaveCount(0)
  })

  test('(b) the E→F creation path: example CSVs → E → one runnable method → Run → F → terminal handling', async ({
    page,
  }) => {
    const errors = watchPage(page)
    await driveToChooseMethods(page)

    // E renders the board's shell: the slots + the shared list with the
    // real eligibility rows and the bottom bar (the runnable verdicts over
    // the example files — never a board number).
    await expect(page.getByTestId('txr-run-intro')).toContainText('learns from your 300 patients', {
      timeout: 120_000,
    })
    await expect(page.getByTestId('txr-run-settings-error')).toHaveCount(0)
    await expect(page.getByTestId('txr-list-bottom-bar')).toBeVisible()
    await expect(page.getByTestId('txr-list-selected-count')).toContainText('0 methods selected')

    // One runnable row — the engine's own verdict over the example files
    // (can_run, env-bearing: the drive takes it; the env phase's outcome is
    // what the terminal assertions read).
    await selectMethod(page, RUNNABLE_METHOD)

    // Run → the module's own `runningPath` (the URL is the engine's id —
    // a 202 summary id, never a fixed literal).
    await page.getByTestId('txr-list-run').click()
    await page.waitForURL(
      url => /^\/analysis\/[^/]+\/running$/.test(url.pathname),
      { timeout: 120_000 },
    )

    // F renders the new run: header (rows = the selected methods), counts
    // strip, the method row, the leave-and-continue note.
    await expect(page.getByTestId('txr-run-header')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('txr-run-title')).toContainText('Running 1 method')
    await expect(page.getByTestId('txr-run-leave-note')).toBeVisible()
    const row = page.getByTestId(`txr-run-row-${RUNNABLE_METHOD}`)
    await expect(row).toBeVisible({ timeout: 60_000 })

    // The row reaches a terminal state deterministically (the env phase's
    // outcome — the engine patches the row in every case; no leg waits for a
    // download or a completion, DEC-20). The counts strip is the engine's
    // own: polled until no live method row remains. The reason bytes are
    // the engine's (the env phase's failure code is provider-factored —
    // the OCI-grammar refusal today, a tool failure after a manifest
    // regen), so the spec pins "terminal + a reason" rather than one code.
    await expectNoLiveRows(page)
    await expect(page.getByTestId(`txr-run-state-${RUNNABLE_METHOD}`)).toHaveText('failed')
    // The detail element renders ONLY when non-empty (the row's rule) — its
    // presence IS the reason's.
    await expect(page.getByTestId(`txr-run-detail-${RUNNABLE_METHOD}`)).toBeVisible({
      timeout: 30_000,
    })

    // The engine-authored log lines: the row's Show log → the All view.
    await page.getByTestId(`txr-run-action-${RUNNABLE_METHOD}`).click()
    await expect(page.getByTestId('txr-run-log')).toBeVisible()
    await page.getByTestId('txr-run-log-filter-all').click()
    const lines = page.getByTestId('txr-run-log-lines')
    await expect(lines).toContainText('run ', { timeout: 30_000 })
    await expect(lines).toContainText(RUNNABLE_METHOD)
    await expect(lines).toContainText('done, 1 failed, 0 skipped')
    await page.getByTestId('txr-run-log-close').click()

    // Stop all → the confirm gate → the run-level control. The run is
    // already terminal (the env phase's refusal finished it), so the stop
    // is refused by the engine — and its typed line surfaces (INV-2's
    // "failure kept with its reason"; a failed control is never a silent
    // no-op). The deterministic invariant: no crash, the counts stay
    // terminal, the row keeps its reason.
    await page.getByTestId('txr-run-stop-all').click()
    await page
      .getByTestId('txr-run-stop-all-confirm')
      .getByText('Stop all', { exact: true })
      .click()
    await expect(page.getByTestId('txr-run-action-error')).toContainText('is already', {
      timeout: 60_000,
    })
    await expectNoLiveRows(page)
    await expect(page.getByTestId(`txr-run-state-${RUNNABLE_METHOD}`)).toHaveText('failed')
    await expect(page.getByTestId('txr-run-load-error')).toHaveCount(0)
    await expect(page.getByTestId('txr-run-not-found')).toHaveCount(0)
    // No uncaught exception. The console DOES carry the app's own error-path
    // lines for the intentional refusal (the endpoint client logs the failed
    // `stop` POST + the browser's 409 resource message) — this leg provokes
    // them on purpose; everything else on the console must be silent.
    const unexpected = errors.consoleErrors.filter(
      line =>
        !/Error calling endpoint POST \/api\/txr\/runs\/.+\/stop/.test(line) &&
        !/Failed to load resource: the server responded with a status of 409/.test(line),
    )
    expect(errors.pageErrors, 'no page error may reach the console').toEqual([])
    expect(unexpected, 'no unexpected console error').toEqual([])
  })

  test('TEST-RUN-29 — a second run creation while one is active is refused (RUN_ALREADY_ACTIVE) and creates nothing', async ({
    page,
  }) => {
    const token = await mintLocalSession(page)

    // The engine's one-active-run contract (PROV-EE-2): a second create
    // while the first is still live is a 409. The first run's live window
    // is the drive's env phase — the environment is refused at the OCI
    // grammar boundary within the same ~200 ms the run begins, so the pair
    // is fired back-to-back with NOTHING in between (a ledger read between
    // them is a full round trip the window does not survive on a loaded
    // host). Unusually slow runs replay the pair; the contract itself is
    // asserted on every round.
    let observedMessage: string | null = null
    for (let round = 0; round < 6 && observedMessage === null; round += 1) {
      // The ledger's ids just before the create — the difference check below
      // proves the refusal created nothing (the DB is shared with the other
      // tests in this run, so only the SAME-round before/after is compared).
      const before = await runLedgerIds(page, token)
      const first = await createRun(page, token, [RUNNABLE_METHOD])
      const second = await page.request.post('/api/txr/runs', {
        data: cohortRunBody([CANNOT_RUN_METHOD]),
        headers: authHeader(token),
      })
      if (second.status() === 409) {
        const body = (await second.json()) as { error: string }
        observedMessage = body.error
        expect(body.error).toContain('a run is already active')
        expect(body.error).toContain(first)
        // The refused create added no row to the ledger: the same-round
        // before/after differs by exactly the first (accepted) run's id —
        // the engine refuses BEFORE any insert (the 409's own message names
        // the active run).
        const after = await runLedgerIds(page, token)
        expect(after.filter(id => !before.includes(id))).toEqual([first])
      } else {
        // The first run terminalized before the second request reached the
        // engine (the env-phase refusal is that fast): the round created a
        // second run instead — let both settle, then replay the pair.
        await new Promise(resolve => setTimeout(resolve, 300))
      }
    }
    expect(observedMessage, 'the pair must observe RUN_ALREADY_ACTIVE').not.toBeNull()
  })
})
