// viz-perf.mjs — the visualization PERFORMANCE-SMOKE driver (ITEM-59). Boots the
// Visualization Showcase under headless software-WebGL, opens the perf story (which drives
// a large fixture scatter — 1,000,000 points by default — through the real GPU
// DeckScatterCanvas and times a ~3s animation-frame sweep), reads the frame-time / fps
// stats + verdict off window.__VIZ_PERF__, prints them, and exits non-zero on failure.
// Mirrors scripts/viz-gallery-verify.mjs (same swiftshader launch args + story-click flow).
//
// ── swiftshader is a SOFTWARE rasterizer — it will NOT hit 60fps ──────────────────────
// So the DEFAULT budget here is LENIENT / INFORMATIONAL: we report the numbers and gate
// ONLY on "the story rendered a batch of frames with non-zero fps and did not crash"
// (that's exactly the story's own verdict, budget { minFrames: 5 }). The point of this
// harness is a repeatable MEASUREMENT you can run anywhere, not a swiftshader fps
// assertion. For a REAL-GPU run, pass a strict budget:
//   node scripts/viz-perf.mjs --min-fps=60          # North-star "1M @ 60fps"
//   node scripts/viz-perf.mjs --max-p95=16.7        # …or gate on the frame-time tail
//   node scripts/viz-perf.mjs --points=2000000 --min-fps=60   # push past 1M
// Other flags: --duration=<ms> (sweep length), --url=<base>, --headed.

import { chromium } from 'playwright-core'

// ── arg parsing (--k=v or --k v or bare --flag) ───────────────────────────────
const args = process.argv.slice(2)
function argVal(name, fallback = undefined) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === `--${name}`) return args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3)
  }
  return fallback
}
function numArg(name) {
  const v = argVal(name)
  if (v == null || v === true) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

const BASE_URL = argVal('url') || 'http://localhost:1421/viz-showcase.html'
const points = numArg('points')
const durationMs = numArg('duration')
const minFps = numArg('min-fps')
const maxP95 = numArg('max-p95')
const headed = argVal('headed') === true

// build the story URL: the perf story reads ?points= / ?durationMs= from the query string.
const url = new URL(BASE_URL)
if (points != null) url.searchParams.set('points', String(points))
if (durationMs != null) url.searchParams.set('durationMs', String(durationMs))

console.log(`[viz-perf] url=${url.toString()}`)
if (minFps != null || maxP95 != null) {
  console.log(`[viz-perf] STRICT budget: ${[
    minFps != null ? `minFps>=${minFps}` : null,
    maxP95 != null ? `p95<=${maxP95}ms` : null,
  ].filter(Boolean).join(', ')}`)
} else {
  console.log('[viz-perf] LENIENT/informational budget (software WebGL): gate = frames rendered, non-zero fps')
}

const browser = await chromium.launch({
  headless: !headed,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })

const consoleErrors = []
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', e => consoleErrors.push('PAGEERR: ' + e.message))

let exitCode = 1
try {
  await page.goto(url.toString(), { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 20000 })
  await page.click('[data-testid="showcase-story-perf-scatter"]')

  // The story loads the (possibly huge) fixture, then runs a ~duration sweep before it
  // publishes window.__VIZ_PERF__. Generous timeout: 1M generation + swiftshader init +
  // the sweep can take a while.
  const result = await page.waitForFunction(
    () => window.__VIZ_PERF__ ?? null,
    { timeout: 180000, polling: 250 },
  ).then(h => h.jsonValue())

  const { stats, verdict, budget } = result
  console.log(`\n[viz-perf] points=${result.points.toLocaleString()} durationMs=${result.durationMs}`)
  console.log('[viz-perf] frame stats:')
  console.log(`  frames   = ${stats.frames}`)
  console.log(`  meanMs   = ${stats.meanMs.toFixed(3)}`)
  console.log(`  medianMs = ${stats.medianMs.toFixed(3)}`)
  console.log(`  p95Ms    = ${stats.p95Ms.toFixed(3)}`)
  console.log(`  meanFps  = ${stats.meanFps.toFixed(2)}`)
  console.log(`  minFps   = ${stats.minFps.toFixed(2)}`)
  console.log(`[viz-perf] story verdict (budget ${JSON.stringify(budget)}): ${verdict.ok ? 'PASS' : 'FAIL'}` +
    (verdict.reasons.length ? ` — ${verdict.reasons.join('; ')}` : ''))

  // Gate: the story's lenient verdict (rendered / non-zero fps / no crash), PLUS any
  // strict CLI budget the caller supplied (real-GPU run).
  const reasons = []
  if (!verdict.ok) reasons.push(...verdict.reasons)
  if (consoleErrors.length) reasons.push(`console errors: ${consoleErrors.slice(0, 3).join(' | ')}`)
  if (minFps != null && stats.minFps < minFps) {
    reasons.push(`min fps ${stats.minFps.toFixed(1)} below --min-fps ${minFps}`)
  }
  if (maxP95 != null && stats.p95Ms > maxP95) {
    reasons.push(`p95 ${stats.p95Ms.toFixed(2)}ms over --max-p95 ${maxP95}ms`)
  }

  if (reasons.length === 0) {
    console.log('\n[viz-perf] RESULT: PASS')
    exitCode = 0
  } else {
    console.log(`\n[viz-perf] RESULT: FAIL — ${reasons.join('; ')}`)
    exitCode = 1
  }
} catch (err) {
  console.error(`[viz-perf] ERROR: ${err && err.message ? err.message : err}`)
  if (consoleErrors.length) console.error('[viz-perf] console errors:', consoleErrors.slice(0, 5))
  exitCode = 1
} finally {
  await browser.close()
}

process.exit(exitCode)
