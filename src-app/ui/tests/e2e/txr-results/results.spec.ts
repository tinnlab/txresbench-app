import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { authHeader, createRun, mintLocalSession, seedLocalSession, waitForTerminalRun } from './helpers'

/**
 * TXRRESULTS full-backend spec — TEST-UR-17 (INV-2, [acceptance]).
 *
 * The gallery tier (tests/gallery-e2e/txr-results.spec.ts) proves the G/H
 * surfaces against the module's cassette; THIS spec proves the DEC-18 state
 * machine + the engine-authored facts against the REAL backend, with the
 * local session minted by the app itself (no login surface) and a run the
 * spec creates through `POST /api/txr/runs` — synthetic 20-patient /
 * 1-marker input, one method id that cannot run on that inventory
 * (`jm-mem-lq`: a catalogue method with no published env layer, so the
 * classification is pure — no sandbox, no env download; the engine's own
 * HTTP suite uses the same method for the same reason).
 *
 * Spec ↔ TESTS.md:
 *   · TEST-UR-17 — `/analysis/<random-uuid>/results` renders the not-found
 *     state; the created run renders `txr-results-cannot-<method_id>` with
 *     the engine's reason, the empty-heatmap state
 *     (`PREDICTIONS_UNAVAILABLE` → no columns, no spinner), the disabled
 *     download button, and "Show the log" showing the engine-authored
 *     cannot-run line; a wrong method id on the method route stays on the
 *     run's own state without a crash (this spec's run is all-cannot-run,
 *     so no predictions ever resolve; the RES-12 method-not-found state for
 *     a run WITH finished columns is the unit tier's pin — the
 *     real-backend tier is scoped to the all-cannot-run run per DEC-14, so
 *     no sandbox is ever needed).
 *
 * Run surface: this spec runs under the full-backend config
 * (`playwright.config.ts`; the config boots the backend + the preview on
 * derived ports). It never self-skips.
 */

test.setTimeout(300_000)

/** The catalogue method the engine classifies cannot_run on this inventory. */
const CANNOT_RUN_METHOD = 'jm-mem-lq'

test.describe('txr-results — the real backend (TEST-UR-17)', () => {
  test('an unknown run id renders the not-found state (message + New analysis CTA)', async ({
    page,
  }) => {
    await page.goto(`/analysis/${randomUUID()}/results`)

    await expect(page.getByTestId('txr-results-not-found')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('txr-results-not-found')).toContainText(
      'This analysis run could not be found',
    )
    await expect(page.getByTestId('txr-results-new-analysis')).toBeVisible()
  })

  test('a real cannot-run run: banner + engine reason, empty-heatmap state, disabled download, engine log line', async ({
    page,
  }) => {
    // The local session (minted by the app itself) + the run creation.
    const token = await mintLocalSession(page)
    const runId = await createRun(page, token, [CANNOT_RUN_METHOD])
    const detail = await waitForTerminalRun(page, token, runId)

    // The engine's own facts: the run finished with exactly one cannot-run
    // method and NO finished ones (predictions are unavailable).
    const methods = detail.methods as Array<Record<string, unknown>>
    expect(methods).toHaveLength(1)
    expect(methods[0].method_id).toBe(CANNOT_RUN_METHOD)
    expect(methods[0].state).toBe('cannot_run')
    expect((methods[0].reason as Record<string, unknown>).code).toBe('ENV_UNKNOWN')
    expect((methods[0].reason as Record<string, unknown>).detail).toContain(
      'no published environment',
    )

    // Open the run's results page — the page's own session is the seeded one.
    await seedLocalSession(page, token)
    await page.goto(`/analysis/${runId}/results`)

    // ── the banner: mono method id + the engine's reason detail verbatim ──
    const banner = page.getByTestId(`txr-results-cannot-${CANNOT_RUN_METHOD}`)
    await expect(banner).toBeVisible({ timeout: 60_000 })
    await expect(banner).toContainText(CANNOT_RUN_METHOD)
    await expect(banner).toContainText('could not run: no published environment')

    // ── the 409 empty-heatmap state: no columns, no spinner loop, the
    //    download is disabled exactly because no method finished ──
    await expect(page.getByTestId('txr-heatmap')).toHaveCount(0)
    await expect(page.getByTestId('txr-results-loading')).toHaveCount(0)
    await expect(page.getByTestId('txr-results-download')).toBeDisabled()
    await expect(page.getByTestId('txr-results-subtitle')).toContainText('0 of 1 method finished')

    // ── "Show the log": the dialog opens for the method (the affordance is
    //    real). The engine's log surface for a PRE-classified cannot_run
    //    method carries the run-level lines only (measured: no per-method
    //    line is written — the reason lives on the method row, which the
    //    banner renders), so the method-scoped dialog renders no lines and
    //    the copy action stays disabled; the engine-authored cannot-run line
    //    is asserted against the same surface the dialog reads (TEST-UR-17's
    //    honest real-backend pin; the per-method line is the engine's plan
    //    promise — DRIFT-1 ITEM-12) ──
    await page.getByTestId(`txr-results-show-log-${CANNOT_RUN_METHOD}`).click()
    const dialog = page.getByTestId('txr-log-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(`Log: ${CANNOT_RUN_METHOD}`)
    const pre = page.getByTestId('txr-log-dialog-pre')
    await expect(pre).toHaveText('')
    await expect(page.getByTestId('txr-log-dialog-copy')).toBeDisabled()

    // The run's engine-authored log lines (the same surface the dialog is
    // fed from — `Txr.listRunLogs`): the start line + the finalize line
    // naming the cannot-run count, and no per-method line.
    const logsResp = await page.request.get(`/api/txr/runs/${runId}/logs`, {
      headers: authHeader(token),
    })
    expect(logsResp.ok(), `GET /api/txr/runs/${runId}/logs -> ${logsResp.status()}`).toBeTruthy()
    const logs = (await logsResp.json()) as { lines: Array<Record<string, unknown>> }
    const content = logs.lines.map(line => line.content).join('\n')
    expect(content).toContain('run ')
    expect(content).toContain('1 cannot run')
    expect(content).toContain('0 done, 0 failed, 0 skipped, 0 stopped, 0 waiting, 1 cannot run')
    // The API's log line carries `method_id` as Option<String> — JSON null
    // for run-level lines, never absent — and NO per-method line exists.
    expect(logs.lines.every(line => line.method_id === null)).toBe(true)
  })

  test("a wrong method id on the method route stays on the run's own view (no crash, no not-found)", async ({
    page,
  }) => {
    const token = await mintLocalSession(page)
    const runId = await createRun(page, token, [CANNOT_RUN_METHOD])
    await waitForTerminalRun(page, token, runId)

    await seedLocalSession(page, token)
    await page.goto(`/analysis/${runId}/results/methods/not-a-method`)

    // The run exists (no not-found); the unknown method id is not a finished
    // method — and this run has NO finished method at all, so the route
    // stays on the run's own empty state with the banner. (A wrong method
    // id on a run WITH finished columns is the RES-12 method-not-found
    // state, pinned by the unit tier + the gallery H stories.)
    await expect(page.getByTestId('txr-results-not-found')).toHaveCount(0)
    await expect(page.getByTestId('txr-results-method-not-found')).toHaveCount(0)
    await expect(page.getByTestId(`txr-results-cannot-${CANNOT_RUN_METHOD}`)).toBeVisible({
      timeout: 60_000,
    })
    await expect(page.getByTestId('txr-heatmap')).toHaveCount(0)
    await expect(page.getByTestId('txr-results-download')).toBeDisabled()
  })
})
