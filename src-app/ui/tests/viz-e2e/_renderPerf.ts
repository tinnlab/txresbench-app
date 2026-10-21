// _renderPerf.ts — the render-perf measurement library (ITEM-8 + ITEM-19).
//
// TWO LEGS, AND EACH REFUSES THE OTHER'S METRIC (DEC-2). This is the whole design:
//
//   • the COUNTER leg runs against the DEV vite server (:1421) with StrictMode on, and
//     produces element counts + React commit counts. Those are machine-independent and
//     bit-deterministic — two runs of the recapture agreed EXACTLY (2 492 / 2 492) — which is
//     why they and not milliseconds are what the budgets gate on. It CANNOT produce honest
//     milliseconds: the dev build inflates typed-array prop diffs ~1000×.
//
//   • the MS leg runs against a PROD bench build (:1422, no StrictMode) and produces
//     ScriptDuration + wheel-ack latency. It CANNOT produce element counts: prod ships `jsx`
//     (not `jsxDEV`) and minifies component names, so `PaneToolbar` becomes `Xy` and a
//     name-keyed counter would read 0 for every component — a perfect false green.
//
// Asking a leg for the metric it cannot honestly produce THROWS. Neither may degrade to a
// plausible-looking zero, because a plausible-looking zero passes every budget in this feature.
//
// THE FALSE-GREEN THE ELEMENT COUNTER ITSELF CAN CAUSE. The counter works by intercepting the
// vite-served `react_jsx-dev-runtime.js` and splicing a tally into `jsxDEV`. If React is bumped
// and the anchor no longer matches, the splice becomes a no-op, every element budget reads 0,
// and the whole suite false-greens on the exact regression it exists to catch. So a non-applied
// patch is a HARD FAILURE (`assertApplied`), never a 0. Same for the commit counter: if React
// never calls the injected devtools hook's `inject`, that is a hard failure, not "0 commits".

import type { CDPSession, Page } from '@playwright/test'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

export type Leg = 'dev' | 'prod'

/** The canonical drive: 30 wheel steps, 120 ms apart. Identical to the drive every recorded
 *  baseline figure in PLAN.md `## Re-captured baseline` was measured with. */
export const CANONICAL_STEPS = 30
export const CANONICAL_GAP_MS = 120
/** The counter recapture used a slightly slower cadence so every commit settles inside its own
 *  step; counts are per-wheel ratios so the cadence does not change them, but it is recorded
 *  here so a re-measurement reproduces the published numbers exactly. */
export const COUNTER_STEPS = 20
export const COUNTER_GAP_MS = 150

/** The anchor spliced into the vite-served dev JSX runtime. Whitespace-tolerant ON PURPOSE:
 *  the byte-exact string differs between the npm tarball and esbuild's pre-bundled output, and
 *  a formatting-only change must not silently disable the counter. A genuine React rename still
 *  fails to match — and that is a hard error, not a zero. */
export const JSXDEV_ANCHOR =
  /(exports\.jsxDEV\s*=\s*function\s*\(\s*type\s*,\s*config\s*,\s*maybeKey\s*,\s*isStaticChildren\s*\)\s*\{)/

/** The tally spliced in after the anchor. Keyed by component display name; DOM intrinsics are
 *  prefixed `dom:` so `dom:div` and a `<Div>` component can never collide. Wrapped in try/catch
 *  because a throw inside `jsxDEV` would take the whole app down rather than fail a budget. */
const COUNTER_SPLICE = `$1 try { var __C = globalThis.__VIZ_COUNTERS__; if (__C && __C.__on) { var __n = typeof type === 'function' ? (type.displayName || type.name || 'anonFn') : (typeof type === 'string' ? 'dom:' + type : (type && (type.displayName || (type.type && (type.type.displayName || type.type.name)) || (type.render && (type.render.displayName || type.render.name)))) || 'obj'); __C[__n] = (__C[__n] || 0) + 1; __C.__total = (__C.__total || 0) + 1; if (__C.__percell) { var __id = config && config.cell && config.cell.id; if (typeof __id === 'string') { var __k = __n + '#' + __id; __C[__k] = (__C[__k] || 0) + 1; } } } } catch (e) {}`

/**
 * Does THIS invocation need the prod-bench server on :1422? (FIX_ROUND-2 / A12)
 *
 * `playwright.viz.config.ts` declared its second `webServer` unconditionally, so EVERY viz-e2e run —
 * including the dev `chromium` project, which `testIgnore`s the ms-leg spec and never touches :1422 —
 * booted `serve-bench.mjs` and paid a cold production build (300s timeout) it would not use. A
 * `webServer` entry cannot be scoped to a project, so the scoping has to be computed here.
 *
 * Conservative by construction: it answers NO only when the invocation is provably not going to run
 * the ms leg (an explicit `--project` that is not the prod one, or an explicit spec-file list that
 * does not include it). Anything ambiguous — a bare run, a `--grep`, CI — answers YES, because a
 * missing bench server is a hard failure while a needless one is only slow.
 *
 * Pure, so it is tested without booting anything (TEST-N6).
 */
export function needsBenchServer(
  argv: readonly string[],
  env: { CI?: string } = {},
  opts: { msSpec?: RegExp; prodProject?: string } = {},
): boolean {
  if (env.CI) return true
  const msSpec = opts.msSpec ?? /render-perf-ms\.spec\.ts/
  const prodProject = opts.prodProject ?? 'chromium-prod-ms'
  const args = argv.slice(2)
  const projects: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--project=')) projects.push(args[i].slice('--project='.length))
    else if (args[i] === '--project' && args[i + 1]) projects.push(args[++i])
  }
  if (projects.length > 0) return projects.includes(prodProject)
  const specFilters = args.filter(a => !a.startsWith('-') && /\.spec\.ts/.test(a))
  if (specFilters.length > 0) return specFilters.some(a => msSpec.test(a))
  return true
}

export interface CounterResult {
  /** total `jsxDEV` calls during the measured window. */
  total: number
  /** elements created per delivered wheel event (the budgeted figure). */
  perWheel: number
  /** per-component-name creations over the whole window. */
  byComponent: Record<string, number>
  /** per-component-name creations per wheel. */
  perWheelByComponent: Record<string, number>
  /** wheel events actually delivered to the page (capture-phase listener), so the ratio is
   *  exact and cannot be inflated by an input the browser dropped. */
  wheels: number
}

export interface ElementCounter {
  /** HARD-FAILS if the jsxDEV splice never applied. Call AFTER the page has loaded. */
  assertApplied(): void
  /** true iff the splice applied — for the negative test that proves the hard-fail fires. */
  applied(): boolean
  /** how many requests the route pattern matched at all (0 ⇒ the module was never served). */
  requestsSeen(): number
  begin(): Promise<void>
  end(): Promise<CounterResult>
}

/**
 * Install the element counter. DEV LEG ONLY — asking for it in prod throws (DEC-2).
 *
 * `anchor` is injectable so TEST-N1 can drive a deliberately non-matching pattern and prove
 * `assertApplied()` throws rather than the harness reporting a comfortable 0.
 *
 * `perCell` (FIX_ROUND-2) additionally tallies `Name#<cell.id>` for every element whose props carry
 * a `cell` — the ONLY way to state "the UNTOUCHED pane's chrome did not rebuild" as a fact rather
 * than as a ratio over totals, which cannot separate one pane's two rebuilds from two panes' one
 * each. OPT-IN, and the opt-in is the point: with it off the tally is byte-identical to before, so
 * no existing budget's `byComponent` gains a key.
 */
export async function installElementCounter(
  page: Page,
  opts: { mode?: Leg; anchor?: RegExp; perCell?: boolean; armAtLoad?: boolean } = {},
): Promise<ElementCounter> {
  const perCell = opts.perCell ?? false
  // ARM AT LOAD (TEST-P2). `begin()` reaches into `globalThis.__VIZ_COUNTERS__`, which the init
  // script below creates — so it can only be called AFTER a navigation. A test whose FIRST measured
  // window is the MOUNT itself therefore cannot open that window with `begin()`: on `about:blank`
  // there is no counters object and `begin()` throws `Cannot convert undefined or null to object`.
  // (TEST-P2 did exactly that and never produced a verdict.) Arming inside the init script starts
  // the tally at page load instead; `end()` closes the mount window as usual and `begin()` opens
  // the next one. OPT-IN, like `perCell`, so every existing spec's tally is byte-identical.
  const armAtLoad = opts.armAtLoad ?? false
  const mode = opts.mode ?? 'dev'
  if (mode === 'prod')
    throw new Error(
      'element counters are DEV-ONLY: the prod bundle ships `jsx` (not `jsxDEV`) and minifies ' +
        'component names, so a name-keyed counter would read 0 for every component.',
    )
  const anchor = opts.anchor ?? JSXDEV_ANCHOR
  let applied = false
  let seen = 0

  await page.route('**/react_jsx-dev-runtime.js*', async route => {
    seen++
    const res = await route.fetch()
    let body = await res.text()
    if (anchor.test(body)) {
      body = body.replace(anchor, COUNTER_SPLICE)
      applied = true
    }
    const headers = { ...res.headers() }
    delete headers['content-length']
    await route.fulfill({ response: res, body, headers })
  })

  await page.addInitScript(
    ([arm, pc]: [boolean, boolean]) => {
    ;(globalThis as unknown as { __VIZ_COUNTERS__: Record<string, unknown> }).__VIZ_COUNTERS__ = {
      __on: arm,
      __percell: pc,
    }
    ;(globalThis as unknown as { __VIZ_WHEELS__: { n: number; on: boolean } }).__VIZ_WHEELS__ = {
      n: 0,
      on: false,
    }
    addEventListener(
      'wheel',
      () => {
        const w = (globalThis as unknown as { __VIZ_WHEELS__: { n: number; on: boolean } })
          .__VIZ_WHEELS__
        if (w.on) w.n++
      },
      { capture: true, passive: true },
    )
    },
    [armAtLoad, armAtLoad && perCell] as [boolean, boolean],
  )

  return {
    applied: () => applied,
    requestsSeen: () => seen,
    assertApplied() {
      if (seen === 0)
        throw new Error(
          'jsxDEV probe did not apply: the react_jsx-dev-runtime.js route matched ZERO requests. ' +
            'Either the page never loaded, or this is not a dev build.',
        )
      if (!applied)
        throw new Error(
          `jsxDEV probe did not apply: the anchor ${String(anchor)} matched nothing in the served ` +
            'react_jsx-dev-runtime.js. React was probably bumped. REFUSING to report 0 elements — ' +
            'a silently-unpatched runtime false-greens every element budget in this feature.',
        )
    },
    async begin() {
      await page.evaluate((pc: boolean) => {
        const C = (globalThis as unknown as { __VIZ_COUNTERS__: Record<string, unknown> })
          .__VIZ_COUNTERS__
        for (const k of Object.keys(C)) delete C[k]
        C.__on = true
        C.__percell = pc
        const W = (globalThis as unknown as { __VIZ_WHEELS__: { n: number; on: boolean } })
          .__VIZ_WHEELS__
        W.n = 0
        W.on = true
      }, perCell)
    },
    async end() {
      const raw = await page.evaluate(() => {
        const C = (globalThis as unknown as { __VIZ_COUNTERS__: Record<string, number | boolean> })
          .__VIZ_COUNTERS__
        C.__on = false
        const W = (globalThis as unknown as { __VIZ_WHEELS__: { n: number; on: boolean } })
          .__VIZ_WHEELS__
        W.on = false
        return { counters: JSON.parse(JSON.stringify(C)) as Record<string, number>, wheels: W.n }
      })
      const byComponent = { ...raw.counters }
      const total = Number(byComponent.__total ?? 0)
      delete (byComponent as Record<string, unknown>).__total
      delete (byComponent as Record<string, unknown>).__on
      delete (byComponent as Record<string, unknown>).__percell
      const wheels = Math.max(1, raw.wheels)
      const perWheelByComponent: Record<string, number> = {}
      for (const [k, v] of Object.entries(byComponent)) perWheelByComponent[k] = v / wheels
      return { total, perWheel: total / wheels, byComponent, perWheelByComponent, wheels: raw.wheels }
    },
  }
}

export interface CommitResult {
  commits: number
  wheels: number
  commitsPerWheel: number
}

export interface CommitCounter {
  /** HARD-FAILS if React never called the injected hook's `inject` — i.e. the hook was installed
   *  too late or React ignored it. Reporting "0 commits" in that case is the false green. */
  assertInjected(): Promise<void>
  begin(): Promise<void>
  end(): Promise<CommitResult>
}

/**
 * Install the React commit counter — a fake `__REACT_DEVTOOLS_GLOBAL_HOOK__` whose
 * `onCommitFiberRoot` tallies commits, alongside a capture-phase `wheel` listener that tallies
 * DELIVERED wheel events. The ratio of the two is INV-4's budget, and counting delivered wheels
 * (rather than requested ones) is what makes it exact.
 *
 * DEV LEG ONLY: React only calls the devtools hook in a development build.
 */
export async function installCommitCounter(
  page: Page,
  opts: { mode?: Leg } = {},
): Promise<CommitCounter> {
  if ((opts.mode ?? 'dev') === 'prod')
    throw new Error(
      'commit counters are DEV-ONLY: the production React build does not call the devtools hook.',
    )

  await page.addInitScript(() => {
    const S = { commits: 0, wheels: 0, on: false }
    ;(globalThis as unknown as { __VIZ_COMMITS__: typeof S }).__VIZ_COMMITS__ = S
    ;(globalThis as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ =
      {
        isDisabled: false,
        supportsFiber: true,
        renderers: new Map(),
        rendererInterfaces: new Map(),
        inject(r: unknown) {
          const id = (this as { renderers: Map<number, unknown> }).renderers.size + 1
          ;(this as { renderers: Map<number, unknown> }).renderers.set(id, r)
          return id
        },
        onCommitFiberRoot() {
          if (S.on) S.commits++
        },
        onCommitFiberUnmount() {},
        onPostCommitFiberRoot() {},
        checkDCE() {},
        on() {},
        off() {},
        emit() {},
        sub() {
          return () => {}
        },
        getFiberRoots() {
          return new Set()
        },
        setStrictMode() {},
        registerInternalModuleStart() {},
        registerInternalModuleStop() {},
      }
    addEventListener(
      'wheel',
      () => {
        if (S.on) S.wheels++
      },
      { capture: true, passive: true },
    )
  })

  return {
    async assertInjected() {
      const n = await page.evaluate(
        () =>
          (
            (globalThis as unknown as {
              __REACT_DEVTOOLS_GLOBAL_HOOK__?: { renderers?: Map<number, unknown> }
            }).__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers ?? new Map()
          ).size,
      )
      if (n === 0)
        throw new Error(
          'commit probe did not attach: React never called __REACT_DEVTOOLS_GLOBAL_HOOK__.inject ' +
            '(renderers.size === 0). REFUSING to report 0 commits/wheel — that would false-green INV-4.',
        )
    },
    async begin() {
      await page.evaluate(() => {
        const S = (globalThis as unknown as {
          __VIZ_COMMITS__: { commits: number; wheels: number; on: boolean }
        }).__VIZ_COMMITS__
        S.commits = 0
        S.wheels = 0
        S.on = true
      })
    },
    async end() {
      const r = await page.evaluate(() => {
        const S = (globalThis as unknown as {
          __VIZ_COMMITS__: { commits: number; wheels: number; on: boolean }
        }).__VIZ_COMMITS__
        S.on = false
        return { commits: S.commits, wheels: S.wheels }
      })
      return {
        ...r,
        commitsPerWheel: r.commits / Math.max(1, r.wheels),
      }
    },
  }
}

export interface TimingResult {
  /** CDP `Performance.getMetrics` deltas over the drive, in milliseconds. */
  scriptMs: number
  taskMs: number
  layoutMs: number
  /** the awaited `page.mouse.wheel` round-trip distribution, in milliseconds. */
  wheelAck: { p50: number; p90: number; max: number }
  longTasks: number
  /** DOM node count delta — the name-independent control-integrity signal (DEC-3). */
  nodesDelta: number
}

export interface TimingProbe {
  begin(): Promise<void>
  end(ackMs: number[]): Promise<TimingResult>
}

/**
 * Install the millisecond probe. PROD LEG ONLY — asking for it in dev throws (DEC-2), because
 * the dev server's typed-array prop diffing inflates the figure ~1000× and a dev millisecond is
 * not a number anybody should be allowed to quote.
 */
export async function installTimingProbe(
  page: Page,
  opts: { mode?: Leg } = {},
): Promise<TimingProbe> {
  const mode = opts.mode ?? 'prod'
  if (mode === 'dev')
    throw new Error(
      'script-duration is PROD-ONLY: the dev build inflates typed-array prop diffs ~1000×, so a ' +
        'dev millisecond figure is not comparable to anything. Use the counter leg in dev.',
    )

  await page.addInitScript(() => {
    const S = { longTasks: 0, on: false }
    ;(globalThis as unknown as { __VIZ_LT__: typeof S }).__VIZ_LT__ = S
    try {
      new PerformanceObserver(list => {
        if (S.on) S.longTasks += list.getEntries().length
      }).observe({ entryTypes: ['longtask'] })
    } catch {
      /* longtask unsupported — reported as 0, and TEST-24 gates the control separately */
    }
  })

  let cdp: CDPSession | null = null
  let before: Record<string, number> = {}
  const metrics = async () =>
    Object.fromEntries(
      (await cdp!.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]),
    ) as Record<string, number>

  return {
    async begin() {
      cdp = await page.context().newCDPSession(page)
      await cdp.send('Performance.enable')
      before = await metrics()
      await page.evaluate(() => {
        const S = (globalThis as unknown as { __VIZ_LT__: { longTasks: number; on: boolean } })
          .__VIZ_LT__
        S.longTasks = 0
        S.on = true
      })
    },
    async end(ackMs: number[]) {
      const after = await metrics()
      const d = (k: string) => +(((after[k] ?? 0) - (before[k] ?? 0)) * 1000).toFixed(1)
      const longTasks = await page.evaluate(() => {
        const S = (globalThis as unknown as { __VIZ_LT__: { longTasks: number; on: boolean } })
          .__VIZ_LT__
        S.on = false
        return S.longTasks
      })
      return {
        scriptMs: d('ScriptDuration'),
        taskMs: d('TaskDuration'),
        layoutMs: d('LayoutDuration'),
        wheelAck: wheelAckQuantiles(ackMs),
        longTasks,
        nodesDelta: (after.Nodes ?? 0) - (before.Nodes ?? 0),
      }
    },
  }
}

/**
 * The wheel-ack quantiles, which REFUSE an empty sample (FIX_ROUND-2 / C14).
 *
 * This was inline in the timing probe as
 * `sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0`, and on an EMPTY array
 * that is `sorted[-1] ?? 0` — so `p50 = p90 = max = 0`, TEST-P7's
 * `ackRatio = subject.p50 / Math.max(1, control.p50)` becomes 0, and `wheelAckRatioVsControl` passes
 * unconditionally. The SCRIPT half of that same ratio is guarded
 * (`expect(control.scriptMs).toBeGreaterThan(1)`, render-perf-ms.spec.ts); the ACK half was not.
 *
 * A drive that delivered no measurable ack is a broken measurement, and this library's standing rule
 * is that the danger is never a wrong number but a comfortable zero — the jsxDEV splice and the
 * devtools hook both hard-fail rather than report 0. Extracted so the refusal is testable without
 * a browser (TEST-N5), the same way `assertScalingLegsNonVacuous` is tested by TEST-N4.
 */
export function wheelAckQuantiles(ackMs: readonly number[]): { p50: number; p90: number; max: number } {
  const sorted = [...ackMs].sort((a, b) => a - b)
  if (sorted.length === 0)
    throw new Error(
      'wheel-ack latency sample is EMPTY: the drive delivered no measurable ack, so p50/p90/max ' +
        'would read 0 and satisfy the wheel-ack budget without measuring anything. REFUSING to ' +
        'report a comfortable zero.',
    )
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  return { p50: q(0.5), p90: q(0.9), max: sorted[sorted.length - 1] }
}

/** Park the pointer at `(x, y)` and let whatever that provokes (hover, tooltip) settle.
 *
 *  Separated from `driveWheels` so a probe can start its measurement window AFTER the settle — the
 *  commit counter needs a window that contains wheels and nothing else.
 *
 *  MEASURED, three windows x {10, 20, 40} wheels on `#render-perf ?panes=4&points=20000`:
 *
 *    | window                                   | 10 | 20 | 40 |
 *    |------------------------------------------|----|----|----|
 *    | settle + wheels both INSIDE               | 11 | 21 | 41 |
 *    | settle OUTSIDE, no warm-up wheel          | 11 | 21 | 41 |
 *    | settle + ONE warm-up wheel OUTSIDE        | 10 | 20 | 40 |
 *
 *  So the +1 is NOT the pointer move: taking the settle out of the window changes nothing. It is the
 *  FIRST WHEEL (the camera leaving its initial state), and it is a constant, not a rate — including
 *  it makes the ratio a function of drive length (1.10 / 1.05 / 1.025), which is a property of the
 *  harness. `TEST-P5` therefore drives one warm-up wheel outside the window as well. */
export async function settlePointer(page: Page, at: { x: number; y: number }, ms = 800): Promise<void> {
  await page.mouse.move(at.x, at.y)
  await page.waitForTimeout(ms)
}

/** Drive the canonical wheel gesture at `(x, y)`, returning the per-step ack latencies. */
export async function driveWheels(
  page: Page,
  opts: { x: number; y: number; steps?: number; gapMs?: number; preSettle?: boolean; deltaY?: number },
): Promise<number[]> {
  const steps = opts.steps ?? CANONICAL_STEPS
  const gap = opts.gapMs ?? CANONICAL_GAP_MS
  const dy = opts.deltaY ?? -120
  if (opts.preSettle !== false) await settlePointer(page, opts)
  const ack: number[] = []
  for (let i = 0; i < steps; i++) {
    const t = Date.now()
    await page.mouse.wheel(0, dy)
    ack.push(Date.now() - t)
    await page.waitForTimeout(gap)
  }
  await page.waitForTimeout(800)
  return ack
}

/** The grid's dev-only per-cell camera (`GridDeckLayer` installs `window.__VIZ_GRID_VIEW__` under
 *  `import.meta.env.DEV`). One `[zoom, targetX, targetY]` per cell. `null` when the hook is absent. */
async function readGridCamera(page: Page): Promise<Record<string, [number, number, number]> | null> {
  return page.evaluate(() => {
    const v = (
      window as unknown as {
        __VIZ_GRID_VIEW__?: { zoom?: Record<string, number>; target?: Record<string, number[]> }
      }
    ).__VIZ_GRID_VIEW__
    if (!v?.zoom || !v.target) return null
    const out: Record<string, [number, number, number]> = {}
    for (const [id, zoom] of Object.entries(v.zoom)) {
      const t = v.target[id] ?? []
      out[id] = [zoom, t[0] ?? Number.NaN, t[1] ?? Number.NaN]
    }
    return out
  })
}

/** Drive `steps` wheels IN and the same number back OUT, leaving the camera where it started —
 *  and PROVE it did.
 *
 *  For behavioural assertions ONLY, never for a budget. A one-way drive zooms deep, and at that zoom
 *  the visible world region can legitimately contain ZERO points — so "no tooltip appears" would
 *  report the fixture's occupancy, not whether hover survived the gesture. MEASURED on `#render-perf
 *  ?panes=4&points=20000`: a full-pane 7x7 hover scan finds a tooltip before the gesture, finds
 *  NOTHING after 5 one-way wheels, and finds one again after those same 5 in + 5 back out.
 *  Returning the camera is what isolates the property under test.
 *
 *  WHY THE RETURN IS NOW ASSERTED (ITEM-16). "Leaving the camera where it started" was a CLAIM, and
 *  at `steps = 20` on this fixture it was FALSE. The camera's zoom is clamped to `[MIN_ZOOM,
 *  MAX_ZOOM] = [-2, 12]` (`linkZoom.ts`) and the story starts at zoom 4, i.e. ~12.9 wheels of
 *  zoom-in headroom at the measured 0.620 levels/wheel. Twenty wheels therefore CLAMP on the way in
 *  and do NOT clamp on the way out: measured, the camera came back at zoom -0.403 / target
 *  (0.63, -20.47) instead of zoom 4 / (0, 0) — 21x zoomed OUT and panned. At that camera the whole
 *  20k-point cloud is a ~23 px blob, a full-pane 7x7 scan has a 43-65 px pitch, and "no tooltip"
 *  reports whether a grid node happened to land on the blob. That is EXACTLY the occupancy confound
 *  this helper exists to remove, reintroduced silently by a step count nobody re-measured.
 *
 *  So the contract is now enforced, not documented: a round trip that does not restore zoom AND
 *  target throws, naming the drift. It refuses to run at all without the camera reader, because a
 *  guard that silently skips is how the confound got back in the first time. (`target` matters as
 *  much as `zoom`: `clampViewState` clamps only the zoom and keeps the cursor-anchored target deck
 *  computed for the UNCLAMPED zoom, so wheels spent against the ceiling still PAN the view.) */
export async function driveWheelsRoundTrip(
  page: Page,
  opts: { x: number; y: number; steps?: number; gapMs?: number },
): Promise<void> {
  const steps = opts.steps ?? 5
  const gap = opts.gapMs ?? CANONICAL_GAP_MS
  const before = await readGridCamera(page)
  if (!before || Object.keys(before).length === 0) {
    throw new Error(
      'driveWheelsRoundTrip: window.__VIZ_GRID_VIEW__ is absent, so the round trip cannot be ' +
        'verified. Refusing to run rather than silently degrade to an unverified drive — an ' +
        'unverified "round trip" is what turned this helper into an occupancy lottery once already.',
    )
  }
  await driveWheels(page, { ...opts, steps, gapMs: gap, deltaY: -120 })
  await driveWheels(page, { ...opts, steps, gapMs: gap, deltaY: 120, preSettle: false })
  const after = await readGridCamera(page)
  // Tolerance: a clean round trip returns to float noise (measured 6.7e-16 on target, exact on
  // zoom). 1e-6 is far above that and far below any drift a clamp can produce (the observed clamp
  // drift was 4.4 zoom levels / 20 world units).
  const EPS = 1e-6
  const drift = Object.entries(before)
    .map(([id, b]) => {
      const a = after?.[id]
      if (!a) return `${id}: cell disappeared during the gesture`
      const [dz, dx, dy] = [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
      return Math.abs(dz) > EPS || Math.abs(dx) > EPS || Math.abs(dy) > EPS
        ? `${id}: zoom ${b[0]} -> ${a[0]}, target (${b[1]}, ${b[2]}) -> (${a[1]}, ${a[2]})`
        : ''
    })
    .filter(Boolean)
  if (drift.length > 0) {
    throw new Error(
      `driveWheelsRoundTrip(steps=${steps}) did NOT return the camera, so anything measured after ` +
        'it reports the fixture at a DIFFERENT camera rather than the behaviour under test. The ' +
        'usual cause is that `steps` exceeds the MIN_ZOOM/MAX_ZOOM headroom from the start zoom, ' +
        `so the IN leg clamps and the OUT leg does not. Drift:\n  ${drift.join('\n  ')}`,
    )
  }
}

/** Open the showcase at a story with an explicit query string, and wait for deck to settle.
 *  Uses a direct URL (not a sidebar click) because `?panes=` must be present at FIRST paint —
 *  the story reads it once at mount. */
export async function openPerfStory(
  page: Page,
  storyId: string,
  query: Record<string, string | number> = {},
  opts: { settleMs?: number; baseUrl?: string } = {},
): Promise<void> {
  const qs = new URLSearchParams(
    Object.entries(query).map(([k, v]) => [k, String(v)]),
  ).toString()
  const base = opts.baseUrl ?? ''
  await page.goto(`${base}/viz-showcase.html${qs ? `?${qs}` : ''}#${storyId}`, {
    waitUntil: 'load',
  })
  await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 30_000 })
  await page.waitForTimeout(opts.settleMs ?? 7000)
}

/** deck.gl's canvas — the ONE surface in a pane that owns the camera. */
const DECK_CANVAS_ID = 'deckgl-overlay'

/** Candidate aim points inside a pane, as (fx, fy) fractions of its box, tried IN ORDER.
 *
 *  The geometric CENTRE is first, so every pane count whose centre already lands on the camera
 *  surface is aimed at exactly the point it was aimed at before this scan existed — measured: at
 *  1 / 2 / 4 panes the centre hits `canvas#deckgl-overlay` and the scan returns on its first
 *  candidate, so those legs are byte-identical to the pre-scan harness. */
const AIM_FRACTIONS: readonly (readonly [number, number])[] = [
  [0.5, 0.5],
  [0.5, 0.72],
  [0.28, 0.72],
  [0.72, 0.72],
  [0.28, 0.5],
  [0.72, 0.5],
  [0.5, 0.28],
  [0.28, 0.28],
  [0.72, 0.28],
]

/**
 * An aim point inside pane `index` that is VERIFIED to sit on deck's camera surface.
 *
 * WHY THE GEOMETRIC CENTRE IS NOT ENOUGH (the E(8)=0 defect). A pane contains overlay canvases —
 * the in-cell legend (`viz-incell-legend`) and the colormap strip — plus its toolbar, all stacked
 * ABOVE deck's canvas. Those overlays are FIXED-SIZE while the pane shrinks with the pane count,
 * so at 8 panes (242x325) the legend (120x164, anchored near the pane's top-left) SWALLOWS the
 * geometric centre. MEASURED on `#render-perf?panes=8&points=20000`, viewport 1280x720:
 * `elementFromPoint(416.75, 227.25)` = `CANVAS[data-testid=viz-incell-legend]`, and the drive then
 * delivered its full 20 wheels (`wheels=20`) to an element that does not move the camera —
 * producing `total=0`, `perWheel=0`. That zero is not a small number, it is a NON-MEASUREMENT, and
 * because TEST-P6's slope is `(E(8) - E(1)) / 7` it drove the slope NEGATIVE and passed the gate
 * vacuously. Delivered-wheel count could not catch it either: the wheels WERE delivered.
 *
 * So the aim point is CHECKED, not assumed: scan `AIM_FRACTIONS` until `elementFromPoint` resolves
 * to `canvas#deckgl-overlay`, and throw with the occluder's identity if no candidate does. A pane
 * whose camera is unreachable is a broken fixture, and the only honest report is a hard failure —
 * never a comfortable, budget-passing 0 (the same rule as `assertApplied`).
 */
export async function paneCentre(page: Page, index: number): Promise<{ x: number; y: number }> {
  const box = await page.locator('[data-viz-cell]').nth(index).boundingBox()
  if (!box) throw new Error(`pane ${index} has no bounding box — the fixture did not render`)
  const tried: string[] = []
  for (const [fx, fy] of AIM_FRACTIONS) {
    const pt = { x: box.x + box.width * fx, y: box.y + box.height * fy }
    const hit = await page.evaluate(
      ({ x, y, id }) => {
        const el = document.elementFromPoint(x, y)
        if (!el) return { ok: false, what: 'nothing (point is outside the viewport)' }
        const ok = el.closest(`canvas#${id}`) != null
        const testId = el.getAttribute('data-testid')
        return {
          ok,
          what: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${testId ? `[${testId}]` : ''}`,
        }
      },
      { x: pt.x, y: pt.y, id: DECK_CANVAS_ID },
    )
    if (hit.ok) return pt
    tried.push(`(${fx},${fy})→${hit.what}`)
  }
  throw new Error(
    `pane ${index} (box ${JSON.stringify(box)}) exposes NO point on canvas#${DECK_CANVAS_ID}: every ` +
      `candidate is occluded by pane chrome. A wheel driven here is delivered but never reaches the ` +
      `camera, which reports 0 elements/wheel and false-greens every scaling budget. Tried: ${tried.join(', ')}`,
  )
}

/** One pane-count leg of the O(1)-in-panes scaling measurement. */
export interface ScalingLeg {
  panes: number
  /** elements created per delivered wheel — the figure the slope is fitted over. */
  perWheel: number
  /** wheels the page actually received during the measured window. */
  wheels: number
  /** raw `jsxDEV` calls during the measured window. */
  total: number
}

/**
 * HARD-FAIL a scaling measurement whose legs cannot support a slope. Called BEFORE the slope
 * arithmetic, because arithmetic over a non-measurement produces a number that looks like a result.
 *
 * Three independent ways a leg can be a non-measurement, each of which has to be its own check:
 *
 *  1. **the drive did not happen** — fewer (or more) wheels than asked for. Cheap, and the first
 *     thing to rule out.
 *  2. **the drive happened but reached nothing** — wheels delivered, zero elements created. This is
 *     the E(8)=0 defect exactly: check (1) passed at 20/20 wheels while the leg measured nothing.
 *  3. **a leg COLLAPSED relative to the others** — not zero, but a fraction of what the SMALLEST
 *     pane count measured. Elements per wheel are per-pane chrome plus a fixed base, so no leg can
 *     honestly read below the 1-pane leg by much; a leg that does is a partially-occluded aim point,
 *     not a result.
 *
 * The floor for (3) is deliberately anchored to the 1-pane leg rather than to a spread between legs:
 * the PRE-split reality is a large POSITIVE spread (E(8) many times E(1)) and the POST-split success
 * condition is all four legs roughly equal, so both must pass. It also bounds how negative the slope
 * can be — an inherently suspect direction, since more panes cannot create fewer elements.
 */
export function assertScalingLegsNonVacuous(
  legs: readonly ScalingLeg[],
  expectedWheels: number,
  /** how far below the 1-pane leg any other leg may sit before it is judged a collapse. */
  collapseFloorRatio = 0.5,
): void {
  const table = legs
    .map(l => `${l.panes}p:{perWheel=${l.perWheel.toFixed(1)} wheels=${l.wheels} total=${l.total}}`)
    .join(' ')
  if (legs.length === 0) throw new Error('scaling measurement produced no legs at all')

  for (const l of legs) {
    if (l.wheels !== expectedWheels)
      throw new Error(
        `the ${l.panes}-pane drive delivered ${l.wheels} wheels, expected ${expectedWheels}. The ` +
          `per-wheel ratio divides by the delivered count, so a short (or missing) drive silently ` +
          `rescales the leg. Legs: ${table}`,
      )
    if (!(l.perWheel > 0))
      throw new Error(
        `the ${l.panes}-pane leg measured ${l.perWheel} elements/wheel from ${l.total} elements over ` +
          `${l.wheels} delivered wheels. Wheels reached the page but created NOTHING, so the wheel ` +
          `landed on something that is not deck's camera (an in-cell legend/colormap overlay, or the ` +
          `pane toolbar). REFUSING to feed a non-measurement into the slope — a zero leg drags the ` +
          `slope negative and passes the O(1) gate vacuously. Legs: ${table}`,
      )
  }

  const base = legs.reduce((a, b) => (a.panes <= b.panes ? a : b))
  const floor = base.perWheel * collapseFloorRatio
  for (const l of legs) {
    if (l.perWheel < floor)
      throw new Error(
        `the ${l.panes}-pane leg measured ${l.perWheel.toFixed(1)} elements/wheel, below ${floor.toFixed(1)} ` +
          `(${collapseFloorRatio}x the ${base.panes}-pane leg). More panes cannot create fewer elements, so ` +
          `this leg is under-measuring — most likely a partially-occluded aim point. Legs: ${table}`,
      )
  }
}

/** Read the committed budgets file. Single source for both legs + the unit schema test. */
export function budgetsPath(): string {
  return new URL('../../../libs/viz/scripts/render-perf-budgets.json', import.meta.url).pathname
}

// ── INV-11: the per-split checkpoint ledger ──────────────────────────────────────────────────────
//
// "every one of the six splits records a complete checkpoint written BY the harness —
// `{behavioural, counters, msRatio, structural}` — into `scripts/render-perf-splits.json`, and the
// structural thresholds are monotonically non-increasing across splits."
//
// Three properties this writer has, each because the alternative is a ledger that lies:
//
//  1. **It refuses to write a PARTIAL checkpoint.** The counters come from three separate tests
//     (TEST-P1 / TEST-P5 / TEST-P6). A `--grep`-filtered run contributes one or two of them, and a
//     ledger entry written from a subset would record a green `counters` field that nothing measured.
//     `writeSplitCheckpoint` throws unless all three contributed in THIS process.
//  2. **It never invents the two fields it cannot measure.** The counter leg cannot produce the ms
//     ratio (DEC-2 makes it throw) and knows nothing about the behavioural sweep. Those arrive
//     through `RENDER_PERF_SPLIT_MS_RATIO` / `RENDER_PERF_SPLIT_BEHAVIOURAL`, and are recorded as
//     `null` when absent — which lands the entry as `complete: false`. A missing field is INV-11's
//     own definition of "not landed", so the honest representation of "not measured" is a hole in
//     the ledger, not a plausible-looking value.
//  3. **It enforces the ratchet at WRITE time.** A structural threshold that rose relative to the
//     previous entry throws rather than being recorded, so the monotonicity clause cannot be
//     violated by the act of recording.

interface SplitCounterContribution {
  readonly metric: string
  readonly value: number
  readonly budget: number
  readonly pass: boolean
}

const splitCounters = new Map<string, SplitCounterContribution>()

/** Where a run's contributions are PERSISTED, and why an in-memory Map is not enough.
 *
 *  Playwright RESTARTS THE WORKER PROCESS after a failed test. `splitCounters` lives in module
 *  scope, so every contribution made before the first failure dies with that worker — and the split
 *  whose counters are legitimately RED is exactly the split that has a failure. Measured at Split
 *  `0a`: TEST-P5 passed and contributed, TEST-P6 then failed, the worker restarted, TEST-P1 ran in
 *  a fresh process, and `afterAll` saw ONE of three contributions and refused the checkpoint. The
 *  amended INV-11 requires the MEASURED state to be recorded green OR red, so the contributions
 *  have to outlive the worker.
 *
 *  This does NOT weaken the anti-fabrication rule. The writer still refuses when a required test
 *  did not contribute AT ALL (never run — a `--grep` subset, a rename), because that is the case
 *  where the field would record a verdict nothing measured. It now distinguishes that from "the
 *  test RAN, measured a real figure, and failed its budget", which IS a measurement and must be
 *  recorded. A red field is data; a missing field is a lie. */
function contribSidecarPath(): string {
  const split = process.env.RENDER_PERF_RECORD_SPLIT ?? 'unnamed'
  return `${splitsLedgerPath()}.contrib-${split}.json`
}

/** Called by each counter test with the figure it just asserted — and deliberately called BEFORE
 *  that assertion, so a failing budget still lands its measured value. The KEY is the test id,
 *  which is what lets the writer prove all three legs ran. */
export function contributeSplitCounter(testId: string, c: SplitCounterContribution): void {
  splitCounters.set(testId, c)
  if (!process.env.RENDER_PERF_RECORD_SPLIT) return
  const p = contribSidecarPath()
  let acc: Record<string, SplitCounterContribution> = {}
  if (existsSync(p)) {
    try {
      acc = JSON.parse(readFileSync(p, 'utf8')) as Record<string, SplitCounterContribution>
    } catch {
      acc = {}
    }
  }
  acc[testId] = c
  writeFileSync(p, `${JSON.stringify(acc, null, 2)}\n`)
}

export function splitsLedgerPath(): string {
  return new URL('../../../libs/viz/scripts/render-perf-splits.json', import.meta.url).pathname
}

/** The three tests whose figures make up the `counters` field. Named, not counted, so a renamed test
 *  fails loudly instead of silently reducing the requirement. */
const REQUIRED_COUNTER_TESTS = ['TEST-P1', 'TEST-P5', 'TEST-P6'] as const

export async function writeSplitCheckpoint(splitName: string): Promise<void> {
  const { execFileSync } = await import('node:child_process')

  // Merge the in-process Map with the cross-worker sidecar. The sidecar is authoritative for any
  // test that ran in an EARLIER worker (Playwright restarts the worker after a failure), the Map
  // for the current one; they never disagree about a given id because each id is written once.
  const contributions = new Map<string, SplitCounterContribution>(splitCounters)
  const sidecar = contribSidecarPath()
  if (existsSync(sidecar)) {
    try {
      const acc = JSON.parse(readFileSync(sidecar, 'utf8')) as Record<string, SplitCounterContribution>
      for (const [k, v] of Object.entries(acc)) if (!contributions.has(k)) contributions.set(k, v)
    } catch {
      /* a corrupt sidecar is treated as absent — the missing-test check below then refuses. */
    }
  }

  const missing = REQUIRED_COUNTER_TESTS.filter(t => !contributions.has(t))
  if (missing.length > 0) {
    throw new Error(
      `REFUSING to write the ${splitName} checkpoint: ${missing.join(', ')} did not contribute in this ` +
        `run. The counters field would record a verdict nothing measured — run the FULL spec, not a ` +
        `--grep subset, when recording a split (INV-11). NOTE: a test that RAN and FAILED its budget ` +
        `does contribute (its red figure is a measurement); only a test that never ran lands here.`,
    )
  }

  const budgetsFile = budgetsPath()
  const budgets = JSON.parse(readFileSync(budgetsFile, 'utf8'))
  const gridDir = new URL('../../../libs/viz/src/viz-core/grid/', import.meta.url).pathname
  const shell = readFileSync(`${gridDir}GridWorkspace.tsx`, 'utf8')
  const shellLines = shell.split('\n').length
  // The component BODY, delimited exactly as INV-10 (b) measures it: the exported component's
  // opening line to the seam-provider return that closes it.
  const bodyStart = shell.split('\n').findIndex(l => l.startsWith('export function GridWorkspace('))
  const bodyEnd = shell.split('\n').findIndex(l => l.includes('return <GridWorkspaceSeamProvider value={seam}>'))
  if (bodyStart < 0 || bodyEnd < 0) throw new Error('could not delimit the GridWorkspace component body')
  const bodyLines = bodyEnd - bodyStart + 2

  const layerFiles: string[] = budgets.structural.layerFiles
  const layersPresent = layerFiles.filter(f => existsSync(`${gridDir}${f}`))

  const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gridDir, encoding: 'utf8' }).trim()

  // TRIMMED-AND-EMPTY IS NOT MEASURED (FIX_ROUND-2 / C18). These were read raw and tested with
  // `!= null`, so `RENDER_PERF_SPLIT_BEHAVIOURAL=''` recorded `behavioural: ''` and `complete: true`
  // with nothing behind it — and this writer's own rule is that a missing field is a hole, "never
  // filled with a plausible value". An empty string is a plausible value.
  const envMeasured = (v: string | undefined): string | null => {
    const t = v?.trim()
    return t ? t : null
  }
  const msRatioEnv = envMeasured(process.env.RENDER_PERF_SPLIT_MS_RATIO)
  const behaviouralEnv = envMeasured(process.env.RENDER_PERF_SPLIT_BEHAVIOURAL)

  const structural = {
    shellFileLines: shellLines,
    shellBodyLines: bodyLines,
    finalCapFileLines: budgets.structural.gridWorkspaceFileLines,
    finalCapBodyLines: budgets.structural.gridWorkspaceBodyLines,
    layersPresent: layersPresent.length,
    layersDeclared: layerFiles.length,
    /** INV-10 (a) + (d) are asserted by `gridDecomposition.test.ts`; (b) is the numeric cap, and this
     *  is the field that says whether it is MET. It is recorded rather than asserted here on purpose:
     *  a budget that is not met must be visible in the ledger, never relaxed in the budgets file. */
    meetsFinalCap: shellLines <= budgets.structural.gridWorkspaceFileLines &&
      bodyLines <= budgets.structural.gridWorkspaceBodyLines,
    green: layersPresent.length === layerFiles.length,
  }

  // Ordered by REQUIRED_COUNTER_TESTS so a checkpoint's counters field has a stable key order
  // regardless of which worker measured which leg.
  const counters = Object.fromEntries(
    REQUIRED_COUNTER_TESTS.map(t => [t, contributions.get(t) as SplitCounterContribution]),
  )
  const countersGreen = REQUIRED_COUNTER_TESTS.every(t => contributions.get(t)?.pass === true)

  const ledger: {
    _readme: string
    splits: Record<string, unknown>
  } = existsSync(splitsLedgerPath())
    ? JSON.parse(readFileSync(splitsLedgerPath(), 'utf8'))
    : {
        _readme:
          'INV-11 checkpoint ledger. WRITTEN BY THE HARNESS (RENDER_PERF_RECORD_SPLIT=<name> npx playwright ' +
          'test --config=playwright.viz.config.ts render-perf.spec.ts), never hand-authored. One entry per ' +
          'split (0a, 0b, A, B, C, D, E). A null field means NOT MEASURED, which is what makes the entry ' +
          'incomplete — it is never filled with a plausible value. Structural thresholds are monotonically ' +
          'non-increasing across entries; the writer throws rather than recording a rise.',
        splits: {},
      }

  // The ratchet, enforced at write time against the most recent entry that has one.
  const prior = Object.values(ledger.splits) as Array<{ structural?: { shellFileLines?: number } }>
  const priorMin = prior
    .map(p => p.structural?.shellFileLines)
    .filter((n): n is number => typeof n === 'number')
  if (priorMin.length > 0 && shellLines > Math.min(...priorMin)) {
    throw new Error(
      `REFUSING to record ${splitName}: the shell is ${shellLines} lines, above the lowest already-recorded ` +
        `${Math.min(...priorMin)}. INV-11 requires monotonically non-increasing structural thresholds — a ` +
        `rise is regrowth, and recording it would launder it.`,
    )
  }

  ledger.splits[splitName] = {
    gitSha,
    recordedAt: new Date().toISOString(),
    recordedBy: 'render-perf.spec.ts (counter leg)',
    counters,
    countersGreen,
    structural,
    // NOT MEASURED BY THIS LEG — supplied by the run that produced them, or null. See (2) above.
    // …and a non-numeric ms ratio is likewise not a measurement: `Number('abc')` is `NaN`, which
    // `JSON.stringify` writes as `null` anyway — recorded as an explicit null instead of relying on
    // that coincidence.
    msRatio: msRatioEnv != null && Number.isFinite(Number(msRatioEnv)) ? Number(msRatioEnv) : null,
    behavioural: behaviouralEnv,
    complete:
      countersGreen &&
      structural.green &&
      msRatioEnv != null &&
      Number.isFinite(Number(msRatioEnv)) &&
      behaviouralEnv != null,
  }

  writeFileSync(splitsLedgerPath(), `${JSON.stringify(ledger, null, 2)}\n`)
  // The sidecar is per-run scratch, not an artifact. Removing it on success means a LATER run for
  // the same split cannot inherit a stale contribution and pass the missing-test check without
  // having measured anything — the exact fabrication the check exists to prevent.
  if (existsSync(sidecar)) unlinkSync(sidecar)
  // eslint-disable-next-line no-console
  console.log(
    `[INV-11] wrote checkpoint '${splitName}' (countersGreen=${countersGreen}) -> ${splitsLedgerPath()}`,
  )
}
