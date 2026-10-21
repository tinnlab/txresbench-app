import { expect, type APIRequestContext, type Page } from '@playwright/test'

// THE app owner for every spec under `tests/e2e` — ONE identity, ONE setup path.
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────
//
// `POST /api/app/setup/admin` is a ONE-SHOT endpoint: it self-gates on
// `has_admin()` and returns 403 SETUP_ALREADY_COMPLETE forever after
// (`server/src/modules/app/handlers.rs::setup_admin`). The e2e database is
// DROP/CREATEd once per RUN by the `webServer` command in `playwright.config.ts`
// — NOT per spec — so across a run that endpoint succeeds exactly once and the
// account it creates is the only owner that can ever log in.
//
// Every suite had its own "setup-if-fresh, else login" helper, which is correct
// in isolation, but they disagreed on WHO the owner is: `mcp/`, `jobs/`,
// `sandbox/`, `packages/` and `smoke.spec.ts` used `e2eadmin` while
// `project/`, `provenance/` and `project-admin/` used `projectowner`. Whichever
// family's spec ran first claimed the account; every spec in the other family
// then fell into its `else` branch and tried to log in as a user that had never
// been created — "Invalid username or password."
//
// That is ORDERING-dependent, so it presented as a mystery: `tests/e2e/jobs`
// alone on a fresh DB passed 6/6, but under the canonical full run
// `14-declarative-qc` sorts first, seeds `projectowner` through
// `project/_helpers`, and the whole `e2eadmin` family (jobs, mcp, processors,
// sandbox, smoke, most of command-palette) then failed to log in — each one
// burning its full 120 s test timeout.
//
// The fix is structural, not a rename: there is now exactly ONE owner constant
// and ONE setup entry point, and `ensureOwner` is genuinely idempotent — it can
// be called by any spec, in any order, any number of times. A suite helper that
// wants the owner delegates here; it does not re-implement the flow.
//
// ── ADDING A SUITE ────────────────────────────────────────────────────────────
//
// Re-export from here (the idiom `datasets/_helpers.ts` already uses against
// `project/_helpers.ts`). Do NOT declare another `OWNER`, and do NOT write
// another `app-setup-*` form-filling branch — `ensureOwner` owns first-run setup
// for the entire directory.

export const OWNER = {
  username: 'e2eadmin',
  email: 'e2e@cyto.test',
  password: 'e2ePassw0rd!',
}

// 127.0.0.1 (not `localhost`) — the backend binds IPv4 only, and `localhost` can
// resolve to ::1 (IPv6) → ECONNREFUSED for the API request context.
//
// `E2E_BACKEND` is DERIVED, not defaulted: `playwright.config.ts` resolves the backend
// port per worktree AND per run and assigns this variable itself, in the runner and in
// every worker (they re-load the config and read the same recorded verdict). So there
// is no committed number here to drift — the literal below is a LAST-RESORT for a spec
// helper imported outside a Playwright run, and it will simply fail to connect rather
// than quietly seed a different worktree's backend, which is what the old committed
// `:3155` default did whenever it was the port somebody else was already using.
// A pre-set `E2E_BACKEND` that disagrees with the resolved port is a hard startup
// failure in the config, so a run still cannot split across two backends.
export const BACKEND = (() => {
  const v = process.env.E2E_BACKEND
  if (v) return v
  throw new Error(
    'HARNESS FAULT — THIS IS THE TEST RIG, NOT YOUR CODE: E2E_BACKEND is unset. ' +
      'playwright.config.ts assigns it from the port it resolved for this run, so an unset ' +
      'value means these helpers were loaded outside that config. Refusing to fall back to a ' +
      'committed default port — that is how a run ends up seeding somebody else’s backend.',
  )
})()

function tokenOf(body: Record<string, unknown>): string {
  return (body.access_token ?? body.token) as string
}

/**
 * Ensure the one owner account exists. Idempotent and order-independent: safe to
 * call from any spec, at any point in a run, however many times.
 *
 * Fresh DB → creates it. Already set up → no-op. Raced (the status read and the
 * POST are not atomic) → the 403 is absorbed, but ONLY after proving the account
 * that won the race is this one; a foreign owner is a hard, LOUD failure rather
 * than a downstream "Invalid username or password" 120 s hang.
 */
export async function ensureOwner(request: APIRequestContext): Promise<void> {
  const status = await request.get(`${BACKEND}/api/app/setup/status`)
  expect(status.ok(), `GET /api/app/setup/status -> ${status.status()}`).toBeTruthy()
  if ((await status.json()).needs_setup === false) return

  const created = await request.post(`${BACKEND}/api/app/setup/admin`, {
    data: { username: OWNER.username, email: OWNER.email, password: OWNER.password },
  })
  if (created.ok()) return

  const detail = await created.text()
  const login = await request.post(`${BACKEND}/api/auth/login`, {
    data: { username: OWNER.username, password: OWNER.password },
  })
  expect(
    login.ok(),
    `first-run setup is already complete (setup/admin -> ${created.status()} ${detail}) but ` +
      `"${OWNER.username}" cannot log in (${login.status()}). The e2e database was claimed by a ` +
      `DIFFERENT owner — every spec under tests/e2e must use the single identity in _owner.ts.`,
  ).toBeTruthy()
}

/** Ensure the owner exists, then return an admin API token (for REST seeding). */
export async function ownerApiToken(request: APIRequestContext): Promise<string> {
  await ensureOwner(request)
  const r = await request.post(`${BACKEND}/api/auth/login`, {
    data: { username: OWNER.username, password: OWNER.password },
  })
  expect(r.ok(), `login ${OWNER.username} -> ${r.status()} ${await r.text()}`).toBeTruthy()
  return tokenOf(await r.json())
}

/**
 * Wait for + return the persisted access token — the same one
 * `@ziee/framework/api-client`'s `getAuthToken()` reads (`Auth.store.ts`).
 *
 * NOTE the `undefined` second argument. `waitForFunction(pageFunction, arg,
 * options)`: passing the options object second makes it the page function's
 * ARGUMENT, so no options are supplied at all and the wait inherits the runner's
 * default of "no timeout" — bounded only by the 120 s test timeout. Keep the
 * three-argument form.
 */
export async function waitForToken(page: Page, timeout = 20_000): Promise<string> {
  await page.waitForFunction(
    () => {
      try {
        return !!JSON.parse(localStorage.getItem('auth-storage') || '{}')?.state?.token
      } catch {
        return false
      }
    },
    undefined,
    { timeout },
  )
  return page.evaluate(
    () => JSON.parse(localStorage.getItem('auth-storage') || '{}')?.state?.token as string,
  )
}

/**
 * Wait until the login form is gone (auth settled). Best-effort by design — the
 * caller asserts on the destination page, not on this.
 */
export async function waitUntilOffLoginScreen(page: Page, timeout = 20_000): Promise<void> {
  await page
    .waitForFunction(
      () =>
        !document.querySelector('[data-testid="app-setup-submit-button"]') &&
        !document.querySelector('[data-testid="auth-login-submit"]'),
      undefined,
      { timeout },
    )
    .catch(() => {})
}

/** Clear the persisted session so the next `goto('/')` lands on the login form. */
export async function logout(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.removeItem('auth-storage'))
}

/** Fill + submit the login form for an already-created user. */
export async function loginViaUi(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/')
  await page.getByTestId('auth-login-username').waitFor({ state: 'visible', timeout: 20_000 })
  await page.getByTestId('auth-login-username').fill(username)
  await page.getByTestId('auth-login-password').fill(password)
  await page.getByTestId('auth-login-submit').click()
}

/**
 * Land authenticated as the owner, whatever the DB state.
 *
 * First-run setup is done over REST (`ensureOwner`) rather than by filling the
 * `app-setup-*` form, so the browser path is always the SAME one: log in. That
 * removes the "is the setup form showing?" branch — the thing that made the flow
 * order-dependent — and with it the 15 s probe every non-first spec used to pay.
 * If the context is already authenticated the login form never appears and the
 * existing token is returned.
 */
export async function loginAsOwner(page: Page): Promise<string> {
  await ensureOwner(page.request)
  await page.goto('/')
  const username = page.getByTestId('auth-login-username')
  const onLoginForm = await username
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  if (onLoginForm) {
    await username.fill(OWNER.username)
    await page.getByTestId('auth-login-password').fill(OWNER.password)
    await page.getByTestId('auth-login-submit').click()
  }
  return waitForToken(page)
}
