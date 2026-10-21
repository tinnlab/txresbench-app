import { expect, test } from '@playwright/test'
import { OWNER } from './helpers'

// The AUTH GATE on processor discovery's leg 2.
//
// `loadDiscoveredProcessors()` runs at MODULE-EVALUATION time and has two legs: leg 1 parses
// the baked manifests out of an `import.meta.glob(?raw)` (synchronous, no network), leg 2
// fetches the runtime-dropped delta from `GET /api/processors/packages`. That endpoint is
// gated by `projects::use`, so running leg 2 at module eval meant every LOGGED-OUT visitor
// issued a request that could only 401 — and the api-client logged
// `Error calling endpoint GET /api/processors/packages: …` for it. That console error is what
// tripped `smoke.spec.ts`'s zero-JS-errors assertion; smoke proves the SYMPTOM is gone, this
// proves the MECHANISM (leg 2 moved behind the auth gate) and — the half a careless fix
// breaks — that leg 2 still runs, and still succeeds, for an authenticated user.
//
// Before this spec, leg 2's only coverage was vitest with an injected `fetchPackages`
// (`core/runtime/{loadProcessors,runtimeDropin}.test.ts`); nothing exercised the REAL
// endpoint from the real browser. Real backend, no `page.route()` mocking.

const PACKAGES_PATH = '/api/processors/packages'

test('leg 2 is not issued on a logged-out boot, and runs exactly once after auth', async ({
  page,
}) => {
  const packageCalls: string[] = []
  page.on('response', r => {
    if (new URL(r.url()).pathname === PACKAGES_PATH)
      packageCalls.push(`${r.request().method()} ${r.status()}`)
  })
  const jsErrors: string[] = []
  page.on('console', m => {
    if (m.type() === 'error' && !/Failed to load resource/i.test(m.text()))
      jsErrors.push(m.text())
  })

  // ── 1. logged-out boot ───────────────────────────────────────────────────────────────
  await page.goto('/')

  const setupSubmit = page.getByTestId('app-setup-submit-button')
  const needsSetup = await setupSubmit
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  if (!needsSetup) {
    await page
      .getByTestId('auth-login-username')
      .waitFor({ state: 'visible', timeout: 15_000 })
  }

  // The unauthenticated surface is rendered, so every module body has been evaluated —
  // module-eval work necessarily precedes React's first commit. The buggy leg-2 call was
  // issued from exactly there, so it would already be in `packageCalls`. The extra beat
  // covers a leg 2 deferred to a microtask/effect that is NOT auth-gated.
  await page.waitForTimeout(1_000)
  expect(
    packageCalls,
    `${PACKAGES_PATH} must not be requested before the user is authenticated`,
  ).toEqual([])
  expect(
    // The substring must match the REAL route (`PACKAGES_PATH` = `/api/processors/packages`),
    // whose `processors` segment ITEM-69 deliberately did not move. The mechanical sweep
    // rewrote it to `packages/packages`, which matches no URL the app ever requests — so the
    // filter returned [] unconditionally and this assertion passed without testing anything.
    jsErrors.filter(e => e.includes('processors/packages')),
    'a logged-out visitor must not take a console error for a doomed authenticated request',
  ).toEqual([])

  // ── 2. authenticate; leg 2 must now run and SUCCEED ─────────────────────────────────
  // Armed before the submit click: leg 2 fires off the `isAuthenticated` transition.
  const packagesResponse = page.waitForResponse(
    r => new URL(r.url()).pathname === PACKAGES_PATH,
    { timeout: 30_000 },
  )

  if (needsSetup) {
    await page.getByTestId('app-setup-username-input').fill(OWNER.username)
    await page.getByTestId('app-setup-email-input').fill(OWNER.email)
    await page.getByTestId('app-setup-password-input').fill(OWNER.password)
    await page.getByTestId('app-setup-confirm-password-input').fill(OWNER.password)
    await setupSubmit.click()
  } else {
    await page.getByTestId('auth-login-username').fill(OWNER.username)
    await page.getByTestId('auth-login-password').fill(OWNER.password)
    await page.getByTestId('auth-login-submit').click()
  }

  const resp = await packagesResponse
  expect(resp.status(), `${PACKAGES_PATH} -> ${resp.status()}`).toBe(200)
  // The payload is the real runtime-folder read: a `packages` array (empty is legitimate —
  // this deployment may bake every package — but the SHAPE proves the route ran, not 401'd).
  const body = (await resp.json()) as { packages?: unknown }
  expect(Array.isArray(body.packages), `body: ${JSON.stringify(body).slice(0, 200)}`).toBe(true)

  // ── 3. exactly once per page session ────────────────────────────────────────────────
  // No reload here: the latch's job is that re-renders / a re-run effect inside ONE page
  // session cannot issue a second fetch or double-register the delta.
  await page.waitForTimeout(1_000)
  expect(packageCalls, 'leg 2 must run exactly once per page session').toEqual(['GET 200'])

  // ── 4. positive control: a RELOAD is a new page session ─────────────────────────────
  // The gate must be "authenticated", not "the login transition" — a user who reloads (token
  // restored from localStorage, no login form) must still get the runtime-dropped delta.
  const afterReload = page.waitForResponse(
    r => new URL(r.url()).pathname === PACKAGES_PATH,
    { timeout: 30_000 },
  )
  await page.reload()
  const resp2 = await afterReload
  expect(resp2.status(), `${PACKAGES_PATH} after reload -> ${resp2.status()}`).toBe(200)
  await page.waitForTimeout(1_000)
  expect(packageCalls, 'one leg-2 fetch per page session, no more').toEqual([
    'GET 200',
    'GET 200',
  ])
  expect(
    // The substring must match the REAL route (`PACKAGES_PATH` = `/api/processors/packages`),
    // whose `processors` segment ITEM-69 deliberately did not move. The mechanical sweep
    // rewrote it to `packages/packages`, which matches no URL the app ever requests — so the
    // filter returned [] unconditionally and this assertion passed without testing anything.
    jsErrors.filter(e => e.includes('processors/packages')),
    'no console error from the processor-packages fetch on any leg of this flow',
  ).toEqual([])
})
