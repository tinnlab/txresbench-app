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

/** Bring one specific method's row into view and select it. The row body
 *  is the ITEM-2 virtualized list (CM-2: the 359 real catalogue rows, the
 *  windowed scroll box) — a deep row is NOT in the DOM until the scroll
 *  container reaches it, so the scroll is the windowed body's own
 *  (`[data-overlayscrollbars-viewport]` — the node the virtualizer listens
 *  on), stepped until the row mounts; the row's index is never pinned (the
 *  catalogue order is the provider's). */
async function selectMethod(page: Page, methodId: string): Promise<void> {
  const checkbox = page.getByTestId(`txr-list-checkbox-${methodId}`)
  if ((await checkbox.count()) === 0) {
    const viewport = page.locator('[data-overlayscrollbars-viewport]').first()
    await viewport.waitFor({ timeout: 60_000 })
    for (let i = 0; i < 80 && (await checkbox.count()) === 0; i += 1) {
      await viewport.evaluate(el => {
        el.scrollTop += 600
        el.dispatchEvent(new Event('scroll'))
      })
      await page.waitForTimeout(150)
    }
  }
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
    // qa-fixes ITEM-2 (one vocabulary, CONS-EE-10): the run-start
    // classification names the SAME code the screens show.
    expect((methods[0].reason as Record<string, unknown>).code).toBe('ENV_IMAGE_MISSING')

    // The F page's own session is the seeded one.
    await seedLocalSession(page, token)
    await page.goto(`/analysis/${runId}/running`)

    // The header: the run's own row count with its terminal status word
    // (qa-fixes ITEM-3 RP-1 — a finished run's title never claims it is
    // running), the termination facts and the research notice — the
    // board's F surface, never a blank.
    await expect(page.getByTestId('txr-run-header')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('txr-run-title')).toHaveText('Finished 1 method')
    await expect(page.getByTestId('txr-run-notice')).toContainText(
      "For research. Not for deciding a patient's treatment.",
    )
    // No prediction finished → the results affordance stays hidden.
    await expect(page.getByTestId('txr-run-see-results')).toHaveCount(0)

    // The row: cannot-run state + the engine's reason (never blank), the
    // counts strip (EVERY engine state counted — qa-fixes ITEM-3 RP-3),
    // the tabs' complete partition.
    const row = page.getByTestId(`txr-run-row-${CANNOT_RUN_METHOD}`)
    await expect(row).toBeVisible()
    await expect(page.getByTestId(`txr-run-state-${CANNOT_RUN_METHOD}`)).toHaveText('cannot run')
    await expect(page.getByTestId(`txr-run-detail-${CANNOT_RUN_METHOD}`)).toContainText(
      'no published environment',
    )
    await expect(page.getByTestId('txr-run-counts')).toBeVisible()
    // The strip counts EVERY engine state over the run's own rows
    // (the component's own pin: RunningPage.test.tsx:285 — a cannot-run
    // row reads `1 cannot run`, never a fabricated zero).
    for (const state of ['finished', 'running', 'downloading', 'waiting', 'failed', 'stopped', 'skipped', 'cannot_run']) {
      await expect(page.getByTestId(`txr-run-counts-${state}`)).toContainText(
        `${state === 'cannot_run' ? '1' : '0'} ${state === 'cannot_run' ? 'cannot run' : state}`,
      )
    }
    await expect(page.getByTestId('txr-run-tab-all')).toContainText('All 1')

    // The cannot-run row is its own tab (RP-3: never the Failed tab's, and
    // never called "finished"); the Failed and Working tabs are empty.
    await page.getByTestId('txr-run-tab-cannot_run').click()
    await expect(row).toBeVisible()
    await expect(page.getByTestId('txr-run-tab-failed')).toContainText('Failed 0')
    await expect(page.getByTestId('txr-run-tab-working')).toContainText('Working 0')
    await page.getByTestId('txr-run-tab-all').click()

    // "Show the log": the panel opens at the method; the engine-authored
    // lines belong to the All view (run-level lines never carry a
    // method_id — the panel's filter rule), so flip to All (the board's
    // select) and assert the run-level start line + the finalize line
    // naming the cannot-run count.
    await page.getByTestId(`txr-run-action-${CANNOT_RUN_METHOD}`).click()
    const panel = page.getByTestId('txr-run-log')
    await expect(panel).toBeVisible()
    await page.getByTestId('txr-run-log-filter').click()
    await page.getByTestId('txr-run-log-filter-opt-all').click()
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
    // never renders blank). The count strip + the row stay; the title
    // reads the run's own terminal word.
    await page.reload()
    await expect(page.getByTestId(`txr-run-row-${CANNOT_RUN_METHOD}`)).toBeVisible({
      timeout: 60_000,
    })
    await expect(page.getByTestId('txr-run-title')).toHaveText('Finished 1 method')
    await expect(page.getByTestId('txr-run-counts-finished')).toContainText('0 finished')
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
    // The run id is the URL's PATHNAME segment — `page.url()` is absolute
    // (`http://host:port/analysis/<id>/running`), so a naive
    // `split('/')[2]` reads the HOST (a latent defect the re-verification
    // run unmasked: the GET then 400s).
    const runId = new URL(page.url()).pathname.split('/')[2]
    expect(runId).toMatch(/^[0-9a-f-]+$/)

    // F renders the new run: header (rows = the selected methods), counts
    // strip, the method row. The run's env phase is refused within ~200 ms
    // of the create (TEST-RUN-29's own window), so the run can be TERMINAL
    // before this page mounts — the title then reads the run's own word and
    // the leave-and-continue note is absent (that surface is pinned exactly
    // at the terminal assertions below); a page that mounts while the run
    // is still live reads the board's "Running" title. Both surfaces are
    // the test's own either-surface contract (the wait below).
    await expect(page.getByTestId('txr-run-header')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('txr-run-title')).toHaveText(
      /^(Running|Finishing|Finished|Failed|Stopped) 1 method$/,
    )
    const row = page.getByTestId(`txr-run-row-${RUNNABLE_METHOD}`)
    await expect(row).toBeVisible({ timeout: 60_000 })

    // The run reaches the terminal state deterministically (the env phase's
    // outcome — the engine patches the row in every case; no leg waits for a
    // download or a completion, DEC-20). How it surfaces is the fix's own
    // contract (qa-fixes ITEM-3 RP-1): a page that watched the run end lands
    // on the results screen; a run that ended before the page loaded renders
    // the terminal snapshot without a redirect — so wait for EITHER surface
    // via the engine's own status (the API, never a board number).
    const token = await mintLocalSession(page)
    await seedLocalSession(page, token)
    const detail = await waitForTerminalRun(page, token, runId)
    const terminalWord =
      detail.status === 'finished' ? 'Finished' : detail.status === 'stopped' ? 'Stopped' : 'Failed'
    await expect(page.getByTestId('txr-run-load-error')).toHaveCount(0)
    await expect(page.getByTestId('txr-run-not-found')).toHaveCount(0)
    let landed = false
    try {
      await page.waitForURL(url => /\/results$/.test(url.pathname), { timeout: 30_000 })
      landed = true
    } catch {
      /* the terminal snapshot rendered on the running URL instead */
    }
    if (!landed) {
      expect(page.url()).toMatch(/\/running$/)
    }
    if (landed) {
      // The results screen renders the run's terminal state (the empty
      // heatmap's header + counts — a finished run whose method failed);
      // then back to the running URL for the terminal snapshot's surface.
      await expect(page.getByTestId('txr-results')).toBeVisible({ timeout: 60_000 })
      await page.goto(`/analysis/${runId}/running`)
    }

    // The terminal snapshot (a direct load of a terminal run never
    // redirects): the run's own terminal title (the status word the engine
    // ended with — never "Running"), the row's terminal state + the
    // engine's reason (never blank), no live-run claim and no controls for
    // a run that is over.
    await expect(page.getByTestId('txr-run-header')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('txr-run-title')).toHaveText(`${terminalWord} 1 method`)
    await expect(page.getByTestId('txr-run-leave-note')).toHaveCount(0)
    await expect(row).toBeVisible()
    await expect(page.getByTestId(`txr-run-state-${RUNNABLE_METHOD}`)).toHaveText('failed')
    // The detail element renders ONLY when non-empty (the row's rule) — its
    // presence IS the reason's.
    await expect(page.getByTestId(`txr-run-detail-${RUNNABLE_METHOD}`)).toBeVisible({
      timeout: 30_000,
    })
    // The counts strip is the engine's own: no live method row remains.
    await expectNoLiveRows(page)

    // The engine-authored log lines: the row's Show log → the All view
    // (the board's select picks the filter).
    await page.getByTestId(`txr-run-action-${RUNNABLE_METHOD}`).click()
    await expect(page.getByTestId('txr-run-log')).toBeVisible()
    await page.getByTestId('txr-run-log-filter').click()
    await page.getByTestId('txr-run-log-filter-opt-all').click()
    const lines = page.getByTestId('txr-run-log-lines')
    await expect(lines).toContainText('run ', { timeout: 30_000 })
    await expect(lines).toContainText(RUNNABLE_METHOD)
    await expect(lines).toContainText('done, 1 failed, 0 skipped')
    await page.getByTestId('txr-run-log-close').click()

    // The run is over: Stop all and the lane pick are DISABLED — a
    // finished run's screen no longer offers live-run controls (RP-1; the
    // engine's 409 refusal of a stop on a terminal run is no longer
    // reachable through the screen). The deterministic invariant: no
    // crash, the counts stay terminal, the row keeps its reason.
    await expect(page.getByTestId('txr-run-stop-all')).toBeDisabled()
    await expectNoLiveRows(page)
    await expect(page.getByTestId(`txr-run-state-${RUNNABLE_METHOD}`)).toHaveText('failed')
    await expect(page.getByTestId('txr-run-load-error')).toHaveCount(0)
    await expect(page.getByTestId('txr-run-not-found')).toHaveCount(0)
    // No uncaught exception; the console stays silent (no deliberate 409
    // is provoked any more — the screen no longer offers the control).
    expect(errors.pageErrors, 'no page error may reach the console').toEqual([])
    expect(errors.consoleErrors, 'no unexpected console error').toEqual([])
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
