// render-perf-ms.spec.ts — the MILLISECOND leg (ITEM-19 / ITEM-20).
//
// Runs ONLY under the `chromium-prod-ms` project, against the production bench bundle served on
// this worktree's DERIVED bench port (the two viz origins used to be the fixed :1421/:1422; see
// the PORT block in `playwright.viz.config.ts` for why a literal was a cross-worktree defect).
// It reports milliseconds and REFUSES to report element counters (DEC-2): the prod bundle ships
// `jsx` rather than `jsxDEV` and minifies component names, so a name-keyed counter would read 0
// for `PaneToolbar`, 0 for `CellView`, and 0 passes every budget in this feature.
//
// NOTHING HERE GATES ON A RAW MILLISECOND (DEC-3). The recapture measured a ~3x swing in 1-min
// load average inside a single run set on this shared box, with one control run taking 18.8s of
// wall for a nominal 3.6s drive — while the SAME sessions' `ScriptDuration` landed within 0.4% of
// a month-old figure and the element counters reproduced bit-identically. So the gate is the
// SAME-RUN RATIO against a 200 000-point control measured in the same session with the same launch
// flags: the machine's speed cancels. The absolute figures are printed into the run record.

import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vizConfig from '../../playwright.viz.config'
import { VIZ_PORT_FLOORS } from '../../scripts/resolve-viz-port.mjs'
import {
  CANONICAL_GAP_MS,
  CANONICAL_STEPS,
  driveWheels,
  installElementCounter,
  installTimingProbe,
  openPerfStory,
  paneCentre,
} from './_renderPerf'

const VIZ_PKG = fileURLToPath(new URL('../../../libs/viz/', import.meta.url))
const BUDGETS = JSON.parse(
  readFileSync(new URL('../../../libs/viz/scripts/render-perf-budgets.json', import.meta.url), 'utf8'),
) as { baseline: Record<string, number>; budgets: Record<string, number>; recordedMs: Record<string, number> }

test.describe('render-perf — millisecond leg (prod bench)', () => {
  // ── TEST-N4 (ITEM-19): the prod leg refuses counters, AND the reason is PROVEN ────────────
  // Not merely "the function throws" — the underlying facts are asserted, so a future refactor
  // cannot re-enable a name-based counter here that silently reads 0 for every component.
  test('TEST-N4 the ms leg refuses element counters, and could not honestly produce them', async ({ page }) => {
    await expect(installElementCounter(page, { mode: 'prod' })).rejects.toThrow(/element counters are DEV-ONLY/)

    // Fact 1: the dev JSX runtime is never served by this origin.
    let devRuntimeRequests = 0
    await page.route('**/react_jsx-dev-runtime*', async route => {
      devRuntimeRequests++
      await route.continue()
    })
    await openPerfStory(page, 'render-perf', { panes: 4, points: 20_000 })
    expect(devRuntimeRequests, 'a prod bundle must not fetch the dev JSX runtime').toBe(0)

    // Fact 2: the component names the counter leg keys on are gone from the shipped JS.
    const names = await page.evaluate(async () => {
      const srcs = [...document.querySelectorAll('script[src]')].map(s => (s as HTMLScriptElement).src)
      const bodies = await Promise.all(srcs.map(s => fetch(s).then(r => r.text()).catch(() => '')))
      const all = bodies.join('\n')
      return {
        bytes: all.length,
        paneToolbar: /function\s+PaneToolbar\b/.test(all),
        cellView: /function\s+CellView\b/.test(all),
      }
    })
    expect(names.bytes, 'the bundle must actually have been read').toBeGreaterThan(10_000)
    expect(names.paneToolbar, 'minified prod has no `function PaneToolbar`').toBe(false)
    expect(names.cellView, 'minified prod has no `function CellView`').toBe(false)
  })

  // ── TEST-23 (ITEM-19/ITEM-20): the served bundle is FRESH ─────────────────────────────────
  // A stale prod bundle does not fail a perf gate — it reports the OLD numbers, which reads
  // exactly like a successful fix. This is the contract that closes that hole.
  test('TEST-23 the served prod bundle matches the working tree, and the cache is a real cache', async () => {
    const info = JSON.parse(readFileSync(`${VIZ_PKG}dist-bench/.buildinfo`, 'utf8')) as { buildHash: string }
    const expected = execFileSync('node', ['scripts/serve-bench.mjs', '--print-hash'], {
      cwd: VIZ_PKG,
      encoding: 'utf8',
    }).trim()
    expect(
      info.buildHash,
      'dist-bench is STALE — it was built from different sources than the tree being measured',
    ).toBe(expected)
    expect(existsSync(`${VIZ_PKG}dist-bench/viz-showcase.html`)).toBe(true)

    // …and the cache genuinely no-ops on an unchanged tree (otherwise every run pays a full
    // production build and the leg becomes too slow to run, which is how a gate stops being run).
    const out = execFileSync('node', ['scripts/serve-bench.mjs', '--build-only'], {
      cwd: VIZ_PKG,
      encoding: 'utf8',
    })
    expect(out, 'a second build-only on an unchanged tree must be a cache hit').toMatch(/cache HIT/)
  })

  // ── TEST-24 (ITEM-19): the control is sane, NAME-INDEPENDENTLY ────────────────────────────
  // Minification defeats component names but not DOM structure. If the control ever grows grid
  // chrome, the ratio's denominator is contaminated and every ratio budget silently loosens.
  test('TEST-24 the 200k control carries no grid chrome (DOM-shape check)', async ({ page }) => {
    test.setTimeout(200_000)
    await openPerfStory(page, 'scatter-basic', { points: 200_000 }, { settleMs: 12_000 })
    const shape = await page.evaluate(() => ({
      cells: document.querySelectorAll('[data-viz-cell]').length,
      toolbars: document.querySelectorAll('[data-testid^="viz-pane-toolbar-"]').length,
      canvases: document.querySelectorAll('canvas').length,
    }))
    expect(shape.cells, 'the control must not be a grid').toBe(0)
    expect(shape.toolbars, 'the control must have no pane chrome').toBe(0)
    expect(shape.canvases, 'the control is exactly one deck canvas').toBeGreaterThanOrEqual(1)
  })

  // ── TEST-P7 (ITEM-19/ITEM-20/ITEM-5, INV-6): the machine-normalized cost ratio ────────────
  // The design's headline: "200 000 points cost 6.5 ms of script per wheel; 20 000 points inside
  // the grid cost 75 ms — 11.6x more script for 10x fewer points". Subject and control are driven
  // back-to-back in ONE session so the box's speed cancels. ACCEPTANCE for the Split-A wave;
  // expected RED until then, and its red value is the required red-proof.
  test('TEST-P7 grid script cost vs the 200k control, same session', async ({ page }) => {
    test.setTimeout(400_000)

    const probe = await installTimingProbe(page, { mode: 'prod' })

    // Subject: 4 panes x 20 000 points.
    await openPerfStory(page, 'render-perf', { panes: 4, points: 20_000 })
    await probe.begin()
    const subjAck = await driveWheels(page, {
      ...(await paneCentre(page, 0)),
      steps: CANONICAL_STEPS,
      gapMs: CANONICAL_GAP_MS,
    })
    const subject = await probe.end(subjAck)

    // Control: 200 000 points, no grid chrome — same page session, same launch flags.
    const probe2 = await installTimingProbe(page, { mode: 'prod' })
    await openPerfStory(page, 'scatter-basic', { points: 200_000 }, { settleMs: 12_000 })
    const box = await page.locator('canvas').first().boundingBox()
    expect(box).toBeTruthy()
    await probe2.begin()
    const ctlAck = await driveWheels(page, {
      x: box!.x + box!.width / 2,
      y: box!.y + box!.height / 2,
      steps: CANONICAL_STEPS,
      gapMs: CANONICAL_GAP_MS,
    })
    const control = await probe2.end(ctlAck)

    const scriptRatio = subject.scriptMs / Math.max(1, control.scriptMs)
    const ackRatio = subject.wheelAck.p50 / Math.max(1, control.wheelAck.p50)
    // RECORDED, never gated (DEC-3).
    console.log(
      `[TEST-P7] subject script=${subject.scriptMs}ms ack.p50=${subject.wheelAck.p50}ms longTasks=${subject.longTasks} | ` +
        `control script=${control.scriptMs}ms ack.p50=${control.wheelAck.p50}ms | ` +
        `scriptRatio=${scriptRatio.toFixed(2)} (baseline ${BUDGETS.baseline.scriptRatioVsControl}, budget ${BUDGETS.budgets.scriptRatioVsControl}) ` +
        `ackRatio=${ackRatio.toFixed(2)} (baseline ${BUDGETS.baseline.wheelAckRatioVsControl}, budget ${BUDGETS.budgets.wheelAckRatioVsControl})`,
    )
    expect(control.scriptMs, 'the control must have done real work, or the ratio is meaningless').toBeGreaterThan(1)
    expect(scriptRatio).toBeLessThanOrEqual(BUDGETS.budgets.scriptRatioVsControl)
    expect(ackRatio).toBeLessThanOrEqual(BUDGETS.budgets.wheelAckRatioVsControl)
  })

  // ── TEST-25 (ITEM-20): the shared-config edit is ADDITIVE ─────────────────────────────────
  // Rule B3 permits this shared-harness edit only because it is additive. This is what keeps that
  // true over time, and it asserts the routing gate's OWN exit code rather than piped output.
  test('TEST-25 the playwright.viz.config edit is additive and routing still passes', async () => {
    const cfg = vizConfig as unknown as {
      workers: number
      timeout: number
      testDir: string
      use: { baseURL: string; viewport: { width: number; height: number }; launchOptions: { args: string[] } }
      projects: { name: string; use?: { baseURL?: string }; testMatch?: RegExp; testIgnore?: RegExp }[]
      webServer: { url: string }[]
    }

    // The pre-existing contract, unchanged.
    expect(cfg.testDir).toBe('./tests/viz-e2e')
    expect(cfg.workers).toBe(1)
    expect(cfg.timeout).toBe(240_000)
    // The baseURL is DERIVED per worktree, so this asserts the PROPERTY the old
    // `toBe('http://localhost:1421')` was standing in for. That literal was a test
    // CERTIFYING the defect: two worktrees sharing one port is the failure, and an
    // assertion that the port is that shared number would have to be deleted to fix it.
    // What must hold is that the origin is a real localhost port inside this leg's
    // derived band (or an explicit `VIZ_E2E_PORT` pin) — never a shared constant.
    const portOf = (url: string) => Number(new URL(url).port)
    const inBand = (port: number, leg: keyof typeof VIZ_PORT_FLOORS) => {
      const { floor, span } = VIZ_PORT_FLOORS[leg]
      return port >= floor && port < floor + span
    }
    expect(cfg.use.baseURL).toMatch(/^http:\/\/localhost:\d+$/)
    const devPort = portOf(cfg.use.baseURL)
    expect(
      inBand(devPort, 'vizShowcase') || Number(process.env.VIZ_E2E_PORT) === devPort,
      `the dev showcase origin :${devPort} is outside the vizShowcase band and is not a VIZ_E2E_PORT pin`,
    ).toBe(true)
    expect(cfg.use.viewport).toEqual({ width: 1280, height: 820 })
    expect(cfg.use.launchOptions.args).toEqual([
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ])

    const dev = cfg.projects.find(p => p.name === 'chromium')!
    const prod = cfg.projects.find(p => p.name === 'chromium-prod-ms')!
    expect(dev, 'the original project must still exist under its original name').toBeTruthy()
    expect(prod).toBeTruthy()
    // The dev project excludes ONLY the ms spec…
    expect(dev.testIgnore!.source).toBe(prod.testMatch!.source)
    expect(dev.testIgnore!.test('tests/viz-e2e/render-perf-ms.spec.ts')).toBe(true)
    // …and EVERY spec in the directory is routed to EXACTLY ONE project (FIX_ROUND-2 / C24).
    // This was a hand-list of four spec names in a directory holding seventy — so a spec excluded
    // from BOTH projects, routed to no runner at all, could not fail it. That is the same
    // directory-vs-hand-list flaw the sibling runner `libs/viz/tests/e2e/run-all.mjs` was
    // written to avoid, and the failure mode this test's own comment names: "EXACTLY how the
    // pre-existing 63-spec viz suite came to be un-run".
    const specDir = fileURLToPath(new URL('.', import.meta.url))
    const specs = readdirSync(specDir).filter(f => f.endsWith('.spec.ts'))
    expect(specs.length, 'the spec directory must not be empty — an empty set routes vacuously').toBeGreaterThan(10)
    const unrouted: string[] = []
    const doubleRouted: string[] = []
    for (const f of specs) {
      const rel = `tests/viz-e2e/${f}`
      const onDev = !dev.testIgnore!.test(rel)
      const onProd = prod.testMatch!.test(rel)
      if (!onDev && !onProd) unrouted.push(f)
      if (onDev && onProd) doubleRouted.push(f)
    }
    expect(unrouted, `these specs are routed to NO project — no runner drives them: ${unrouted.join(', ')}`).toEqual([])
    expect(doubleRouted, `these specs would run on BOTH origins: ${doubleRouted.join(', ')}`).toEqual([])
    // …and the ms leg is on the prod project specifically, not merely routed somewhere.
    expect(specs, 'the ms-leg spec must be present for the split to mean anything').toContain('render-perf-ms.spec.ts')
    expect(prod.testMatch!.test('tests/viz-e2e/render-perf-ms.spec.ts')).toBe(true)
    // The prod project is the only one with its OWN origin, and the two origins are
    // DISTINCT — the property DEC-2's split depends on (each leg refuses the other's
    // metric, which is meaningless if they can land on one server).
    expect(prod.use!.baseURL).toMatch(/^http:\/\/localhost:\d+$/)
    const benchPort = portOf(prod.use!.baseURL!)
    expect(
      inBand(benchPort, 'vizBench') || Number(process.env.VIZ_BENCH_PORT) === benchPort,
      `the bench origin :${benchPort} is outside the vizBench band and is not a VIZ_BENCH_PORT pin`,
    ).toBe(true)
    expect(benchPort, 'the dev and bench legs must never resolve to ONE origin').not.toBe(devPort)
    expect(dev.use?.baseURL).toBeUndefined() // inherits the top-level dev origin

    // Each webServer entry serves ITS OWN leg's origin. Asserted by equality with the
    // ports above rather than against literals, so the config cannot boot a server on
    // one port while pointing the browser at another — which is the mismatch a hardcoded
    // pair hides.
    expect(cfg.webServer).toHaveLength(2)
    expect(portOf(new URL(cfg.webServer[0].url).origin)).toBe(devPort)
    expect(portOf(new URL(cfg.webServer[1].url).origin)).toBe(benchPort)

    // The five-rule routing gate must still pass — this is what stops the four new specs from
    // landing where no runner drives them, which is EXACTLY how the pre-existing 63-spec viz suite
    // came to be un-run. Assert the gate's own exit code.
    const ui = fileURLToPath(new URL('../../', import.meta.url))
    expect(() => execFileSync('node', ['scripts/check-e2e-routing.mjs'], { cwd: ui, stdio: 'pipe' })).not.toThrow()
  })

  // ── TEST-F6 (ITEM-19): the bench preview is REACHABLE BY PLAYWRIGHT'S OWN GROUP KILL ─────────
  //
  // This is the B5 property, asserted where it actually lives. `serveBench.test.ts` used to
  // approximate it from a unit suite with a stand-in child; three fix-loop rounds each found a new
  // spelling of the same hole, because a stand-in cannot see the runner's teardown contract. That
  // guard is deleted (DEC-45) and this is its replacement.
  //
  // The defect it catches, concretely: `serve-bench.mjs` once spawned the preview `detached: true`
  // and signalled the process GROUP. That reaps a grandchild in isolation — and it made the real
  // runner WORSE. Playwright starts a `webServer` detached and tears it down by killing ITS process
  // group; a `detached` preview lands in a NEW group, so Playwright's kill no longer reaches it.
  // Measured at the time: an ms-leg run left `vite preview` orphaned on the bench port at `ppid=1` while
  // Playwright hung. That is how this was caught in practice, twice.
  //
  // So the assertion is on the REAL listener of the REAL server this very run is using: it shares a
  // process group with the `serve-bench.mjs` parent Playwright spawned. Ship `detached: true` and
  // the preview becomes its own group leader (pgid === its own pid, != the parent's) and this goes
  // RED. Ship the `npx` wrapper and the reachable-by-direct-signal half regresses, which the
  // wrapper-free parent chain below also sees.
  //
  // Linux-only: it reads `/proc`. Skipped elsewhere with a stated reason rather than silently
  // passing — a vacuous green here is the exact failure class this test exists to end.
  test('TEST-F6 the bench preview shares the harness process group (no orphan)', async () => {
    test.skip(process.platform !== 'linux', 'reads /proc for pgid/ppid; Linux-only by construction')

    // The port THIS run's bench server is on — read off the config that booted it, not a
    // literal. A hardcoded 1422 here would, after the per-worktree port derivation, find
    // nothing listening and (before the `inodes.size > 0` premise check below) pass
    // vacuously — or worse, find a SIBLING worktree's preview and assert on its process.
    const BENCH_PORT = Number(
      new URL(
        (vizConfig as unknown as { projects: { name: string; use?: { baseURL?: string } }[] }).projects.find(
          p => p.name === 'chromium-prod-ms',
        )!.use!.baseURL!,
      ).port,
    )

    const stat = (pid: number) => {
      // Fields after the comm field, which may itself contain spaces/parens — split on the LAST ')'.
      const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const rest = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
      // rest[0]=state, rest[1]=ppid, rest[2]=pgrp  (proc(5) fields 3,4,5)
      return { ppid: Number(rest[1]), pgrp: Number(rest[2]) }
    }
    const cmdline = (pid: number) => readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()

    // Find the pid LISTENING on the bench port from `/proc` ALONE — no `ss`/`lsof`/`fuser` (none is
    // guaranteed on PATH: the first version of this test shelled out to `ss` and died `ENOENT` on
    // the very box it was written for), and no `pgrep -f` pattern match (which would also match
    // this test's own argv).
    //
    // Step 1 — the listening socket's INODE, from the kernel's own tables. `local_address` is
    // `<hex-addr>:<hex-port>`. State `0A` is TCP_LISTEN, so a client connection to the same port
    // is not mistaken for the server.
    const PORT_HEX = BENCH_PORT.toString(16).toUpperCase().padStart(4, '0')
    const inodes = new Set<string>()
    for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
      if (!existsSync(f)) continue
      for (const row of readFileSync(f, 'utf8').split('\n').slice(1)) {
        const c = row.trim().split(/\s+/)
        if (c.length < 10) continue
        if (!c[1].toUpperCase().endsWith(`:${PORT_HEX}`)) continue
        if (c[3].toUpperCase() !== '0A') continue
        inodes.add(c[9])
      }
    }
    expect(
      inodes.size,
      `nothing is LISTENING on :${BENCH_PORT} — the bench webServer for this run is not up, so every clause ` +
        `below would pass by finding nothing to check`,
    ).toBeGreaterThan(0)

    // Step 2 — the pid holding that socket, by matching `socket:[inode]` across process fds. Only
    // our own processes are readable, which is exactly the set the preview belongs to.
    let pid = 0
    for (const ent of readdirSync('/proc')) {
      if (!/^\d+$/.test(ent)) continue
      let fds: string[]
      try {
        fds = readdirSync(`/proc/${ent}/fd`)
      } catch {
        continue // not ours, or exited between readdir and open
      }
      for (const fd of fds) {
        let link: string
        try {
          link = readlinkSync(`/proc/${ent}/fd/${fd}`)
        } catch {
          continue
        }
        const m = /^socket:\[(\d+)\]$/.exec(link)
        if (m && inodes.has(m[1])) {
          pid = Number(ent)
          break
        }
      }
      if (pid) break
    }
    expect(
      pid > 0,
      `a socket is LISTENING on :${BENCH_PORT} but no readable process owns it (inode(s) ${[...inodes].join(',')})`,
    ).toBe(true)

    const self = stat(pid)

    // 1. NOT ORPHANED. `ppid=1` is the literal signature the two real catches produced.
    expect(self.ppid, `the :${BENCH_PORT} listener (${cmdline(pid)}) is orphaned at ppid=1 — its parent died without it`).not.toBe(1)

    // 2. The parent is OUR server, so this is not some foreign process that happened to hold the
    //    port (`reuseExistingServer` makes that reachable). Establishes the premise before the
    //    property — an assertion against the wrong process would be vacuous.
    const parent = cmdline(self.ppid)
    expect(parent, `the listener's parent is not serve-bench.mjs, so :${BENCH_PORT} is a FOREIGN server: ${parent}`).toContain('serve-bench.mjs')

    // 3. NO WRAPPER: the listener is a direct child of serve-bench.mjs, so `child.kill(sig)` reaches
    //    the thing holding the port. An `npx` wrapper would sit between them.
    expect(parent, 'an `npx` wrapper is back between serve-bench.mjs and the preview').not.toMatch(/(?:^|\/|\s)npx(?:\s|$)/)

    // 4. THE PROPERTY: same process group as the parent Playwright spawned. `detached: true` breaks
    //    exactly this and nothing else observable from here.
    const parentStat = stat(self.ppid)
    expect(
      self.pgrp,
      `the :${BENCH_PORT} preview leads its OWN process group (pgid=${self.pgrp}, parent pgid=${parentStat.pgrp}) — ` +
        "Playwright tears a webServer down by killing its group, so a detached preview survives the run and holds the port",
    ).toBe(parentStat.pgrp)
  })
})
