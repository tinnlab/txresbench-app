// Smoke-verify the showcase renders a real deck.gl scatter under software WebGL.
import { chromium } from 'playwright-core'

const URL = 'http://localhost:1421/viz-showcase.html'
const OUT = '/tmp/claude-1000/-data-pbya-ziee-ziee/b5b52393-63e9-49f1-8500-803873494642/scratchpad/viz-showcase.png'

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
  ],
})
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
const consoleErrors = []
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message))

await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 })
// wait for the scatter canvas + deck to render
await page.waitForSelector('[data-testid="viz-scatter-canvas"]', { timeout: 20000 })
await page.waitForTimeout(3500) // let the fixture load + deck draw a few frames

// WebGL context present?
const webglInfo = await page.evaluate(() => {
  const c = document.querySelector('canvas')
  if (!c) return { hasCanvas: false }
  const gl = c.getContext('webgl2') || c.getContext('webgl')
  return {
    hasCanvas: true,
    hasGL: !!gl,
    glVersion: gl ? gl.getParameter(gl.VERSION) : null,
    w: c.width, h: c.height,
  }
})

// non-blank check: sample the deck canvas pixels, count distinct-ish colors
const pixelStats = await page.evaluate(() => {
  const c = document.querySelector('canvas')
  if (!c) return { ok: false }
  const off = document.createElement('canvas')
  off.width = c.width; off.height = c.height
  const ctx = off.getContext('2d')
  ctx.drawImage(c, 0, 0)
  const { data } = ctx.getImageData(0, 0, off.width, off.height)
  let nonBg = 0, total = 0
  const seen = new Set()
  for (let i = 0; i < data.length; i += 4 * 137) { // sample
    total++
    const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3]
    seen.add(`${r>>4},${g>>4},${b>>4}`)
    if (a > 10 && !(r > 245 && g > 245 && b > 245)) nonBg++
  }
  return { ok: true, sampled: total, nonBackground: nonBg, distinctColors: seen.size }
})

await page.screenshot({ path: OUT })

console.log('WEBGL:', JSON.stringify(webglInfo))
console.log('PIXELS:', JSON.stringify(pixelStats))
console.log('CONSOLE_ERRORS:', consoleErrors.length, JSON.stringify(consoleErrors.slice(0, 8)))
console.log('SCREENSHOT:', OUT)

await browser.close()
const rendered = webglInfo.hasGL && pixelStats.ok && pixelStats.nonBackground > 0 && pixelStats.distinctColors > 3
console.log('RESULT:', rendered ? 'RENDERED_OK' : 'RENDER_FAILED')
process.exit(rendered && consoleErrors.length === 0 ? 0 : 1)
