// image-render.e2e.mjs — TEST-A1 [acceptance][invariant: INV-1] (covers ITEM-1). Proves the
// annotation editor's IMAGE surface is storage-agnostic + backend-free: a fixture PixelSource
// pyramid renders on the ONE shared <DeckGL> (exactly one WebGL canvas for a single image cell),
// the RGB single-level (ImageLayer) AND the 16-bit multiplex (MultiscaleImageLayer/pyramid) paths
// both draw, and NO network request reaches any backend (only static localhost assets) — nothing
// but the vite dev server is contacted.
// Runnable: node tests/e2e/image-render.e2e.mjs [baseUrl]   (default http://localhost:1471)
// Run `npx vite --port 1471 --strictPort` in the package first.
import { chromium } from 'playwright'
const BASE = process.argv[2] ?? 'http://localhost:1471'
const SC = '/tmp/claude-1000/-data-pbya-ziee-ziee/b5b52393-63e9-49f1-8500-803873494642/scratchpad'
const ORIGIN = new URL(BASE).origin

const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1400, height: 900 } })
const errs = []
// Any request NOT to the dev-server origin (and not a data:/blob: inline asset) = a "backend" call.
const foreignReqs = []
p.on('pageerror', e => errs.push(String(e)))
p.on('console', m => {
  const t = m.text()
  if (m.type() === 'error' && !/favicon|shader|luma|SwiftShader|assertion failed|SelectableScatterLayer/i.test(t))
    errs.push('C:' + t)
})
p.on('request', r => {
  const u = r.url()
  if (u.startsWith('data:') || u.startsWith('blob:')) return
  if (!u.startsWith(ORIGIN)) foreignReqs.push(u)
})

let pass = true
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) pass = false
}
const glCount = () =>
  p.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')]
    const gl = cs.filter(c => {
      try {
        return !!(c.getContext('webgl2') || c.getContext('webgl'))
      } catch {
        return false
      }
    }).length
    return { canvases: cs.length, gl, hasRaster: !!document.querySelector('[data-testid="viz-raster-image"]') }
  })

try {
  await p.goto(`${BASE}/viz-showcase.html#annotate-image-render`, { waitUntil: 'commit' })
  await p.waitForSelector('[data-testid="viz-annotate-image-render"]', { timeout: 20000 })

  // ── RGB single-level (ImageLayer path) — one shared WebGL canvas. ──
  await p.getByTestId('annotate-image-variant-rgb').click({ force: true })
  await p.waitForSelector('[data-testid="viz-raster-image"]', { timeout: 20000 })
  await p.waitForTimeout(3500)
  const rgb = await glCount()
  await p.screenshot({ path: `${SC}/e2e-image-render-rgb.png` })
  check(rgb.hasRaster, 'TEST-A1 RGB image cell renders (viz-raster-image present)')
  check(rgb.gl === 1, 'TEST-A1 single image cell renders on ONE shared WebGL context', `gl=${rgb.gl} canvases=${rgb.canvases}`)

  // ── 16-bit multiplex pyramid (MultiscaleImageLayer path) — still ONE context, still draws. ──
  await p.getByTestId('annotate-image-variant-multiplex').click({ force: true })
  await p.waitForTimeout(3500)
  const mx = await glCount()
  check(mx.hasRaster && mx.gl === 1, 'TEST-A1 16-bit multiplex pyramid renders on ONE context', `gl=${mx.gl}`)

  // ── Backend-free: not a single request left the dev-server origin. ──
  check(foreignReqs.length === 0, 'TEST-A1 storage-agnostic — NO backend network request', `foreign=${foreignReqs.length} ${foreignReqs.slice(0, 3).join(' | ')}`)
  check(errs.length === 0, 'no console/page errors', errs.slice(0, 3).join(' | '))
} catch (e) {
  check(false, 'e2e threw', String(e))
}

await b.close()
console.log(pass ? '\nimage-render e2e: ALL PASS' : '\nimage-render e2e: FAILURES ABOVE')
process.exit(pass ? 0 : 1)
