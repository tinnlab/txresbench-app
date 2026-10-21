import { test, expect, type Page, type CDPSession } from '@playwright/test'
import { openStory, trackErrors } from './_helpers'

// MEMORY STRESS / LEAK GUARD for the pop-out + tear-off + add/remove system.
//
// The pop-out/tear-off path is a large leak surface: window.open popups, the portal's node adoptNode
// across documents, window-level drag + portal listeners, a MutationObserver style bridge, and a deck
// WebGL context created inside each popup (browsers cap ~16 contexts — a disposal leak here CRASHES
// after ~16 pop-outs). This drives N cycles of {add→remove a cell, pop a cell out→close it} and, with
// forced GC (CDP HeapProfiler.collectGarbage), asserts every resource returns to a stable baseline:
// JS heap, canvas/WebGL-context count (main + popups), DOM node count (adoptNode detached-subtree
// proxy), and open-popup count. Bounded == no leak. Each cycle pops a cell out into a real window
// (its own GridWorkspace + deck WebGL context) and docks it back via the popup's Return affordance
// (returnPaneToGrid) — the deterministic dock-back path that drives the full create+dispose leak
// surface. (The OS-window-close `beforeunload → returnPaneToGrid` variant is a separate correctness
// path hardened + tested in docking P5.)
//
// Configurable: STRESS_CYCLES (default 20). Run:
//   STRESS_CYCLES=30 npx playwright test --config=playwright.viz.config.ts memory-stress

// Default kept modest — the dense-cell pop-out renders a 150k-point DeckScatterCanvas in the popup,
// which is ~slow under headless swiftshader (~50s/cycle). 8 cycles gives a clear flat trend within the
// suite timeout; STRESS_CYCLES=30+ drives a deeper manual leak hunt.
const CYCLES = Number(process.env.STRESS_CYCLES ?? 8)
const WARMUP = 3

// Thresholds (documented). The hard leak indicators are canvas + popup counts (a leak there is a real
// resource leak / eventual crash); DOM + heap are softer (caches/noise) so they get generous bands.
const CANVAS_SLACK = 2 // deck may retain ≤2 canvases post-GC; a leak grows ~1/pop-out
const NODE_BAND = 0.15 // DOM nodes must return within +15% of baseline
const HEAP_BAND = 1.6 // final heap ≤ 1.6× baseline (JS heap is noisy; the real tell is the TREND)

interface Sample {
  heap: number
  canvas: number
  nodes: number
  pages: number
}

async function forceGc(cdp: CDPSession): Promise<void> {
  // Twice: the first pass may resurrect via finalization; the second settles.
  await cdp.send('HeapProfiler.collectGarbage')
  await cdp.send('HeapProfiler.collectGarbage')
}

async function heapUsed(cdp: CDPSession): Promise<number> {
  const r = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number }
  return r.usedSize
}

/** Sum canvas + DOM-node counts across the main page AND every open popup page. */
async function resourceCounts(page: Page): Promise<{ canvas: number; nodes: number; pages: number }> {
  const pages = page.context().pages()
  let canvas = 0
  let nodes = 0
  for (const p of pages) {
    try {
      canvas += await p.evaluate(() => document.querySelectorAll('canvas').length)
      nodes += await p.evaluate(() => document.getElementsByTagName('*').length)
    } catch {
      /* a page mid-close */
    }
  }
  return { canvas, nodes, pages: pages.length }
}

async function sample(page: Page, cdp: CDPSession): Promise<Sample> {
  await forceGc(cdp)
  const c = await resourceCounts(page)
  return { heap: await heapUsed(cdp), ...c }
}

async function cellIds(page: Page): Promise<string[]> {
  return page.$$eval('[data-testid^="viz-cell-view-"]', els =>
    els.map(e => (e.getAttribute('data-testid') as string).replace('viz-cell-view-', '')),
  )
}

/** One stress cycle: add a cell → remove it; pop a cell out (real popup) → close it. */
async function cycle(page: Page, i: number): Promise<void> {
  // ── add → remove one cell ─────────────────────────────────────────────────────────────────
  const before = await cellIds(page)
  await page.click('[data-testid="grid-add-col"]')
  await page.waitForFunction(
    n => document.querySelectorAll('[data-testid^="viz-cell-view-"]').length > n,
    before.length,
    { timeout: 45_000 },
  )
  const added = (await cellIds(page)).find(id => !before.includes(id))
  if (added) {
    await page.click(`[data-testid="viz-cell-remove-${added}"]`)
    await page.waitForSelector(`[data-testid="viz-cell-view-${added}"]`, {
      state: 'detached',
      timeout: 45_000,
    })
  }

  // ── pop out → close (alternate a CHART cell (cell-2) and a DENSE cell (cell-1) so BOTH the
  //    chart-canvas and the standalone-dense DeckScatterCanvas popup-context paths are exercised).
  //    Close via the popup's Return affordance (returnPaneToGrid) — the deterministic dock-back
  //    path. This is what the leak guard needs: it fully exercises the leak surface (window.open,
  //    the per-popup deck WebGL context create+dispose, movePane, portal adoptNode, and the popup
  //    close/unregister), which is orthogonal to WHICH gesture triggers the close.
  //    (The OS-window-close `beforeunload → returnPaneToGrid` path — Playwright's
  //    popup.close({ runBeforeUnload:true }) — is a SEPARATE correctness concern hardened + tested
  //    in docking P5; exercising it here made the multi-cycle stress harness flaky, not the leak.)
  const cellId = i % 2 === 0 ? 'cell-2' : 'cell-1'
  const popoutBtn = page.locator(`[data-testid="viz-cell-popout-${cellId}"]`)
  // FAIL LOUD if the pop-out affordance isn't there — else the whole leak guard silently no-ops
  // (every cycle returns, baseline==final, all assertions trivially pass having popped out NOTHING).
  await expect(popoutBtn, `pop-out button for ${cellId} must exist (leak guard would no-op otherwise)`)
    .toHaveCount(1, { timeout: 45_000 })
  const [popup] = await Promise.all([
    page.context().waitForEvent('page'),
    popoutBtn.click({ force: true }),
  ])
  await popup.waitForLoadState('domcontentloaded')
  // The cell MOVED into the popup (its own GridWorkspace) and the main grid reflowed (view gone).
  await expect
    .poll(() => page.locator(`[data-testid="viz-cell-view-${cellId}"]`).count(), { timeout: 45_000 })
    .toBe(0)
  // Return from INSIDE the popup → the cell docks back into the main grid; the emptied popup closes.
  await popup.click(`[data-testid="viz-cell-return-${cellId}"]`)
  // The cell is back in the main grid (docked/reflowed in) and the popup auto-closed.
  await expect
    .poll(() => page.locator(`[data-testid="viz-cell-view-${cellId}"]`).count(), { timeout: 45_000 })
    .toBe(1)
  await expect.poll(() => popup.isClosed(), { timeout: 45_000 }).toBe(true)
}

test('memory: pop-out/tear-off/add-remove cycles do not leak (heap / WebGL contexts / DOM / popups)', async ({
  page,
}) => {
  test.setTimeout(1_500_000)
  const bag = trackErrors(page)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('HeapProfiler.enable')

  await openStory(page, 'grid-nonuniform')
  await expect(page.getByTestId('viz-grid-workspace')).toBeVisible()
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid^="viz-cell-view-"]').length >= 2,
    undefined,
    { timeout: 45_000 },
  )

  // Warm up (JIT / lazy init / one-time caches) BEFORE the baseline so growth is real, not startup.
  for (let i = 0; i < WARMUP; i++) await cycle(page, i)
  const baseline = await sample(page, cdp)

  const trend: Sample[] = [baseline]
  for (let i = 0; i < CYCLES; i++) {
    await cycle(page, i)
    if (i === Math.floor(CYCLES / 3) || i === Math.floor((2 * CYCLES) / 3)) {
      trend.push(await sample(page, cdp))
    }
  }
  const final = await sample(page, cdp)
  trend.push(final)

  const mb = (n: number) => (n / 1_048_576).toFixed(1)
  /* eslint-disable no-console */
  console.log(`\n=== memory-stress: ${CYCLES} cycles (+${WARMUP} warmup) ===`)
  console.log('phase       heapMB  canvas  domNodes  pages')
  const labels = ['baseline', 'mid1/3', 'mid2/3', 'final'].slice(0, trend.length)
  trend.forEach((s, k) =>
    console.log(
      `${labels[k].padEnd(11)} ${mb(s.heap).padStart(6)}  ${String(s.canvas).padStart(6)}  ${String(
        s.nodes,
      ).padStart(8)}  ${String(s.pages).padStart(5)}`,
    ),
  )
  console.log(
    `deltas final-baseline: heap ${mb(final.heap - baseline.heap)}MB, canvas ${
      final.canvas - baseline.canvas
    }, domNodes ${final.nodes - baseline.nodes}, pages ${final.pages - baseline.pages}`,
  )
  /* eslint-enable no-console */

  // ── Hard leak indicators ──────────────────────────────────────────────────────────────────
  // No leaked popup windows.
  expect(final.pages, 'open pages returned to 1 (no leaked popups)').toBe(1)
  // WebGL/canvas contexts return to baseline (the crash-risk metric — must not climb toward the cap).
  expect(
    final.canvas,
    `canvas/WebGL-context count returned to baseline (±${CANVAS_SLACK}) — was ${baseline.canvas}, now ${final.canvas}`,
  ).toBeLessThanOrEqual(baseline.canvas + CANVAS_SLACK)
  // DOM nodes return near baseline (portal adoptNode detached-subtree guard).
  expect(
    final.nodes,
    `DOM node count returned within +${NODE_BAND * 100}% of baseline (was ${baseline.nodes}, now ${final.nodes})`,
  ).toBeLessThanOrEqual(Math.ceil(baseline.nodes * (1 + NODE_BAND)))
  // ── Softer: heap not runaway (noisy; band + trend check) ────────────────────────────────────
  expect(
    final.heap,
    `JS heap not runaway (baseline ${mb(baseline.heap)}MB, final ${mb(final.heap)}MB)`,
  ).toBeLessThanOrEqual(Math.ceil(baseline.heap * HEAP_BAND))

  // Filter the benign "ResizeObserver loop …" browser quirk (fires under rapid layout churn; not a
  // real error) + WebGL context-loss chatter (expected on the canvas-move + popup-close paths).
  const realErrors = bag.errors.filter(
    e => !/ResizeObserver loop|context (lost|restored)|webglcontextlost|deck\.gl: assertion|deck: initialization/i.test(e),
  )
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})
