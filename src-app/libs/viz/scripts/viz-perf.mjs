// viz-perf.mjs — reproducible CPU-vs-GPU fps benchmark harness for @txresbench/viz.
//
// WHAT IT DOES
//   Drives the `benchmark` showcase story (which publishes window.__BENCH__) through a real
//   Chromium via Playwright, forcing either a SOFTWARE (SwiftShader) or a HARDWARE (NVIDIA)
//   WebGL backend, and records the STEADY-STATE pan/zoom frame cadence for a range of point
//   counts. It reads the WebGL UNMASKED_RENDERER_WEBGL string so the run PROVES which backend
//   actually served (cpu => "SwiftShader…", gpu => "NVIDIA…"). Results are printed as a table
//   AND written to libs/viz/scripts/viz-perf.<mode>.json so a before/after pair is diffable.
//
// WHY IT LIVES HERE BUT RUNS FROM src-app/ui
//   This is a plain-Node ESM script (no bundler). It imports `chromium` from `@playwright/test`,
//   which is NOT a dependency of libs/viz — it is resolvable from src-app/ui. So RUN THIS
//   SCRIPT FROM src-app/ui (node module resolution walks up from the cwd, so @playwright/test
//   resolves there). The script path is absolute-agnostic; only the cwd matters for resolution.
//
// SETUP (operator, two terminals)
//   1) Start the showcase dev server from libs/viz (a DIFFERENT port than the shared 1421):
//        cd libs/viz && npx vite --port 1431 --strictPort
//      (or point VIZ_PERF_URL at any already-running showcase, see below)
//   2) From src-app/ui, run the harness for each backend:
//        cd src-app/ui
//        node ../libs/viz/scripts/viz-perf.mjs cpu    # SwiftShader baseline
//        node ../libs/viz/scripts/viz-perf.mjs gpu    # NVIDIA hardware
//      Optionally pass explicit point counts:
//        node ../libs/viz/scripts/viz-perf.mjs gpu 100000 1000000
//
// ENV
//   VIZ_PERF_URL   base showcase URL (default http://localhost:1431/viz-showcase.html).
//
// OUTPUT
//   libs/viz/scripts/viz-perf.cpu.json / viz-perf.gpu.json — an array of
//     { points, renderer, meta, stats, deckFps, error? }
//   where `meta` is __BENCH__.meta() { kind, points, loadMs, supportsDataInteractions } and
//   `stats` is __BENCH__.frameStats() { frames, meanMs, medianMs, p95Ms, minFps, meanFps }.
//
// NOTES
//   - Dependency-free beyond @playwright/test.
//   - Each point count is guarded in try/catch: 10M under SwiftShader can exceed the ready
//     timeout — that point records an `error` and the run continues to the next size.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { chromium } from '@playwright/test'

const __dirname = dirname(fileURLToPath(import.meta.url))

const DEFAULT_POINTS = [100000, 1000000, 10000000]
const READY_TIMEOUT_MS = 150000
const DRIVE_MS = 3500
const VIEWPORT = { width: 1280, height: 820 }

// Backend-forcing Chromium flags. CPU => SwiftShader (software rasterizer, no GPU). GPU =>
// native EGL/GL with the blocklist ignored so a headless NVIDIA context is actually created.
const LAUNCH_ARGS = {
  cpu: ['--use-gl=angle', '--use-angle=swiftshader'],
  gpu: ['--use-gl=angle', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox'],
}

function parseArgs(argv) {
  const [mode, ...rest] = argv
  if (mode !== 'cpu' && mode !== 'gpu') {
    console.error('usage: node viz-perf.mjs <cpu|gpu> [points...]')
    process.exit(2)
  }
  const points = rest.length
    ? rest.map(p => {
        const n = Number(p)
        if (!Number.isFinite(n) || n <= 0) {
          console.error(`invalid point count: ${p}`)
          process.exit(2)
        }
        return Math.floor(n)
      })
    : DEFAULT_POINTS.slice()
  return { mode, points }
}

// Read the ACTUAL WebGL renderer string via the debug-renderer-info extension. This is the
// proof-of-backend: SwiftShader for cpu, an NVIDIA string for gpu.
async function readRenderer(page) {
  return page.evaluate(() => {
    try {
      const canvas = document.createElement('canvas')
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
      if (!gl) return 'no-webgl-context'
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      if (ext) {
        const r = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
        if (r) return String(r)
      }
      return String(gl.getParameter(gl.RENDERER) || 'unknown-renderer')
    } catch (e) {
      return 'renderer-read-error: ' + String(e && e.message ? e.message : e)
    }
  })
}

// Drive continuous camera motion (pan + zoom) over the benchmark canvas for ~DRIVE_MS. Only
// deck's internal viewState changes, so the recorded frame cadence is the true steady-state
// pan/zoom fps. Uses Playwright's real input (mouse drags + wheel), alternating direction.
async function drivePanZoom(page, box) {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const dx = box.width * 0.28
  const dy = box.height * 0.28
  const deadline = Date.now() + DRIVE_MS
  let phase = 0
  while (Date.now() < deadline) {
    const dir = phase % 2 === 0 ? 1 : -1
    // pan: press near center, drag across, release.
    await page.mouse.move(cx - dx * dir, cy - dy * dir)
    await page.mouse.down()
    await page.mouse.move(cx + dx * dir, cy + dy * dir, { steps: 8 })
    await page.mouse.up()
    // zoom: alternate in/out so the view stays roughly in range over the drive window.
    await page.mouse.move(cx, cy)
    await page.mouse.wheel(0, dir > 0 ? -120 : 120)
    phase++
  }
}

function fmt(n, digits = 1) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : '—'
}

function printTable(mode, results) {
  const rows = results.map(r => {
    if (r.error) {
      return { points: r.points.toLocaleString(), renderer: (r.renderer || '').slice(0, 28), status: 'ERROR: ' + r.error }
    }
    const s = r.stats || {}
    return {
      points: r.points.toLocaleString(),
      renderer: (r.renderer || '').slice(0, 28),
      frames: s.frames,
      meanMs: fmt(s.meanMs, 2),
      p95Ms: fmt(s.p95Ms, 2),
      meanFps: fmt(s.meanFps, 1),
      minFps: fmt(s.minFps, 1),
      deckFps: fmt(r.deckFps, 1),
      loadMs: r.meta ? fmt(r.meta.loadMs, 0) : '—',
    }
  })
  console.log(`\n=== viz-perf [${mode}] ===`)
  console.table(rows)
}

async function benchOne(browser, url, points) {
  const context = await browser.newContext({ viewport: VIEWPORT })
  const page = await context.newPage()
  try {
    const target = url + (url.includes('?') ? '&' : '?') + 'points=' + points
    await page.goto(target, { waitUntil: 'load', timeout: 60000 })

    const renderer = await readRenderer(page)

    // Select the benchmark story (mounts BenchmarkStory, which reads ?points= + installs __BENCH__).
    await page.getByTestId('showcase-story-benchmark').click({ timeout: 30000 })

    // Wait for the fixture to load + first paint (ready flips true).
    await page.waitForFunction(
      () => !!(window.__BENCH__ && window.__BENCH__.ready === true),
      { timeout: READY_TIMEOUT_MS },
    )

    const meta = await page.evaluate(() => window.__BENCH__.meta())

    // Locate the canvas to drive; boundingBox gives real client coords for the mouse.
    const canvas = page.locator('[data-testid="viz-benchmark-root"] canvas').first()
    await canvas.waitFor({ state: 'visible', timeout: 30000 })
    const box = await canvas.boundingBox()
    if (!box) throw new Error('benchmark canvas has no bounding box')

    await page.evaluate(() => window.__BENCH__.startRecording())
    await drivePanZoom(page, box)
    await page.evaluate(() => window.__BENCH__.stopRecording())

    const stats = await page.evaluate(() => window.__BENCH__.frameStats())
    const deckFps = await page.evaluate(() => window.__BENCH__.deckFps())

    return { points, renderer, meta, stats, deckFps }
  } catch (e) {
    let renderer = ''
    try {
      renderer = await readRenderer(page)
    } catch {
      // ignore — page may be in a bad state after the failure.
    }
    return { points, renderer, meta: null, stats: null, deckFps: null, error: String(e && e.message ? e.message : e) }
  } finally {
    await context.close().catch(() => {})
  }
}

async function main() {
  const { mode, points } = parseArgs(process.argv.slice(2))
  const url = process.env.VIZ_PERF_URL || 'http://localhost:1431/viz-showcase.html'

  console.log(`viz-perf: mode=${mode} points=[${points.join(', ')}] url=${url}`)
  console.log(`viz-perf: launching chromium with args: ${LAUNCH_ARGS[mode].join(' ')}`)

  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS[mode] })
  const results = []
  try {
    for (const n of points) {
      process.stdout.write(`viz-perf: benchmarking ${n.toLocaleString()} points… `)
      const r = await benchOne(browser, url, n)
      if (r.error) {
        console.log(`ERROR (${r.error})`)
      } else {
        console.log(`ok — meanFps=${fmt(r.stats.meanFps, 1)} p95=${fmt(r.stats.p95Ms, 2)}ms [${(r.renderer || '').slice(0, 40)}]`)
      }
      results.push(r)
    }
  } finally {
    await browser.close().catch(() => {})
  }

  printTable(mode, results)

  const outPath = join(__dirname, `viz-perf.${mode}.json`)
  writeFileSync(outPath, JSON.stringify(results, null, 2) + '\n')
  console.log(`\nviz-perf: wrote ${outPath}`)
}

main().catch(e => {
  console.error('viz-perf: fatal', e)
  process.exit(1)
})
