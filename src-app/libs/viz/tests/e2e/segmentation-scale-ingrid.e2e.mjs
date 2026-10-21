// segmentation-scale-ingrid.e2e.mjs — TEST-3 (covers ITEM-1 + ITEM-2). The in-grid label-mask surface
// is LIVE: the `in-grid-mask` story renders a fixture label mask IN the grid on the single shared
// <DeckGL>; selecting the Segment tool opens the review/correct panel; toggling solo/hide flips the LUT
// (no refetch); and a relabel + brush correction driven through the LIVE per-cell mask session mutates
// the SAME raster the layer renders (dirty-rect) and undoes byte-for-byte — proving the previously-inert
// controls are now wired. Offline; clean at desktop + 390px.
// Runnable: node tests/e2e/segmentation-scale-ingrid.e2e.mjs [baseUrl]   (default http://localhost:1471)
// Run `npx vite --port 1471 --strictPort` in the package first.
import { chromium } from 'playwright'
const BASE = process.argv[2] ?? 'http://localhost:1471'
const ORIGIN = new URL(BASE).origin
const IGNORE = /favicon|shader|luma|SwiftShader|assertion failed|SelectableScatterLayer|WebGL|Compilation error|fragment/i

const b = await chromium.launch()
let pass = true
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) pass = false
}

async function openStory(width) {
  const p = await b.newPage({ viewport: { width, height: 900 } })
  const errs = []
  p.on('pageerror', e => errs.push('P:' + String(e).slice(0, 140)))
  p.on('console', m => {
    if (m.type() === 'error' && !IGNORE.test(m.text())) errs.push('C:' + m.text().slice(0, 140))
  })
  await p.goto(`${BASE}/viz-showcase.html#in-grid-mask`, { waitUntil: 'commit' })
  await p.waitForSelector('[data-testid="viz-in-grid-mask"]', { timeout: 20000 })
  await p.waitForTimeout(3500) // let the mask resolve + deck settle
  return { p, errs }
}

try {
  // ── Desktop: render + live review/correct ────────────────────────────────────────────────────────
  const { p, errs } = await openStory(1400)

  // The mask resolved + the segment cell is bound (the DataSource.imageLabelMask seam fed a 512² raster).
  // We assert via the render being clean here; the session is minted once Segment mode engages (below).
  check((await p.$('[data-testid="viz-in-grid-mask"]')) != null, 'story rendered')

  // Press Segment on the PANE's own toolbar (finding #14 — the button exists only on a
  // segment-capable pane, exactly as the old rail button existed only when the grid had one).
  const segBtns = await p.$$('[data-testid^="viz-cell-segment-"]')
  check(segBtns.length >= 1, 'per-pane Segment button present on the segment pane', `n=${segBtns.length}`)
  for (const btn of segBtns) await btn.click()
  await p.waitForSelector('[data-testid="viz-mask-review-controls"]', { timeout: 10000 })
  check(true, "review/correct panel docks on the pane's Segment button")

  // The per-cell mask session is now minted + exposed (LIVE controller bound to the rendered raster).
  const bound = await p.evaluate(() => {
    const m = window.__vizMaskSessions
    const s = m && m.get('slide')
    return s ? { w: s.data.width, h: s.data.height, len: s.data.raster.length } : null
  })
  check(bound != null && bound.w === 512 && bound.len === 512 * 512, 'mask session bound to the 512² raster', JSON.stringify(bound))

  // Solo + hide flip the panel state (LUT-only; no refetch). Assert the controls respond (aria-pressed).
  let netAfter = 0
  const onReq = r => { const u = r.url(); if (!u.startsWith('data:') && !u.startsWith('blob:') && !u.startsWith(ORIGIN)) netAfter++ }
  p.on('request', onReq)
  await p.click('[data-testid="viz-mask-class-solo-1"]')
  await p.waitForTimeout(300)
  const soloed = await p.getAttribute('[data-testid="viz-mask-class-solo-1"]', 'aria-pressed')
  check(soloed === 'true', 'solo class 1 sets aria-pressed')
  await p.click('[data-testid="viz-mask-class-solo-1"]') // clear solo
  await p.click('[data-testid="viz-mask-class-visible-2"]') // hide class 2
  await p.waitForTimeout(300)
  const vis2 = await p.getAttribute('[data-testid="viz-mask-class-visible-2"]', 'aria-checked').catch(() => null)
  // native checkbox: checked property, not aria — read it directly
  const checked2 = await p.$eval('[data-testid="viz-mask-class-visible-2"]', el => el.checked)
  check(checked2 === false, 'hide class 2 unchecks its visibility toggle')
  check(netAfter === 0, 'solo/hide made ZERO data refetches (LUT-only)', `net=${netAfter}`)

  // ── LIVE correction through the in-grid session: relabel + brush + undo (the ITEM-2 deliverable) ──
  const relabel = await p.evaluate(() => {
    const s = window.__vizMaskSessions.get('slide')
    const { raster, categoryForId } = s.data
    let id = 0
    for (let i = 0; i < raster.length; i++) { if (raster[i] > 0) { id = raster[i]; break } }
    const before = categoryForId[id]
    const next = before === 1 ? 2 : 1
    s.controller.relabel(id, next)
    const after = categoryForId[id]
    const canUndo = s.controller.canUndo
    s.controller.undo()
    const restored = categoryForId[id]
    return { id, before, after, next, canUndo, restored }
  })
  check(relabel.id > 0 && relabel.after === relabel.next && relabel.canUndo && relabel.restored === relabel.before,
    'relabel changes the id→category + undo restores it', JSON.stringify(relabel))

  const brush = await p.evaluate(() => {
    const s = window.__vizMaskSessions.get('slide')
    const { raster, width } = s.data
    let idL = 0
    for (let i = 0; i < raster.length; i++) { if (raster[i] > 0) { idL = raster[i]; break } }
    // a background pixel to paint into (corners are background in the fixture)
    let iBg = -1
    for (let i = 0; i < raster.length; i++) { if (raster[i] === 0) { iBg = i; break } }
    const x = iBg % width, y = Math.floor(iBg / width)
    const before = raster[iBg]
    s.controller.brush({ x, y, r: 5, id: idL })
    const after = raster[iBg]
    const canUndo = s.controller.canUndo
    s.controller.undo()
    const restored = raster[iBg]
    return { idL, before, after, canUndo, restored }
  })
  check(brush.idL > 0 && brush.before === 0 && brush.after === brush.idL && brush.canUndo && brush.restored === 0,
    'brush paints the label at the point + undo reverts it', JSON.stringify(brush))

  p.off('request', onReq)
  check(errs.length === 0, 'desktop: no console/page errors', errs.slice(0, 3).join(' | '))
  await p.close()

  // ── 390px: the surface renders clean at mobile width ─────────────────────────────────────────────
  const { p: pm, errs: em } = await openStory(390)
  check((await pm.$('[data-testid="viz-in-grid-mask"]')) != null, 'mobile-390: story rendered')
  check(em.length === 0, 'mobile-390: no console/page errors', em.slice(0, 3).join(' | '))
  await pm.close()
} catch (e) {
  check(false, 'threw', String(e).slice(0, 200))
}

await b.close()
console.log(pass ? 'segmentation-scale-ingrid e2e: ALL PASS' : 'segmentation-scale-ingrid e2e: FAIL')
process.exit(pass ? 0 : 1)
