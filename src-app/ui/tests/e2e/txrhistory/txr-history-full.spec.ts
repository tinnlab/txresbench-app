import { expect, test, type Page } from '@playwright/test'
import {
  createRun,
  getHistoryDetail,
  getRun,
  mintLocalSession,
  seedLocalSession,
  waitForTerminalRun,
  authHeader,
} from './helpers'

/**
 * TXRHISTORY full-backend spec — TEST-HIST-15 ([acceptance] tier e2e,
 * INV-2/INV-3).
 *
 * The gallery tier (`tests/gallery-e2e/txr-history.spec.ts`) proves the K
 * surfaces against the module's cassette; THIS spec proves the same
 * surfaces against the REAL engine + the REAL history-store routes, with
 * the local session minted by the app itself (no login surface) and a run
 * the spec creates through `POST /api/txr/runs` — the synthetic
 * 20-patient / 1-marker cohort, one method id the engine classifies
 * `cannot_run` (`jm-mem-lq`: a catalogue method with no published env
 * layer, so the classification is pure — no sandbox, no env download),
 * `keep_copies: true` (so the rerun + retention legs are real).
 *
 * Spec ↔ TESTS.md:
 *   · TEST-HIST-15 —
 *     (a) `/history` renders the real run's card (the title from the run
 *         record's file names, the methods, the status, the chip) and the
 *         expanded block's Settings/Took rows from the real record (the
 *         Made row omits — the run produced no models; the download
 *         action is absent — `can_download` mirrors `predictions_ready`,
 *         the honest gate);
 *     (b) "Run again with the same settings" POSTs the engine's rerun and
 *         lands on the new run's F route with the same settings;
 *     (c) the preference-off flow (confirmed) PUTs the preference, POSTs
 *         the all-runs copy clear — the real run dir's `input/` is gone
 *         (`copies.kept` false in the real record), the row's honest
 *         negation renders and `can_rerun` flips false ("Use these
 *         settings again" — never a rerun call on a copy-cleared row);
 *     (d) "Clear all history" (the recorded-files choice) empties the
 *         real list and the run's rows are gone.
 *
 * The download-leg's successful half (a produced run's
 * `predictions-<runId>.csv`) needs real completed methods, which needs
 * the sandbox tier (DEC-14's recorded scope: no produced model exists
 * over HTTP without a real sandbox — measured in the txr-models item's
 * ledger). It is recorded here, not self-skipped: the spec asserts the
 * cannot-run run's honest ABSENCE of the action instead (the same
 * entry-gate honesty), and the real route's download contract belongs to
 * the sandbox tier's runbook.
 *
 * Run surface: this spec runs under the full-backend config
 * (`playwright.config.ts`; `just e2e` in the integrated tree — the
 * provider branches are merged on this line). It never self-skips: every
 * leg above is deterministic on a host without a sandbox (the
 * cannot-run classification is pure — no capability).
 */

test.setTimeout(300_000)

/** The catalogue method the engine classifies cannot_run on this inventory
 *  (no published env layer — the engine's own reason). */
const CANNOT_RUN_METHOD = 'jm-mem-lq'

/** Collect page errors — an uncaught exception anywhere fails the leg. */
function watchPageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
  return errors
}

/** The real run's K title (the run record's file names — the parsed
 *  sources' own names, never a board example). */
async function runRowTitle(page: Page, runId: string): Promise<string> {
  return (
    (await page.getByTestId(`txr-history-row-${runId}`).textContent()) ?? ''
  )
}

test.describe('txr-history — the real backend (TEST-HIST-15)', () => {
  test('the real run\'s card and the expanded block from the real record', async ({
    page,
  }) => {
    const token = await mintLocalSession(page)
    await seedLocalSession(page, token)
    const errors = watchPageErrors(page)
    const runId = await createRun(page, token, [CANNOT_RUN_METHOD])
    const runDetail = await waitForTerminalRun(page, token, runId)
    expect(runDetail.status, `run ${runId} must be terminal`).toBe('finished')

    await page.goto('/history')

    // The real run's card in the newest-first list: the record's file
    // names in the title, the one method, the finished status, the train
    // chip — the engine's own facts, never a mock.
    const row = page.getByTestId(`txr-history-row-${runId}`)
    await expect(row).toBeVisible({ timeout: 90_000 })
    const rowText = await runRowTitle(page, runId)
    expect(rowText).toContain('patients.csv')
    expect(rowText).toContain('values.csv')
    await expect(page.getByTestId(`txr-history-status-${runId}`)).toHaveText('Done')
    await expect(page.getByTestId(`txr-history-chip-${runId}`)).toHaveText(
      'Learned and predicted',
    )
    await expect(page.getByTestId(`txr-history-subtitle-${runId}`)).toContainText(
      'learned from 20 patients',
    )
    await expect(page.getByTestId(`txr-history-subtitle-${runId}`)).toContainText(
      'decision day 56',
    )
    await expect(page.getByTestId(`txr-history-subtitle-${runId}`)).toContainText(
      'progression, death by day 238',
    )

    // Expand: ONE getHistory against the real record — the Settings row's
    // bytes (the run's own config facts, the recorded seed; the machine's
    // memory figure is the host's and reads "N GB"), the Methods row with
    // the engine's cannot-run row, the Took row's sub-minute words.
    await page.getByTestId(`txr-history-toggle-${runId}`).click()
    const detail = page.getByTestId(`txr-history-detail-${runId}`)
    await expect(detail).toBeVisible()
    await expect(detail).toContainText('landmark 56')
    await expect(detail).toContainText('horizon 238')
    await expect(detail).toContainText('covariates off')
    await expect(detail).toContainText(/seed \d+/)
    await expect(detail).toContainText(CANNOT_RUN_METHOD)
    await expect(detail).toContainText('Took')
    await expect(detail).toContainText('under a minute')
    // The honest Made row: the run produced no models — the row omits.
    await expect(detail.getByText('Made')).toHaveCount(0)
    // The honest download gate: no produced predictions → no action.
    await expect(page.getByTestId(`txr-history-download-${runId}`)).toHaveCount(0)
    // The rerun affordance is real (the engine kept the input copies).
    await expect(page.getByTestId(`txr-history-rerun-${runId}`)).toBeVisible()

    expect(errors, `page errors on /history: ${errors.join('; ')}`).toEqual([])
  })

  test('"Run again with the same settings" replays the real run and lands on the new run', async ({
    page,
  }) => {
    const token = await mintLocalSession(page)
    await seedLocalSession(page, token)
    const errors = watchPageErrors(page)
    const runId = await createRun(page, token, [CANNOT_RUN_METHOD])
    await waitForTerminalRun(page, token, runId)

    await page.goto('/history')
    const row = page.getByTestId(`txr-history-row-${runId}`)
    await expect(row).toBeVisible({ timeout: 90_000 })
    await page.getByTestId(`txr-history-toggle-${runId}`).click()
    await expect(page.getByTestId(`txr-history-detail-${runId}`)).toBeVisible()

    // The engine's replay: the same settings + inputs, a NEW run id — the
    // page lands on the new run's F route.
    await page.getByTestId(`txr-history-rerun-${runId}`).click()
    await page.waitForURL(/\/analysis\/[0-9a-f-]+\/running/, { timeout: 60_000 })
    const newId = /\/analysis\/([0-9a-f-]+)\/running/.exec(page.url())![1]!
    expect(newId).not.toBe(runId)

    // The F screen mounts the real replay (never a mock): let it reach its
    // own terminal state (the replay classifies the same method the same
    // way — deterministic, no sandbox).
    const replayed = await waitForTerminalRun(page, token, newId)
    expect(replayed.status).toBe('finished')
    const replayedMethods = replayed.methods as Array<Record<string, unknown>>
    expect(replayedMethods).toHaveLength(1)
    expect(replayedMethods[0].method_id).toBe(CANNOT_RUN_METHOD)
    expect((replayedMethods[0].state ?? replayedMethods[0].status) as string).toBe('cannot_run')

    expect(errors, `page errors on the rerun leg: ${errors.join('; ')}`).toEqual([])
  })

  test('the confirmed preference-off flow clears the real input copies and flips can_rerun', async ({
    page,
  }) => {
    const token = await mintLocalSession(page)
    await seedLocalSession(page, token)
    const errors = watchPageErrors(page)
    const runId = await createRun(page, token, [CANNOT_RUN_METHOD])
    await waitForTerminalRun(page, token, runId)

    await page.goto('/history')
    const row = page.getByTestId(`txr-history-row-${runId}`)
    await expect(row).toBeVisible({ timeout: 90_000 })
    await expect(page.getByTestId('txr-history-copies-off')).toBeVisible()

    // The confirmation gate: the dialog opens; nothing destructive before
    // the CTA (the order is the row's PUT then POST — TEST-HIST-13's pin,
    // against the real server).
    await page.getByTestId('txr-history-copies-off').click()
    await expect(page.getByTestId('txr-history-confirm-copies-off')).toBeVisible()
    await page.getByTestId('txr-history-confirm-copies-off').click()
    await expect(page.getByTestId('txr-history-copies-on')).toBeVisible({
      timeout: 30_000,
    })

    // The real retention record: copies dropped and the row's can_rerun
    // flipped — the store's honest UI (the negation + the settings-again
    // slot) matches the server's record.
    await page.getByTestId(`txr-history-toggle-${runId}`).click()
    const detail = page.getByTestId(`txr-history-detail-${runId}`)
    await expect(detail).toBeVisible()
    await expect(detail).toContainText('Copies are not kept with this run.')

    await expect(page.getByTestId(`txr-history-rerun-${runId}`)).toHaveCount(0)
    await expect(page.getByTestId(`txr-history-settings-again-${runId}`)).toBeVisible()

    const realDetail = await getHistoryDetail(page, token, runId)
    const copies = realDetail.copies as Record<string, unknown>
    expect(copies.kept).toBe(false)
    expect(realDetail.can_rerun).toBe(false)
    expect(realDetail.can_reopen).toBe(false)

    expect(errors, `page errors on the copies-off leg: ${errors.join('; ')}`).toEqual([])
  })

  test('"Clear all history" empties the real list and the run records are gone', async ({
    page,
  }) => {
    const token = await mintLocalSession(page)
    await seedLocalSession(page, token)
    const errors = watchPageErrors(page)
    const runId = await createRun(page, token, [CANNOT_RUN_METHOD])
    await waitForTerminalRun(page, token, runId)

    await page.goto('/history')
    await expect(page.getByTestId(`txr-history-row-${runId}`)).toBeVisible({
      timeout: 90_000,
    })

    // The two-choice dialog; the files-with-rows choice (the built
    // default, OWNER-HIST-3) — the engine's DELETE against the real rows.
    await page.getByTestId('txr-history-clear-all').click()
    await expect(page.getByTestId('txr-history-confirm-clear-files')).toBeVisible()
    await page.getByTestId('txr-history-confirm-clear-files').click()

    // The real list empties (the store's reload hits the real store) and
    // the run's records are gone — the engine's own 404, never a mock.
    await expect(page.getByTestId('txr-history-empty')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId(`txr-history-row-${runId}`)).toHaveCount(0)

    const gone = await page.request.get(`/api/txr/runs/${runId}`, {
      headers: authHeader(token),
    })
    expect(
      gone.status(),
      `GET /api/txr/runs/${runId} after the clear -> ${gone.status()} ${await gone.text()}`,
    ).toBe(404)

    expect(errors, `page errors on the clear-all leg: ${errors.join('; ')}`).toEqual([])
  })
})
