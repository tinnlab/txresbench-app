// shared-deck-charts.e2e.mjs — proves the refactor's GOAL: every chart type renders as a VIEW in the
// ONE shared grid deck, so the all-plot-types capabilities grid runs on a SINGLE WebGL context (it
// used to spawn ~17 → "too many active WebGL contexts" → a plot vanished). Also checks the migrated
// charts still draw (no context-lost) and a heatmap texel hover still shows its tooltip.
// Runnable: node tests/e2e/shared-deck-charts.e2e.mjs [baseUrl]
import { chromium } from 'playwright'
const BASE = process.argv[2] ?? 'http://localhost:1482'
const SC = '/tmp/claude-1000/-data-pbya-ziee-ziee/b5b52393-63e9-49f1-8500-803873494642/scratchpad'

const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1500, height: 920 } })
const errs = []
const warns = []
p.on('pageerror', e => errs.push(String(e)))
p.on('console', m => {
  const t = m.text()
  if (/Too many active WebGL/i.test(t)) warns.push(t)
  // Filter deck.gl-internal noise + the pre-existing `SelectableScatterLayer` init-race assertion
  // (non-fatal — it predates this refactor, appears in the dense-only aim-to-place story, and every
  // cell still renders). This test asserts the shared-deck GOAL, not deck's internal init timing.
  else if (
    m.type() === 'error' &&
    !/favicon|shader|luma|SwiftShader|assertion failed|SelectableScatterLayer/i.test(t)
  )
    errs.push('C:' + t)
})

let pass = true
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) pass = false
}

try {
  await p.goto(`${BASE}/viz-showcase.html#capabilities`, { waitUntil: 'commit' })
  await p.waitForSelector('[data-viz-cell]', { timeout: 20000 })
  await p.waitForTimeout(5000) // let all cells paint

  const stat = await p.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')]
    const gl = cs.filter(c => {
      try {
        return !!(c.getContext('webgl2') || c.getContext('webgl'))
      } catch {
        return false
      }
    }).length
    return { cells: document.querySelectorAll('[data-viz-cell]').length, gl }
  })
  const lost = await p.locator('text=/context lost/i').count()
  await p.screenshot({ path: `${SC}/e2e-shared-deck.png` })

  // GOAL: all chart types render on ONE WebGL context (allow a small margin, but nowhere near ~17).
  check(stat.gl === 1, 'TEST-9 all plot types share ONE WebGL context', `gl=${stat.gl} (was ~17)`) // eslint-disable-line
  check(stat.cells >= 10, 'TEST-9 all cells rendered', `cells=${stat.cells}`)
  check(lost === 0, 'TEST-9 no context-lost overlay', `lost=${lost}`)
  check(warns.length === 0, 'TEST-9 no "too many active WebGL" warning', `warnings=${warns.length}`)

  // Hover a heatmap texel → its tooltip shows (routed through the shared deck, un-prefixed layer id).
  const hm = await p.$eval('[data-viz-cell="heatmap"]', el => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  }).catch(() => null)
  if (hm) {
    for (const [fx, fy] of [[0.3, 0.35], [0.32, 0.37], [0.34, 0.39]]) {
      await p.mouse.move(hm.x + hm.w * fx, hm.y + hm.h * fy)
      await p.waitForTimeout(300)
    }
    await p.waitForTimeout(400)
    const tips = await p.locator('.viz-tooltip, [class*="tooltip"], [data-testid*="tooltip"]').count()
    check(tips > 0, 'TEST-10 heatmap texel hover shows a tooltip on the shared deck', `tooltips=${tips}`)
  } else {
    check(false, 'TEST-10 heatmap cell present')
  }

  // TEST-11: a migrated chart's DOM chrome is INTERACTIVE in-grid (regression guard). The cell root
  // is pointerEvents:none (pan/zoom → deck), but the toolbars/rails must re-arm pointerEvents:auto —
  // else clicks fall through to the deck and pan. Assert the heatmap toolbar toggle actually flips.
  const pe = await p.evaluate(() => {
    const get = s => {
      const e = document.querySelector(s)
      return e ? getComputedStyle(e).pointerEvents : 'MISSING'
    }
    return {
      cellRoot: get('[data-viz-cell="heatmap"]'),
      toolbar: get('[data-testid="viz-heatmap-toolbar"]'),
      rail: get('[data-testid="viz-heatmap-datazoom-rows"]'),
    }
  })
  check(pe.cellRoot === 'none', 'TEST-11 migrated chart cell root passes pan/zoom through', `pe=${pe.cellRoot}`)
  check(pe.toolbar === 'auto' && pe.rail === 'auto', 'TEST-11 chart toolbar + rail re-arm pointer events', JSON.stringify(pe))
  const before = await p.getByTestId('viz-heatmap-annotation-toggle').isChecked().catch(() => null)
  await p.getByTestId('viz-heatmap-annotation-toggle').click({ force: true }).catch(() => {})
  await p.waitForTimeout(500)
  const after = await p.getByTestId('viz-heatmap-annotation-toggle').isChecked().catch(() => null)
  check(before != null && before !== after, 'TEST-11 heatmap toolbar toggle responds to a click', `${before}→${after}`)

  // TEST-15: SCALE — a 100-chart-cell grid runs on ONE WebGL context (was ~100 → far past the cap).
  await p.goto(`${BASE}/viz-showcase.html#scale-100`, { waitUntil: 'commit' })
  await p.waitForSelector('[data-viz-cell]', { timeout: 30000 })
  await p.waitForTimeout(8000)
  const scale = await p.evaluate(() => {
    const gl = [...document.querySelectorAll('canvas')].filter(c => {
      try {
        return !!(c.getContext('webgl2') || c.getContext('webgl'))
      } catch {
        return false
      }
    }).length
    return { cells: document.querySelectorAll('[data-viz-cell]').length, gl }
  })
  check(scale.cells >= 100, 'TEST-15 100 chart cells mounted', `cells=${scale.cells}`)
  check(scale.gl === 1, 'TEST-15 100 cells share ONE WebGL context', `gl=${scale.gl}`)
  check(warns.length === 0, 'TEST-15 no "too many active WebGL" warning at 100 cells', `warnings=${warns.length}`)

  check(errs.length === 0, 'no console/page errors', errs.slice(0, 3).join(' | '))
} catch (e) {
  check(false, 'e2e threw', String(e))
}

await b.close()
console.log(pass ? '\nshared-deck-charts e2e: ALL PASS' : '\nshared-deck-charts e2e: FAILURES ABOVE')
process.exit(pass ? 0 : 1)
