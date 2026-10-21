// export-pubready.e2e.mjs — TEST-23/24: the publication export controls (EPS/TIFF formats, print-size
// column + DPI, TIFF color-mode + CVD check, and the reproducible-figure Bundle) are reachable in the
// GridWorkspace-owned export dialog, and a TIFF export downloads. Runnable: node tests/e2e/export-pubready.e2e.mjs
import { chromium } from 'playwright'
const BASE = process.argv[2] ?? 'http://localhost:1483'

const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1560, height: 900 } })
let pass = true
const check = (ok, label, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`); if (!ok) pass = false }
const domClick = sel => p.$eval(sel, el => el.click())

await p.goto(`${BASE}/viz-showcase.html#plot-editing`, { waitUntil: 'commit' })
await p.waitForSelector('[data-viz-cell]', { timeout: 20000 }).catch(() => {})
await p.waitForTimeout(5000)

try {
  // Open the "cont" pane export dialog (its ⤓ button).
  await domClick('[data-testid="viz-cell-export-cont"]')
  await p.waitForSelector('[data-testid="viz-export-dialog-cont"]', { timeout: 8000 })

  // TEST-23a: the format select offers EPS + TIFF.
  await domClick('[data-testid="export-format-cont"]')
  await p.waitForTimeout(300)
  const opts = await p.$$eval('[role="option"]', els => els.map(e => (e.textContent || '').toLowerCase()))
  const hasEps = opts.some(o => o.includes('eps'))
  const hasTiff = opts.some(o => o.includes('tiff'))
  check(hasEps && hasTiff, 'TEST-23 export offers EPS + TIFF formats', `eps=${hasEps} tiff=${hasTiff}`)
  // pick TIFF
  const tiffOpt = p.locator('[role="option"]', { hasText: /tiff/i }).first()
  await tiffOpt.click().catch(() => {})
  await p.waitForTimeout(300)

  // TEST-23b: print-size (column + dpi), TIFF color-mode + CVD check controls present.
  const controls = await p.evaluate(() =>
    ['export-column', 'export-dpi', 'export-color-mode', 'export-cvd'].map(
      s => document.querySelector(`[data-testid="${s}-cont"]`) != null,
    ),
  )
  check(controls.every(Boolean), 'TEST-23 print-size + color-mode + CVD controls present', controls.join(','))

  // TEST-23c: the reproducible-figure Bundle toggle is present (a manifest is wired for this pane).
  const hasBundle = (await p.$('[data-testid="export-bundle-cont"]')) != null
  check(hasBundle, 'TEST-23 bundle toggle present (manifest wired)', `bundle=${hasBundle}`)

  // TEST-24: a TIFF export downloads a .tiff file.
  const go = await p.$('[data-testid="export-button-cont"]')
  let file = ''
  if (go) {
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 15000 }).catch(() => null), go.click()])
    if (dl) file = dl.suggestedFilename()
  }
  check(/\.tiff$/.test(file), 'TEST-24 TIFF export downloads', `file=${file}`)

  // TEST-25: the CVD/grayscale color-vision-CHECK select is present + selectable, and a CVD-simulated
  // TIFF exports (the design-check path — ITEM-9).
  const cvdPresent = (await p.$('[data-testid="export-cvd-cont"]')) != null
  await domClick('[data-testid="export-cvd-cont"]').catch(() => {})
  await p.waitForTimeout(250)
  await p.locator('[role="option"]', { hasText: /deuteranopia/i }).first().click().catch(() => {})
  await p.waitForTimeout(250)
  const goCvd = await p.$('[data-testid="export-button-cont"]')
  let cvdFile = ''
  if (goCvd) {
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 15000 }).catch(() => null), goCvd.click()])
    if (dl) cvdFile = dl.suggestedFilename()
  }
  check(cvdPresent && /\.tiff$/.test(cvdFile), 'TEST-25 CVD-check select + simulated TIFF export', `present=${cvdPresent} file=${cvdFile}`)

  // TEST-32: the reproducible-figure Bundle downloads a .zip (figure + source-data + manifest).
  await domClick('[data-testid="export-bundle-cont"]').catch(() => {})
  await p.waitForTimeout(300)
  const go2 = await p.$('[data-testid="export-button-cont"]')
  let zip = ''
  if (go2) {
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 15000 }).catch(() => null), go2.click()])
    if (dl) zip = dl.suggestedFilename()
  }
  check(/\.zip$/.test(zip), 'TEST-32 reproducible bundle downloads a .zip', `file=${zip}`)
} catch (e) {
  check(false, 'export-pubready threw', String(e))
}

console.log(pass ? 'ALL PASS' : 'SOME FAILED')
await b.close()
process.exit(pass ? 0 : 1)
