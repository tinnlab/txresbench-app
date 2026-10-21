// pubready-color.e2e.mjs — TEST-26: the colormap picker excludes the banned non-monotonic rainbow map
// (turbo) — ITEM-10 jet-ban, verified through the real edit-form UI. Runnable: node tests/e2e/pubready-color.e2e.mjs
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
  // Open the continuous cell's edit form + its colormap picker.
  if (!(await p.$('[data-testid="viz-edit-form-cont"]'))) {
    await domClick('[data-testid="viz-cell-edit-cont"]').catch(() => {})
    await p.waitForSelector('[data-testid="viz-edit-form-cont"]', { timeout: 8000, state: 'attached' })
  }
  await domClick('[data-testid="viz-edit-colormap-cont"]')
  await p.waitForTimeout(300)
  const opts = await p.$$eval('[role="option"]', els => els.map(e => (e.textContent || '').toLowerCase()))
  const hasViridis = opts.some(o => o.includes('viridis'))
  const hasTurbo = opts.some(o => o.trim() === 'turbo' || /\bturbo\b/.test(o))
  check(hasViridis && !hasTurbo, 'TEST-26 colormap picker keeps viridis, drops turbo (jet-ban)', `viridis=${hasViridis} turbo=${hasTurbo} n=${opts.length}`)
  // close the open colormap listbox
  await p.keyboard.press('Escape').catch(() => {})
  await p.waitForTimeout(200)

  // TEST-30: compare mode (shared color scale) toggle flips + persists.
  const before = await p.getAttribute('[data-testid="viz-edit-compare-cont"]', 'aria-checked').catch(() => null)
  await domClick('[data-testid="viz-edit-compare-cont"]').catch(() => {})
  await p.waitForTimeout(300)
  const after = await p.getAttribute('[data-testid="viz-edit-compare-cont"]', 'aria-checked').catch(() => null)
  check(before !== null && after !== null && before !== after, 'TEST-30 compare (shared color scale) toggle flips', `before=${before} after=${after}`)
} catch (e) {
  check(false, 'pubready-color threw', String(e))
}

console.log(pass ? 'ALL PASS' : 'SOME FAILED')
await b.close()
process.exit(pass ? 0 : 1)
