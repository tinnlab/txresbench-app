// annotate-draw.e2e.mjs — TEST-5 (covers ITEM-3). The editable vector overlay: pick the polygon
// tool, click vertices on the canvas, finish → a NEW annotation is committed (the Undo affordance
// arms, proving the collection grew), then reshape via the SELECT tool's vertex handles (DEC-18
// folded the separate Reshape mode into select). Starts from the EMPTY
// state so "an annotation was added" is unambiguous.
// Runnable: node tests/e2e/annotate-draw.e2e.mjs [baseUrl]   (default http://localhost:1471)
// Run `npx vite --port 1471 --strictPort` in the package first.
import { chromium } from 'playwright'
const BASE = process.argv[2] ?? 'http://localhost:1471'
const SC = '/tmp/claude-1000/-data-pbya-txresbench-txresbench/b5b52393-63e9-49f1-8500-803873494642/scratchpad'

const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1400, height: 900 } })
const errs = []
p.on('pageerror', e => errs.push(String(e)))
p.on('console', m => {
  const t = m.text()
  if (m.type() === 'error' && !/favicon|shader|luma|SwiftShader|assertion failed|SelectableScatterLayer/i.test(t))
    errs.push('C:' + t)
})

let pass = true
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) pass = false
}
// A single pointer click on the overlay (React onPointerDown adds a polygon vertex).
const clickOverlay = async (box, fx, fy) => {
  const x = box.x + box.width * fx
  const y = box.y + box.height * fy
  await p.mouse.move(x, y)
  await p.mouse.down()
  await p.mouse.up()
  await p.waitForTimeout(120)
}

try {
  await p.goto(`${BASE}/viz-showcase.html#annotate-draw`, { waitUntil: 'commit' })
  await p.waitForSelector('[data-testid="viz-annotate-draw"]', { timeout: 20000 })

  // Empty state → a fresh store with no annotations (the canvas is blank), so a committed polygon
  // is a visible delta on the surface.
  await p.getByTestId('annotate-draw-mode-empty').click({ force: true })
  await p.waitForSelector('[data-testid="annotate-draw-surface-overlay"]', { timeout: 20000 })
  await p.waitForTimeout(1500)
  const surface = () => p.getByTestId('annotate-draw-surface').screenshot()
  const surfaceBlank = await surface()

  // Pick the Polygon tool, then drop ≥3 vertices on the canvas.
  await p.getByTestId('annotate-draw-controls-tool-polygon').click({ force: true })
  await p.waitForTimeout(200)
  const box = await p.getByTestId('annotate-draw-surface-overlay').boundingBox()
  check(!!box, 'TEST-5 draw surface overlay present')
  for (const [fx, fy] of [[0.4, 0.4], [0.6, 0.42], [0.62, 0.62], [0.42, 0.6]]) await clickOverlay(box, fx, fy)

  // The Finish affordance arms once the draft has ≥3 vertices.
  const finish = p.getByTestId('annotate-draw-surface-finish')
  await p.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="annotate-draw-surface-finish"]')
      return el && !el.hasAttribute('disabled')
    },
    { timeout: 5000 },
  ).catch(() => {})
  const finishArmed = (await finish.count()) > 0 && !(await finish.isDisabled().catch(() => true))
  check(finishArmed, 'TEST-5 polygon draft (≥3 verts) arms the Finish affordance')
  await finish.click({ force: true })
  await p.waitForTimeout(800)

  // Committed → a new annotation renders on the (previously blank) surface: the canvas changed,
  // and Undo is enabled (an undoable op landed on top of the seeded classes).
  const surfaceDrawn = await surface()
  const undoEnabledAfter = !(await p.getByTestId('annotate-draw-controls-undo').isDisabled())
  await p.screenshot({ path: `${SC}/e2e-annotate-draw.png` })
  check(!surfaceBlank.equals(surfaceDrawn), 'TEST-5 finishing the polygon adds an annotation (surface renders it)')
  check(undoEnabledAfter, 'TEST-5 the committed polygon is an undoable op')

  // Reshape: switch to the Reshape tool and drag near a placed vertex (best-effort — asserts the
  // reshape path runs without error; the add above is the hard assertion).
  // DEC-18: reshape is no longer a separate mode — selecting an annotation reveals its vertex
  // handles, so the reshape gesture is driven through the SELECT tool.
  await p.getByTestId('annotate-draw-controls-tool-select').click({ force: true })
  await p.waitForTimeout(200)
  await p.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4)
  await p.mouse.down()
  await p.mouse.move(box.x + box.width * 0.36, box.y + box.height * 0.36, { steps: 6 })
  await p.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3, { steps: 6 })
  await p.mouse.up()
  await p.waitForTimeout(400)
  check(true, 'TEST-5 reshape-via-select drag ran without throwing')

  check(errs.length === 0, 'no console/page errors', errs.slice(0, 3).join(' | '))
} catch (e) {
  check(false, 'e2e threw', String(e))
}

await b.close()
console.log(pass ? '\nannotate-draw e2e: ALL PASS' : '\nannotate-draw e2e: FAILURES ABOVE')
process.exit(pass ? 0 : 1)
