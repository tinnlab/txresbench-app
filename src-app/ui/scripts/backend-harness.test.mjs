/**
 * OWNERSHIP TESTS for the FULL-BACKEND Playwright tier (`playwright.config.ts`).
 *
 * `ab51cabc` fixed six backend-free tiers and reported this one as still exposed, for
 * three reasons. Each has a test here, and each test was RED before the change:
 *
 *   1. fixed port literals `3155`/`4173` — two runs collide BY CONSTRUCTION, and the
 *      fixed DATABASE name meant the loser's `DROP DATABASE … (FORCE)` landed on the
 *      winner's live run;
 *   2. no backend sentinel existed, so "is this server mine?" was UNASKABLE;
 *   3. `!process.env.CI || !!process.env.E2E_REUSE` is unconditionally true off CI, so
 *      the documented knob controlled nothing — including `E2E_REUSE=0`.
 *
 * The three behaviours the mechanism has to demonstrate — refuse a FOREIGN server,
 * step over a SAME-WORKTREE OTHER-RUN server, and stay consistent ACROSS PROCESSES —
 * are the last three suites. The cross-process one is the important one: it is where
 * `ab51cabc`'s own mutation survived, because Playwright re-loads a config in every
 * worker and a per-process resolution silently disagrees with the runner's.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  assertFactsAgree,
  deriveConfig,
  patchBlock,
  readFacts,
  setField,
} from './e2e-config-derive.mjs'
import { PORT_FLOORS, resolveWorktreeRoot } from '@txresbench/gallery/scripts/lib/run-key.mjs'

import { reuseRequested } from './harness-origin.mjs'
import {
  APP_E2E_BACKEND_BAND,
  APP_E2E_PREVIEW_BAND,
  BANDS,
  GALLERY_E2E_BAND,
  resolveBands,
  resolveHarnessPort,
} from './resolve-harness-port.mjs'

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OURS = '/fixture/worktree/ours'
const THEIRS = '/fixture/worktree/theirs'

/** A server that answers `/__worktree` with `root` (null ⇒ 404, i.e. unidentified). */
async function sentinelServer(root, t) {
  const srv = createServer((req, res) => {
    if (req.url?.startsWith('/__worktree') && root) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ worktreeRoot: root, pid: process.pid }))
      return
    }
    res.writeHead(root ? 404 : 200)
    res.end('ok')
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const { port } = srv.address()
  t.after(() => new Promise(r => srv.close(r)))
  return port
}

/**
 * Hold a port with a bare TCP listener that ACCEPTS and never answers.
 *
 * The sockets are tracked and destroyed on teardown. Without that the file hangs
 * forever: `net.Server#close` stops accepting but leaves established connections
 * open, and the probe deliberately leaves one open (it aborts a request this server
 * never answers), so `close()`'s callback never fires. Observed exactly that — the
 * suite ran to this test and then sat until the outer timeout with `Promise
 * resolution is still pending but the event loop has already resolved`.
 */
async function holdPort(port, t) {
  const sockets = new Set()
  const srv = createNetServer(s => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise((res, rej) => {
    srv.once('error', rej)
    srv.listen(port, '0.0.0.0', res)
  })
  t.after(async () => {
    for (const s of sockets) s.destroy()
    await new Promise(r => srv.close(r))
  })
  return srv
}

/**
 * Start `harness-fixture-sentinel.mjs` on `port`, answering as `root`, and wait until it
 * is actually listening. Separate process — see that file for why an in-process one is
 * useless here.
 */
function startFixtureSentinel(port, root, t) {
  const child = spawn(
    process.execPath,
    [path.join(UI, 'scripts', 'harness-fixture-sentinel.mjs'), String(port), root],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  t.after(() => {
    child.kill('SIGKILL')
  })
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('fixture sentinel never reported ready')), 10_000)
    child.stdout.on('data', d => {
      if (String(d).includes('ready')) {
        clearTimeout(timer)
        res(child)
      }
    })
    child.once('error', rej)
  })
}

// ── DEFECT 3: E2E_REUSE is real, not decorative ──────────────────────────────────

test('E2E_REUSE controls reuse, and E2E_REUSE=0 disables it', () => {
  // The old expression, for contrast — TRUE for every value off CI, which is what
  // made the knob a lie.
  const old = env => !env.CI || !!env.E2E_REUSE
  assert.equal(old({ E2E_REUSE: '0' }), true, 'the OLD line enabled reuse even at =0')

  assert.equal(reuseRequested({}, 'E2E_REUSE'), false, 'default is NOT reuse')
  assert.equal(reuseRequested({ E2E_REUSE: '1' }, 'E2E_REUSE'), true)
  assert.equal(reuseRequested({ E2E_REUSE: '0' }, 'E2E_REUSE'), false, '=0 must disable')
  assert.equal(reuseRequested({ E2E_REUSE: 'yes' }, 'E2E_REUSE'), false, 'strict "1" only')
  // The repo-wide opt-in reaches this tier too, so one variable can enable them all.
  assert.equal(reuseRequested({ HARNESS_REUSE_SERVER: '1' }, 'E2E_REUSE'), true)
  // And CI is no longer an input at all: reuse is a request, not a side effect of
  // which machine you are on.
  assert.equal(reuseRequested({ CI: '1' }, 'E2E_REUSE'), false)
})

test('both app-e2e legs name E2E_REUSE as their opt-in', () => {
  assert.equal(APP_E2E_BACKEND_BAND.reuseEnv, 'E2E_REUSE')
  assert.equal(APP_E2E_PREVIEW_BAND.reuseEnv, 'E2E_REUSE')
})

// ── DEFECT 1: the ports are derived, and the bands cannot collide ────────────────

const overlaps = (a, b) => a.floor < b.floor + b.span && b.floor < a.floor + a.span

test('the e2e bands occupy disjoint port ranges — each other AND every PORT_FLOORS entry', () => {
  // `just e2e-all` runs these tiers back to back in ONE tree. A shared floor would
  // recreate the collision INSIDE a single worktree, which is the exact failure the
  // whole mechanism exists for.
  const bands = [GALLERY_E2E_BAND, APP_E2E_BACKEND_BAND, APP_E2E_PREVIEW_BAND]
  for (const a of bands) {
    for (const b of bands) {
      if (a === b) continue
      assert.equal(overlaps(a, b), false, `${a.label} overlaps ${b.label}`)
    }
  }
  // …and, for the two bands THIS change chose, against the SDK's reservation table.
  // This assertion earned its keep on the first run: the obvious floor for a backend
  // leg is `PORT_FLOORS.webE2eBackend` (9100), and 9100 sits INSIDE `webE2eVite`
  // (9000 + 200) — which `galleryE2e` derives from. The "reserved" floor would have
  // put this tier's backend inside the gallery tier's span.
  for (const band of [APP_E2E_BACKEND_BAND, APP_E2E_PREVIEW_BAND]) {
    for (const [name, res] of Object.entries(PORT_FLOORS)) {
      assert.equal(
        overlaps(band, res),
        false,
        `${band.label} (${band.floor}+${band.span}) overlaps PORT_FLOORS.${name} (${res.floor}+${res.span})`,
      )
    }
  }
})

test('the ONE pre-existing PORT_FLOORS overlap is exactly webE2eVite ∩ webE2eBackend', () => {
  // `galleryE2e` is deliberately IDENTICAL to `webE2eVite`, and `webE2eVite` overlaps
  // `webE2eBackend` inside the SDK's own table. That is pre-existing and not this
  // change's to fix (the table lives in the `sdk/` submodule), but it is exactly the
  // trap that sent this change at 9100 in the first place — so it is PINNED rather
  // than quietly excluded. A NEW overlap appearing in that table fails here.
  const pairs = []
  const entries = Object.entries(PORT_FLOORS)
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (overlaps(entries[i][1], entries[j][1])) pairs.push(`${entries[i][0]}∩${entries[j][0]}`)
    }
  }
  assert.deepEqual(pairs, ['webE2eVite∩webE2eBackend'], `PORT_FLOORS overlaps changed: ${pairs}`)
})

test('no two legs share a pin variable', () => {
  // Sharing one would make pinning either leg move both.
  const pins = [GALLERY_E2E_BAND, APP_E2E_BACKEND_BAND, APP_E2E_PREVIEW_BAND].map(b => b.envVar)
  assert.equal(new Set(pins).size, pins.length, `duplicate pin env vars: ${pins}`)
})

test('an unknown band fails closed rather than resolving nothing', async () => {
  await assert.rejects(() => resolveBands(['appE2eBackend', 'typo']), /unknown harness band 'typo'/)
  assert.ok(BANDS.appE2eBackend && BANDS.appE2ePreview && BANDS.galleryE2e)
})

// ── the derived per-run backend config ───────────────────────────────────────────

const BASE_YAML = `database:
  path: null
server:
  host: "127.0.0.1"
  port: 3155
  api_prefix: "/api"
logging:
  level: "warn"
`

test('derivation rewrites server.port + database.path and NOTHING else', () => {
  const dbPath = '/tmp/txr-e2e-9251.sqlite'
  const out = deriveConfig(BASE_YAML, { port: 9251, dbPath })
  const f = readFacts(out)
  assert.equal(f.serverPort, '9251')
  assert.equal(f.dbPath, dbPath)
  // The interesting one: a stale `postgresql:` block must NOT have survived into
  // the derived config — the backend on this node boots the SQLite store, and
  // resetting via psql would be the mis-aimed patch the post-condition exists to
  // catch (a whole-file replace would repoint the DATABASE at the harness port
  // while `server.port` still read correctly and every other check still passed).
  assert.equal(f.hasPostgres, false, 'no postgresql block may remain')
  // Exactly two lines differ from the base.
  const changed = out
    .split('\n')
    .filter((l, i) => l !== BASE_YAML.split('\n')[i])
  assert.equal(changed.length, 2, `expected 2 changed lines, got ${changed.length}: ${changed}`)
})

test('a field that appears zero or twice in a block is refused, not guessed', () => {
  assert.throws(() => setField('  host: x\n', 'port', '1'), /found 0/)
  assert.throws(() => setField('  port: 1\n  port: 2\n', 'port', '9'), /found 2/)
})

test('a missing block is refused rather than silently no-op', () => {
  assert.throws(() => patchBlock(BASE_YAML, 'nosuch', b => b), /no top-level 'nosuch:' block/)
})

test('the read-back post-condition catches a patch that landed in the wrong block', () => {
  // Simulate an UN-scoped `path:` replace — the realistic mis-aim, and the dangerous
  // one, because `server.port` still reads correctly afterwards so every other check
  // in the config passes while the backend boots the abandoned Postgres path.
  const wrong = deriveConfig(BASE_YAML, { port: 9251, dbPath: '/tmp/db.sqlite' }).replace(
    '  port: 3155',
    '  port: 9251\npostgresql:\n  use_embedded: false',
  )
  assert.equal(readFacts(wrong).serverPort, '9251', 'the decoy half must look correct')
  assert.throws(
    () => assertFactsAgree(wrong, { port: 9251, dbPath: '/tmp/db.sqlite' }),
    /a postgresql block is still present/,
  )
  // And it catches a port that simply was not applied.
  assert.throws(
    () => assertFactsAgree(BASE_YAML, { port: 9251, dbPath: '/tmp/db.sqlite' }),
    /server\.port 3155 ≠ resolved 9251/,
  )
})

// ── DEMONSTRATION 1: a FOREIGN server on the expected port is refused ────────────

test('a FOREIGN server is refused, by name, in seconds', async t => {
  const port = await sentinelServer(THEIRS, t)
  // Pinned onto the occupied port — the case a human hits when they isolate a run by
  // hand on a busy box, i.e. exactly when a stranger on that port is most likely.
  await assert.rejects(
    () =>
      resolveHarnessPort({
        ...APP_E2E_BACKEND_BAND,
        env: { E2E_BACKEND_PORT: String(port) },
        ownRoot: OURS,
      }),
    e => {
      assert.match(e.message, /cannot prove it belongs to \/fixture\/worktree\/ours/)
      assert.match(e.message, /it reports \/fixture\/worktree\/theirs/)
      return true
    },
  )
  // And unpinned: the search STEPS OVER it rather than adopting it, even with reuse on.
  const v = await resolveHarnessPort({
    ...APP_E2E_BACKEND_BAND,
    env: {},
    start: port,
    ownRoot: OURS,
    allowReuse: true,
  })
  assert.notEqual(v.port, port, 'a foreign server must never be adopted')
  assert.equal(v.reused, false)
})

test('a server that will not identify itself is refused too', async t => {
  const port = await sentinelServer(null, t) // answers 200, no sentinel
  await assert.rejects(
    () =>
      resolveHarnessPort({
        ...APP_E2E_BACKEND_BAND,
        env: { E2E_BACKEND_PORT: String(port) },
        ownRoot: OURS,
      }),
    /it reports <no sentinel>/,
  )
})

// ── DEMONSTRATION 2: a SAME-WORKTREE OTHER-RUN server is stepped over ────────────

test('a server that IS this worktree is still not adopted — it is another RUN', async t => {
  const port = await sentinelServer(OURS, t)
  // This is the whole correction `ab51cabc` made. The sentinel truthfully answers
  // "yes, this worktree" to BOTH runs; what differs is that the server's LIFETIME
  // belongs to whichever run started it, and Playwright kills only servers it
  // started. So identity is not permission.
  const v = await resolveHarnessPort({
    ...APP_E2E_BACKEND_BAND,
    env: {},
    start: port,
    ownRoot: OURS,
  })
  assert.notEqual(v.port, port, 'the occupied port must be stepped over')
  assert.equal(v.reused, false)

  // Pinned onto it, there is nowhere to step to — so it REFUSES, and says why.
  await assert.rejects(
    () =>
      resolveHarnessPort({
        ...APP_E2E_BACKEND_BAND,
        env: { E2E_BACKEND_PORT: String(port) },
        ownRoot: OURS,
      }),
    /another run of THIS worktree .* It is not this run's server to use/s,
  )

  // Only an EXPLICIT request adopts it. That is what E2E_REUSE=1 now means.
  const reused = await resolveHarnessPort({
    ...APP_E2E_BACKEND_BAND,
    env: { E2E_BACKEND_PORT: String(port) },
    ownRoot: OURS,
    allowReuse: true,
  })
  assert.deepEqual(reused, { port, reused: true, pinned: true })
})

test('a bind-verified walk skips a port held by something that answers nothing', async t => {
  // A dead TCP listener is neither `ours` nor a sentinel; the bind probe alone must
  // reject it, before any HTTP question is asked.
  const base = 9100 + 137
  await holdPort(base, t)
  const v = await resolveHarnessPort({
    ...APP_E2E_BACKEND_BAND,
    env: {},
    start: base,
    ownRoot: OURS,
    allowReuse: true,
  })
  assert.notEqual(v.port, base)
})

// ── DEMONSTRATION 3: CROSS-PROCESS agreement (the survivor's window) ─────────────

function probeConfig(env) {
  const out = execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--import',
      './scripts/ts-resolve.mjs',
      'scripts/e2e-config-probe.mjs',
    ],
    {
      cwd: UI,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_OPTIONS: '',
        ...env,
      },
    },
  )
  return JSON.parse(out.trim())
}

test('the config WIRES the resolver verdict, the pre-flight and the watchdog', async t => {
  // These assertions exist because the unit tests above prove the MECHANISM while
  // saying nothing about whether the config still uses it. Each one is a mutation
  // that survived until it was written: reverting `reuseExistingServer` to
  // `!CI || E2E_REUSE`, dropping `globalSetup`, listing the watchdog in only the
  // default reporter branch, or letting `E2E_BACKEND` fall back to a committed port.
  const c = probeConfig({})
  const backendPort = new URL(c.urls[0]).port

  // 1. reuse is the RESOLVER's verdict. Nothing was listening, so it must be false —
  //    under the old expression this would be TRUE off CI, and TRUE with E2E_REUSE=0.
  assert.deepEqual(c.reuse, [false, false], 'a freshly-resolved port must not be "reused"')
  assert.deepEqual(
    probeConfig({ E2E_REUSE: '0' }).reuse,
    [false, false],
    'E2E_REUSE=0 must not enable reuse',
  )

  // 2. the pre-flight is wired, and it is the shared one.
  assert.match(String(c.globalSetup), /harness-preflight\.mjs$/)
  assert.equal(c.origins.length, 2, 'both legs must be published for the pre-flight')
  assert.deepEqual(
    c.origins.map(o => String(o.port)),
    [backendPort, new URL(c.urls[1]).port],
    'the published origins must be the ports the servers are booted on',
  )

  // 3. the watchdog is in BOTH reporter branches.
  const wd = /harness-watchdog-reporter\.mjs$/
  assert.ok(c.reporters.some(r => wd.test(String(r))), 'watchdog missing from the default reporter')
  const junit = probeConfig({ PLAYWRIGHT_JUNIT: '/tmp/does-not-need-to-exist.xml' })
  assert.ok(
    junit.reporters.some(r => wd.test(String(r))),
    'watchdog missing when PLAYWRIGHT_JUNIT is set — the guard would switch itself off under the gate',
  )

  // 4. E2E_BACKEND is DERIVED from the resolved port, not a committed default.
  assert.equal(c.backend, `http://127.0.0.1:${backendPort}`)
  assert.ok(!c.backend.includes('3155'), 'the committed default port must be gone')

  // 5. the database + app-data dir carry the RUN discriminator, so two runs in one
  //    worktree cannot DROP each other's database.
  assert.match(c.dataDir, new RegExp(`txresbench_e2e_${backendPort}$`))

  // A disagreeing pre-set E2E_BACKEND is a hard failure, not a silent split.
  assert.throws(
    () => probeConfig({ E2E_BACKEND: 'http://127.0.0.1:3155' }),
    /Command failed/,
    'a pre-set E2E_BACKEND that disagrees must abort the run',
  )
  t.diagnostic(`config wiring verified against backend :${backendPort}`)
})

test('the config passes E2E_REUSE through — an occupied OUR-worktree port is stepped over', async t => {
  // BUILT because a mutation survived. Everything above asserts that `resolveHarnessPort`
  // refuses to adopt without an explicit request, and that the config uses the resolver's
  // verdict — but with NOTHING on the derived port, `reused` is false either way, so
  // `allowReuse: true` hard-coded inside `resolveBands` passed every one of them. The
  // window only exists when a server that CAN prove it is this worktree is sitting on the
  // port the config is about to pick, which is the actual two-runs-in-one-tree situation.
  const first = probeConfig({})
  const port = Number(new URL(first.urls[0]).port)

  // A server that truthfully identifies as THIS worktree — i.e. another run of ours.
  // OUT OF PROCESS: `probeConfig` uses `execFileSync`, which blocks this process's event
  // loop, so an in-process sentinel would accept the probe's connection and never answer
  // it. See `harness-fixture-sentinel.mjs` — the in-process version made the step-over
  // assertion pass for the wrong reason and did not kill the mutation.
  const ownRoot = resolveWorktreeRoot(UI)
  await startFixtureSentinel(port, ownRoot, t)

  const stepped = probeConfig({})
  assert.notEqual(
    Number(new URL(stepped.urls[0]).port),
    port,
    'the config adopted a server it did not start — reuse must be opt-in',
  )
  assert.equal(stepped.reuse[0], false)

  // …and the opt-in still works, on the same port, so this is a gate and not a wall.
  const adopted = probeConfig({ E2E_REUSE: '1' })
  assert.equal(Number(new URL(adopted.urls[0]).port), port)
  assert.equal(adopted.reuse[0], true, 'E2E_REUSE=1 must adopt the proven server')
  t.diagnostic(`stepped over :${port}, adopted it only under E2E_REUSE=1`)
})

test('a WORKER re-loading the config lands on the runner\'s ports, not a fresh search', async t => {
  // The runner resolves first.
  const runner = probeConfig({})
  assert.ok(runner.carry, 'the runner must record its verdict for the workers')
  const backendPort = Number(new URL(runner.urls[0]).port)

  // …then boots its backend, which now OCCUPIES that port. This is the state a worker
  // starts in, and it is why a re-resolution is not merely redundant but WRONG: the
  // run's own server is indistinguishable from any other occupant.
  await holdPort(backendPort, t)

  // A worker: same env, including the carry Playwright propagates to forked workers.
  const worker = probeConfig({ __HARNESS_RESOLVED_app_e2e: runner.carry })
  assert.deepEqual(worker.urls, runner.urls, 'worker and runner must navigate to ONE origin')
  assert.equal(worker.baseURL, runner.baseURL)
  assert.deepEqual(worker.origins, runner.origins, 'the pre-flight and the specs must agree')
  assert.equal(worker.backend, runner.backend, 'the spec helpers must hit the booted backend')
  assert.equal(worker.dataDir, runner.dataDir, 'a divergent port would fork the app-data dir too')

  // NEGATIVE CONTROL — without the carry, a second process DOES step over the
  // runner's own server and lands somewhere else. That is the live defect this
  // window holds; if this assertion ever stops holding, the test above has gone
  // vacuous and is no longer proving anything.
  const uncarried = probeConfig({})
  assert.notDeepEqual(
    uncarried.urls,
    runner.urls,
    'the negative control did not diverge — this test is no longer holding the window it claims to',
  )
})
