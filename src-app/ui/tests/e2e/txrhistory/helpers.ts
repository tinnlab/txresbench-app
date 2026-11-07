import { expect, type Page } from '@playwright/test'
import { authHeader } from '../txr-results/helpers'

/**
 * txrhistory backend-e2e helpers — TEST-HIST-15's run surface.
 *
 * The session + run-creation idioms are the sibling txr-results helpers'
 * (the node convention since txrrun): the app's own no-login mint
 * (`POST /api/session/local`), the seeded `localStorage['auth-storage']`
 * the framework transport reads, and the synthetic 20-patient / 1-marker
 * cohort `cannot_run` run body the engine's own HTTP fixture uses
 * (`server/tests/execution_engine`). The spec imports THESE helpers — one
 * fixture source for the real-backend suites, never a second copy of the
 * cohort (the txrmodels one-source idiom).
 */
export {
  authHeader,
  cannotRunRunBody,
  cohortMeasurementsJson,
  cohortPatientsJson,
  createRun,
  mintLocalSession,
  seedLocalSession,
  waitForTerminalRun,
  type TxrParsedTableJson,
} from '../txr-results/helpers'

/**
 * `GET /api/txr/runs/{id}` — the run detail for the real-engine assertions
 * (the terminal state + the produced-model list the K row reads are the
 * engine's own records, never a mock).
 */
export async function getRun(
  page: Page,
  token: string,
  runId: string,
): Promise<Record<string, unknown>> {
  const resp = await page.request.get(`/api/txr/runs/${runId}`, {
    headers: authHeader(token),
  })
  expect(resp.ok(), `GET /api/txr/runs/${runId} -> ${resp.status()}`).toBeTruthy()
  return (await resp.json()) as Record<string, unknown>
}

/**
 * `GET /api/txr/history/{id}` — the K detail's real record (the copies
 * state the retention transition flips — TEST-HIST-15's server-side proof
 * next to the UI's honest note).
 */
export async function getHistoryDetail(
  page: Page,
  token: string,
  runId: string,
): Promise<Record<string, unknown>> {
  const resp = await page.request.get(`/api/txr/history/${runId}`, {
    headers: authHeader(token),
  })
  expect(resp.ok(), `GET /api/txr/history/${runId} -> ${resp.status()}`).toBeTruthy()
  return (await resp.json()) as Record<string, unknown>
}
