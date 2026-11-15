import { defineConfig, devices } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeDerivedConfig, assertFactsAgree } from './scripts/e2e-config-derive.mjs'
import { resolvedOnce } from './scripts/resolved-once.mjs'

// TxResBench demo-mode E2E (demo-mode ITEM-6, the plan's "browser tests in
// demo mode": the three paths from the landing page to the running page and
// results, no upload possible, the recorded-methods list, the run button
// label). The web model is the demo server's:
//
//   backend  — the SAME binary in DEMO mode (TXR_DEMO=1) with a minimal
//              VALID demo bundle (scripts/demo/write-demo-test-bundle.py,
//              written into this run's scratch dir before the boot — the
//              like of the Rust harness's bundle fixture), its own data dir
//              and a closed catalogue URL (the pretrained boot refresh must
//              never dial out);
//   app      — `vite preview` proxying `/api` → the demo backend.
//
// TEST ROUTING — a third disjoint testDir, sibling to `tests/e2e` and
// `tests/gallery-e2e` (the directory table + `check:e2e-routing` R1/R2).
//
// SERVER OWNERSHIP — the same rule as `playwright.config.ts`: bind-verify,
// prove the occupant with the `/__worktree` sentinel, never adopt a server
// this run did not start (`DEMO_E2E_REUSE=1` is the request). The demo
// backend leg proves itself the same way the desktop backend does.
const here = dirname(fileURLToPath(import.meta.url))
const serverDir = resolve(here, '../server')
const REPO = resolve(here, '../..')
// CARGO_TARGET_DIR is the worktree builds' shared cache on this box; the
// per-worktree default stays the documented fallback.
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR ?? resolve(here, '../../target')
const bin = resolve(CARGO_TARGET_DIR, 'debug/txresbench')
const RESOLVER = fileURLToPath(new URL('./scripts/resolve-harness-port.mjs', import.meta.url))

type Verdict = { port: number; reused: boolean; pinned: boolean }

const PORTS = resolvedOnce('demo_app_e2e', () =>
  JSON.parse(
    execFileSync('node', [RESOLVER, 'demoE2eBackend', 'demoE2ePreview'], { encoding: 'utf8' }).trim(),
  ),
) as { demoE2eBackend: Verdict; demoE2ePreview: Verdict }

const BACKEND_PORT = String(PORTS.demoE2eBackend.port)
const APP_PORT = String(PORTS.demoE2ePreview.port)
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`
const APP_URL = `http://localhost:${APP_PORT}`
const RUN_TAG = `${BACKEND_PORT}`
// The owner rule on the shared box: every build runs through ops/cap.sh with
// CAP_CPUS=4 (the tool sizes node/cargo pools to the cap). The command uses
// it when the ops path exists and falls back to a plain cargo build elsewhere.
const CAP = '/data/share/pbya/sigtrans/ops/cap.sh'
const CAP_PREFIX = fs.existsSync(CAP) ? `CAP_CPUS=4 ${CAP} ` : ''
const CARGO_TARGET_DIR_DIRECTIVE = process.env.CARGO_TARGET_DIR
  ? `CARGO_TARGET_DIR="${process.env.CARGO_TARGET_DIR}" `
  : ''

// Demo-mode specifics: the run-unique data dir, DB file and the recorded
// bundle. All under os.tmpdir() like the sibling config (TMPDIR relocates
// the whole family on a shared box).
const DEMO_DATA_DIR = process.env.DEMO_E2E_DATA_DIR ?? `${tmpdir()}/txr-e2e-demo-${RUN_TAG}`
const DEMO_DB_FILE = `${DEMO_DATA_DIR}/txresbench.db`
const DEMO_BUNDLE_DIR = `${tmpdir()}/txr-e2e-demo-${RUN_TAG}.bundle`
process.env.DEMO_E2E_BACKEND = BACKEND_URL
process.env.DEMO_E2E_BACKEND_PORT = BACKEND_PORT
process.env.DEMO_E2E_APP_PORT = APP_PORT

const DERIVED_CONFIG = writeDerivedConfig({
  basePath: resolve(serverDir, 'config/e2e.yaml'),
  outPath: `${tmpdir()}/txr-e2e-demo-${RUN_TAG}.yaml`,
  port: BACKEND_PORT,
  dbPath: DEMO_DB_FILE,
})
{ const yaml = fs.readFileSync(DERIVED_CONFIG, 'utf8')
  assertFactsAgree(yaml, { port: BACKEND_PORT, dbPath: DEMO_DB_FILE, path: DERIVED_CONFIG }) }

process.env.HARNESS_ORIGINS = JSON.stringify([
  { label: 'demo e2e backend (cargo, TXR_DEMO=1)', port: Number(BACKEND_PORT), url: `${BACKEND_URL}/__worktree` },
  { label: 'demo e2e app (vite preview)', port: Number(APP_PORT), url: APP_URL },
])

export default defineConfig({
  testDir: './tests/demo-e2e',
  timeout: 150_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  globalSetup: './scripts/harness-preflight.mjs',
  reporter: [['list']],
  use: {
    baseURL: APP_URL,
    testIdAttribute: 'data-testid',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 720 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Build the binary (the worktree's CARGO_TARGET_DIR when set), wipe
      // the run's DB, write the valid demo bundle, then boot the SAME
      // binary in DEMO mode on the resolved port with the derived config.
      command: `bash -c '${CARGO_TARGET_DIR_DIRECTIVE}${CAP_PREFIX}cargo build --bin txresbench && rm -f "${DEMO_DB_FILE}" "${DEMO_DB_FILE}-wal" "${DEMO_DB_FILE}-shm" && mkdir -p "${DEMO_DATA_DIR}" && python3 "${resolve(REPO, 'scripts/demo/write-demo-test-bundle.py')}" --assets "${resolve(REPO, 'data/file-validator/examples')}" --out "${DEMO_BUNDLE_DIR}" && TXR_APP_DATA_DIR="${DEMO_DATA_DIR}" TXR_DEMO_BUNDLE="${DEMO_BUNDLE_DIR}" TXR_CATALOGUE_URL="http://127.0.0.1:1" TXR_DEMO=1 CONFIG_FILE="${DERIVED_CONFIG}" "${bin}"'`,
      cwd: serverDir,
      url: `${BACKEND_URL}/__worktree`,
      timeout: 900_000,
      reuseExistingServer: PORTS.demoE2eBackend.reused,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // The UI build goes through the same cap as the cargo build (the
      // shared box's owner rule: every build via ops/cap.sh with
      // CAP_CPUS=4 — an uncapped vite build sizes its oxc/rayon workers to
      // the whole machine and starves under the neighbour load).
      command: `${CAP_PREFIX}bash -c 'npm run build && npm run preview -- --port ${APP_PORT} --strictPort'`,
      cwd: here,
      url: APP_URL,
      timeout: 900_000,
      reuseExistingServer: PORTS.demoE2ePreview.reused,
      env: { VITE_API_PROXY_TARGET: BACKEND_URL },
    },
  ],
})
