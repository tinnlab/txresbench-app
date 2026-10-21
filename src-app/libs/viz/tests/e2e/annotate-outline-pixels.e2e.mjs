// annotate-outline-pixels.e2e.mjs — TEST-25 / DRIFT-3.1 regression. THE PIXEL GATE.
//
// WHY THIS EXISTS. Every other annotate test asserts layer CONSTRUCTION (a layer with the right
// id / data / props reaches the deck). All of them passed for the entire life of the annotation
// surface while `annot-outline` and `annot-edit-edges` drew ZERO pixels: the layers were built
// perfectly and tesselated to nothing, because `_pathType` disables path normalization and the
// builder was handing the tesselator NESTED `[[x,y],…]` paths, which it then measured as
// `path.length / 3` → "< 2 points" → geometry size 0. A prop-level assertion physically cannot
// see that. So this spec reads the ACTUAL RENDERED PIXELS off the canvas.
//
// Vehicle: the `annotate-draw` story in its EMPTY state. Its annotation overlay is its own
// canvas and is FULLY TRANSPARENT before anything is drawn, so a committed feature's colours are
// unambiguous. (The `annotate-workbench` story composites the overlay into the ONE shared grid
// deck canvas on top of a synthetic rainbow image, so an outline-colour count there is swamped by
// the image's own blue — deliberately NOT used as the probe surface.)
//
// The three assertions per tier are: a NEGATIVE control (blank ⇒ 0 px, so the probe cannot be
// trivially true), a PRESENCE floor (the tier actually paints), and — for the closed ring — a
// CENTROID guard that catches the second half of DRIFT-3.1: `_pathType:'loop'` expects an
// explicitly CLOSED ring, and an open one makes the tesselator's wrap emit a spurious `p3→p1`
// segment, i.e. a diagonal slashed corner-to-corner through the polygon.
//
// Runnable: node tests/e2e/annotate-outline-pixels.e2e.mjs [baseUrl]   (default http://localhost:1471)
// Run `npx vite --port 1471 --strictPort` in the package first.
import { chromium } from 'playwright'
const BASE = process.argv[2] ?? 'http://localhost:1471'

// Overlay palette, mirrored from buildAnnotationLayers.ts (numeric deck colours).
const LINE = [37, 99, 235] // committed outline (annot-outline)
const SEL_LINE = [250, 204, 21] // selected-feature edges (annot-edit-edges) + the draft path
const FILL = [96, 165, 250] // committed polygon fill (annot-fill) — the "did it commit" control

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

/** Count canvas pixels matching `colour` (± tol per channel, alpha > `alphaMin`). `box`
 *  (fractional x0,y0,x1,y1 of the canvas) restricts the scan — used for the centroid diagonal
 *  guard. `alphaMin` defaults to a stroke-grade 120; the FILL tier is a 55/255-alpha wash and so
 *  passes its own lower floor. */
const countPixels = (colour, box = null, tol = 12, alphaMin = 120) =>
  p.evaluate(
    ({ colour, box, tol, alphaMin }) => {
      const c = document.querySelector('[data-testid="annotate-draw-surface"] canvas')
      if (!c) return { err: 'no-canvas' }
      const off = document.createElement('canvas')
      off.width = c.width
      off.height = c.height
      const ctx = off.getContext('2d')
      try {
        ctx.drawImage(c, 0, 0)
      } catch {
        return { err: 'draw-failed' }
      }
      let img
      try {
        img = ctx.getImageData(0, 0, off.width, off.height)
      } catch {
        return { err: 'tainted' }
      }
      const { data: d, width: W, height: H } = img
      const x0 = box ? Math.floor(box[0] * W) : 0
      const y0 = box ? Math.floor(box[1] * H) : 0
      const x1 = box ? Math.ceil(box[2] * W) : W
      const y1 = box ? Math.ceil(box[3] * H) : H
      let n = 0
      let opaque = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 4
          if (d[i + 3] > 10) opaque++
          if (
            d[i + 3] > alphaMin &&
            Math.abs(d[i] - colour[0]) <= tol &&
            Math.abs(d[i + 1] - colour[1]) <= tol &&
            Math.abs(d[i + 2] - colour[2]) <= tol
          )
            n++
        }
      }
      return { n, opaque, W, H }
    },
    { colour, box, tol, alphaMin },
  )

try {
  await p.goto(`${BASE}/viz-showcase.html#annotate-draw`, { waitUntil: 'commit' })
  await p.waitForSelector('[data-testid="viz-annotate-draw"]', { timeout: 20000 })
  await p.getByTestId('annotate-draw-mode-empty').click({ force: true })
  await p.waitForSelector('[data-testid="annotate-draw-surface-overlay"]', { timeout: 20000 })
  await p.waitForTimeout(2500)

  // ── negative control: nothing drawn ⇒ the overlay canvas is empty ────────────────────────
  const blankLine = await countPixels(LINE)
  check(!blankLine.err, 'TEST-25 overlay canvas is readable', blankLine.err ?? '')
  check(
    blankLine.n === 0 && blankLine.opaque === 0,
    'TEST-25 blank overlay paints no outline pixels (probe is not trivially true)',
    `outline=${blankLine.n} opaque=${blankLine.opaque}`,
  )

  // ── draw a quad and commit it ───────────────────────────────────────────────────────────
  const box = await p.getByTestId('annotate-draw-surface-overlay').boundingBox()
  const verts = [
    [0.35, 0.35],
    [0.65, 0.36],
    [0.66, 0.66],
    [0.36, 0.64],
  ]
  await p.getByTestId('annotate-draw-controls-tool-polygon').click({ force: true })
  await p.waitForTimeout(200)
  for (const [fx, fy] of verts) {
    await p.mouse.move(box.x + box.width * fx, box.y + box.height * fy)
    await p.mouse.down()
    await p.mouse.up()
    await p.waitForTimeout(150)
  }

  // draft tier (annot-draft-path) — an OPEN PathLayer polyline in amber.
  const draft = await countPixels(SEL_LINE)
  check(draft.n > 300, 'TEST-25 the in-progress DRAFT path paints (annot-draft-path)', `px=${draft.n}`)

  await p.getByTestId('annotate-draw-surface-finish').click({ force: true })
  await p.waitForTimeout(1500)

  // ── the committed static tier ───────────────────────────────────────────────────────────
  const fill = await countPixels(FILL, null, 12, 20)
  check(fill.n > 2000, 'TEST-25 the committed polygon FILL paints (annot-fill)', `px=${fill.n}`)

  // THE regression assertion: before the DRIFT-3.1 fix this was EXACTLY 0 while the fill above
  // rendered ~57k px — i.e. the polygon was visibly committed but had no outline at all.
  const outline = await countPixels(LINE)
  check(
    outline.n > 300,
    'TEST-25 the committed polygon OUTLINE paints (annot-outline) [DRIFT-3.1]',
    `px=${outline.n}`,
  )

  // Diagonal guard: the ring interior must be free of OUTLINE-coloured pixels. An unclosed ring
  // fed to `_pathType:'loop'` draws a corner-to-corner diagonal straight through this box.
  const cx = verts.reduce((s, v) => s + v[0], 0) / verts.length
  const cy = verts.reduce((s, v) => s + v[1], 0) / verts.length
  const centroidBox = [cx - 0.06, cy - 0.06, cx + 0.06, cy + 0.06]
  const interior = await countPixels(LINE, centroidBox)
  check(
    interior.n === 0,
    'TEST-25 no outline pixels inside the ring (no spurious closing diagonal) [DRIFT-3.1]',
    `px=${interior.n}`,
  )

  // ── the edit tier ───────────────────────────────────────────────────────────────────────
  await p.getByTestId('annotate-draw-controls-tool-select').click({ force: true })
  await p.waitForTimeout(300)
  await p.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5)
  await p.mouse.down()
  await p.mouse.up()
  await p.waitForTimeout(900)
  // Selected ⇒ amber edges. Before the fix this was EXACTLY 0 (only the white vertex handles drew).
  const edges = await countPixels(SEL_LINE)
  check(
    edges.n > 300,
    'TEST-25 the selected feature EDGES paint (annot-edit-edges) [DRIFT-3.1]',
    `px=${edges.n}`,
  )

  check(errs.length === 0, 'no console/page errors', errs.slice(0, 3).join(' | '))
} catch (e) {
  check(false, 'e2e threw', String(e))
}

await b.close()
console.log(pass ? '\nannotate-outline-pixels e2e: ALL PASS' : '\nannotate-outline-pixels e2e: FAILURES ABOVE')
process.exit(pass ? 0 : 1)
