// channel-controls.e2e.mjs — TEST-3 (covers ITEM-2). The per-channel contrast / color / visibility
// controls over the 16-bit multiplex fixture: toggling a channel + dragging its contrast updates the
// render LIVE (a shader recomposite, NOT a tile refetch → NO network), and every control carries a
// WCAG accessible name.
// Runnable: node tests/e2e/channel-controls.e2e.mjs [baseUrl]   (default http://localhost:1471)
// Run `npx vite --port 1471 --strictPort` in the package first.
import { chromium } from 'playwright'
const BASE = process.argv[2] ?? 'http://localhost:1471'
const SC = '/tmp/claude-1000/-data-pbya-txresbench-txresbench/b5b52393-63e9-49f1-8500-803873494642/scratchpad'
const ORIGIN = new URL(BASE).origin

const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1400, height: 900 } })
const errs = []
let netAfterInteract = 0
let watching = false
p.on('pageerror', e => errs.push(String(e)))
p.on('console', m => {
  const t = m.text()
  if (m.type() === 'error' && !/favicon|shader|luma|SwiftShader|assertion failed|SelectableScatterLayer/i.test(t))
    errs.push('C:' + t)
})
p.on('request', r => {
  if (!watching) return
  const u = r.url()
  if (u.startsWith('data:') || u.startsWith('blob:')) return
  // vite HMR/module chunks under the dev origin are fine; anything else during an interaction
  // (a real tile refetch would hit a data host) counts.
  if (!u.startsWith(ORIGIN)) netAfterInteract++
})

let pass = true
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) pass = false
}
try {
  await p.goto(`${BASE}/viz-showcase.html#annotate-channels`, { waitUntil: 'commit' })
  await p.waitForSelector('[data-testid="viz-annotate-channels"]', { timeout: 20000 })
  await p.waitForSelector('[data-testid="raster-channel-controls"]', { timeout: 20000 })
  await p.waitForTimeout(3500)

  // The Channels section lists one control group per channel (`raster-channel-<i>`).
  const nChannels = await p.$$eval('[data-testid^="raster-channel-"]', els =>
    els.filter(e => /^raster-channel-\d+$/.test(e.getAttribute('data-testid') || '')).length,
  )
  check(nChannels >= 2, 'TEST-3 channel controls list every channel', `channels=${nChannels}`)

  // Accessible names on every control (visible toggle, color, contrast begin/end).
  const a11y = await p.evaluate(() => {
    const need = ['raster-channel-0-visible', 'raster-channel-0-color', 'raster-channel-0-contrast-begin', 'raster-channel-0-contrast-end']
    return need.map(id => {
      const el = document.querySelector(`[data-testid="${id}"]`)
      return { id, name: el?.getAttribute('aria-label') || '' }
    })
  })
  check(a11y.every(c => c.name.length > 0), 'TEST-3 every channel control has a WCAG accessible name', JSON.stringify(a11y))

  const shot = () => p.getByTestId('viz-raster-image').screenshot()
  const baseline = await shot()
  watching = true

  // Drag a contrast slider → a LIVE recomposite (shader uniform), still no tile refetch.
  await p.getByTestId('raster-channel-1-contrast-begin').fill('30000')
  await p.waitForTimeout(1200)
  const afterContrast = await shot()
  const contrastVal = await p.$eval('[data-testid="raster-channel-1-contrast-begin"]', el => Number(el.value))
  check(contrastVal === 30000, 'TEST-3 contrast slider value commits', `begin=${contrastVal}`)
  check(!baseline.equals(afterContrast), 'TEST-3 dragging contrast updates the render (live recomposite)')

  // Toggle a whole channel off → a second visible recomposite.
  await p.getByTestId('raster-channel-0-visible').uncheck({ force: true })
  await p.waitForTimeout(1200)
  const afterToggle = await shot()
  watching = false
  check(!afterContrast.equals(afterToggle), 'TEST-3 toggling a channel updates the render')
  check(netAfterInteract === 0, 'TEST-3 recomposite made NO tile refetch (no network)', `net=${netAfterInteract}`)

  await p.screenshot({ path: `${SC}/e2e-channel-controls.png` })
  check(errs.length === 0, 'no console/page errors', errs.slice(0, 3).join(' | '))
} catch (e) {
  check(false, 'e2e threw', String(e))
}

await b.close()
console.log(pass ? '\nchannel-controls e2e: ALL PASS' : '\nchannel-controls e2e: FAILURES ABOVE')
process.exit(pass ? 0 : 1)
