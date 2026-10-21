// viz-bench.mjs — the REAL interaction-performance benchmark runner (counterpart to
// viz-perf.mjs). viz-perf measures the pessimistic "rebuild the layer every frame" cost;
// THIS runner measures whether interactions are REALTIME:
//
//   • STEADY-STATE pan/zoom fps — drives REAL camera motion (page.mouse wheel + drag) over the
//     canvas for ~3s. That changes ONLY deck's internal viewState, never the data, so the
//     recorded frame cadence is the true steady-state fps of panning/zooming N points.
//   • PER-INTERACTION latency — asks the story's window.__BENCH__ to apply ONLY what each
//     interaction changes (a uniform / an attribute re-upload / a selection mask / a resize /
//     a discrete zoom step) and time to the frame that PAINTS the change.
//
// It sweeps each `kind` × each `N`, prints a per-config row, and emits one machine-readable
// JSON blob at the end. The WebGL RENDERER string is printed once at startup so the report
// PROVES which GPU it ran on (real NVIDIA vs SwiftShader).
//
// The orchestrator runs this on a REAL NVIDIA GPU, so the DEFAULT launch args are the real-GPU
// ANGLE/Vulkan args; override with --gpu=swiftshader (software) or --launch-args="a,b,c".
//
//   node scripts/viz-bench.mjs                              # all kinds × [1e4,1e5,1e6,1e7], real GPU
//   node scripts/viz-bench.mjs --kinds=scatter --points=10000   # smoke
//   node scripts/viz-bench.mjs --gpu=swiftshader --points=10000 # software (local, no GPU)
//   node scripts/viz-bench.mjs --url=http://localhost:<derived>/viz-showcase.html --out=bench.json
//
// Flags: --url, --kinds=a,b,c, --points=n,n,n, --duration=<ms> (steady sweep),
//   --timeout=<ms> (per-config budget), --gpu=swiftshader|angle, --launch-args="...", --headed,
//   --out=<file.json>.

import { chromium } from 'playwright-core'
import { writeFileSync } from 'node:fs'

import { assertOriginIsOurs } from './harness-origin.mjs'
import { resolveVizPort } from './resolve-viz-port.mjs'

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
function listArg(name, fallback) {
  const v = argVal(name)
  if (v == null || v === true) return fallback
  return String(v)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}
function numArg(name, fallback) {
  const v = argVal(name)
  if (v == null || v === true) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

// THE DEFAULT USED TO BE THE RETIRED FIXED `http://localhost:1421/viz-showcase.html`.
// This driver is not Playwright, so `reuseExistingServer` never applied to it and the
// port fix never reached it — but the exposure is the same class and arguably worse: a
// benchmark silently measures whatever answers :1421, which on a box with ~150
// worktrees is very likely somebody else's showcase, and a WRONG NUMBER does not look
// like a failure. It reads as a result.
//
// So the default is the derived, sentinel-proved dev origin, and whatever origin we end
// up with (default or `--url`) is asserted to be THIS worktree's before a single frame
// is measured. `allowReuse: true` because adopting is the whole point here — this driver
// measures a showcase a human already booted (`npm run viz-showcase`) — and the
// assertion below is what makes adopting safe.
const explicitUrl = argVal('url')
let BASE_URL = explicitUrl
if (!BASE_URL) {
  const { port, reused } = await resolveVizPort('vizShowcase', { allowReuse: true })
  if (!reused) {
    console.error(
      `[viz-bench] no showcase of this worktree is running (nothing on the derived :${port}).\n` +
        '            Start one with `npm run viz-showcase`, or pass --url=<origin>.',
    )
    process.exit(2)
  }
  BASE_URL = `http://localhost:${port}/viz-showcase.html`
}
{
  const u = new URL(BASE_URL)
  if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname)) {
    // Measuring a foreign tree's bundle produces a number that is not about this
    // branch, and nothing downstream can tell. Refuse rather than report it.
    await assertOriginIsOurs({ port: Number(u.port), url: BASE_URL, label: 'viz bench driver' })
  }
}
const KINDS = listArg('kinds', ['scatter', 'heatmap', 'dotplot'])
const POINTS = listArg('points', ['10000', '100000', '1000000', '10000000']).map(Number).filter(n => n > 0)
const DURATION_MS = numArg('duration', 3000)
const PER_CONFIG_TIMEOUT_MS = numArg('timeout', 120000)
const HEADED = argVal('headed') === true
const OUT = argVal('out')

// Launch args: real-GPU (default), swiftshader shortcut, or a full override.
const REAL_GPU_ARGS = ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist']
const SWIFTSHADER_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
let launchArgs = REAL_GPU_ARGS
const gpu = argVal('gpu')
if (gpu === 'swiftshader') launchArgs = SWIFTSHADER_ARGS
const laOverride = argVal('launch-args')
if (typeof laOverride === 'string') launchArgs = laOverride.split(',').map(s => s.trim()).filter(Boolean)

console.log(`[viz-bench] url=${BASE_URL}`)
console.log(`[viz-bench] kinds=${KINDS.join(',')} points=${POINTS.join(',')} duration=${DURATION_MS}ms timeout=${PER_CONFIG_TIMEOUT_MS}ms`)
console.log(`[viz-bench] launch args: ${launchArgs.join(' ')}`)

const browser = await chromium.launch({ headless: !HEADED, args: launchArgs })

// ── print the WebGL RENDERER once (proves the real GPU vs SwiftShader) ────────
async function probeRenderer() {
  const page = await browser.newPage()
  try {
    await page.setContent('<canvas id="c"></canvas>')
    const info = await page.evaluate(() => {
      const gl = document.getElementById('c').getContext('webgl2') || document.getElementById('c').getContext('webgl')
      if (!gl) return { renderer: 'NO-WEBGL', vendor: 'NO-WEBGL', version: '' }
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      return {
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        version: gl.getParameter(gl.VERSION),
      }
    })
    return info
  } catch (e) {
    return { renderer: `PROBE-FAILED: ${e.message}`, vendor: '', version: '' }
  } finally {
    await page.close()
  }
}

const renderer = await probeRenderer()
console.log(`[viz-bench] WebGL RENDERER = ${renderer.renderer}`)
console.log(`[viz-bench] WebGL VENDOR   = ${renderer.vendor}`)
console.log(`[viz-bench] WebGL VERSION  = ${renderer.version}`)
const isSoftware = /swiftshader|llvmpipe|software|microsoft basic/i.test(String(renderer.renderer))
console.log(`[viz-bench] GPU class: ${isSoftware ? 'SOFTWARE (numbers are informational)' : 'HARDWARE (real GPU)'}\n`)

const INTERACTIONS = ['filter', 'recolor', 'select', 'resize', 'zoomStep']

/** Drive real camera motion (wheel zoom + drag pan) over `box` for ~durationMs. Pure viewState
 *  churn — no data rebuild — so the recorded frames are true steady-state pan/zoom. */
async function driveCameraMotion(page, box, durationMs) {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const end = Date.now() + durationMs
  let i = 0
  await page.mouse.move(cx, cy)
  while (Date.now() < end) {
    // drag-pan: press, move across the canvas in steps (each step → a deck redraw), release.
    await page.mouse.move(cx - 120, cy - 60)
    await page.mouse.down()
    await page.mouse.move(cx + 120, cy + 70, { steps: 10 })
    await page.mouse.up()
    // wheel-zoom in/out alternately.
    await page.mouse.wheel(0, i % 2 === 0 ? -90 : 90)
    i++
  }
}

/** Run ONE (kind, N) config with a hard per-config timeout. Records whatever it measured; a
 *  hang / OOM / crash lands as status 'failed' with the partial data + error. */
async function runConfig(kind, n) {
  const result = {
    kind,
    points: n,
    status: 'failed',
    loadMs: null,
    steady: null, // { frames, medianMs, p95Ms, meanFps, minFps }
    interactions: {}, // { filter: ms|null, ... }
    deckFps: null,
    error: null,
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  const consoleErrors = []
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', e => consoleErrors.push('PAGEERR: ' + e.message))

  const work = (async () => {
    const url = new URL(BASE_URL)
    url.searchParams.set('points', String(n))
    url.searchParams.set('kind', kind)
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 20000 })
    await page.click('[data-testid="showcase-story-benchmark"]')

    // Wait for the story to load the fixture + paint its first frame (aggregation for matrix).
    await page.waitForSelector('[data-testid="viz-benchmark-ready"]', { timeout: PER_CONFIG_TIMEOUT_MS })
    result.status = 'ok'
    result.loadMs = await page.evaluate(() => window.__BENCH__.meta().loadMs)
    const supportsData = await page.evaluate(() => window.__BENCH__.meta().supportsDataInteractions)

    // 1) STEADY-STATE pan/zoom fps.
    const box = await page.locator('[data-testid="viz-benchmark-root"]').boundingBox()
    await page.evaluate(() => window.__BENCH__.startRecording())
    if (box) await driveCameraMotion(page, box, DURATION_MS)
    await page.evaluate(() => window.__BENCH__.stopRecording())
    const stats = await page.evaluate(() => window.__BENCH__.frameStats())
    result.steady = {
      frames: stats.frames,
      medianMs: stats.medianMs,
      p95Ms: stats.p95Ms,
      meanFps: stats.meanFps,
      minFps: stats.minFps,
    }
    result.deckFps = await page.evaluate(() => window.__BENCH__.deckFps())

    // 2) PER-INTERACTION latency.
    for (const type of INTERACTIONS) {
      // Skip data-interactions for matrix kinds (they'd return null anyway; record 'n/a').
      if (!supportsData && (type === 'filter' || type === 'recolor' || type === 'select')) {
        result.interactions[type] = null
        continue
      }
      try {
        // Measure STEADY latency, not a single cold shot: repeat, DISCARD the first
        // (cold: first buffer alloc / pipeline warmup + any post-pan GC), report the
        // median of the rest. A one-shot right after the 3s pan sweep captured a
        // post-churn GC stall, not the latency a user actually feels on repeated use.
        const samples = []
        for (let i = 0; i < 6; i++) {
          const ms = await page.evaluate(t => window.__BENCH__.measureInteraction(t), type)
          if (typeof ms === 'number') samples.push(ms)
          await page.waitForTimeout(120)
        }
        if (samples.length === 0) { result.interactions[type] = null; continue }
        const warm = samples.slice(1).length ? samples.slice(1) : samples
        warm.sort((a, b) => a - b)
        const median = warm[Math.floor(warm.length / 2)]
        result.interactions[type] = Math.round(median * 10) / 10
        result.interactionsCold = result.interactionsCold || {}
        result.interactionsCold[type] = Math.round(samples[0] * 10) / 10
      } catch (e) {
        result.interactions[type] = { error: String(e.message || e) }
      }
    }
    if (consoleErrors.length) result.consoleErrors = consoleErrors.slice(0, 5)
  })()

  let timer
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`per-config timeout after ${PER_CONFIG_TIMEOUT_MS}ms`)), PER_CONFIG_TIMEOUT_MS + 90000)
  })
  try {
    await Promise.race([work, timeout])
  } catch (e) {
    result.status = result.status === 'ok' ? 'partial' : 'failed'
    result.error = String(e.message || e)
    if (consoleErrors.length) result.consoleErrors = consoleErrors.slice(0, 5)
  } finally {
    clearTimeout(timer)
    await page.close().catch(() => {})
  }
  return result
}

function fmt(v, digits = 1) {
  return v == null ? 'n/a' : typeof v === 'number' ? v.toFixed(digits) : (v.error ? 'ERR' : String(v))
}
function fmtLat(v) {
  if (v == null) return 'n/a'
  if (typeof v === 'object') return 'ERR'
  return `${v.toFixed(1)}ms`
}

// ── the sweep ─────────────────────────────────────────────────────────────────
const all = []
// header row
const header = ['kind', 'N', 'load(ms)', 'steady med', 'steady p95', 'steady fps', 'min fps', 'filter', 'recolor', 'select', 'resize', 'zoom']
console.log(header.join('\t'))

for (const kind of KINDS) {
  for (const n of POINTS) {
    const r = await runConfig(kind, n)
    all.push(r)
    const s = r.steady
    const row = [
      r.kind,
      n.toLocaleString(),
      r.loadMs == null ? 'n/a' : r.loadMs.toFixed(0),
      s ? fmt(s.medianMs, 2) : 'n/a',
      s ? fmt(s.p95Ms, 2) : 'n/a',
      s ? fmt(s.meanFps, 1) : 'n/a',
      s ? fmt(s.minFps, 1) : 'n/a',
      fmtLat(r.interactions.filter),
      fmtLat(r.interactions.recolor),
      fmtLat(r.interactions.select),
      fmtLat(r.interactions.resize),
      fmtLat(r.interactions.zoomStep),
    ]
    const tag = r.status === 'ok' ? '' : `  [${r.status}${r.error ? ': ' + r.error : ''}]`
    console.log(row.join('\t') + tag)
  }
}

const blob = {
  renderer,
  gpuClass: isSoftware ? 'software' : 'hardware',
  launchArgs,
  durationMs: DURATION_MS,
  results: all,
  generatedAt: new Date().toISOString(),
}
console.log('\n[viz-bench] JSON:')
console.log(JSON.stringify(blob))
if (typeof OUT === 'string') {
  writeFileSync(OUT, JSON.stringify(blob, null, 2))
  console.log(`[viz-bench] wrote ${OUT}`)
}

await browser.close()
// Exit non-zero only if EVERY config failed (a total wipeout); partial/ok sweeps exit 0 so the
// orchestrator keeps the numbers it did collect.
const anyOk = all.some(r => r.status === 'ok' || r.status === 'partial')
process.exit(anyOk ? 0 : 1)
