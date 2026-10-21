// visualmap-filters.e2e.mjs — the ROUND-TRIP regression for a dense scatter's in-cell visual-map range.
//
// THE DEFECT THIS PINS: setting the in-cell visual-map range filtered the plot but NEVER reached
// `VizOption.filters` — the range lived only in GridWorkspace's local `perCellRange` React state, so
// `getOption()` emitted no `filters` at all and a restored figure kept its selection while silently
// losing the filter that explained it.
//
// Drives the REAL UI (a pointer drag on the in-cell bar — no dev setter), then:
//   T1  the drag actually clamps the plot (ink drops)                        ← the filter works visually
//   T2  `getOption().filters['cont']` carries that range in DATA units       ← the round-trip OUT (was absent)
//   T3  a fresh-mount RESET drops both the option value and the clamp        ← a real reset, not a no-op
//   T4  `setOption(saved, {replace})` restores the OPTION value              ← the round-trip BACK
//   T5  …and the VISUAL clamp (per-cell range + the pane's ink)              ← not just the JSON
//
// Runnable: node tests/e2e/visualmap-filters.e2e.mjs [baseUrl]
import { chromium } from 'playwright'
const BASE = process.argv[2] ?? 'http://localhost:1489'
const CELL = 'cont'

const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1200, height: 820 } })
const errs = []
p.on('pageerror', e => errs.push(String(e)))
p.on('console', m => {
  const t = m.text()
  if (m.type() === 'error' && !/favicon|shader|luma|SwiftShader|assertion failed|SelectableScatterLayer|Compilation error|fragment/i.test(t))
    errs.push('C:' + t)
})

let pass = true
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) pass = false
}
const near = (x, y) => Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(x), Math.abs(y))
const sameRange = (a, c) => Array.isArray(a) && Array.isArray(c) && near(a[0], c[0]) && near(a[1], c[1])

// The live `getOption().filters` (verbatim; absent is the defect's signature).
const filters = () => p.evaluate(() => window.__VIZ_FILTERS_TEST__.filters())
// The live VISUAL clamp the grid applies (GridWorkspace's per-cell range → the alpha-0 mask + the bar).
const clamp = () => p.evaluate(id => window.__VIZ_INCELL__?.ranges?.[id] ?? null, CELL)
const domain = () => p.evaluate(id => window.__VIZ_INCELL__?.domains?.[id] ?? null, CELL)

// Non-white ink inside the pane — the pixel proof the clamp is actually DRAWN. The PNG is decoded IN
// THE PAGE (createImageBitmap → 2D canvas) so the harness needs no image dependency. Two rAFs + a
// settle precede the capture: a stale WebGL backbuffer otherwise makes the reading non-deterministic.
const paneInk = async () => {
  const el = await p.$(`[data-viz-cell="${CELL}"]`)
  if (!el) return -1
  await p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
  await p.waitForTimeout(350)
  const buf = await el.screenshot()
  return p.evaluate(async b64 => {
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const bmp = await createImageBitmap(new Blob([bin], { type: 'image/png' }))
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    const g = c.getContext('2d')
    g.drawImage(bmp, 0, 0)
    const d = g.getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) n++
    return n
  }, buf.toString('base64'))
}

// Ink is only meaningful once the scatter has actually PAINTED: an unpainted pane still shows ~5k px of
// chrome (title / axes / the visual-map bar), and a 20k-point scatter draws ~85k. Poll until the pane
// clears the PAINTED floor (the FIRST mount can take several seconds to compile shaders + upload).
// The very first deck mount in a fresh page sometimes sits on an unpainted canvas until something
// invalidates it, so nudge a resize every few polls (a redraw kick, not a state change).
const PAINTED = 20000
const waitPainted = async () => {
  let n = -1
  for (let i = 0; i < 40; i++) {
    n = await paneInk()
    if (n >= PAINTED) return n
    if (i % 3 === 2) await p.evaluate(() => window.dispatchEvent(new Event('resize')))
  }
  return n
}

// Wait for the grid to mount + settle (a remount re-creates the cell, so this is re-usable).
const settle = async () => {
  await p.waitForSelector(`[data-viz-cell="${CELL}"]`, { timeout: 30000 })
  await p.waitForSelector(`[data-testid="viz-cell-visualmap-${CELL}"]`, { timeout: 30000 })
  await waitPainted()
}

try {
  await p.goto(`${BASE}/viz-showcase.html#visualmap-filters`, { waitUntil: 'commit' })
  await settle()
  // The FIRST deck mount of a fresh page can sit on an unpainted canvas (a known first-paint quirk,
  // unrelated to filters), which would poison the ink BASELINE. Remount once — every subsequent mount
  // paints deterministically — and measure from there. State-wise this is a no-op (no filter is set yet).
  await p.evaluate(() => window.__VIZ_FILTERS_TEST__.reset())
  await settle()

  const inkFull = await paneInk()
  const dom = await domain()

  // ── Drive the REAL control: drag the HI handle (bar top, VPAD=12) down to clamp the range. ──
  const vm = await p.$(`[data-testid="viz-cell-visualmap-${CELL}"]`)
  const bb = vm ? await vm.boundingBox() : null
  if (bb) {
    await p.mouse.move(bb.x + bb.width / 2, bb.y + 12)
    await p.mouse.down()
    await p.mouse.move(bb.x + bb.width / 2, bb.y + Math.round(bb.height * 0.55), { steps: 10 })
    await p.mouse.up()
  }
  await p.waitForTimeout(600)

  const dragged = await clamp()
  const inkClamped = await paneInk()
  check(
    !!bb && Array.isArray(dragged) && inkClamped < inkFull * 0.9,
    'T1 the in-cell visual-map drag clamps the plot',
    `range=${JSON.stringify(dragged)} ink ${inkFull} → ${inkClamped}`,
  )

  // ── T2: the dragged range reaches `getOption().filters`, keyed by the stable cell id, in DATA units. ──
  const f = await filters()
  const inDomain =
    !!dom && Array.isArray(f?.[CELL]) && f[CELL][0] >= dom[0] - 1e-6 && f[CELL][1] <= dom[1] + 1e-6
  check(
    f != null && sameRange(f[CELL], dragged) && inDomain,
    'T2 getOption().filters carries the range (DATA units, keyed by the cell id)',
    `filters=${JSON.stringify(f)} domain=${JSON.stringify(dom)}`,
  )

  // ── Capture the "saved figure", then RESET to a fresh mount (no live state). ──
  const saved = await p.evaluate(() => window.__VIZ_FILTERS_TEST__.capture())
  await p.evaluate(() => window.__VIZ_FILTERS_TEST__.reset())
  await settle()
  const afterResetFilters = await filters()
  const afterResetClamp = await clamp()
  const inkReset = await paneInk()
  check(
    sameRange(saved?.[CELL], dragged) &&
      afterResetFilters?.[CELL] == null &&
      afterResetClamp == null &&
      inkReset > inkClamped * 1.2,
    'T3 the capture holds the range and a fresh mount drops it (option + clamp + ink)',
    `saved=${JSON.stringify(saved)} reset.filters=${JSON.stringify(afterResetFilters)} reset.clamp=${JSON.stringify(afterResetClamp)} ink=${inkReset}`,
  )

  // ── T4/T5: restore the captured option → the option value AND the visual clamp both come back. ──
  await p.evaluate(() => window.__VIZ_FILTERS_TEST__.restore())
  await settle()
  const restoredFilters = await filters()
  const restoredClamp = await clamp()
  const inkRestored = await paneInk()
  check(
    sameRange(restoredFilters?.[CELL], saved?.[CELL]),
    'T4 setOption(saved) restores the OPTION value',
    `filters=${JSON.stringify(restoredFilters)}`,
  )
  check(
    sameRange(restoredClamp, saved?.[CELL]) && inkRestored < inkReset * 0.9,
    'T5 …and the VISUAL clamp (per-cell range + the pane ink)',
    `clamp=${JSON.stringify(restoredClamp)} ink ${inkReset} → ${inkRestored}`,
  )

  check(errs.length === 0, 'no page errors', errs.slice(0, 3).join(' | '))
} catch (e) {
  check(false, 'harness threw', String(e))
} finally {
  await b.close()
}

console.log(pass ? '\nALL PASS' : '\nFAILURES')
process.exit(pass ? 0 : 1)
