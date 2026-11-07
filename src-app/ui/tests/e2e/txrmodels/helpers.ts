import { expect, type Page } from '@playwright/test'
import { authHeader } from '../txr-results/helpers'

/**
 * txr-models backend-e2e helpers — TEST-MOD-20's run surface.
 *
 * The session + run-creation idioms are the sibling txr-results helpers'
 * (the node convention since txrrun): the app's own no-login mint
 * (`POST /api/session/local`), the seeded `localStorage['auth-storage']`
 * the framework transport reads, and the synthetic 20-patient / 1-marker
 * cohort `cannot_run` run body the engine's own HTTP fixture uses
 * (`server/tests/execution_engine`). The spec imports THESE helpers — one
 * fixture source for the three real-backend suites, never a second copy of
 * the cohort.
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
 * `GET /api/txr/runs/{id}` — the run detail for the L dialog's
 * engine-facts assertions (the produced-model list the checklist reads is
 * the real engine's, never a mock).
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
