import { expect, type Page } from '@playwright/test'

/**
 * txr-run backend-e2e helpers — TEST-RUN-28/29's run surface.
 *
 * The session + run-creation idioms are the sibling txr-results helpers':
 * the app's own no-login mint (`POST /api/session/local`), the seeded
 * `localStorage['auth-storage']` the framework transport reads, and the
 * synthetic 20-patient / 1-marker cohort `cannot_run` run body the engine's
 * own HTTP fixture uses (`server/tests/execution_engine`). The spec imports
 * THESE helpers — one fixture source for the two run-screen suites, never a
 * second copy of the cohort (the same one-run request body is what the
 * engine parses either way).
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

/** The committed example CSVs through the app's own origin (the preview
 *  proxy → the real backend) — the same path the screens' downloads use.
 *  The asset routes are bearer-gated and the app's session lives in the
 *  api-client's in-memory provider, so the spec mints the same local
 *  session and carries its token itself (the txr-intake spec's idiom). */
export async function fetchCsv(page: Page, path: string): Promise<string> {
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
export async function dropCsv(page: Page, cardTestId: string, name: string, text: string): Promise<void> {
  await page
    .getByTestId(cardTestId)
    .locator('input[type=file]')
    .setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(text, 'utf8') })
}
