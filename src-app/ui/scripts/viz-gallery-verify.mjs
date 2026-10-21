// Walk EVERY showcase story under headless software-WebGL, screenshot each, and check
// it renders (non-blank canvas) with no console errors. The render-verify harness.
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const URL = 'http://localhost:1421/viz-showcase.html'
const DIR = process.env.SHOT_DIR || '/tmp/claude-1000/-data-pbya-ziee-ziee/b5b52393-63e9-49f1-8500-803873494642/scratchpad/shots'
mkdirSync(DIR, { recursive: true })

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 20000 })

const storyIds = await page.$$eval('[data-testid^="showcase-story-"]', els =>
  els.map(e => e.getAttribute('data-testid').replace('showcase-story-', '')),
)

const results = []
for (const id of storyIds) {
  const errors = []
  const onErr = m => { if (m.type() === 'error') errors.push(m.text()) }
  const onPage = e => errors.push('PAGEERR: ' + e.message)
  page.on('console', onErr)
  page.on('pageerror', onPage)
  await page.click(`[data-testid="showcase-story-${id}"]`)
  await page.waitForTimeout(2600)
  const stats = await page.evaluate(() => {
    const c = document.querySelector('canvas')
    if (!c) return { hasCanvas: false }
    const off = document.createElement('canvas')
    off.width = c.width; off.height = c.height
    const ctx = off.getContext('2d'); ctx.drawImage(c, 0, 0)
    const { data } = ctx.getImageData(0, 0, off.width, off.height)
    let nonBg = 0; const seen = new Set()
    for (let i = 0; i < data.length; i += 4 * 97) {
      const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3]
      seen.add(`${r>>4},${g>>4},${b>>4}`)
      if (a > 10 && !(r > 245 && g > 245 && b > 245)) nonBg++
    }
    return { hasCanvas: true, nonBg, colors: seen.size }
  })
  await page.screenshot({ path: `${DIR}/${id}.png` })
  page.off('console', onErr); page.off('pageerror', onPage)
  const ok = stats.hasCanvas && stats.nonBg > 0 && errors.length === 0
  results.push({ id, ok, ...stats, errors: errors.slice(0, 3) })
  console.log(`${ok ? 'OK ' : 'XX '} ${id.padEnd(20)} canvas=${stats.hasCanvas} nonBg=${stats.nonBg ?? '-'} colors=${stats.colors ?? '-'} err=${errors.length}`)
}
await browser.close()
const failed = results.filter(r => !r.ok)
console.log(`\nRESULT: ${results.length - failed.length}/${results.length} rendered OK`)
if (failed.length) console.log('FAILED:', JSON.stringify(failed, null, 1))
process.exit(failed.length === 0 ? 0 : 1)
