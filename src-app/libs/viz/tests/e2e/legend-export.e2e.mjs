// legend-export.e2e.mjs — TEST-10. Drives the `grid-cell-export` showcase in a real browser:
// clicks a cell's ⤓ export, exports SVG WITH "Include legend" on, and asserts the downloaded SVG
// contains the legend swatch <rect>/label <text>; then toggles the legend OFF and asserts they're
// gone. Proves the legend is baked into the exported artifact end-to-end (the JTBD).
//
// Runnable script (the @txresbench/viz package has no playwright test runner — matches the prior
// lifecycle's e2e-script convention). Usage:
//   node tests/e2e/legend-export.e2e.mjs [baseUrl]   (default http://localhost:1480)
// Run `npx vite --port 1480 --strictPort` in the package first.
import { chromium } from 'playwright'
import { readFile } from 'node:fs/promises'

const BASE = process.argv[2] ?? 'http://localhost:1480'
const url = `${BASE}/viz-showcase.html#grid-cell-export`

async function exportSvg(page, { withLegend }) {
  // open the dialog for the first dense cell
  await page.waitForSelector('[data-testid^="viz-cell-export-"]', { timeout: 20000 })
  await page.click('[data-testid^="viz-cell-export-"]')
  await page.waitForSelector('[data-testid="viz-export-dialog"]', { timeout: 10000 })
  await page.selectOption('[data-testid="export-format"]', 'svg')
  // the legend toggle appears once the async legend spec resolves
  await page.waitForSelector('[data-testid="export-legend"]', { timeout: 10000 })
  const checked = await page.isChecked('[data-testid="export-legend"]')
  if (checked !== withLegend) await page.click('[data-testid="export-legend"]')
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    page.click('[data-testid="export-button"]'),
  ])
  const path = await download.path()
  return await readFile(path, 'utf8')
}

const b = await chromium.launch()
const ctx = await b.newContext({ acceptDownloads: true })
const page = await ctx.newPage()
const errs = []
page.on('pageerror', e => errs.push(String(e)))
await page.goto(url, { waitUntil: 'commit' })

let pass = true
try {
  const withLegend = await exportSvg(page, { withLegend: true })
  const hasRect = /<rect[^>]*fill="#[0-9a-fA-F]{6}"/.test(withLegend)
  const hasText = /<text[^>]*>/.test(withLegend)
  const hasImage = withLegend.includes('<image')
  console.log(`WITH legend:  <image>=${hasImage} legend<rect fill>=${hasRect} <text>=${hasText}  bytes=${withLegend.length}`)
  if (!(hasImage && hasRect && hasText)) pass = false

  // reload to reset the dialog, then export WITHOUT the legend
  await page.goto(url, { waitUntil: 'commit' })
  const noLegend = await exportSvg(page, { withLegend: false })
  const noRect = /<rect[^>]*fill="#[0-9a-fA-F]{6}"/.test(noLegend)
  console.log(`WITHOUT legend: <image>=${noLegend.includes('<image')} legend<rect fill>=${noRect}  bytes=${noLegend.length}`)
  // without a legend the scene is just the plot image (no colored swatch rects)
  if (noRect) pass = false
  // and the with-legend export must be strictly larger (extra marks)
  if (!(withLegend.length > noLegend.length)) pass = false
} catch (e) {
  console.log('ERROR:', e.message)
  pass = false
}

const appErrs = errs.filter(e => !/favicon|shader|luma|WebGL|SwiftShader/i.test(e))
if (appErrs.length) { console.log('APP ERRORS:', appErrs.slice(0, 3).join(' | ')); pass = false }
console.log(pass ? 'TEST-10 PASS' : 'TEST-10 FAIL')
await b.close()
process.exit(pass ? 0 : 1)
