import { defineConfig, devices } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { needsBenchServer } from './tests/viz-e2e/_renderPerf.ts'
import { resolvedOnce } from './scripts/resolved-once.mjs'

// Dedicated e2e config for the `visualization` module. The viz surfaces are
// BACKEND-FREE (fixture-seeded), so — unlike the app e2e config that boots
// cargo + postgres — this runs ONLY the viz Showcase vite entry (on a per-worktree
// derived port; see the PORT block below) and
// drives it under headless software-WebGL (swiftshader), which is the module's
// blessed browser-verify harness (the same surface viz-gallery-verify.mjs uses).
//
// ROUTING — the whole partition is declared in `tests/ROUTING.json`; see the
// TEST ROUTING header in `playwright.config.ts`. Invoke with `just e2e-viz`
// (`npm run test:e2e:viz`).
//
// These specs used to live at `tests/e2e/visualization/`, NESTED INSIDE the full-backend
// config's `testDir: './tests/e2e'`, which carried no `testIgnore`. That config therefore
// collected all 63 of them — 95 of its 217 tests, 44% — and drove them at its own baseURL
// :4173, where `viz-showcase.html` does not exist; meanwhile NO justfile recipe or npm
// script invoked THIS config, so the only runner that can actually drive them was never
// run at all. They now live at `tests/viz-e2e/`, a SIBLING of `tests/gallery-e2e/` — the
// layout `playwright.gallery.config.ts` already documents as the reason a backend-free
// suite gets its own top-level dir. Directory == runner, checked by
// `npm run check:e2e-routing`.
//
// PORT — derived per worktree, bind-verified, and never reused without PROOF.
// This config used to pin :1421 / :1422 with `reuseExistingServer: !CI`, which is
// the same shared-mutable-resource bug `playwright.gallery.config.ts` documents
// (fixed there in 086d45a5, where the fixed gallery port produced 9,355
// ERR_NETWORK_CHANGED findings and a gate reporting a SIBLING worktree's console
// errors as 216 failures of this tree). Two worktrees running the viz tier raced
// for :1421 and the loser silently adopted the winner's server — i.e. audited the
// wrong @ziee/viz build while reporting on this one, which is exactly the failure
// the `reuseExistingServer` comment below says it prevents. `!CI` guards only the
// CI half; locally it is what makes the collision SILENT instead of loud.
//
// `scripts/resolve-viz-port.mjs` derives the base from the per-worktree run key,
// walks forward to a port that is either FREE (dual-stack-verified: 0.0.0.0 + ::1
// + 127.0.0.1) or answering a `/__worktree` sentinel that proves it is THIS
// worktree's server. Anything it cannot identify is skipped, never adopted — it
// fails CLOSED. `VIZ_E2E_PORT` / `VIZ_BENCH_PORT` pin a one-off (and a pin is now
// VERIFIED like any other port — it overrides the search, never the proof).
//
// AND THAT WAS STILL NOT ENOUGH, which is the reason for everything below it.
// `viz-full-2.log` (132 failed / 15 passed in 10.6 min, every failure
// `ERR_CONNECTION_REFUSED at :21000`) and `viz-full-3.log` (`:21400… is already
// used`) both ran with the derivation and the sentinel in place. :21000/:21400 are
// the two viz FLOORS exactly — the ports derived by the single worktree on this box
// whose key is ≡ 0 mod 200 — so both runs came from ONE tree: two agents running
// this tier concurrently in the SAME worktree.
//
// Against that, per-worktree derivation is not a partial fix, it is the mechanism:
// both runs derive the same number, the sentinel is asked "is this server this
// worktree's?" and truthfully says yes to both, and both adopt it. The sentinel
// proves WORKTREE identity while the shared thing is a SERVER PROCESS owned by
// exactly one run — Playwright kills only servers it started. The owner exited, and
// the adopter narrated the corpse for ten minutes.
//
// Three changes follow, and none of them is another port:
//   1. reuse is OPT-IN (`VIZ_REUSE_SERVER=1`). Occupied — even by this worktree —
//      means SKIP, so concurrent runs in one tree are disjoint by construction.
//   2. `reuseExistingServer` is the RESOLVER'S OWN verdict, not `!process.env.CI`.
//      Those were two independent decisions about one port and `viz-full-3` is what
//      it looks like when they disagree: a port valid only if reused, and a policy
//      refusing to reuse it.
//   3. a `globalSetup` PRE-FLIGHT and a mid-run watchdog re-take the proof, at t=0
//      and on the first connection-level failure. A proof taken once in a child
//      process at config-load time is a proof about the past; the corpse case is
//      created afterwards, by definition.
//
// Resolved in a child process because a Playwright config is loaded
// SYNCHRONOUSLY (its esbuild-CJS transform has no top-level await) while
// bind-probing and sentinel-fetching are inherently async.
const RESOLVER = fileURLToPath(new URL('./scripts/resolve-viz-port.mjs', import.meta.url))
type Verdict = { port: number; reused: boolean; pinned: boolean }
// `resolvedOnce` because Playwright loads this config once in the runner AND again in
// every worker. Re-resolving in a worker steps OVER the server the runner just
// booted — correctly, since it cannot tell that server from any other occupant — and
// leaves `use.baseURL` pointing one port past the live origin.
const resolvePort = (leg: 'dev' | 'bench'): Verdict =>
  resolvedOnce(
    `viz_${leg}`,
    () => JSON.parse(execFileSync('node', [RESOLVER, leg, '--json'], { encoding: 'utf8' }).trim()) as Verdict,
  )

const DEV = resolvePort('dev')
const VIZ_PORT = DEV.port
const VIZ_URL = `http://localhost:${VIZ_PORT}`
// The PROD BENCH origin for the render-perf MS leg (ITEM-19/ITEM-20). A millisecond measured on
// the dev server above is not comparable to anything — dev ships `jsxDEV`, runs StrictMode, and
// inflates typed-array prop diffs ~1000x — so the two render-perf legs are split across two
// origins and each REFUSES the other's metric (DEC-2, enforced in `tests/viz-e2e/_renderPerf.ts`).
// This is deliberately a SECOND PROJECT INSIDE THIS CONFIG rather than a fifth playwright config:
// `npm run check:e2e-routing` (R1/R4) requires every config to own a non-nested testDir AND to have
// its own npm script + justfile recipe, so a new config file would have to be wired into both. A
// project is the additive form (rule B3 / DEC-4).
// Resolved UNCONDITIONALLY, unlike the `needsBenchServer` gate on the webServer entry
// below. That gate exists to avoid a ~40s PRODUCTION BUILD, not to avoid a ~150ms port
// resolution — and making the port conditional too would leave the prod project's
// baseURL at `http://localhost:0` on every dev-only run: a live landmine for the next
// spec routed there, in a config whose whole history is specs quietly pointed at an
// origin that could not serve them.
const BENCH = resolvePort('bench')
const VIZ_BENCH_PORT = BENCH.port
const VIZ_BENCH_URL = `http://localhost:${VIZ_BENCH_PORT}`

// The origins the PRE-FLIGHT and the WATCHDOG assert, published to both. Only the
// origins this invocation will actually open are listed: asserting the bench origin
// on a dev-only run would fail the run over a server it was right not to boot.
//
// `process.env` is the channel because Playwright loads this config and then runs
// globalSetup + constructs reporters in the same process. `harness-preflight.mjs`
// treats an ABSENT value as a failure rather than a skip — a pre-flight that no-ops
// when disconnected would report "checked" forever while checking nothing.
const PREFLIGHT_ORIGINS = [
  { label: 'viz showcase (dev)', port: VIZ_PORT, url: `${VIZ_URL}/viz-showcase.html` },
  ...(needsBenchServer(process.argv, process.env)
    ? [{ label: 'viz bench (prod)', port: VIZ_BENCH_PORT, url: `${VIZ_BENCH_URL}/viz-showcase.html` }]
    : []),
]
process.env.HARNESS_ORIGINS = JSON.stringify(PREFLIGHT_ORIGINS)
/** The one spec that must run on the prod bench origin, and nowhere else. Named once so the
 *  include (prod project) and the exclude (dev project) can never drift apart. */
const MS_LEG_SPEC = /render-perf-ms\.spec\.ts/

export default defineConfig({
  testDir: './tests/viz-e2e',
  fullyParallel: false,
  workers: 1,
  // Software-WebGL (swiftshader) renders are slow, and heavy coordination specs render
  // several deck views per test; the 60s default didn't even cover fixture (context+page)
  // setup once several heavy specs had run back-to-back. A generous global timeout covers
  // fixture setup too (an in-body test.setTimeout does NOT). workers:1 keeps a hang bounded.
  timeout: 240_000,
  expect: { timeout: 15_000 },
  // The origins are proven ONCE, before any spec, and the run is refused in seconds
  // if the answer is no. 132 specs each independently reporting
  // `ERR_CONNECTION_REFUSED` is not 132 findings, it is one fact told 132 times —
  // and told in the shape of a catastrophic code regression.
  globalSetup: './scripts/harness-preflight.mjs',
  reporter: [['list'], ['./scripts/harness-watchdog-reporter.mjs']],
  use: {
    baseURL: VIZ_URL,
    trace: 'off',
    viewport: { width: 1280, height: 820 },
    launchOptions: {
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
      ],
    },
  },
  projects: [
    // The DEV / counter + behaviour project. Unchanged except for the one exclusion that keeps the
    // ms-leg spec off this origin — running it here would silently produce dev milliseconds.
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: MS_LEG_SPEC },
    // The PROD-BENCH / millisecond project. Same launch args, same viewport, same workers:1 and
    // same timeout as above (inherited from the top-level `use`), because the DEC-3 ratio is only
    // meaningful across identically-launched sessions — only the origin differs.
    {
      name: 'chromium-prod-ms',
      use: { ...devices['Desktop Chrome'], baseURL: VIZ_BENCH_URL },
      testMatch: MS_LEG_SPEC,
    },
  ],
  // SCOPED TO THE INVOCATIONS THAT CAN USE IT (FIX_ROUND-2 / A12). See `needsBenchServer`: the bench
  // entry was unconditional, so every dev-project run paid a cold production build for an origin it
  // never opened. `webServer` cannot be declared per-project, so the second entry is filtered here.
  webServer: [
    {
      // The viz Showcase was extracted into the standalone @ziee/viz package
      // (src-app/libs/viz), which now owns viz-showcase.html + its vite. Serve THAT
      // package's showcase (cwd here is src-app/ui → ../libs/viz).
      command: `npx vite --port ${VIZ_PORT} --strictPort`,
      cwd: '../libs/viz',
      url: `${VIZ_URL}/viz-showcase.html`,
      // THE RESOLVER'S OWN VERDICT, not `!process.env.CI`. `DEV.reused` is true only
      // when the resolver just proved a server of this worktree is on this port AND
      // reuse was explicitly requested (`VIZ_REUSE_SERVER=1`); by default it is false
      // and the port is one nothing was listening on, so Playwright boots ours.
      //
      // `!process.env.CI` was a SECOND decision about the same port, taken with none
      // of the resolver's information: under CI it turned a legitimately-reusable port
      // into the hard error in `viz-full-3.log`, and off CI it authorised adopting
      // ANYTHING that answered 200 here — the corpse in `viz-full-2.log` included.
      reuseExistingServer: DEV.reused,
      timeout: 120_000,
    },
    ...(needsBenchServer(process.argv, process.env) ? [{
      // The prod bench bundle. `serve-bench.mjs` content-hashes `src/** + viz-showcase.html + both
      // vite configs` and rebuilds ONLY when that hash moved, so a warm run costs a hash walk
      // instead of a ~40s production build. The hash is written to `dist-bench/.buildinfo` and
      // TEST-23 re-derives it from the working tree before measuring: a frozen artifact serving
      // last week's code would not FAIL a perf gate, it would report the OLD (good) numbers, which
      // is indistinguishable from "the fix worked".
      command: `node scripts/serve-bench.mjs --port ${VIZ_BENCH_PORT}`,
      cwd: '../libs/viz',
      url: `${VIZ_BENCH_URL}/viz-showcase.html`,
      reuseExistingServer: BENCH.reused,
      // The cold path is a full production build of the whole showcase.
      timeout: 300_000,
    }] : []),
  ],
})
