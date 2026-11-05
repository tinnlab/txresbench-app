import { expect, test, type Page } from '@playwright/test'

/**
 * TXRINTAKE full-backend spec — TEST-INT-17 (INV-4, [acceptance]).
 *
 * The gallery tier (tests/gallery-e2e/txr-intake.spec.ts) proves the screens
 * against the cassette; THIS spec proves the same screens against the REAL
 * backend: the local session is minted by the app itself (no login screen),
 * the example CSVs come from the real `FileValidation.example` endpoints
 * (CONS-UI-INTAKE-6), and the real inspect / validate / eligibility wiring
 * renders the board's data-filled boxes. Every number asserted below is the
 * provider's real response for the committed synthetic examples (300
 * patients / 3,848 rows) — never the boards' design-example counts.
 *
 * Spec ↔ TESTS.md:
 *   · TEST-INT-17 — the C screen (example files → green boxes + the A04
 *     notes, the Continue gate, the E-screen handoff), the N screen (predict
 *     mode, board-N line, Continue to the model choice), the B panel (the
 *     fit count is the real eligibility's and changes with an answer), the
 *     A learn-card count (`GET /api/methods?runnable=true`), and TEST-INT-8's
 *     deferred template-heads row pinned against the real API.
 *
 * Run surface: this spec runs under the full-backend config
 * (`playwright.config.ts`; `just e2e` in the integrated tree). It never
 * self-skips: TEST-INT-17's "skipped with a stated reason otherwise" is the
 * RUN surface's decision, not the spec's.
 */

/** The committed example CSVs through the app's own origin (the preview
 *  proxy → the real backend) — the same path the screens' downloads use.
 *  The asset routes are bearer-gated (the framework's reused permission),
 *  and the app's session lives in the api-client's in-memory provider, so
 *  the spec mints the same local session (the idempotent
 *  `POST /api/session/local`) and carries its token itself. */
async function fetchCsv(page: Page, path: string): Promise<string> {
  const session = await page.request.post('/api/session/local', { data: {} })
  expect(session.ok(), `POST /api/session/local -> ${session.status()}`).toBeTruthy()
  const token = ((await session.json()) as { access_token: string }).access_token
  const result = await page.evaluate(
    async ({ p, bearer }) => {
      const r = await fetch(p, { headers: { authorization: `Bearer ${bearer}` } })
      return { ok: r.ok, status: r.status, text: await r.text() }
    },
    { p: path, bearer: token },
  )
  expect(result.ok, `${path} -> ${result.status}`).toBeTruthy()
  return result.text
}

/** Drop one CSV text onto a card through the card's REAL file input. */
async function dropCsv(page: Page, cardTestId: string, name: string, text: string): Promise<void> {
  await page
    .getByTestId(cardTestId)
    .locator('input[type=file]')
    .setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(text, 'utf8') })
}

/** Collect every `POST /api/file-validation/validate` body seen on the page. */
function captureValidateBodies(page: Page): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = []
  page.on('request', request => {
    if (request.method() !== 'POST') return
    if (!request.url().includes('/api/file-validation/validate')) return
    const body = request.postDataJSON() as Record<string, unknown>
    bodies.push(body)
  })
  return bodies
}

/** Record every SPA navigation URL (history push/replace) on `window.__txrNav`. */
async function recordNavigations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __txrNav: string[] }
    const seen: string[] = []
    w.__txrNav = seen
    const push = history.pushState.bind(history)
    const replace = history.replaceState.bind(history)
    history.pushState = (...args) => {
      const result = push(...(args as Parameters<typeof push>))
      seen.push(window.location.href)
      return result
    }
    history.replaceState = (...args) => {
      const result = replace(...(args as Parameters<typeof replace>))
      seen.push(window.location.href)
      return result
    }
  })
}

test.setTimeout(180_000)

test.describe('txr-intake-full — the real backend (TEST-INT-17)', () => {
  test('screen A — local session minted, live runnable count, no login surface', async ({ page }) => {
    await page.goto('/')

    // The app has no login screen: the local session mint happens on the
    // page's own and the intake Start screen renders under the session guard.
    await expect(page.getByTestId('txr-intake-start-card-pretrained')).toBeVisible({
      timeout: 45_000,
    })
    await expect(page.getByTestId('auth-login-submit')).toHaveCount(0)

    // The learn card's count is the real runnable set (CONS-UI-INTAKE-3).
    await expect(page.getByTestId('txr-intake-start-card-train')).toContainText(
      '359 methods, with the time each will take',
    )

    // The web-URL notice is a dev-only line (DEC-12): the preview build is
    // production, so nothing renders.
    await expect(page.getByTestId('txr-intake-web-url')).toHaveCount(0)
  })

  test('screen B — the live fit panel answers the real eligibility endpoint', async ({ page }) => {
    await page.goto('/study')

    // The panel's first verdict (default answers: no marker group checked,
    // draw schedule always / 1 draw / day 56) — the real catalogue's 359
    // methods, 173 of which fit.
    const fitCount = page.getByTestId('txr-intake-panel-fit-count')
    await expect(fitCount).toHaveText('173of 359 methods fit', { timeout: 60_000 })
    await expect(page.getByTestId('txr-intake-panel-excluded')).toContainText(
      '186 methods are left out',
    )
    // No can-run-for-some row: the real response reports zero.
    await expect(page.getByTestId('txr-intake-panel-some')).toHaveCount(0)

    // The board's group checkboxes come from the real vocabulary (PROV-MC-4).
    await expect(page.getByTestId('txr-intake-study-group-ctdna')).toBeVisible()
    await expect(page.getByTestId('txr-intake-study-group-counts')).toBeVisible()

    // "This updates as you answer": ticking ctDNA re-runs the eligibility and
    // the count moves (173 → 176 — the real catalogue's verdicts).
    await expect(page.getByTestId('txr-intake-panel-sentence')).toHaveText(
      'This updates as you answer.',
    )
    await page.getByTestId('txr-intake-study-group-ctdna').click()
    await expect(fitCount).toHaveText('176of 359 methods fit', { timeout: 60_000 })
    await expect(page.getByTestId('txr-intake-panel-sentence')).toHaveText(
      'with ctDNA. This updates as you answer.',
    )
    await expect(page.getByTestId('txr-intake-panel-excluded')).toContainText(
      '183 methods are left out',
    )
  })

  test('screen C — the committed examples through the real inspect/validate flow', async ({
    page,
  }) => {
    await recordNavigations(page)
    await page.goto('/files')

    // TEST-INT-8's deferred template-heads row: the bytes are the PROVIDER's,
    // asserted here against the real API (never a mock pin).
    const patientsTemplate = await fetchCsv(page, '/api/file-validation/templates/patients')
    expect(patientsTemplate.split('\n')[0]).toBe(
      'patient_id,pfs_days,pfs_event,os_days,os_event,age,sex,stage',
    )
    const measurementsTemplate = await fetchCsv(
      page,
      '/api/file-validation/templates/measurements',
    )
    expect(measurementsTemplate.split('\n')[0]).toBe('patient_id,day,marker,value,unit')

    // The examples the screens serve (CONS-UI-INTAKE-6): the committed
    // synthetic world — 300 patients, 3,848 value rows.
    const patients = await fetchCsv(page, '/api/file-validation/examples/patients')
    const measurements = await fetchCsv(page, '/api/file-validation/examples/measurements')
    expect(patients.trimEnd().split('\n')).toHaveLength(301)
    expect(measurements.trimEnd().split('\n')).toHaveLength(3849)

    // The real drop → browser decode (PROV-FV-7) → inspect → validate flow.
    const validateBodies = captureValidateBodies(page)
    await dropCsv(page, 'txr-intake-file-drop-patients', 'patients.csv', patients)
    await expect(page.getByTestId('txr-intake-file-status-patients')).toContainText(
      '300 rows read',
    )
    await dropCsv(page, 'txr-intake-file-drop-measurements', 'measurements.csv', measurements)

    // The patients card: the board's green line, data-filled by the REAL
    // validate summary (300 rows, 300 with the primary outcome, the real
    // median follow-up of the synthetic world).
    const patientsStatus = page.getByTestId('txr-intake-file-status-patients')
    await expect(patientsStatus).toContainText('✓ 300 patients read')
    await expect(patientsStatus).toContainText(
      'Found 300 rows, 300 progressions or deaths, median follow-up 215.72024826342715 days. Ready.',
    )

    // The measurements card: the board-N line with the C "Ready." terminator
    // — the real marker columns and the real draw schedule (PROV-FV-3).
    const measurementsStatus = page.getByTestId('txr-intake-file-status-measurements')
    await expect(measurementsStatus).toContainText('✓ 300 patients read')
    await expect(measurementsStatus).toContainText(
      'Found 3,848 rows: markers M1 and M2; draws at day 0, 21, 42, 63, 84, 126, 168, 252 and 336. Ready.',
    )

    // The example files carry the provider's own two A04 notes (the a.u.
    // unit is not a recognizable family — warning severity, never a gate).
    const problems = page.getByTestId('txr-intake-file-problems-measurements')
    await expect(measurementsStatus).toContainText('2 notes')
    await expect(problems).toContainText(
      "column `M1` unit 'a.u.' is not a recognizable unit family — no scale assumption is made",
    )
    await expect(problems.getByRole('listitem')).toHaveCount(2)

    // Warnings never block (DEC-10): Continue is enabled.
    await expect(page.getByTestId('txr-intake-continue')).toBeEnabled()
    await expect(page.getByTestId('txr-intake-files')).toContainText(
      'Both files check out — next you choose the methods that can run on them.',
    )

    // The E-screen handoff (EXAMPLE-INT-8): the validated snapshot's bytes
    // (the same facts `buildTxrRunInput` packs — its per-input tests are
    // TEST-INT-9's; the E screen's own execution is ui-run's spec, since the
    // route itself is ui-run's to register).
    const validate = validateBodies[validateBodies.length - 1]
    expect(validate, 'the C flow must have posted one validate').toBeDefined()
    expect(validate!.mode).toBe('files')
    expect((validate!.patients as { rows: unknown[] }).rows).toHaveLength(300)
    expect((validate!.measurements as { rows: unknown[] }).rows).toHaveLength(3848)
    expect(validate!.joins).toEqual([])
    expect(validate!.mapping).toEqual([])
    expect(validate!.parameters).toEqual({ decision_day: 56, baseline_max_day: 0 })

    // The persisted handoff slice (DEC-4: small fields only, tables never).
    const persisted = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('txr-intake-storage') ?? '{}'),
    )
    expect(persisted.state.intent).toBe('train')
    expect(persisted.state.mode).toBe('study')
    expect(persisted.state.parameters).toEqual({ decision_day: 56, baseline_max_day: 0 })

    // Continue navigates to the DECLARED E route. The route's registration
    // is ui-run's (not in this tree), so the router's catch-all re-homes
    // after it; the history record IS the observed handoff.
    await page.getByTestId('txr-intake-continue').click()
    const navigations = await page.evaluate(
      () => (window as unknown as { __txrNav: string[] }).__txrNav,
    )
    expect(
      navigations,
      'the Continue click must push the declared E route (ui-run registers its screen)',
    ).toEqual(expect.arrayContaining([expect.stringContaining('/choose-methods')]))
  })

  test('screen N — predict mode through the real backend, Continue to the model choice', async ({
    page,
  }) => {
    await recordNavigations(page)

    // The honest path: screen A's pretrained card (intent `pretrained`),
    // which the N screen's Continue routes on.
    await page.goto('/')
    await expect(page.getByTestId('txr-intake-start-card-pretrained')).toBeVisible({
      timeout: 45_000,
    })
    await page.getByTestId('txr-intake-start-card-pretrained-cta').click()
    await page.waitForURL('**/predict-files')

    // One measurements card, no patients card (the board-N screen).
    await expect(page.getByTestId('txr-intake-file-card-measurements')).toBeVisible()
    await expect(page.getByTestId('txr-intake-file-card-patients')).toHaveCount(0)
    await expect(page.getByTestId('txr-intake-aside')).toContainText(
      'No outcomes are needed, and no patients file.',
    )

    const measurements = await fetchCsv(page, '/api/file-validation/examples/measurements')
    await dropCsv(page, 'txr-intake-file-drop-measurements', 'measurements.csv', measurements)

    // The board-N green box, data-filled from the real predict-mode validate
    // (the same measurements facts; the board's own continuation line).
    const status = page.getByTestId('txr-intake-file-status-measurements')
    await expect(status).toContainText('✓ 300 patients read')
    await expect(status).toContainText(
      'Found 3,848 rows: markers M1 and M2; draws at day 0, 21, 42, 63, 84, 126, 168, 252 and 336. Next you choose the models that can run on it.',
    )
    await expect(page.getByTestId('txr-intake-continue')).toBeEnabled()

    // Continue → the declared D route for intent `pretrained`.
    await page.getByTestId('txr-intake-continue').click()
    const navigations = await page.evaluate(
      () => (window as unknown as { __txrNav: string[] }).__txrNav,
    )
    expect(
      navigations,
      'the Continue click must push the declared pretrained-models route',
    ).toEqual(expect.arrayContaining([expect.stringContaining('/pretrained-models')]))
  })
})
