import { defineConfig, devices } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolvedOnce } from './scripts/resolved-once.mjs'

// dimension-primitives Phase-5 S5 — the general-primitives e2e config. The
// primitives are BACKEND-FREE: each gallery story mounts a primitive against a
// seeded fake host, and the non-single-cell image fixture is registered through
// the REAL FE datatype registry at gallery boot (`seedGalleryDatatypes()`). So —
// unlike the app e2e config that boots cargo + docker Postgres — this runs ONLY
// this worktree's gallery vite entry and drives the primitives through the DOM.
//
// It is a SEPARATE testDir (`tests/gallery-e2e`) so the full-backend
// `playwright.config.ts` (testDir `./tests/e2e`) never sweeps these fixture-only
// specs into a backend run.
//
// PORT: the comment above this line used to promise "a UNIQUE port … so a concurrent
// worktree's gallery on this box can't be silently reused and validate the wrong build"
// while the code pinned the fixed literal 1487 — unique only in the sense of "not 1420".
// Two worktrees running this config still collided, and `reuseExistingServer` then made
// the loser validate the winner's tree. The port is now derived from the per-worktree run
// key, so distinct worktrees get distinct ports by construction and
// `reuseExistingServer` can only ever pick up THIS worktree's server.
// `GALLERY_E2E_PORT=<n>` still pins it for a one-off.
//
// It searches from the `webE2eVite` floor, NOT `webGallery`: the visual config + the
// runtime-health gate already derive from `webGallery`, and using one floor for both
// would recreate the collision INSIDE a single worktree (gallery-e2e and gate:ui are
// routinely run back-to-back). Disjoint floors keep them disjoint by construction —
// which is exactly what the old `1420` vs `1487` pair was reaching for by hand.
// AND THE DERIVATION ALONE WAS NOT ENOUGH — this config had the WEAKEST form of it.
// `resolveGalleryPort` returns a search BASE, not a usable port: no bind probe, no
// `/__worktree` sentinel, and `reuseExistingServer: !process.env.CI` on top, so this
// tier would adopt anything answering 200 on that number. A base collides by the
// pigeonhole principle long before it is unlucky — ~150 worktrees over a 200-wide
// span, with five trees on this box deriving 21061 today.
//
// The viz tier, which DID bind-verify and DID check the sentinel, still lost three
// runs (`viz-full-2.log`: 132 failed in 10.6 min; `viz-full-3.log`: "already used").
// Both came from ONE worktree running the tier twice at once: same tree ⇒ same
// derived port ⇒ the sentinel truthfully says "yours" to both runs ⇒ both adopt one
// server ⇒ the run that owns it kills it on exit and the other narrates the corpse.
// The sentinel proves WORKTREE identity; a server's lifetime belongs to a RUN.
//
// So this config now shares the viz tier's whole answer, via one implementation:
//   * `resolve-harness-port.mjs` — bind-verified walk, sentinel-proved, and reuse is
//     OPT-IN (`GALLERY_REUSE_SERVER=1`), so an occupied port is skipped even when it
//     is this worktree's;
//   * `reuseExistingServer` is that resolver's verdict rather than `!process.env.CI`
//     — one decision instead of two that can contradict;
//   * a `globalSetup` pre-flight and a mid-run watchdog re-take the proof, because a
//     proof taken at config-load time says nothing about the corpse case, which is
//     created afterwards by definition.
const RESOLVER = fileURLToPath(new URL('./scripts/resolve-harness-port.mjs', import.meta.url))
// `resolvedOnce`: Playwright loads this config in the runner AND again in every
// worker, and a re-resolution would step over the server the runner just booted.
const VERDICT = resolvedOnce(
  'gallery_e2e',
  () => JSON.parse(execFileSync('node', [RESOLVER], { encoding: 'utf8' }).trim()),
) as { port: number; reused: boolean; pinned: boolean }
const GALLERY_PORT = VERDICT.port
const GALLERY_URL = `http://localhost:${GALLERY_PORT}`
const GALLERY_PAGE = `${GALLERY_URL}/gallery.html`

// Published for `globalSetup` + the watchdog reporter, both of which run in this
// process. An ABSENT value is a failure there, never a skip.
process.env.HARNESS_ORIGINS = JSON.stringify([
  { label: 'component gallery (e2e)', port: GALLERY_PORT, url: GALLERY_PAGE },
])

export default defineConfig({
  testDir: './tests/gallery-e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  globalSetup: './scripts/harness-preflight.mjs',
  reporter: [['list'], ['./scripts/harness-watchdog-reporter.mjs']],
  use: {
    baseURL: GALLERY_URL,
    testIdAttribute: 'data-testid',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 820 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Boot THIS worktree's standalone component gallery on a unique port
    // (backend-free), serving `/gallery.html`. Never reuse a foreign server —
    // on a shared multi-worktree box a stale gallery would validate the wrong build.
    command: `npx vite --port ${GALLERY_PORT} --strictPort`,
    url: GALLERY_PAGE,
    // The resolver's verdict — true only when it just proved a server of this
    // worktree is here AND `GALLERY_REUSE_SERVER=1` asked for adoption. Otherwise the
    // port is one nothing was listening on and Playwright boots ours.
    reuseExistingServer: VERDICT.reused,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
