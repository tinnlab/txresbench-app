import { test, expect } from '@playwright/test'
import { OWNER, loginAsOwner } from './_owner'

// CytoAnalyst's first E2E: the full production path through a REAL backend
// (embedded Postgres) + the REAL built SPA. Proves the app boots and the shell
// AppLayout (the @ziee/shell B-1 adoption) renders with NO console errors /
// uncaught exceptions — the runtime-health signal for the whole frontend.
//
// Robust to DB state: `loginAsOwner` runs first-run setup on a fresh DB and
// otherwise logs in with the same owner creds (so a re-run against a dirty
// backend still passes). That owner is the single `tests/e2e/_owner.ts` identity
// shared by every suite — smoke previously declared its OWN copy, which is half
// of how the directory ended up with two rival owners fighting over a
// once-per-database setup endpoint. CytoAnalyst has no home page yet, so the
// sidebar is asserted on a settings route (which renders via SettingsLayout →
// the shell AppLayout).

// Paths whose failed requests are EXPECTED in current CytoAnalyst: the sync
// client polls an unmounted /api/sync/subscribe (FE-9), and there's no favicon.
const BENIGN_REQUEST = /sync\/subscribe|\/api\/sync|favicon/i

test('app boots into the shell AppLayout, no runtime errors', async ({
  page,
}) => {
  // JS errors (uncaught exceptions + app-logged console.error, EXCLUDING the
  // URL-less "Failed to load resource" network messages) — must be zero.
  const jsErrors: string[] = []
  page.on('pageerror', e => jsErrors.push(e.message))
  page.on('console', m => {
    if (m.type() === 'error' && !/Failed to load resource/i.test(m.text()))
      jsErrors.push(m.text())
  })
  // Failed requests — allow the known-benign ones; fail on any server error or
  // unexpected 404 (ignore auth-flow 401/403).
  const badRequests: string[] = []
  page.on('response', r => {
    const s = r.status()
    const p = new URL(r.url()).pathname
    if ((s >= 500 || (s === 404 && !BENIGN_REQUEST.test(p))))
      badRequests.push(`${s} ${p}`)
  })

  // Ensure the owner exists (first-run setup on a fresh DB) and log in. Resolves
  // only once auth has actually SUCCEEDED — the persisted localStorage token is
  // the reliable signal, since CytoAnalyst has no home page to assert against and
  // `app-root` renders on the login page too.
  await loginAsOwner(page)

  // Navigate to a settings page — it renders via SettingsLayout → the shell
  // AppLayout. Assert BOTH the page content (SettingsLayout) AND the injected
  // LeftSidebar (the signed-in user's footer button) rendered — the runtime
  // proof the B-1 AppLayout adoption works end-to-end. (Content assertions, not
  // the `app-sidebar` testid, so this is robust to the desktop-panel vs
  // mobile-Sheet rendering of the sidebar.)
  await page.goto('/settings/general')
  await expect(
    page.getByRole('heading', { name: 'Settings' }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: OWNER.username }).first(),
  ).toBeVisible()

  expect(jsErrors, `JS errors:\n${jsErrors.join('\n')}`).toEqual([])
  expect(
    badRequests,
    `unexpected failed requests:\n${badRequests.join('\n')}`,
  ).toEqual([])
})
