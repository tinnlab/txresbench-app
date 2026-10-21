// render-perf.spec.ts — the COUNTER leg (ITEM-8): element creations + React commits per wheel.
//
// Every budget here is a COUNT, never a millisecond. Counts are bit-deterministic (the recapture's
// two runs agreed exactly: 2 492 / 2 492) and machine-independent, which is why the load-swinging
// shared box this runs on cannot corrupt them. The millisecond leg lives in `render-perf-ms.spec.ts`
// and refuses to report counts, exactly as this leg refuses to report milliseconds (DEC-2).
//
// Budgets are read from `libs/viz/scripts/render-perf-budgets.json` so the gate and the
// recorded baseline can never drift apart; `renderPerfBudgets.test.ts` proves each budget is
// STRICTER than the baseline it sits beside (a budget looser than its own baseline is a no-op).

import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { ScalingLeg } from './_renderPerf'
import {
  assertScalingLegsNonVacuous,
  contributeSplitCounter,
  COUNTER_GAP_MS,
  COUNTER_STEPS,
  driveWheels,
  driveWheelsRoundTrip,
  installCommitCounter,
  installElementCounter,
  installTimingProbe,
  needsBenchServer,
  openPerfStory,
  paneCentre,
  settlePointer,
  wheelAckQuantiles,
  writeSplitCheckpoint,
} from './_renderPerf'

const BUDGETS = JSON.parse(
  readFileSync(new URL('../../../libs/viz/scripts/render-perf-budgets.json', import.meta.url), 'utf8'),
) as {
  baseline: Record<string, number>
  budgets: Record<string, number>
}

/** The chrome components INV-1 forbids the camera from touching. */
const CHROME = ['PaneToolbar', 'CellView'] as const
/** TEST-P2: the chrome's TRANSITIVE CHILDREN. `CHROME` above is the two memo ROOTS; these are the
 *  leaf components the design source §2.1 baselined at 252/136/136/68/60/24 per wheel before the
 *  fix. Roots at 0 with this family still churning would make the headline result false, so the
 *  subtree is pinned by name rather than inferred from the aggregate total. */
const CHROME_DESCENDANTS = [
  'Button',
  'TooltipProvider',
  'TooltipTrigger',
  'TooltipContent',
  'SelectItem',
  'SelectTrigger',
] as const
/** The overflow-container family INV-3 forbids allocating when nothing folds. RE-CAPTURED
 *  2026-07-28: this subtree went 0 → 96/wheel and is the ENTIRE +140 element delta this month.
 *  A budget written only against `MenuRowButton` would have gone green while it stayed. */
const OVERFLOW_FAMILY = [
  'Popover',
  'PopoverTrigger',
  'PopoverContent',
  'PopoverRoot',
  'PopoverPopup',
  'PopoverPositioner',
  'PopoverPortal',
  'Ellipsis',
] as const

test.describe('render-perf — counter leg', () => {
  // ── TEST-1 (ITEM-9): the fixture is what the URL asked for ───────────────────────────────
  // Every budget below divides by a pane count. If the story silently rendered 4 panes when the
  // URL said 8, the slope in TEST-P6 is measured against the wrong denominator and reads green.
  for (const panes of [1, 2, 4, 8] as const) {
    test(`TEST-1 render-perf renders exactly ${panes} pane(s) with chrome`, async ({ page }) => {
      await openPerfStory(page, 'render-perf', { panes, points: 20_000 })

      const handle = await page.evaluate(
        () => (window as unknown as { __VIZ_RENDER_PERF__?: { panes: number; points: number; cellIds: string[] } }).__VIZ_RENDER_PERF__,
      )
      expect(handle, 'the story must publish __VIZ_RENDER_PERF__').toBeTruthy()
      expect(handle!.panes, 'published pane count must match the URL').toBe(panes)
      expect(handle!.points).toBe(20_000)
      expect(handle!.cellIds).toHaveLength(panes)

      await expect(page.locator('[data-viz-cell]')).toHaveCount(panes)
      await expect(page.locator('[data-testid^="viz-cell-view-"]')).toHaveCount(panes)
      await expect(page.locator('[data-testid^="viz-pane-toolbar-"]')).toHaveCount(panes)
      await expect(page.locator('[data-testid^="viz-pane-toolbar-"]').first()).toBeVisible()
    })
  }

  // ── TEST-N1 (ITEM-8): the element probe HARD-FAILS when its splice does not apply ────────
  // The single most dangerous failure mode in this feature: a React bump makes the anchor stop
  // matching, every element budget reads 0, and the whole suite certifies the regression.
  test('TEST-N1 element counter hard-fails on a non-applying splice (never reports 0)', async ({ page }) => {
    const counter = await installElementCounter(page, {
      anchor: /exports\.jsxDEV = function \(THIS_WILL_NEVER_MATCH\)/,
    })
    await openPerfStory(page, 'render-perf', { panes: 1, points: 20_000 }, { settleMs: 3000 })

    expect(counter.requestsSeen(), 'the dev JSX runtime must have been served at all').toBeGreaterThan(0)
    expect(counter.applied(), 'the deliberately-wrong anchor must not have applied').toBe(false)
    expect(() => counter.assertApplied()).toThrow(/jsxDEV probe did not apply/)

    // And prove the consequence the hard-fail exists to prevent: without it, this is what the
    // budget would have read.
    await counter.begin()
    await driveWheels(page, { ...(await paneCentre(page, 0)), steps: 3, gapMs: 100 })
    const r = await counter.end()
    expect(r.total, 'an unpatched runtime reports a comfortable, budget-passing 0').toBe(0)
  })

  // ── TEST-N2 (ITEM-8): the commit probe hard-fails when React never injected ───────────────
  test('TEST-N2 commit counter hard-fails when React never called inject', async ({ page }) => {
    const commits = await installCommitCounter(page)
    await openPerfStory(page, 'render-perf', { panes: 1, points: 20_000 }, { settleMs: 3000 })

    // Positive control first: in a real dev build React DOES inject, so the guard is not simply
    // always-throwing.
    await commits.assertInjected()

    // Now simulate the failure the guard exists for (React ignored the hook) and prove it throws
    // rather than reporting a plausible 0 commits/wheel.
    await page.evaluate(() => {
      ;(globalThis as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: { renderers: Map<number, unknown> } }).__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.clear()
    })
    await expect(commits.assertInjected()).rejects.toThrow(/commit probe did not attach/)
  })

  // ── TEST-N3 (ITEM-8/ITEM-19): the dev leg REFUSES to produce milliseconds (DEC-2) ─────────
  test('TEST-N3 the counter leg refuses to report script duration', async ({ page }) => {
    await expect(installTimingProbe(page, { mode: 'dev' })).rejects.toThrow(/script-duration is PROD-ONLY/)
    // …and the converse refusal is real too, so neither leg can quietly serve both.
    await expect(installElementCounter(page, { mode: 'prod' })).rejects.toThrow(/element counters are DEV-ONLY/)
  })

  // ── TEST-3 (ITEM-11): the recapture is reproducible ───────────────────────────────────────
  // A baseline that is not reproducible cannot anchor a budget. Counter metrics must agree
  // EXACTLY across two consecutive drives in one session.
  test('TEST-3 two consecutive counter drives agree exactly', async ({ page }) => {
    test.setTimeout(220_000)
    const counter = await installElementCounter(page)
    await openPerfStory(page, 'render-perf', { panes: 4, points: 20_000 })
    counter.assertApplied()
    const at = await paneCentre(page, 0)

    await counter.begin()
    await driveWheels(page, { ...at, steps: COUNTER_STEPS, gapMs: COUNTER_GAP_MS })
    const a = await counter.end()

    await counter.begin()
    await driveWheels(page, { ...at, steps: COUNTER_STEPS, gapMs: COUNTER_GAP_MS })
    const b = await counter.end()

    expect(a.total, 'counter metrics are deterministic — this is why they, not ms, are the gate').toBe(b.total)
    // THE POSITIVE CONTROL THIS TEST LACKED (FIX_ROUND-2 / C3). `expect(a.byComponent.X).toBe(
    // b.byComponent.X)` was `undefined === undefined` whenever the name was absent — so for the two
    // components the whole feature gates on, TEST-3 certified nothing exactly when their display
    // names were unpinned, which is the failure it is supposed to be the backstop for. A wheel drive
    // is camera-only, so the honest premise is not "the names are non-zero here" (INV-1 requires 0)
    // but "the counter CAN SEE these names on this page at all": asserted against a non-camera
    // mutation below.
    for (const name of CHROME) {
      expect(a.byComponent[name] ?? 0, `${name} must be a NUMBER in both runs, not undefined`).toBe(b.byComponent[name] ?? 0)
    }
    // The names must be RESOLVABLE — proven by a mutation that legitimately rebuilds the chrome,
    // measured OUTSIDE the two determinism drives so neither is disturbed.
    //
    // A VIEWPORT RESIZE, not a re-navigation. The first form written here re-opened the story with a
    // different pane count, and it measured ZERO: `openPerfStory` navigates, a navigation re-runs the
    // page's init script, and the counter's own tally is re-initialised to `{__on:false}` — so the
    // probe's window did not survive its own mutation. It went red rather than quietly reporting 0,
    // which is the whole reason this clause exists; recorded because "the probe measured nothing" and
    // "the names are unpinned" produce the identical 0 and only one of them is a defect. A resize
    // drives the shell's ResizeObserver → `measure()` → a real `setRects` → the pane chrome, in the
    // SAME document.
    const vp = page.viewportSize()!
    await counter.begin()
    await page.setViewportSize({ width: vp.width - 220, height: vp.height })
    await page.waitForTimeout(2_000)
    const chromeProbe = await counter.end()
    await page.setViewportSize(vp)
    for (const name of CHROME) {
      expect(
        chromeProbe.byComponent[name] ?? 0,
        `the counter cannot SEE '${name}' on this page — its memo displayName is unpinned, and every ` +
          '`?? 0` in this feature then reads a perfect score. This clause is the reason TEST-3 exists.',
      ).toBeGreaterThan(0)
    }
    // The WebGL renderer is recorded so a baseline can never be compared across backends.
    const renderer = await page.evaluate(() => {
      const c = document.createElement('canvas')
      const gl = c.getContext('webgl2') ?? c.getContext('webgl')
      if (!gl) return 'none'
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown'
    })
    expect(renderer, 'the blessed harness is software WebGL').toMatch(/swiftshader|software|llvmpipe|angle/i)
    console.log(`[TEST-3] renderer=${renderer} elements/wheel=${a.perWheel.toFixed(1)} (run2 ${b.perWheel.toFixed(1)})`)
  })

  // ── TEST-11 (ITEM-8): the control surface is sane on the counter leg ──────────────────────
  // `#scatter-basic` is the normalization denominator for every ratio budget. If it ever starts
  // creating chrome elements, every ratio silently loosens.
  test('TEST-11 the 200k control creates no chrome elements', async ({ page }) => {
    test.setTimeout(200_000)
    const counter = await installElementCounter(page)
    await openPerfStory(page, 'scatter-basic', { points: 200_000 }, { settleMs: 12_000 })
    counter.assertApplied()

    const box = await page.locator('canvas').first().boundingBox()
    expect(box, 'the control must have rendered a canvas').toBeTruthy()
    await counter.begin()
    await driveWheels(page, {
      x: box!.x + box!.width / 2,
      y: box!.y + box!.height / 2,
      steps: COUNTER_STEPS,
      gapMs: COUNTER_GAP_MS,
    })
    const r = await counter.end()

    // NON-MEASUREMENT PREMISE FIRST (FIX_ROUND-2 / C6). Every clause below is a `toBe(0)`, so a
    // page that rendered nothing interactive — or a wheel that landed off the camera surface —
    // reported PASS on a dead page. The bounding-box check above proves a canvas EXISTS; it does not
    // prove the wheel reached it. TEST-P5 (`r.wheels > COUNTER_STEPS/2`) and TEST-P3 (`total > 0`,
    // "or every zero below is a non-measurement") already apply this discipline two tests away, and
    // TEST-24 — this test's ms-leg twin — asserts `canvases >= 1`.
    expect(r.wheels, 'the wheel drive must have been DELIVERED, or every zero below is a non-measurement').toBeGreaterThan(
      COUNTER_STEPS / 2,
    )
    expect(r.total, 'the control must have created SOME elements — the camera-driven deck layer').toBeGreaterThan(0)
    for (const name of [...CHROME, 'Button']) {
      expect(r.byComponent[name] ?? 0, `control must not allocate ${name}`).toBe(0)
    }
    console.log(`[TEST-11] control elements/wheel=${r.perWheel.toFixed(1)} wheels=${r.wheels} total=${r.total}`)
  })

  // ── TEST-P4 (ITEM-3, INV-3): the overflow form is not built when nothing folds ────────────
  // WIDENED by the recapture: the budget covers the overflow CONTAINER, not just its rows.
  // `MenuRowButton` was already 96/wheel before this month; the container went 0 → 96/wheel and
  // is the entire regression. A `MenuRowButton`-only budget would pass on the defect.
  test('TEST-P4 no overflow allocation at a width where nothing folds', async ({ page }) => {
    test.setTimeout(220_000)
    await page.setViewportSize({ width: 1900, height: 900 })
    const counter = await installElementCounter(page)
    await openPerfStory(page, 'render-perf', { panes: 1, points: 20_000 })
    counter.assertApplied()

    // Establish the premise IN-TEST: nothing may be folded, or the budget is vacuous.
    await expect(page.locator('[data-testid^="viz-cell-overflow-"]')).toHaveCount(0)

    await counter.begin()
    await driveWheels(page, { ...(await paneCentre(page, 0)), steps: COUNTER_STEPS, gapMs: COUNTER_GAP_MS })
    const r = await counter.end()

    // NON-MEASUREMENT PREMISE (FIX_ROUND-2 / C7, half a): `offenders` is a FILTER, so an empty
    // `byComponent` yields an empty offenders list and this test reported PASS on a drive that never
    // happened. Asserted in its own clause so a red names the cause.
    expect(r.wheels, 'the wheel drive must have been DELIVERED, or the empty offender list is a non-measurement').toBeGreaterThan(
      COUNTER_STEPS / 2,
    )
    expect(r.total, 'the drive must have created SOME elements').toBeGreaterThan(0)
    // …and the fold premise must still hold AFTER the drive, not just before it: a fold triggered
    // mid-drive (a re-measure at a different width) would make the whole window off-premise.
    await expect(page.locator('[data-testid^="viz-cell-overflow-"]')).toHaveCount(0)

    const offenders = Object.entries(r.byComponent).filter(
      ([k, v]) => v > 0 && (k === 'MenuRowButton' || (OVERFLOW_FAMILY as readonly string[]).includes(k)),
    )
    expect(
      offenders,
      `nothing folds at this width, so the overflow subtree must allocate nothing. Got: ${JSON.stringify(offenders)}`,
    ).toEqual([])
    // THE BUDGET IS NOW READ (FIX_ROUND-2 / C7, half b). `budgets.overflowElementsWhenNothingFolds`
    // existed, was listed in `renderPerfBudgets.test.ts`'s KEYS_READ_BY_SPECS, and NO spec read it —
    // an inert number that looked like a gate. Gating the per-wheel TOTAL of the overflow family on
    // it makes editing that budget change this test's verdict, which is the only thing that makes a
    // budget a budget.
    //
    // KNOWN LIMIT, declared rather than implied: the family is still a NAME list, so an overflow
    // affordance re-implemented on a primitive not on it (a DropdownMenu, a base-ui Menu) is caught
    // by the DOM premise above and not by this sum. Lengthening the list is what the previous round
    // did; the list is not the gate, the DOM premise is.
    const overflowPerWheel = [...OVERFLOW_FAMILY, 'MenuRowButton'].reduce(
      (n, name) => n + (r.perWheelByComponent[name] ?? 0),
      0,
    )
    console.log(`[TEST-P4] overflow elements/wheel=${overflowPerWheel.toFixed(1)} total=${r.total} wheels=${r.wheels}`)
    expect(overflowPerWheel).toBeLessThanOrEqual(BUDGETS.budgets.overflowElementsWhenNothingFolds)
  })

  // ── TEST-P5 (ITEM-7, INV-4): one React commit per wheel ───────────────────────────────────
  //
  // Measured on the STEADY STATE, and that is a measurement correction rather than a budget
  // relaxation — the budget is still ≤ 1. The drive's very first wheel carries one extra commit
  // (the camera leaving its initial state), and it is provably a ONE-OFF, not a rate: driven at
  // 10 / 20 / 40 steps the totals were 11 / 21 / 41, i.e. a CONSTANT excess of exactly 1. Including
  // it would make the ratio a function of how long the drive is (1.10 / 1.05 / 1.025), which is a
  // property of the harness, not of the code. Contrast the pre-fix figure, which was a genuine rate:
  // 40 commits / 20 wheels = exactly 2.0, doubling with the drive length.
  //
  // BOTH figures RE-MEASURED at wave close, not carried forward from prose. 10/20/40 → 11/21/41 on
  // this tree; and 40 commits / 20 wheels = 2.000 with `libs/viz/src` checked out at 049f364c
  // (the commit before ITEM-2), measured through THIS window — i.e. the warm-up wheel is already
  // outside it, so the 2.0 is a rate and not the one-off. The one-off is the first wheel, not the
  // pointer settle: taking the settle out of the window on its own still reads 11/21/41 (see the
  // measured table on `settlePointer`).
  test('TEST-P5 at most one React commit per delivered wheel', async ({ page }) => {
    test.setTimeout(220_000)
    const commits = await installCommitCounter(page)
    await openPerfStory(page, 'render-perf', { panes: 4, points: 20_000 })
    await commits.assertInjected()

    // Settle the pointer and take one warm-up wheel, BOTH outside the measured window. The warm-up
    // wheel is the one that matters (it carries the camera-init commit); the settle is outside for
    // symmetry — measured, it contributes nothing either way.
    const at = await paneCentre(page, 0)
    await settlePointer(page, at)
    await driveWheels(page, { ...at, steps: 1, gapMs: COUNTER_GAP_MS, preSettle: false })
    await commits.begin()
    await driveWheels(page, { ...at, steps: COUNTER_STEPS, gapMs: COUNTER_GAP_MS, preSettle: false })
    const r = await commits.end()

    expect(r.wheels, 'the drive must actually have delivered wheels').toBeGreaterThan(COUNTER_STEPS / 2)
    console.log(`[TEST-P5] commits=${r.commits} wheels=${r.wheels} ratio=${r.commitsPerWheel.toFixed(2)} (baseline ${BUDGETS.baseline.commitsPerWheel})`)
    contributeSplitCounter('TEST-P5', {
      metric: 'commitsPerWheel',
      value: r.commitsPerWheel,
      budget: BUDGETS.budgets.commitsPerWheel,
      pass: r.commitsPerWheel <= BUDGETS.budgets.commitsPerWheel,
    })
    expect(r.commitsPerWheel).toBeLessThanOrEqual(BUDGETS.budgets.commitsPerWheel)
  })

  // ── TEST-9 (ITEM-7): hover still works during and after a camera gesture ──────────────────
  // The behavioural gate on ITEM-7. If the second commit turns out to be `setHovered`, the
  // tempting fix (suppress hover during a gesture) is a real behaviour change; this is what
  // forces it to be a deliberate, escalated one rather than a silent regression.
  test('TEST-9 hover survives the camera drive', async ({ page }) => {
    // Generous ON PURPOSE. Each probe of the scan below costs a real GPU pick under swiftshader, so
    // a FAILING run (three exhaustive 7x7 scans that find nothing) is several times the cost of a
    // passing one. Budgeted for the failing path: a red that arrives as a TIMEOUT inside
    // `page.mouse.move` is indistinguishable from a slow box and prints none of the diagnostics
    // below, which is exactly the kind of red nobody can act on. Verified: with hover deliberately
    // suppressed after the first camera change, this fails at the `during` assertion in ~4 min.
    test.setTimeout(900_000)
    await openPerfStory(page, 'render-perf', { panes: 4, points: 20_000 })
    const at = await paneCentre(page, 0)

    // The tooltip needs a POINT under the cursor, and the fixture is a stochastic cloud whose
    // occupancy at any one pixel changes as the camera moves — so the pane centre is not a reliable
    // hover target and a single-position probe measures the fixture, not the behaviour. Scan a small
    // neighbourhood until a tooltip appears; a scan that finds nothing anywhere is the real failure.
    const pane = await page.locator('[data-viz-cell]').first().boundingBox()
    expect(pane).toBeTruthy()
    const tooltip = page.locator('[data-testid="viz-tooltip"]')
    const findHover = async (): Promise<{ dx: number; dy: number } | null> => {
      const N = 7
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const dx = Math.round((i / (N - 1) - 0.5) * pane!.width * 0.8)
          const dy = Math.round((j / (N - 1) - 0.5) * pane!.height * 0.8)
          await page.mouse.move(at.x + dx, at.y + dy)
          await page.waitForTimeout(200)
          if ((await tooltip.count()) > 0 && (await tooltip.first().isVisible())) return { dx, dy }
        }
      }
      return null
    }

    // Baseline: hover works before any gesture. Without this the two assertions below could both
    // "pass" on a fixture that never had a hoverable point, which is a vacuous gate.
    const before = await findHover()

    // ROUND-TRIP gestures (in, then the same number back out). A one-way drive zooms deep enough
    // that the visible world region can legitimately hold ZERO points, so "no tooltip" would report
    // the fixture's occupancy rather than whether the gesture wedged hover off. MEASURED on this
    // fixture: after 5 one-way wheels the full-pane 7x7 scan finds nothing anywhere
    // (`afterOneWay5=null`), and after those same 5 in + 5 back out it finds a tooltip again. The
    // return is therefore load-bearing, not tidiness.
    await driveWheelsRoundTrip(page, { ...at, steps: 5, gapMs: COUNTER_GAP_MS })
    const during = await findHover()

    // The LONG drive: the SAME COUNTER_STEPS wheels in and COUNTER_STEPS back out as before, but as
    // TWO round trips that each fit inside the camera's zoom headroom instead of one that does not.
    // The story starts at zoom 4 and `linkZoom.ts` clamps to [-2, 12], i.e. ~12.9 wheels of zoom-in
    // headroom at the measured 0.620 levels/wheel — so a single 20-wheel round trip CLAMPED on the
    // way in and not on the way out, and returned the camera to zoom -0.403 / target (0.63, -20.47)
    // rather than zoom 4 / (0, 0). At 21x zoomed out the entire 20k-point cloud is a ~23 px blob
    // while this scan's grid pitch is 43-65 px, so `after` was reporting whether a grid node
    // happened to land on the blob — the fixture's occupancy, which is the precise confound the
    // round trip exists to remove. `driveWheelsRoundTrip` now HARD-FAILS on a camera that did not
    // come back, so this can never silently decay into a lottery again; splitting the drive is what
    // keeps it inside the headroom while leaving its length unchanged.
    const LONG_DRIVE_TRIPS = 2
    for (let i = 0; i < LONG_DRIVE_TRIPS; i++) {
      await driveWheelsRoundTrip(page, {
        ...at,
        steps: COUNTER_STEPS / LONG_DRIVE_TRIPS,
        gapMs: COUNTER_GAP_MS,
      })
    }
    const after = await findHover()

    // Logged BEFORE the first assertion so a red carries its evidence: which of the three scans
    // found a point and where, rather than only which expect() threw.
    console.log(`[TEST-9] tooltip before=${JSON.stringify(before)} during=${JSON.stringify(during)} after=${JSON.stringify(after)}`)

    expect(before, 'the fixture must have a hoverable point at all, or this gate is vacuous').not.toBeNull()
    expect(during, 'a tooltip must be reachable by hover DURING a camera gesture').not.toBeNull()
    expect(after, 'a tooltip must be reachable by hover AFTER a camera gesture').not.toBeNull()
  })

  // ── TEST-P6 (ITEM-5/ITEM-9, INV-5): elements per wheel are O(1) in pane count ─────────────
  // The scaling-law form of the mechanism, and the one assertion a memo-without-split cannot
  // pass by accident. ACCEPTANCE for the Split-A wave — expected RED until then, and its red
  // value is itself the required red-proof (the slope must read ~588/pane, not merely
  // "over budget", which is what distinguishes a real measurement from a broken probe).
  //
  // NON-VACUITY IS ASSERTED BEFORE THE SLOPE (the E(8)=0 defect). This test used to compute
  // `(E(8) − E(1)) / 7` over whatever the four drives happened to produce. At 8 panes the pane
  // shrinks to 242×325 while the in-cell legend overlay stays a fixed 120×164, so the geometric
  // pane centre landed ON THE LEGEND: 20 wheels delivered, zero elements created, E(8)=0, slope
  // −39.5/pane — i.e. this gate PASSED, on a leg that measured nothing. `paneCentre` now verifies
  // its aim point against deck's canvas, and `assertScalingLegsNonVacuous` refuses to let a leg
  // that did not measure anything reach the arithmetic. Note TEST-N1's lesson generalized: the
  // danger is never a wrong number, it is a comfortable zero.
  //
  // FIRST HONEST MEASUREMENT ON THIS TREE (7633c42c): E(1)=279 E(2)=309 E(4)=375 E(8)=482,
  // slope 29.1/pane — RED on the slope (>8) and on E(4) (>200), which is the required red-proof.
  // The ~588/pane above is the baseline captured at `1d391dc4`, BEFORE ITEM-3; the level has since
  // fallen with it (E(4) 2484.8 → 375), so ~29/pane is this tree's figure, not a shortfall of the
  // probe. What certifies the probe is the LINEARITY of the four legs — the per-added-pane deltas
  // are 30.8 / 32.8 / 26.8 across 1→2, 2→4, 4→8 — and their bit-reproducibility (totals
  // 5570 / 6186 / 7498 identical across three independent runs).
  test('TEST-P6 elements per wheel are O(1) in pane count', async ({ page }) => {
    test.setTimeout(600_000)
    const counter = await installElementCounter(page)
    const legs: ScalingLeg[] = []

    for (const panes of [1, 2, 4, 8] as const) {
      await openPerfStory(page, 'render-perf', { panes, points: 20_000 })
      counter.assertApplied()
      // THE FIXTURE PREMISE, PER LEG (FIX_ROUND-2 / C5). `assertScalingLegsNonVacuous` anchors its
      // collapse floor RELATIVE to the smallest leg, so four legs that are all equally and wrongly
      // small pass every clause and yield slope 0 — and this test establishes no premise of its own,
      // delegating the pane count to the separate TEST-1. A regressed `?panes=` parse in
      // `render-perf.story.tsx` (whose `readPaneCount` silently falls back to 4) would render the
      // SAME fixture for all four legs, and "elements are O(1) in pane count" would be certified
      // without panes ever having varied. The recorded slope of EXACTLY 0 is consistent with either
      // the real result or that failure; this is the clause that tells them apart.
      await expect(
        page.locator('[data-viz-cell]'),
        `the story must actually render ${panes} panes — a leg measured at the wrong pane count makes the slope a fiction`,
      ).toHaveCount(panes)
      await counter.begin()
      await driveWheels(page, { ...(await paneCentre(page, 0)), steps: COUNTER_STEPS, gapMs: COUNTER_GAP_MS })
      const r = await counter.end()
      legs.push({ panes, perWheel: r.perWheel, wheels: r.wheels, total: r.total })
    }

    // Logged BEFORE any assertion so a red carries its evidence — including WHICH leg failed to
    // measure, which the slope alone can never show.
    console.log(
      '[TEST-P6] legs: ' +
        legs.map(l => `E(${l.panes})=${l.perWheel.toFixed(0)} (wheels=${l.wheels} total=${l.total})`).join(' '),
    )
    assertScalingLegsNonVacuous(legs, COUNTER_STEPS)

    const measured = Object.fromEntries(legs.map(l => [l.panes, l.perWheel])) as Record<number, number>
    const slope = (measured[8] - measured[1]) / 7
    console.log(`[TEST-P6] E(1)=${measured[1].toFixed(0)} E(2)=${measured[2].toFixed(0)} E(4)=${measured[4].toFixed(0)} E(8)=${measured[8].toFixed(0)} slope=${slope.toFixed(1)}/pane`)
    contributeSplitCounter('TEST-P6', {
      metric: 'elementsPerPaneSlope',
      value: slope,
      budget: BUDGETS.budgets.elementsPerPaneSlope,
      pass: slope <= BUDGETS.budgets.elementsPerPaneSlope && measured[4] <= BUDGETS.budgets.elementsPerWheelAt4Panes,
    })
    expect(slope, 'elements must not scale with pane count').toBeLessThanOrEqual(BUDGETS.budgets.elementsPerPaneSlope)
    expect(measured[4]).toBeLessThanOrEqual(BUDGETS.budgets.elementsPerWheelAt4Panes)
  })

  // ── TEST-N4: the scaling guard hard-fails on a leg that measured nothing ──────────────────
  // The permanent negative control for TEST-P6's own arithmetic, and the counterpart to TEST-N1.
  // TEST-N1 proves the ELEMENT PROBE refuses to report 0; this proves the SLOPE refuses to be
  // computed from one. It is a pure-function test on purpose: re-driving four pane counts to prove
  // a guard fires would cost ~2 min and is not what is under test.
  test('TEST-N4 the scaling guard refuses a zero / short / collapsed leg', async () => {
    const good: ScalingLeg[] = [
      { panes: 1, perWheel: 278.5, wheels: 20, total: 5570 },
      { panes: 2, perWheel: 309.3, wheels: 20, total: 6186 },
      { panes: 4, perWheel: 374.9, wheels: 20, total: 7498 },
      { panes: 8, perWheel: 4400, wheels: 20, total: 88_000 },
    ]
    // Positive control FIRST, so the guard is not simply always-throwing: the real pre-split shape
    // (a large POSITIVE spread) must pass, and so must the post-split success shape (all equal).
    expect(() => assertScalingLegsNonVacuous(good, 20)).not.toThrow()
    expect(() =>
      assertScalingLegsNonVacuous(
        good.map(l => ({ ...l, perWheel: 278.5, total: 5570 })),
        20,
      ),
    ).not.toThrow()

    // 1. the exact defect: wheels delivered, nothing measured.
    const zeroed = good.map(l => (l.panes === 8 ? { ...l, perWheel: 0, total: 0 } : l))
    expect(() => assertScalingLegsNonVacuous(zeroed, 20)).toThrow(/8-pane leg measured 0 elements\/wheel/)
    // …and prove the consequence it exists to prevent: this is the slope that zero would have produced.
    const vacuousSlope = (0 - good[0].perWheel) / 7
    expect(vacuousSlope, 'a zero leg makes the slope NEGATIVE — i.e. it passes the O(1) gate').toBeLessThan(0)

    // 2. the drive never happened / was short.
    expect(() =>
      assertScalingLegsNonVacuous(good.map(l => (l.panes === 8 ? { ...l, wheels: 0 } : l)), 20),
    ).toThrow(/delivered 0 wheels, expected 20/)

    // 3. a leg that is not zero but has collapsed relative to the 1-pane leg.
    expect(() =>
      assertScalingLegsNonVacuous(good.map(l => (l.panes === 4 ? { ...l, perWheel: 12 } : l)), 20),
    ).toThrow(/4-pane leg measured 12\.0 elements\/wheel, below/)
  })

  // ── TEST-N5: the wheel-ack quantiles refuse an empty sample (FIX_ROUND-2 / C14) ────────────
  // TEST-N4's sibling, one metric over. The ack quantiles were computed as
  // `sorted[Math.min(len-1, floor(p*len))] ?? 0`, which on an EMPTY array is `sorted[-1] ?? 0` — so
  // p50 = p90 = max = 0, TEST-P7's `ackRatio = subject.p50 / max(1, control.p50)` becomes 0, and the
  // `wheelAckRatioVsControl` budget passes with nothing behind it. Pure-function for TEST-N4's
  // reason: re-driving the prod bench to prove a guard fires is not what is under test.
  test('TEST-N5 the wheel-ack quantiles refuse an empty sample and are exact on a real one', async () => {
    expect(() => wheelAckQuantiles([])).toThrow(/EMPTY/)
    // …and the consequence that refusal prevents, stated as arithmetic: this is the ratio the
    // comfortable zero would have produced against ANY control.
    expect(0 / Math.max(1, 29), 'an empty sample makes the ack ratio 0 — i.e. it passes any budget').toBeLessThanOrEqual(1.5)
    // The happy path is unchanged by the guard (indices, not a re-definition of the quantile).
    const q = wheelAckQuantiles([50, 10, 30, 20, 40])
    expect(q.p50).toBe(30)
    expect(q.p90).toBe(50)
    expect(q.max).toBe(50)
    expect(wheelAckQuantiles([7])).toEqual({ p50: 7, p90: 7, max: 7 })
  })

  // ── TEST-N6: the bench server is booted only for invocations that can use it (A12) ────────
  // `playwright.viz.config.ts` declared the prod-bench `webServer` unconditionally, so every dev
  // run paid a cold production build (300s timeout) for an origin the dev project never opens.
  // The predicate that scopes it is pure, and its two failure directions are asymmetric: a
  // needless boot is slow, a MISSING boot is a hard failure — so every ambiguous invocation must
  // answer YES. That asymmetry is what this test pins.
  test('TEST-N6 needsBenchServer scopes the prod bench without ever under-booting', async () => {
    const N = (args: string[], env: { CI?: string } = {}) => needsBenchServer(['node', 'pw', ...args], env)
    // YES — the invocations that reach the ms leg.
    expect(N([]), 'a bare full run runs every project').toBe(true)
    expect(N(['--project=chromium-prod-ms'])).toBe(true)
    expect(N(['--project', 'chromium-prod-ms'])).toBe(true)
    expect(N(['render-perf-ms.spec.ts'])).toBe(true)
    expect(N(['tests/viz-e2e/render-perf-ms.spec.ts'])).toBe(true)
    expect(N(['--grep', 'TEST-P1']), 'a grep with no spec filter may still select the ms leg').toBe(true)
    expect(N(['--project=chromium'], { CI: '1' }), 'CI always boots it').toBe(true)
    // NO — provably cannot reach it.
    expect(N(['--project=chromium'])).toBe(false)
    expect(N(['render-perf.spec.ts'])).toBe(false)
    expect(N(['render-perf.spec.ts', 'render-perf-parity.spec.ts'])).toBe(false)
    expect(N(['render-perf.spec.ts', 'render-perf-ms.spec.ts']), 'one ms spec in the list is enough').toBe(true)
    // …and the CONFIG actually consults it. A predicate with no consumer is the defect this round
    // keeps finding; asserting the shape without the wiring would be another instance of it.
    const cfg = readFileSync(new URL('../../playwright.viz.config.ts', import.meta.url), 'utf8')
    expect(cfg, 'the viz config must import the predicate').toContain("import { needsBenchServer }")
    expect(cfg, 'the bench webServer entry must be gated on it').toMatch(
      /\.\.\.\(needsBenchServer\(process\.argv, process\.env\) \? \[\{/,
    )
  })

  // ── TEST-P1 (ITEM-5/ITEM-6, INV-1): the camera must not re-render pane chrome ─────────────
  // The design's §4.3 promise stated directly. Red if the camera reaches the chrome by ANY
  // route, whether or not `memo` happens to be present — so it cannot be satisfied by a
  // tautology. ACCEPTANCE for the Split-A wave.
  test('TEST-P1 a camera drive creates zero chrome elements', async ({ page }) => {
    test.setTimeout(220_000)
    const counter = await installElementCounter(page)
    await openPerfStory(page, 'render-perf', { panes: 4, points: 20_000 })
    counter.assertApplied()

    await counter.begin()
    await driveWheels(page, { ...(await paneCentre(page, 0)), steps: COUNTER_STEPS, gapMs: COUNTER_GAP_MS })
    const r = await counter.end()

    console.log(
      `[TEST-P1] PaneToolbar=${r.perWheelByComponent.PaneToolbar ?? 0}/wheel CellView=${r.perWheelByComponent.CellView ?? 0}/wheel total=${r.perWheel.toFixed(0)}/wheel`,
    )
    // The per-component table is the RUN RECORD: every claim this feature makes about where the
    // elements went is attributed from it, and an unattributed delta is not a result.
    console.log(
      '[TEST-P1] top components/wheel: ' +
        Object.entries(r.perWheelByComponent)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 22)
          .map(([k, v]) => `${k}=${v}`)
          .join(' '),
    )
    const chromeTotal = CHROME.reduce((n, name) => n + (r.byComponent[name] ?? 0), 0)
    contributeSplitCounter('TEST-P1', {
      metric: 'chromeElementsPerWheel',
      value: chromeTotal,
      budget: BUDGETS.budgets.chromeElementsPerWheel,
      pass: chromeTotal === 0,
    })
    for (const name of CHROME) {
      expect(r.byComponent[name] ?? 0, `${name} must not be re-created by a camera change`).toBe(0)
    }
  })

  // ── TEST-P2 (ITEM-1 / ITEM-2): the chrome's TRANSITIVE CHILDREN, not just its two roots ────────
  //
  // TEST-P1 proves `PaneToolbar` and `CellView` are not re-created. That is a claim about two memo
  // ROOTS. TEST-P2 is the leaf-level proof that the subtree BELOW them is genuinely not rebuilt —
  // the design source's §2.1 baselines were 252 `Button`, 136 `TooltipProvider`, 136
  // `TooltipTrigger`, 68 `TooltipContent`, 60 `SelectItem`, 24 `SelectTrigger` per wheel, so roots
  // counted at 0 while the subtree still churned would make the headline result false.
  //
  // Written as the DIRECT assertion the existing measurement already implies, rather than as a
  // rebuilt per-component baseline harness: TEST-P1 measures a per-wheel TOTAL of 6 across ALL
  // components, and 252 Buttons per wheel cannot hide inside a total of 6. Stating the leaf-level
  // property explicitly pins it BY NAME, so a future regression in the subtree fails here instead
  // of having to be inferred from an aggregate.
  //
  // THE VACUITY RISK, AND THE CONTROL THAT CLOSES IT: asserting "zero Buttons" against a counter
  // that cannot SEE a Button is a guaranteed pass measuring nothing. So the MOUNT window is counted
  // first and must show this family being created; only then is the camera-drive window asserted to
  // be zero. That control is the difference between a measurement and a tautology.
  test('TEST-P2 a camera drive creates zero chrome DESCENDANTS (leaf-level)', async ({ page }) => {
    test.setTimeout(220_000)
    // ARMED AT LOAD: the mount window cannot be opened with `begin()`, because `begin()` reads
    // `globalThis.__VIZ_COUNTERS__` and that object is created by the counter's INIT SCRIPT — which
    // has not run on `about:blank`. Calling it before the first navigation threw
    // `Cannot convert undefined or null to object` and this test produced no verdict at all. The
    // opt-in `armAtLoad` starts the tally inside the init script instead, so window 1 really is
    // the mount.
    const counter = await installElementCounter(page, { armAtLoad: true })

    // Window 1 — MOUNT. Proves the counter can see this family at all.
    await openPerfStory(page, 'render-perf', { panes: 4, points: 20_000 })
    counter.assertApplied()
    const mount = await counter.end()
    console.log(
      '[TEST-P2] mount window: ' +
        CHROME_DESCENDANTS.map(n => `${n}=${mount.byComponent[n] ?? 0}`).join(' '),
    )
    const mountSeen = CHROME_DESCENDANTS.filter(n => (mount.byComponent[n] ?? 0) > 0)
    expect(
      mountSeen.length,
      `the counter never saw ANY of ${CHROME_DESCENDANTS.join('/')} even while the grid was MOUNTING, ` +
        'so asserting zero of them after a wheel would be vacuous — the names have been renamed or ' +
        'minified out of the counter, or the story no longer builds this chrome',
    ).toBeGreaterThan(0)

    // Window 2 — the CAMERA DRIVE. The actual property.
    await counter.begin()
    await driveWheels(page, { ...(await paneCentre(page, 0)), steps: COUNTER_STEPS, gapMs: COUNTER_GAP_MS })
    const r = await counter.end()
    console.log(
      '[TEST-P2] wheel window: ' +
        CHROME_DESCENDANTS.map(n => `${n}=${r.byComponent[n] ?? 0}`).join(' ') +
        ` | total=${r.perWheel.toFixed(1)}/wheel`,
    )
    for (const name of CHROME_DESCENDANTS) {
      expect(
        r.byComponent[name] ?? 0,
        `${name} was re-created by a camera change. TEST-P1's two memo ROOTS can read 0 while the ` +
          'subtree under them churns, which is the whole reason this leaf-level check exists',
      ).toBe(0)
    }
  })

  // ── INV-11: the per-split checkpoint ledger ──────────────────────────────────────────────
  // Runs only when the split name is supplied, and only AFTER all three counter tests have
  // contributed — `writeSplitCheckpoint` throws on a partial set rather than recording one, so a
  // `--grep`-filtered iteration run cannot leave a half-measured checkpoint behind.
  test.afterAll(async () => {
    const split = process.env.RENDER_PERF_RECORD_SPLIT
    if (!split) return
    await writeSplitCheckpoint(split)
  })
})
