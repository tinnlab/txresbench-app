// viz-raster-probe.mjs — measures the CPU RASTER-mode capability (the actual large-N CPU path),
// NOT the naive single-layer scatter that viz-perf.mjs's `benchmark` story drives. It navigates
// the `cpu-raster` story (CategoricalPointsView in cpuRaster mode → ONE bin-then-shade BitmapLayer
// quad), waits for the COMMITTED raster (a non-'0' data-raster-hash), records the load time, then
// drives real pan/zoom for ~3.5s and reports the steady-state fps.
//
// usage: node viz-raster-probe.mjs <cpu|gpu> [points...]   (default 1000000 10000000)

import { chromium } from '@playwright/test'

const READY_TIMEOUT_MS = 240000
const DRIVE_MS = 3500
const VIEWPORT = { width: 1280, height: 820 }
const URL = process.env.VIZ_PERF_URL || 'http://localhost:1431/viz-showcase.html'

const LAUNCH_ARGS = {
  cpu: ['--use-gl=angle', '--use-angle=swiftshader'],
  gpu: ['--use-gl=angle', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox'],
}

const [mode, ...rest] = process.argv.slice(2)
if (mode !== 'cpu' && mode !== 'gpu') {
  console.error('usage: node viz-raster-probe.mjs <cpu|gpu> [points...]')
  process.exit(2)
}
const points = rest.length ? rest.map(p => Math.floor(Number(p))) : [1000000, 10000000]

async function drivePanZoom(page, box) {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const dx = box.width * 0.28
  const dy = box.height * 0.28
  const deadline = Date.now() + DRIVE_MS
  let phase = 0
  while (Date.now() < deadline) {
    const dir = phase % 2 === 0 ? 1 : -1
    await page.mouse.move(cx - dx * dir, cy - dy * dir)
    await page.mouse.down()
    await page.mouse.move(cx + dx * dir, cy + dy * dir, { steps: 8 })
    await page.mouse.up()
    await page.mouse.move(cx, cy)
    await page.mouse.wheel(0, dir > 0 ? -120 : 120)
    phase++
  }
}

async function probeOne(browser, n) {
  const context = await browser.newContext({ viewport: VIEWPORT })
  const page = await context.newPage()
  try {
    const target = `${URL}${URL.includes('?') ? '&' : '?'}points=${n}`
    const t0 = Date.now()
    await page.goto(target, { waitUntil: 'load', timeout: 60000 })
    await page.getByTestId('showcase-story-cpu-raster').click({ timeout: 30000 })

    // Load = navigation → the FIRST committed raster (non-'0' hash on the raster view). This times
    // the real fixture-build + off-thread bin+shade + paint pipeline for N points.
    const view = page.locator('[data-testid="viz-cpu-raster-view"]')
    await view.waitFor({ state: 'attached', timeout: READY_TIMEOUT_MS })
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="viz-cpu-raster-view"]')
        const h = el?.getAttribute('data-raster-hash')
        return !!h && h !== '0'
      },
      { timeout: READY_TIMEOUT_MS },
    )
    const loadMs = Date.now() - t0

    // Record rAF cadence during real pan/zoom.
    await page.evaluate(() => {
      const w = window
      w.__RAF__ = { on: false, s: [], h: 0 }
      w.__RAF_START__ = () => {
        w.__RAF__.s = []
        w.__RAF__.on = true
        const tick = t => {
          if (!w.__RAF__.on) return
          w.__RAF__.s.push(t)
          w.__RAF__.h = requestAnimationFrame(tick)
        }
        w.__RAF__.h = requestAnimationFrame(tick)
      }
      w.__RAF_STOP__ = () => {
        w.__RAF__.on = false
        cancelAnimationFrame(w.__RAF__.h)
      }
    })
    const box = await view.boundingBox()
    await page.evaluate(() => window.__RAF_START__())
    await drivePanZoom(page, box)
    await page.evaluate(() => window.__RAF_STOP__())
    const stats = await page.evaluate(() => {
      const s = window.__RAF__.s
      if (s.length < 3) return { frames: s.length, meanFps: 0, p95Ms: 0 }
      const deltas = []
      for (let i = 1; i < s.length; i++) deltas.push(s[i] - s[i - 1])
      deltas.sort((a, b) => a - b)
      const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length
      const p95 = deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.95))]
      return { frames: s.length, meanFps: 1000 / mean, p95Ms: p95 }
    })

    const renderer = await page.evaluate(() => {
      try {
        const c = document.createElement('canvas')
        const gl = c.getContext('webgl2') || c.getContext('webgl')
        const ext = gl && gl.getExtension('WEBGL_debug_renderer_info')
        return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown'
      } catch {
        return 'err'
      }
    })
    return { points: n, loadMs, ...stats, renderer: renderer.slice(0, 30) }
  } catch (e) {
    return { points: n, error: String(e && e.message ? e.message : e).slice(0, 120) }
  } finally {
    await context.close()
  }
}

const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS[mode] })
console.log(`viz-raster-probe: mode=${mode} points=[${points.join(', ')}]`)
const results = []
for (const n of points) {
  const r = await probeOne(browser, n)
  results.push(r)
  if (r.error) console.log(`  ${n.toLocaleString()} → ERROR: ${r.error}`)
  else
    console.log(
      `  ${n.toLocaleString()} → load ${r.loadMs}ms · pan ${r.meanFps.toFixed(1)}fps (p95 ${r.p95Ms.toFixed(1)}ms, ${r.frames} frames) [${r.renderer}]`,
    )
}
await browser.close()
console.table(results)
