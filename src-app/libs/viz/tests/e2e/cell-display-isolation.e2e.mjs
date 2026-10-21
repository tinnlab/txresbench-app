// cell-display-isolation.e2e.mjs — the SPLIT 0b (ITEM-21) acceptance proof, and the standing guard on
// the property the per-cell display store exists to provide: a legend click on cell A changes cell A
// and NOTHING else.
//
// Why pixels and not state: the hoist moved `perCellHiddenCodes` (and six sibling records) out of
// component state into a per-cell-keyed zustand slice. Asserting the STORE is per-cell would be
// asserting the implementation; asserting that three untouched panes are pixel-IDENTICAL after a real
// coordinate click on the fourth pane's legend canvas is asserting the user-visible promise, and it is
// red on any cross-pane leak the hoist could introduce (INV-7).
//
// The clicked pane's own signature MUST change — that assertion is the negative control, without which
// "everything is identical" would pass on a page where the click did nothing at all.
//
// FIX_ROUND-1 / C3 — TWO WAYS THIS SCRIPT USED TO CERTIFY THE PROPERTY WITHOUT TESTING IT, both
// measured on the running page before they were closed:
//   1. ZERO-ITERATION QUANTIFIER. The comparison loop skips the clicked pane and had no precondition
//      on how many panes there were. With ONE rendered pane it ran zero times, `pass` stayed true and
//      the script printed "ISOLATION PROOF: PASS" and exited 0 — an isolation claim certified by an
//      empty quantifier. (Reproduced by truncating `cellIds` to 1: PASS, exit 0.)
//   2. 'nobox' AS A COMPARABLE VALUE. A pane with no bounding box was given the literal signature
//      'nobox', and 'nobox' === 'nobox', so a pane that rendered NOTHING in BOTH snapshots was
//      reported "pixel-IDENTICAL". (Reproduced by hiding two panes with a style tag: both printed
//      "PASS … nobox -> nobox".)
// Both are now hard failures: the comparison set is asserted NON-EMPTY and counted, and a missing box
// fails the run instead of producing a value that compares equal to itself.
//
// Runnable: node tests/e2e/cell-display-isolation.e2e.mjs [baseUrl]
import { chromium } from 'playwright'
import { createHash } from 'node:crypto'

const BASE = process.argv[2] ?? 'http://localhost:1461'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const p = await b.newPage({ viewport: { width: 1560, height: 900 } })
let pass = true
const check = (ok, label, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`); if (!ok) pass = false }

await p.goto(`${BASE}/viz-showcase.html#plot-editing`, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(9000)

const cellIds = await p.$$eval('[data-viz-cell]', els => els.map(e => e.getAttribute('data-viz-cell')))
console.log('cells:', JSON.stringify(cellIds))
// PRECONDITION. The whole claim is "the OTHER panes did not change", so it needs at least one other
// pane. Refuse to run rather than report PASS over an empty comparison set.
if (cellIds.length < 2) {
  check(false, 'the page rendered at least 2 panes (1 clicked + >=1 comparison)', `got ${cellIds.length}: ${JSON.stringify(cellIds)}`)
  console.log('\nISOLATION PROOF: FAIL')
  await b.close()
  process.exit(1)
}

const sigs = async () => {
  const out = {}
  for (const id of cellIds) {
    const el = await p.$(`[data-viz-cell="${id}"]`)
    const box = el && (await el.boundingBox())
    if (!box) {
      // HARD FAILURE, never a comparable value: a pane that rendered nothing has no pixels to be
      // identical to, and 'nobox' === 'nobox' would report exactly that as the property under test.
      check(false, `cell ${id} has a bounding box to screenshot`, 'the pane rendered NOTHING — it cannot participate in a pixel comparison')
      out[id] = null
      continue
    }
    // Screenshot the PAGE clipped to the cell's plot area — the deck canvas is a sibling overlay, so a
    // per-element shot would miss the points. Inset to skip the toolbar strip + legend chrome.
    const shot = await p.screenshot({
      clip: { x: box.x + 8, y: box.y + 46, width: Math.max(8, box.width - 16), height: Math.max(8, box.height - 56) },
    })
    out[id] = createHash('sha1').update(shot).digest('hex').slice(0, 16)
  }
  return out
}
const hidden = () => p.evaluate(() => {
  const h = window.__VIZ_INCELL__?.hidden ?? {}
  return JSON.stringify(Object.fromEntries(Object.entries(h).map(([k, v]) => [k, [...v].sort()])))
})

const before = await sigs()
const hBefore = await hidden()
console.log('sig before:', JSON.stringify(before))
console.log('hidden before:', hBefore)

// The in-cell legend is a CANVAS (hit-tested internally), so the click is a real coordinate press on
// a swatch row — not a DOM item click. Walk the rows until the hidden-set actually changes, which is
// also the proof that a REAL legend click (not a test hook) drove the state.
let target = null
let clicked = null
for (const id of cellIds) {
  const canvas = await p.$(`[data-testid="viz-cell-legend-${id}"] [data-testid="viz-incell-legend"]`)
  if (!canvas) continue
  const cb = await canvas.boundingBox()
  if (!cb) continue
  for (let y = 12; y < cb.height - 4 && !clicked; y += 7) {
    await p.mouse.click(cb.x + 12, cb.y + y)
    await p.waitForTimeout(600)
    if ((await hidden()) !== hBefore) { target = id; clicked = { x: 12, y } }
  }
  if (clicked) break
}
check(!!target, 'a real click on an in-cell categorical legend swatch changed the hidden set', `${target} at ${JSON.stringify(clicked)}`)
if (!target) { await b.close(); process.exit(1) }
await p.waitForTimeout(3500)

const after = await sigs()
const hAfter = await hidden()
console.log('sig after :', JSON.stringify(after))
console.log('hidden after :', hAfter)

check(before[target] !== after[target], `cell ${target} (clicked) RE-RENDERED`, `${before[target]} -> ${after[target]}`)
check(hBefore !== hAfter, 'the hidden-code state actually changed', `${hBefore} -> ${hAfter}`)
let compared = 0
for (const id of cellIds) {
  if (id === target) continue
  // `!= null` is load-bearing: a null signature means the pane produced no pixels in that snapshot,
  // and comparing two such panes is not evidence of isolation.
  check(
    before[id] != null && after[id] != null && before[id] === after[id],
    `cell ${id} (untouched) pixel-IDENTICAL`,
    `${before[id]} -> ${after[id]}`,
  )
  compared++
}
// The quantifier is non-empty — asserted, not assumed. This is the clause that turns "no untouched
// pane changed" from a vacuous truth into a measurement.
check(compared >= 1, 'at least one UNTOUCHED pane was actually compared', `compared ${compared} of ${cellIds.length} panes`)

await b.close()
console.log(pass ? '\nISOLATION PROOF: PASS' : '\nISOLATION PROOF: FAIL')
process.exit(pass ? 0 : 1)
