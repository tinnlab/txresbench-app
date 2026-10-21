import { defineConfig, devices } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeDerivedConfig } from './scripts/e2e-config-derive.mjs'
import { resolvedOnce } from './scripts/resolved-once.mjs'
import { narrowedOut, narrowingBanner } from './scripts/tag-narrowing.mjs'

// CytoAnalyst E2E (Layer-B). CytoAnalyst's web model is TWO servers: the backend
// (external docker Postgres on :54321 — the embedded PG's subprocess is SIGKILLed
// as exit-144 in the process-killing harness) + `vite preview` proxying `/api` →
// the backend. Neither @ziee/test-e2e preset fits that exactly (the full-stack
// preset assumes a per-run Postgres DOCKER container; the desktop preset assumes
// a SINGLE webServer), so this is a native Playwright config that still reuses
// the package's i18n-safe selectors + testid attribute. Logged as an
// @ziee/test-e2e dogfooding gap in SDK_GAPS (an "embedded-PG two-server web"
// preset would remove this bespoke config).
//
// ── TEST ROUTING — four configs, four DISJOINT testDirs ──────────────────────────
//
//   playwright.config.ts          tests/e2e          backend + preview (ports DERIVED)
//   playwright.viz.config.ts      tests/viz-e2e      @ziee/viz showcase (derived)
//   playwright.gallery.config.ts  tests/gallery-e2e  gallery (derived)
//   playwright.visual.config.ts   tests/visual       gallery (derived, `npm run gate:ui`)
//
// Directory == runner. There is deliberately NO `testIgnore` anywhere: an exclusion
// pattern puts the routing sixty lines away from the spec, so the next directory added
// under `tests/e2e/` is swept in again by default. THIS config had no `testIgnore` and
// `tests/e2e/visualization/` sat NESTED inside `./tests/e2e`, so a default run collected
// 95 viz tests — 44% of its 217 — and drove them at the preview port, where the
// `viz-showcase.html` they `goto()` does not exist; meanwhile nothing in the repo invoked
// the only config that CAN drive them, nor the gallery or visual ones. Those specs are now
// `tests/viz-e2e/`, a sibling of the `tests/gallery-e2e/` layout
// `playwright.gallery.config.ts` had already written down as the convention.
//
// Enforced, not remembered: `npm run check:e2e-routing` (inside `just check`) fails on
// a nested testDir, a spec owned by zero or two configs, an empty testDir, or a config
// with no npm script + just recipe. `just e2e-all` runs all four; `just e2e-inventory`
// prints what each one really collects, including the files that collect NOTHING.
//
// ── SERVER OWNERSHIP — why the fixed :3155/:4173 are gone ────────────────────────
//
// `ab51cabc` established the rule for six backend-free tiers and reported THIS one as
// still exposed. It carried three defects, and the first is the worst kind, because it
// needs no bad luck at all:
//
//   1. FIXED PORT LITERALS. `3155`/`4173` are the same numbers in every worktree and
//      every run, so two runs collide BY CONSTRUCTION — a derived port collides only
//      when a hash happens to agree. Worse, the DATABASE name was fixed too, so the
//      loser's `DROP DATABASE … WITH (FORCE)` landed on the winner's live run.
//   2. NO SENTINEL WAS POSSIBLE. The backend-free tiers ask a vite server
//      `/__worktree` and refuse anything that cannot prove it is this tree. The cargo
//      backend exposed no such endpoint, so "is this server mine?" was not merely
//      unanswered here — it was UNASKABLE. `server/src/harness_sentinel.rs` is the
//      answer: `GET /__worktree`, `#[cfg(debug_assertions)]`, serving the worktree
//      root this binary was COMPILED from.
//   3. `E2E_REUSE` WAS A NO-OP. `!process.env.CI || !!process.env.E2E_REUSE` is
//      unconditionally true off CI, so the documented knob controlled nothing —
//      including `E2E_REUSE=0`, which plainly asks to disable the thing it enabled.
//      A knob that appears to control something and controls nothing is worse than no
//      knob, because it gets set and believed.
//
// All three are now one rule, shared with the other tiers via
// `scripts/resolve-harness-port.mjs`: bind-verify the port, prove the occupant with the
// sentinel, and NEVER adopt a server this run did not start unless adoption was
// explicitly asked for. `E2E_REUSE=1` (or the repo-wide `HARNESS_REUSE_SERVER=1`) is
// that request, and it is now real: it is the ONE input to `reuseExistingServer`, so
// there is no second opinion left to contradict it.
//
// ── ONE SOURCE FOR THE PORT/DB FACTS ─────────────────────────────────────────────
//
// The previous config CROSS-CHECKED four sources for two facts (the committed YAML's
// `server.port` + `postgresql.database`, `E2E_DB`, `E2E_BACKEND`, `E2E_BACKEND_PORT`)
// and threw when they diverged. That check was correct and it is why this rewrite is
// not simply "derive the ports": the moment a port is derived, a COMMITTED yaml can
// never match it, so the check would fail every run. The answer is to remove the
// divergence rather than police it — the resolved ports are DERIVED into a per-run
// config file and into `E2E_BACKEND`, so the four sources become one and agreement is
// structural. The old check survives as a POST-CONDITION on the file we just wrote
// (`assertDerivedConfigAgrees`), which is a real assertion about the artifact the
// backend will actually boot with, not a hope that four inputs were typed alike.

const here = dirname(fileURLToPath(import.meta.url))
const serverDir = resolve(here, '../server')
const bin = resolve(here, '../../target/debug/cytoanalyst')
const RESOLVER = fileURLToPath(new URL('./scripts/resolve-harness-port.mjs', import.meta.url))

type Verdict = { port: number; reused: boolean; pinned: boolean }

// ONE resolution per RUN, carried into every worker through `process.env`.
// `resolved-once.mjs` documents why: Playwright re-loads this config in every worker
// process, and a worker that re-resolved would correctly step OVER the server the
// runner had just booted and hand its specs a port nothing is listening on. That
// exact defect was observed live on the viz tier — the pre-flight reporting :21133
// healthy while every spec navigated to :21134 — and this config has the same
// exposure squared, because a divergent port here would also change the derived
// DATABASE NAME and the derived config file.
const PORTS = resolvedOnce('app_e2e', () =>
  JSON.parse(
    execFileSync('node', [RESOLVER, 'appE2eBackend', 'appE2ePreview'], { encoding: 'utf8' }).trim(),
  ),
) as { appE2eBackend: Verdict; appE2ePreview: Verdict }

const BACKEND_PORT = String(PORTS.appE2eBackend.port)
const APP_PORT = String(PORTS.appE2ePreview.port)
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`
const APP_URL = `http://localhost:${APP_PORT}`

// The RUN DISCRIMINATOR is the resolved backend port. It is unique across concurrent
// runs by construction — the resolver bind-verified it and steps over anything
// occupied — so keying the database and the app-data dir off it makes two runs in ONE
// worktree non-destructive, which a per-worktree key alone can never do. That was the
// whole lesson of the incident this mechanism came from.
const RUN_TAG = `${BACKEND_PORT}`
/** Overridable, but DERIVED by default — the committed `cytoanalyst_e2e` was shared by
 *  every worktree and every run, and this suite DROPs it with `(FORCE)`. */
const E2E_DB = process.env.E2E_DB ?? `cytoanalyst_e2e_${RUN_TAG}`
/** The BASE config the per-run file is derived FROM (not the file the backend boots). */
const E2E_BASE_CONFIG = process.env.E2E_CONFIG_FILE ?? 'config/e2e.yaml'
/** The e2e backend's app-data dir — ISOLATED from the developer's. See the note on `command`
 *  below: sharing it let the workstore GC delete real user data. */
const E2E_DATA_DIR = process.env.CYTO_APP_DATA_DIR ?? `${tmpdir()}/cyto-e2e-data-${E2E_DB}`
// …and the TEST process must see the same value the server is given. It is passed to the
// backend inline on `command` below, which puts it in that child's environment and nowhere
// else — so a spec reading `process.env.CYTO_APP_DATA_DIR` saw nothing, and
// `manifest-ui-separation.spec.ts` (which DROPS a fixture processor into the server's folder,
// so it genuinely needs the path) skipped its three tests silently. A skip reads as a pass in
// every summary, which is how three real tests sat un-run.
process.env.CYTO_APP_DATA_DIR = E2E_DATA_DIR

// `E2E_BACKEND` is what the spec helpers (`tests/e2e/_owner.ts`) hit directly. It is
// DERIVED here rather than cross-checked, so a run can no longer seed one server while
// the harness boots another. A pre-set value that disagrees is still a hard failure:
// honouring it silently is exactly the split this removes.
if (process.env.E2E_BACKEND) {
  const port = new URL(process.env.E2E_BACKEND).port || '80'
  if (port !== BACKEND_PORT)
    throw new Error(
      `e2e config mismatch: E2E_BACKEND=${process.env.E2E_BACKEND} (port ${port}) but this run ` +
        `resolved the backend to :${BACKEND_PORT}. The specs would seed one server while the ` +
        `harness boots another. Unset E2E_BACKEND (it is derived), or pin with ` +
        `E2E_BACKEND_PORT=${port}.`,
    )
} else {
  process.env.E2E_BACKEND = `http://127.0.0.1:${BACKEND_PORT}`
}

// The two PIN variables are ALSO published with the resolved values, so a spec that needs
// a port reads the one this run actually used instead of carrying its own default.
//
// `desktop-gating.spec.ts` is why. It builds a `127.0.0.1:<port>` baseURL and reasoned, in
// a comment, that reading `E2E_APP_PORT` was safer than "a second literal … the two
// literals diverge the moment a run is isolated onto private ports". Correct — but
// `E2E_APP_PORT` was only ever an INPUT, set when a human pinned, so its `?? '4173'`
// default was a second literal wearing the first one's clothes. It agreed with the config
// only while the config also defaulted to 4173. The moment the port was derived, that spec
// navigated to :4173 and got ERR_CONNECTION_REFUSED while the other 154 were fine.
// Publishing the resolved values makes the knob an OUTPUT too, so there is one number.
process.env.E2E_BACKEND_PORT = BACKEND_PORT
process.env.E2E_APP_PORT = APP_PORT

// ── the per-run backend config file ──────────────────────────────────────────────
//
// Derived, written atomically and READ BACK (`scripts/e2e-config-derive.mjs`, which
// carries the reasoning + the unit tests). The read-back is the post-condition that
// replaced the four-source cross-check.
const DERIVED_CONFIG = writeDerivedConfig({
  basePath: resolve(serverDir, E2E_BASE_CONFIG),
  outPath: `${tmpdir()}/cyto-e2e-${E2E_DB}.yaml`,
  port: BACKEND_PORT,
  database: E2E_DB,
})

// The origins the pre-flight + the mid-run watchdog assert. BOTH legs are listed: the
// preview leg answers `/__worktree` through `gallerySentinelPlugin()` (vite.config.ts,
// `configurePreviewServer`), the backend leg through `harness_sentinel.rs`. An absent
// value is a failure in `harness-preflight.mjs`, never a skip.
process.env.HARNESS_ORIGINS = JSON.stringify([
  { label: 'e2e backend (cargo)', port: Number(BACKEND_PORT), url: `${BACKEND_URL}/api/app/setup/status` },
  { label: 'e2e app (vite preview)', port: Number(APP_PORT), url: APP_URL },
])

// HOST-CAPABILITY GATE — by TAG, in the CONFIG (the Playwright analogue of
// `#[cfg(target_os = ...)]`).
//
// Tests that commit a GENUINE `cell.filter` sandbox run need a sandbox-executable host
// (bwrap + a staged analysis rootfs). They carry `@acceptance` in their title, are
// excluded from a DEFAULT run by the `grepInvert` below, and are positively selected by
// `just verify-acceptance` (`CYTO_E2E_REAL_COMPUTE=1` + `--grep @acceptance`).
//
// ── R3-114: two earlier levers, and why each was wrong ────────────────────────────
//
// 1. A file-level `testIgnore` came first. It was chosen to avoid an in-body conditional
//    skip that "reports ok while executing nothing" — correct reasoning for Rust's
//    libtest (an `eprintln! + return` prints `ok`), but NOT for Playwright, whose
//    conditional skip is reported as SKIPPED, with its reason, in the run summary and is
//    never counted as passed. `testIgnore` is the one that hides: it removes the spec
//    from COLLECTION, so its absence is invisible in the output. Worker E measured the
//    consequence — **224 tests collected by default vs 241 with
//    `CYTO_E2E_REAL_COMPUTE=1`** — and nothing in the repo set the flag, so
//    `filter-save-records-recipe.spec.ts` (TEST-26, the plan's own `[acceptance][INV-8]`
//    spec and the ONLY test exercising the frontend save path) had never run in any gate
//    while 224 green looked exactly like 241 green.
// 2. Round 4 moved the gate INTO the spec body as a conditional skip. Strictly more
//    honest than (1) — the file is always collected and a capability-less host says so —
//    but the ACCEPTANCE host could still self-exempt, and the condition sat in the spec
//    where a reader of the invocation could not see it.
//
// Round 6 moved it to the tag. The exclusion now lives in the invocation surface, in ONE
// greppable place; on the acceptance host the test cannot opt out at all — it must PASS;
// and "selected nothing" cannot read as green either, because `just verify-acceptance`
// parses its JUnit report FAIL-CLOSED and hard-fails on `tests == 0`. That coupling is
// what makes a tag safe here where a bare grep filter would not be.
const REAL_COMPUTE = !!process.env.CYTO_E2E_REAL_COMPUTE
// WHAT THIS RUN LEFT OUT — derived, never remembered. This block used to carry
// `REAL_COMPUTE_SPECS`, a hand-written array naming ONE spec file; by the time anyone
// re-read it, FIVE spec files carried `@acceptance`, so the banner disclosed a fifth of
// the exclusion and no count at all — a disclosure that reads as complete while being
// stale is worse than none. `narrowedOut()` scans the specs on disk, so adding a tagged
// test anywhere updates this banner with no edit here (`scripts/tag-narrowing.mjs`), and
// `scripts/check-test-scope-lists.mjs` fails the build if a hand-list comes back.
if (!REAL_COMPUTE) {
  console.warn(narrowingBanner(narrowedOut({ testDir: './tests/e2e' })))
}

console.warn(
  `[playwright] e2e origins — backend :${BACKEND_PORT}` +
    `${PORTS.appE2eBackend.pinned ? ' (pinned)' : ''}${PORTS.appE2eBackend.reused ? ' REUSED' : ''}` +
    `, app :${APP_PORT}${PORTS.appE2ePreview.pinned ? ' (pinned)' : ''}` +
    `${PORTS.appE2ePreview.reused ? ' REUSED' : ''}; db ${E2E_DB}; config ${DERIVED_CONFIG}`,
)

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  // The HOST-CAPABILITY EXCLUSION itself (see the block above). Must be dropped under
  // CYTO_E2E_REAL_COMPUTE rather than left on: a config-level `grepInvert` is ANDed with a
  // CLI `--grep` (runner applies the project filter independently of the CLI one), so
  // leaving it in place would make `verify-acceptance`'s `--grep @acceptance` select ZERO
  // tests — which that recipe's fail-closed JUnit parser now treats as a hard FAIL.
  grepInvert: REAL_COMPUTE ? undefined : /@acceptance/,
  // Proof re-taken before the first spec. Playwright starts `webServer` entries BEFORE
  // `globalSetup`, so by the time this runs both origins either exist and identify
  // themselves as this worktree, or the run is refused in seconds with a banner naming
  // the cause — instead of N specs each re-reporting one dead fact.
  globalSetup: './scripts/harness-preflight.mjs',
  // `PLAYWRIGHT_JUNIT=<path>` adds a junit reporter so a gate can COUNT skipped/failed
  // mechanically instead of eyeballing the list output (the e2e analogue of the Rust
  // skip ledger). Off by default — local runs keep the plain list. The WATCHDOG is in
  // both branches: a reporter that is present only in the default configuration is a
  // guard that switches itself off under the gate that needs it most.
  reporter: process.env.PLAYWRIGHT_JUNIT
    ? [['list'], ['junit', { outputFile: process.env.PLAYWRIGHT_JUNIT }], ['./scripts/harness-watchdog-reporter.mjs']]
    : [['list'], ['./scripts/harness-watchdog-reporter.mjs']],
  use: {
    baseURL: APP_URL,
    testIdAttribute: 'data-testid',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 720 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Build the binary, DROP+CREATE the external e2e DB on :54321 (fresh DB →
      // repeatable first-run setup; the backend migrates it on boot), then boot
      // the backend on the RESOLVED port with the DERIVED config. External docker PG
      // (not embedded) so the process-killing harness can't SIGKILL a PG subprocess
      // (the exit-144 friction). `CYTO_APP_DATA_DIR` is LOAD-BEARING, and its absence
      // destroyed real data.
      //
      // The e2e backend gets its own DATABASE (dropped + recreated above) but used to inherit
      // the default app-data dir — the same `~/.app/workstore` a developer's running dev server
      // uses. The workstore GC's keep-set comes from `all_blob_refs()`, i.e. from WHATEVER
      // DATABASE IT IS CONNECTED TO. So every e2e boot swept the shared store against an empty
      // catalog, decided every blob belonging to the developer's own projects was orphaned, and
      // freed it (observed: `reclaimed orphaned blobs freed=247`). The catalog rows survived, so
      // the damage surfaced later as "its stored bytes are MISSING from the object store" on a
      // project that had been fine.
      //
      // The 1-hour grace in the sweep does not save you: it protects blobs younger than the
      // window, and a developer's data is older than that by definition.
      //
      // Per RUN, not a fixed path — and now genuinely per-run, because the name is keyed on
      // the RESOLVED port rather than on a literal every worktree shared.
      command: `bash -c 'cargo build --bin cytoanalyst && PGPASSWORD=password psql -h 127.0.0.1 -p 54321 -U postgres -c "DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)" -c "CREATE DATABASE ${E2E_DB}" && CYTO_APP_DATA_DIR="${E2E_DATA_DIR}" CONFIG_FILE="${DERIVED_CONFIG}" "${bin}"'`,
      cwd: serverDir,
      url: `${BACKEND_URL}/api/app/setup/status`,
      timeout: 180_000,
      // The RESOLVER'S OWN VERDICT — true only when it just proved a backend of this
      // worktree holds this port AND `E2E_REUSE=1` (or `HARNESS_REUSE_SERVER=1`) asked
      // for adoption. One decision, so there is no second one left to contradict it;
      // the old `!CI || E2E_REUSE` was unconditionally true off CI and made the knob a
      // no-op. Default false ⇒ the port is one nothing was listening on and Playwright
      // boots ours, which is also what guarantees the fresh build + DB reset actually
      // happen.
      reuseExistingServer: PORTS.appE2eBackend.reused,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Build the SPA + serve it via preview; the preview proxy forwards /api to
      // the backend above (VITE_API_PROXY_TARGET).
      command: `npm run build && npm run preview -- --port ${APP_PORT} --strictPort`,
      cwd: here,
      url: APP_URL,
      timeout: 180_000,
      reuseExistingServer: PORTS.appE2ePreview.reused,
      // VITE_ENABLE_TEST_SEAMS: expose the read-only workstore data-plane test seams
      // (`window.__cyto_read`/`__cyto_ds`) in THIS preview build so the e2e can drive the
      // real catalog→select flow; a real release build never sets it (→ seam absent).
      env: { VITE_API_PROXY_TARGET: BACKEND_URL, VITE_ENABLE_TEST_SEAMS: '1' },
    },
  ],
})
