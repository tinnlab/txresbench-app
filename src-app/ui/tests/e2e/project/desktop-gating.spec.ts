import { expect, type Page, test } from '@playwright/test'
import { loginAsOwner, openDatasetsPane, openProjectCardMenu, projectCard } from './_helpers'

// TEST-32: platform gating. On WEB the owner sees Share/Transfer affordances; with
// `window.__TAURI__` present (isDesktop() true) they are ABSENT — while projects +
// datasets + the card still work (the module is NOT blocklisted).
//
// ── Rewritten onto the card ⋮ menu ─────────────────────────────────────────────────────
//
// This spec asserted `project-detail-share` / `-transfer` / `-name` / `-permission` /
// `-edit` on the project detail page. `a7c75ef1` made the full-bleed workbench the default
// and only project section, and the `fullBleed` early return renders no header — so those
// testids appear nowhere, for any platform.
//
// The web-vs-desktop gate itself is intact and now lives on the projects-list card ⋮ menu
// (`ProjectCard`), under the SAME `isOwner && web` / `transferEnabled` predicates the
// header used. So the assertions move there.
//
// The desktop case is the one that was rotting silently: its two `toHaveCount(0)` checks
// kept passing after the header vanished, so they no longer proved that `isDesktop()`
// hides anything — they would pass with the platform gate deleted. They now run against a
// menu that is asserted OPEN and asserted POPULATED (Open + Edit both present), so an
// absence is a real absence.

/** Create a project from the /projects grid and return its name (stays on /projects). */
async function makeProject(page: Page): Promise<string> {
  const name = `Gating Project ${Date.now()}-${Math.floor(performance.now())}`
  await page.getByTestId('projects-new-button').click()
  await page.getByTestId('project-name-input').fill(name)
  await page.getByTestId('project-form-submit').click()
  await expect(projectCard(page, name)).toBeVisible()
  return name
}

test('web: owner sees Share + Transfer', async ({ page }) => {
  await loginAsOwner(page)
  const name = await makeProject(page)
  await openProjectCardMenu(page, name)
  await expect(page.getByRole('menuitem', { name: /^share$/i })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /transfer/i })).toBeVisible()
})

// The preview app's port, as RESOLVED by `playwright.config.ts` for this run — which
// publishes it back into `E2E_APP_PORT` precisely so this spec has one number to read.
//
// This used to end `?? '4173'`, with a comment explaining that reading the env knob beat
// "a second literal". The reasoning was right and the code still carried the second
// literal: `E2E_APP_PORT` was an INPUT only, set when a human pinned, so the default fired
// on every ordinary run and merely happened to match the config's own default. The moment
// the port became per-worktree, this one spec navigated to :4173 and failed with
// ERR_CONNECTION_REFUSED while the other 154 in the tier were fine. No fallback now: an
// unset value means the config did not publish it, and guessing is what broke it.
const APP_PORT = process.env.E2E_APP_PORT
if (!APP_PORT) {
  throw new Error(
    'HARNESS FAULT — THIS IS THE TEST RIG, NOT YOUR CODE: E2E_APP_PORT is unset. ' +
      'playwright.config.ts publishes the preview port it resolved for this run; an unset value ' +
      'means this spec was loaded outside that config. Refusing to guess a port.',
  )
}

test.describe('desktop platform', () => {
  // Serve everything from 127.0.0.1 so getBaseUrl's `http://127.0.0.1:<port>`
  // (built when __TAURI__ is present) is SAME-origin as the page.
  test.use({ baseURL: `http://127.0.0.1:${APP_PORT}` })

  test('__TAURI__: Share + Transfer absent, projects still work', async ({ page }) => {
    await page.addInitScript((port: number) => {
      // Plain JS — this runs in the browser (no TS annotations). getBaseUrl →
      // http://127.0.0.1:<port> → the preview proxies /api to the backend.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__TAURI__ = {
        core: { invoke: async (cmd: string) => (cmd === 'get_server_port' ? port : undefined) },
      }
    }, Number(APP_PORT))
    await loginAsOwner(page)
    const name = await makeProject(page)

    // TEST-18: the scope layer runs identically single-tenant — the role badge renders and
    // the implicit single user is Owner. Asserted BEFORE the absences: it proves the card
    // itself rendered with real permission data.
    await expect(projectCard(page, name).getByTestId('project-permission-badge')).toHaveText(
      /owner/i,
    )

    await openProjectCardMenu(page, name) // asserts the menu is genuinely open ("Open")
    // Web-only affordances are gone on desktop…
    await expect(page.getByRole('menuitem', { name: /^share$/i })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: /transfer/i })).toHaveCount(0)
    // …while the OWNER-gated, platform-independent items are still there. This is the
    // control that makes the two absences above meaningful: the menu is populated from the
    // same `isOwner` scope, so "Share is missing" is the platform gate doing its job and
    // not an empty/unrendered menu. (Delete is owner-gated but NOT web-gated — it is the
    // sharpest control available here, since it survives exactly the gate Share does not.)
    await expect(page.getByRole('menuitem', { name: /^edit$/i })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /^delete$/i })).toBeVisible()
    await page.keyboard.press('Escape')

    // …and the project surface itself still works (the module is NOT blocklisted).
    await page.getByTestId('project-card-title').filter({ hasText: name }).click()
    await expect(page.getByTestId('project-detail-page')).toBeVisible()
    await expect(page.getByTestId('workbench-project-name')).toHaveText(name)
    await openDatasetsPane(page) // asserts `project-datasets-card` becomes visible
  })
})
