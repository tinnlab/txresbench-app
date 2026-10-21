import { expect, test } from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loginAsOwner, OWNER } from './helpers'

// INV-3, the WHOLE loop, in the real browser: a processor package DROPPED into the
// server's runtime folder — never seen by the FE build-time `import.meta.glob` — is served
// by `GET /api/processors/packages` and REGISTERS into the shipped `workbenchRegistry`,
// with zero FE rebuild.
//
// WHY THIS EXISTS. Leg 2 of `loadDiscoveredProcessors` used to fire at module-EVALUATION
// time, against a `projects::use`-gated endpoint, and `loadRuntimeProcessors` swallows its
// own fetch failure — so on the boot where no session exists yet the fetch 401'd silently
// and the capability was dead for that whole page session (the load guard latches; there is
// no retry). The FE unit tier (`core/runtime/runtimeDropin.test.ts`) proves the
// decode→register half with the HTTP call substituted, and the server tier
// (`server/tests/extensions/runtime_dropin_test.rs`) proves the discovery half. Neither can
// catch a leg 2 that never RAN.
//
// THE SESSION SHAPE IS THE WHOLE POINT — DO NOT ADD A RELOAD. The assertion runs in a
// context that reaches the app UNAUTHENTICATED and then logs in, with no page reload
// afterwards. That is the case the old code got wrong. A reload is NOT equivalent and does
// not discriminate: the access token is persisted in `localStorage` and zustand rehydrates
// it synchronously, so on a reload the module-eval fetch already carried an `Authorization`
// header and succeeded even before the fix. A version of this spec written with
// `page.reload()` passed against the BROKEN code.
//
// HOST-CAPABILITY GATE (the config's `@acceptance` rationale, applied by env rather than
// tag): the drop must write the SERVER's `<data_root>/processors/`. That root defaults to a
// machine-shared `~/.app` which several worktrees' servers read at once, so this runs ONLY
// when the harness has isolated the data root via `CYTO_APP_DATA_DIR` — the same env the
// backend reads. A Playwright skip is reported, with its reason, in the run summary; it is
// never counted as passed.

const DROP_ID = 'e2e-runtime-dropin'
const ANALYSIS_ID = 'e2e-runtime-dropin.inspect'
const PACKAGES_PATH = '/api/processors/packages'

const DATA_ROOT = process.env.CYTO_APP_DATA_DIR

const MANIFEST = `id: ${DROP_ID}
name: E2E runtime drop-in
publisher: cyto-e2e
version: 0.0.1
apiVersion: "1.0"
contributes:
  analyses:
    - id: ${ANALYSIS_ID}
      category: inspect
      title: E2E runtime drop-in probe
`

const registeredAnalyses = () =>
  (
    window as unknown as { __workbenchRegistry: { analyses: () => string[] } }
  ).__workbenchRegistry.analyses()

test('a package dropped at runtime registers in a freshly-authenticated session (INV-3)', async ({
  page,
  browser,
}) => {
  test.skip(
    !DATA_ROOT,
    'needs CYTO_APP_DATA_DIR (an isolated server data root) — the drop writes the server folder',
  )
  const pkgDir = path.join(DATA_ROOT!, 'processors', DROP_ID)

  try {
    // ── setup, in a THROWAWAY session ───────────────────────────────────────────────────
    // Only to obtain an admin token (and run first-run setup on a fresh DB). The assertion
    // happens in a different, clean context below.
    const token = await loginAsOwner(page)

    // The precondition INV-3 is about: the shipped app knows nothing of this package — it
    // did not exist when the SPA was built, so no glob could have seen it.
    const baseline = await page.evaluate(registeredAnalyses)
    expect(baseline, 'the drop-in must not already be registered').not.toContain(ANALYSIS_ID)
    expect(
      baseline.length,
      'the baked baseline must be non-empty, or "not registered" is vacuous',
    ).toBeGreaterThan(0)

    // DROP it and make the server reflect the folder (the S7 reload endpoint that
    // `processors-admin.spec.ts` already drives).
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(path.join(pkgDir, 'manifest.yaml'), MANIFEST, 'utf8')

    const reload = await page.request.post('/api/processors/reload', {
      headers: { Authorization: `Bearer ${token}` },
      data: {},
    })
    expect(reload.ok(), `reload -> ${reload.status()} ${await reload.text()}`).toBeTruthy()
    const reloadBody = (await reload.json()) as {
      packages: { id: string; ok: boolean; error?: string | null }[]
    }
    const row = reloadBody.packages.find(p => p.id === DROP_ID)
    expect(
      row,
      `the server did not discover the drop-in: ${JSON.stringify(reloadBody.packages)}`,
    ).toBeTruthy()
    expect(row!.ok, `the drop-in failed server-side load: ${row!.error}`).toBe(true)

    // ── the actual claim, in a CLEAN unauthenticated context ────────────────────────────
    const ctx = await browser.newContext()
    try {
      const fresh = await ctx.newPage()
      const packagesResponse = fresh.waitForResponse(
        r => new URL(r.url()).pathname === PACKAGES_PATH,
        { timeout: 30_000 },
      )

      // Boots logged-out (no persisted token in this context), then logs in. NO RELOAD.
      await fresh.goto('/')
      await fresh
        .getByTestId('auth-login-username')
        .waitFor({ state: 'visible', timeout: 15_000 })
      await fresh.getByTestId('auth-login-username').fill(OWNER.username)
      await fresh.getByTestId('auth-login-password').fill(OWNER.password)
      await fresh.getByTestId('auth-login-submit').click()

      const resp = await packagesResponse
      expect(resp.status(), `${PACKAGES_PATH} -> ${resp.status()}`).toBe(200)
      const served = (await resp.json()) as { packages: { id: string }[] }
      expect(
        served.packages.map(p => p.id),
        'the endpoint must serve the dropped package',
      ).toContain(DROP_ID)

      // THE CLAIM: it reached the registry the app actually renders from — no FE rebuild,
      // no page reload, in the session that just authenticated.
      await expect
        .poll(() => fresh.evaluate(registeredAnalyses), {
          timeout: 15_000,
          message: 'the runtime-dropped analysis must reach workbenchRegistry',
        })
        .toContain(ANALYSIS_ID)
    } finally {
      await ctx.close()
    }
  } finally {
    rmSync(pkgDir, { recursive: true, force: true })
  }
})
