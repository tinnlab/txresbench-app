import { expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * txr-results backend-e2e helpers — TEST-UR-17's run surface.
 *
 * The app has no login screen: the local server mints the one owner's session
 * (`POST /api/session/local`, `modules/localsession`). The framework transport
 * reads the token from `localStorage['auth-storage'] {state:{token}}` (its
 * documented default source — `sdk/packages/framework/src/api-client/core.ts`),
 * so the helpers mint the session over the app's own origin and seed that
 * storage BEFORE the page scripts run: no form login, no UI path — the
 * single-owner discipline the suite's `_owner.ts` exists for.
 *
 * The run-creation body mirrors the engine's own HTTP fixture
 * (`server/tests/execution_engine/mod.rs::cohort_run_body`): a synthetic
 * 20-patient / 1-marker (LOINC 14804-9, three draws) cohort with the
 * canonical column names the engine's file validator checks. The selected
 * method id (`jm-mem-lq`) is a catalogue method with NO published env layer
 * (the manifest check is pure — no sandbox, no env download), so the run
 * classifies it `cannot_run` + `ENV_UNKNOWN` and finishes in milliseconds:
 * the exact case DEC-14 scopes the real-backend tier to.
 */

export interface TxrParsedTableJson {
  columns: string[]
  header_row: number
  rows: Array<Array<string | null>>
  source: { format: 'csv'; name: string }
}

/** The synthetic patients table (20 patients, half with the pfs/os event). */
export function cohortPatientsJson(): TxrParsedTableJson {
  const rows: Array<Array<string | null>> = []
  for (let i = 1; i <= 20; i += 1) {
    const id = `C${String(i).padStart(2, '0')}`
    const pfs = i > 10 ? 120 + (i - 10) * 3 : 240 + i * 3
    const os = i > 10 ? 130 + (i - 10) * 3 : 250 + i * 3
    rows.push([id, String(pfs), i > 10 ? '1' : '0', String(os), i > 10 ? '1' : '0'])
  }
  return {
    columns: ['patient_id', 'pfs_days', 'pfs_event', 'os_days', 'os_event'],
    header_row: 1,
    rows,
    source: { format: 'csv', name: 'patients.csv' },
  }
}

/** The synthetic measurements table (one marker, three draws per patient). */
export function cohortMeasurementsJson(): TxrParsedTableJson {
  const rows: Array<Array<string | null>> = []
  for (let i = 1; i <= 20; i += 1) {
    const id = `C${String(i).padStart(2, '0')}`
    for (const [day, value] of [
      ['0', '100'],
      ['28', '110'],
      ['56', '105'],
    ] as const) {
      rows.push([id, day, '14804-9', value, 'U/L'])
    }
  }
  return {
    columns: ['patient_id', 'day', 'marker', 'value', 'unit'],
    header_row: 1,
    rows,
    source: { format: 'csv', name: 'values.csv' },
  }
}

/** The cannot-run run's request body (the TESTS.md TEST-UR-17 config facts). */
export function cannotRunRunBody(methodIds: string[]): Record<string, unknown> {
  return {
    mode: 'train',
    input: {
      patients: cohortPatientsJson(),
      measurements: cohortMeasurementsJson(),
      predict_measurements: null,
      joins: [],
      mapping: [],
      keep_copies: true,
    },
    config: {
      endpoint: 'pfs',
      decision_day: 56,
      look_ahead_day: 238,
      covariates: false,
      at_a_time: 3,
      cpus: null,
      save_models: false,
      label_day: null,
    },
    method_ids: methodIds,
    model_ids: [],
  }
}

/** Mint the app's no-login owner session and return the access token. */
export async function mintLocalSession(page: Page): Promise<string> {
  const resp = await page.request.post('/api/session/local', { data: {} })
  expect(resp.ok(), `POST /api/session/local -> ${resp.status()} ${await resp.text()}`).toBeTruthy()
  const body = (await resp.json()) as { access_token: string }
  return body.access_token
}

/** Seed the token where the transport reads it — BEFORE the page scripts run. */
export async function seedLocalSession(page: Page, token: string): Promise<void> {
  await page.addInitScript(
    (seeded: string) => {
      localStorage.setItem('auth-storage', JSON.stringify({ state: { token: seeded } }))
    },
    token,
  )
}

export function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

/** `POST /api/txr/runs` — returns the new run id (the 202 summary). */
export async function createRun(page: Page, token: string, methodIds: string[]): Promise<string> {
  const resp = await page.request.post('/api/txr/runs', {
    data: cannotRunRunBody(methodIds),
    headers: authHeader(token),
  })
  expect(
    resp.ok(),
    `POST /api/txr/runs ${methodIds.join(',')} -> ${resp.status()} ${await resp.text()}`,
  ).toBeTruthy()
  const body = (await resp.json()) as { id: string }
  return body.id
}

/** Poll `GET /api/txr/runs/{id}` until it is terminal (the all-cannot-run run finishes fast). */
export async function waitForTerminalRun(
  page: Page,
  token: string,
  runId: string,
): Promise<Record<string, unknown>> {
  let detail: Record<string, unknown> = {}
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const resp = await page.request.get(`/api/txr/runs/${runId}`, { headers: authHeader(token) })
    expect(resp.ok(), `GET /api/txr/runs/${runId} -> ${resp.status()}`).toBeTruthy()
    detail = (await resp.json()) as Record<string, unknown>
    const status = detail.status
    if (status === 'finished' || status === 'failed' || status === 'stopped') return detail
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  expect(detail.status, `run ${runId} must turn terminal (last: ${JSON.stringify(detail)})`).toBe(
    'finished',
  )
  return detail
}
