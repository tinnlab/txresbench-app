import { expect, test, type Page } from '@playwright/test'
import {
  authHeader,
  createRun,
  getRun,
  mintLocalSession,
  seedLocalSession,
  waitForTerminalRun,
} from './helpers'

/**
 * TXRMODELS full-backend spec — TEST-MOD-20 ([acceptance] tier e2e;
 * INV-4/INV-5, EXAMPLE-UM-3/4).
 *
 * The gallery tier (`tests/gallery-e2e/txr-models.spec.ts`) proves the
 * D/I/J surfaces and the L/L2/L3 dialogs against the module's cassette;
 * THIS spec proves the same screens against the REAL engine, with the
 * local session minted by the app itself (no login surface) and a run the
 * spec creates through `POST /api/txr/runs` — the synthetic 20-patient /
 * 1-marker cohort, one method id the engine classifies `cannot_run`
 * (`jm-mem-lq`: a catalogue method with no published env layer, so the
 * classification is pure — no sandbox, no env download), `save_models:
 * false` (the DEC-14 real-backend scope: the deterministic terminal run,
 * no sandbox ever).
 *
 * Spec ↔ TESTS.md:
 *   · TEST-MOD-20 —
 *     (a) `/models` renders the REAL empty inventory (a seeded
 *         `GET /api/txr/models` with zero rows: the empty state + the
 *         Open-a-model-file CTA + the Models nav highlight + the real
 *         models-root footnote and no Open-the-folder in web mode);
 *     (b) `/pretrained-models` and `/saved-models` render their
 *         no-inventory not-ready states (no validated file — never a
 *         half-built list) against the real engine, no crash;
 *     (c) the L dialog on the real engine: a terminal all-cannot-run run
 *         shows the results screen's honest entry gate (no Save button —
 *         the run produced nothing) and, driven through the SAME bus
 *         event the button emits (the release-gated `__txrSaveModels`
 *         seam — TEST-MOD-20's event device; a real release carries no
 *         such window), the dialog renders the no-models-to-save state:
 *         "0 of 0 selected", the cannot-run note naming the method, the
 *         made-from line from the engine's input summary, and a disabled
 *         Save;
 *     (d) the save route's real-engine contract through
 *         `POST /api/txr/models/save`: an empty method list is refused
 *         (400) and a cannot-run run's method is refused (409
 *         METHOD_NOT_FINISHED — the same row the dialog's cannot-run note
 *         names). The successful save of REAL produced models needs a
 *         run that finished methods, which needs the sandbox tier
 *         (DEC-14); recorded in DRIFT-1 ITEM-11, not self-skipped here.
 *
 * Run surface: this spec runs under the full-backend config
 * (`playwright.config.ts`; `just e2e` in the integrated tree). It never
 * self-skips: every leg above is deterministic on a host without a
 * sandbox (the cannot-run classification is pure — no capability).
 */

test.setTimeout(300_000)

/** The catalogue method the engine classifies cannot_run on this inventory
 *  (no published env layer — the engine's own HTTP suite's reason). */
const CANNOT_RUN_METHOD = 'jm-mem-lq'

/** Collect page errors — an uncaught exception anywhere fails the leg
 *  (a real-backend render defect is exactly what this tier exists for). */
function watchPageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
  return errors
}

/** The seam's evaluate-time guard (the same call the results button
 *  makes — `emitSaveModels`): the spec drives the L entry through the
 *  release-gated window device of `TxrModelsDialogHost`. */
async function openSaveModelsDialog(page: Page, runId: string, methodIds: string[]): Promise<void> {
  await page.evaluate(
    ({ id, ids }) => {
      const seam = (window as unknown as { __txrSaveModels?: (runId: string, methodIds: string[]) => void })
        .__txrSaveModels
      if (seam === undefined) {
        throw new Error('the txr-models e2e seam is absent — VITE_ENABLE_TEST_SEAMS must be set')
      }
      seam(id, ids)
    },
    { id: runId, ids: methodIds },
  )
}

test.describe('txr-models — the real backend (TEST-MOD-20)', () => {
  test('screen J — the real empty inventory, the import CTA and the Models nav highlight', async ({
    page,
  }) => {
    const token = await mintLocalSession(page)
    await seedLocalSession(page, token)
    const errors = watchPageErrors(page)

    await page.goto('/models')

    // The page + the REAL empty inventory (the store's seeded database has
    // no model rows): the board's empty state + the Open-a-model-file CTA.
    await expect(page.getByTestId('txr-models-j')).toBeVisible({ timeout: 90_000 })
    await expect(page.getByTestId('txr-models-j-empty')).toBeVisible()
    await expect(page.getByTestId('txr-models-j-empty')).toContainText('No models yet.')
    await expect(page.getByTestId('txr-models-empty-import')).toBeVisible()
    await expect(page.getByTestId('txr-models-empty-import')).toHaveText('Open a model file')

    // The footnote carries the REAL models root (the store's
    // `models_dir()` under the e2e app-data dir) and the desktop-gated
    // Open-the-folder is absent in the web preview while the path text is
    // present (TEST-MOD-11's positive control, against the real response).
    await expect(page.getByTestId('txr-models-j-stored-line')).toBeVisible()
    await expect(page.getByTestId('txr-models-j-models-path')).toBeVisible()
    await expect(page.getByTestId('txr-models-j-models-path')).toContainText('/models')
    await expect(page.getByTestId('txr-models-open-folder')).toHaveCount(0)

    // The nav highlight: the Models NavLink is the active one (its inline
    // active style) — the shell route handoff the module took over.
    await expect(page.locator('.txr-nav-link', { hasText: 'Models' })).toHaveCSS(
      'font-weight',
      '700',
    )

    // The no-login discipline: the local session satisfies the route guard.
    await expect(page.getByTestId('auth-login-submit')).toHaveCount(0)

    expect(errors, `page errors on /models: ${errors.join('; ')}`).toEqual([])
  })

  test('screens D and I — the no-inventory not-ready states against the real engine', async ({
    page,
  }) => {
    const token = await mintLocalSession(page)
    await seedLocalSession(page, token)
    const errors = watchPageErrors(page)

    // D: no validated predict file — the not-ready state, never a half list.
    await page.goto('/pretrained-models')
    await expect(page.getByTestId('txr-models-d')).toBeVisible({ timeout: 90_000 })
    await expect(page.getByTestId('txr-models-d-empty')).toBeVisible()
    await expect(page.getByTestId('txr-models-d-empty')).toContainText(
      'Add the patients\u2019 measurements you want to predict first.',
    )
    await expect(page.getByTestId('txr-models-d-empty-cta')).toBeVisible()
    await expect(page.getByTestId('txr-models-d-empty-cta')).toHaveText('Go to the start')

    // The same state on I.
    await page.goto('/saved-models')
    await expect(page.getByTestId('txr-models-i')).toBeVisible({ timeout: 90_000 })
    await expect(page.getByTestId('txr-models-i-empty')).toBeVisible()
    await expect(page.getByTestId('txr-models-i-empty')).toContainText(
      'Add the patients\u2019 measurements you want to predict first.',
    )
    await expect(page.getByTestId('txr-models-i-empty-cta')).toBeVisible()

    // The real catalogue + inventory reads against the real engine did not
    // crash either screen (the renders above are the boards' own context).
    expect(errors, `page errors on the not-ready screens: ${errors.join('; ')}`).toEqual([])
  })

  test('the L dialog on a real all-cannot-run run: the entry gate, the no-models-to-save state and the disabled save', async ({
    page,
  }) => {
    const token = await mintLocalSession(page)
    const runId = await createRun(page, token, [CANNOT_RUN_METHOD])
    const detail = await waitForTerminalRun(page, token, runId)

    // The engine's own facts: the run finished with one cannot-run method
    // and NO produced models (the checklist's truth, never a mock).
    const methods = detail.methods as Array<Record<string, unknown>>
    expect(methods).toHaveLength(1)
    expect(methods[0].method_id).toBe(CANNOT_RUN_METHOD)
    expect(methods[0].state).toBe('cannot_run')
    expect((methods[0].reason as Record<string, unknown>).code).toBe('ENV_UNKNOWN')
    expect((detail.models as unknown[]).length).toBe(0)
    const real = await getRun(page, token, runId)
    expect((real.models as unknown[]).length).toBe(0)

    // The results screen's honest entry gate: NO produced models means NO
    // "Save the models (N)" button (CONS-UM-14 renders it only when
    // `run.models.length > 0`) — the real engine's empty-heatmap state.
    await seedLocalSession(page, token)
    await page.goto(`/analysis/${runId}/results`)
    await expect(page.getByTestId(`txr-results-cannot-${CANNOT_RUN_METHOD}`)).toBeVisible({
      timeout: 90_000,
    })
    await expect(page.getByTestId('txr-results-subtitle')).toContainText('0 of 1 method finished')
    await expect(page.getByTestId('txr-results-save-models')).toHaveCount(0)
    await expect(page.getByTestId('txr-results-download')).toBeDisabled()

    // The same event the button would emit, through the release-gated seam:
    // the dialog opens and renders the engine's real no-models facts.
    await openSaveModelsDialog(page, runId, [CANNOT_RUN_METHOD])
    const dialog = page.getByTestId('txr-models-save')
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('txr-models-save-count')).toHaveText('0 of 0 selected')
    await expect(page.getByTestId('txr-models-save-cannot-run')).toContainText(CANNOT_RUN_METHOD)
    await expect(page.getByTestId('txr-models-save-cannot-run')).toContainText(
      'could not run, so it has no model to save.',
    )
    const madeFrom = page.getByTestId('txr-models-save-made-from')
    await expect(madeFrom).toContainText('Made from patients.csv')
    await expect(madeFrom).toContainText('20 patients')
    await expect(madeFrom).toContainText('decision day 56')
    // The empty checklist: NOTHING saveable, the confirm disabled for the
    // engine's own zero-model truth (never a fabricated "Save 20 models").
    await expect(page.locator('[data-testid^="txr-models-save-row-"]')).toHaveCount(0)
    await expect(page.getByTestId('txr-models-save-confirm')).toBeDisabled()
    await expect(page.getByTestId('txr-models-save-confirm')).toHaveText('Save 0 models')

    // Cancel closes without a call and leaves the results screen intact.
    await page.getByTestId('txr-models-save-cancel').click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('txr-results-header')).toBeVisible()
  })

  test('the save route against the real engine: an empty request and a cannot-run method are refused', async ({
    page,
  }) => {
    const token = await mintLocalSession(page)
    const runId = await createRun(page, token, [CANNOT_RUN_METHOD])
    await waitForTerminalRun(page, token, runId)

    // The PROV-MS-3 save through the REAL route: the engine's own records
    // for this run (a cannot-run method → no produced model) refuse the
    // save — the same row the L dialog's cannot-run note names.
    const refused = await page.request.post('/api/txr/models/save', {
      data: {
        run_id: runId,
        method_ids: [CANNOT_RUN_METHOD],
        target: { set_name: 'real-engine-check' },
        keep_training_files: false,
        also_export: false,
      },
      headers: authHeader(token),
    })
    const refusedBody = (await refused.json()) as {
      error?: string
      error_code?: string
    }
    expect(
      refused.status(),
      `POST /api/txr/models/save -> ${refused.status()} ${JSON.stringify(refusedBody)}`,
    ).toBe(409)
    expect(refusedBody.error_code).toBe('METHOD_NOT_FINISHED')
    expect(refusedBody.error).toContain(CANNOT_RUN_METHOD)

    // The empty-selection contract: `method_ids` is 1..=N — an empty save
    // is refused before any run lookup (400 EMPTY_METHODS).
    const empty = await page.request.post('/api/txr/models/save', {
      data: {
        run_id: runId,
        method_ids: [],
        target: { set_name: 'real-engine-check' },
        keep_training_files: false,
        also_export: false,
      },
      headers: authHeader(token),
    })
    const emptyBody = (await empty.json()) as { error_code?: string }
    expect(
      empty.status(),
      `POST /api/txr/models/save (empty) -> ${empty.status()} ${JSON.stringify(emptyBody)}`,
    ).toBe(400)
    expect(emptyBody.error_code).toBe('EMPTY_METHODS')

    // Neither refusal created a set or rows (the inventory stays the real
    // empty state — the save route mutated nothing for a refused request).
    const inventory = await page.request.get('/api/txr/models', {
      headers: authHeader(token),
    })
    const list = (await inventory.json()) as { models: unknown[]; total: number }
    expect(list.models).toHaveLength(0)
    expect(list.total).toBe(0)
  })
})
