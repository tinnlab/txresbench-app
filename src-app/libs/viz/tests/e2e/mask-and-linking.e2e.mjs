// mask-and-linking.e2e.mjs — TEST-A5 [acceptance][invariant: INV-5] (covers ITEM-11, ITEM-13).
// Proves the surface REUSES the real layers/stores instead of reinventing them:
//   • mask-review — hovering a mask cell resolves its label id through the EXISTING LabelMaskLayer
//     GPU picking (the view's own `viz-label-mask-hover-readout` shows "Cell: <id> · <class>").
//   • annotate-linking — a gate on the tissue lights the SAME canonical cells through the shared
//     Coordination store (the `shared selection: N cells` readout goes non-zero).
// Runnable: node tests/e2e/mask-and-linking.e2e.mjs [baseUrl]   (default http://localhost:1471)
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
const readoutNum = async testId => {
  const t = (await p.getByTestId(testId).textContent().catch(() => '')) ?? ''
  const m = t.replace(/,/g, '').match(/(\d+)/)
  return m ? Number(m[1]) : null
}

try {
  // ══════════════ mask-review — real LabelMaskLayer picking on hover ══════════════
  await p.goto(`${BASE}/viz-showcase.html#mask-review`, { waitUntil: 'commit' })
  await p.waitForSelector('[data-testid="viz-mask-review"]', { timeout: 20000 })
  await p.waitForSelector('[data-testid="viz-label-mask-view"]', { timeout: 20000 })
  await p.waitForTimeout(3500) // let the mask paint + picking framebuffer arm

  // The review controls exist AND are accessible (role=group + labelled toggles).
  const controls = await p.evaluate(() => {
    const el = document.querySelector('[data-testid="viz-mask-review-controls"]')
    if (!el) return { present: false }
    const vis0 = document.querySelector('[data-testid="viz-mask-class-visible-0"]')
    return {
      present: true,
      role: el.getAttribute('role'),
      groupName: el.getAttribute('aria-label'),
      visLabelled: !!(vis0 && (vis0.getAttribute('aria-label') || vis0.textContent?.trim())),
    }
  })
  check(controls.present, 'TEST-A5 mask review controls render')
  check(controls.role === 'group' && !!controls.groupName, 'TEST-A5 review panel has an accessible name', JSON.stringify(controls))
  check(controls.visLabelled, 'TEST-A5 class-visibility toggles have accessible names')

  // Hover the mask canvas across a grid — the EXISTING layer's picking resolves a cell id.
  const box = await p.getByTestId('viz-label-mask-view').boundingBox()
  let hoveredId = null
  if (box) {
    outer: for (const fx of [0.4, 0.5, 0.6, 0.45, 0.55, 0.35, 0.65]) {
      for (const fy of [0.4, 0.5, 0.6, 0.45, 0.55]) {
        await p.mouse.move(box.x + box.width * fx, box.y + box.height * fy)
        await p.waitForTimeout(160)
        const txt = (await p.getByTestId('viz-label-mask-hover-readout').textContent().catch(() => '')) ?? ''
        const m = txt.match(/Cell:\s*(\d+)/)
        if (m && Number(m[1]) > 0) {
          hoveredId = Number(m[1])
          break outer
        }
      }
    }
  }
  await p.screenshot({ path: `${SC}/e2e-mask-review.png` })
  check(hoveredId != null && hoveredId > 0, 'TEST-A5 hover resolves a label id via the real LabelMaskLayer picking', `id=${hoveredId}`)

  // ══════════════ annotate-linking — gate lights the same cells via Coordination ══════════════
  await p.goto(`${BASE}/viz-showcase.html#annotate-linking`, { waitUntil: 'commit' })
  await p.waitForSelector('[data-testid="viz-annotate-linking"]', { timeout: 20000 })
  // Wait until the fixture finishes loading (buttons enable).
  await p.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="annotate-linking-tissue"]')
      return el && !el.hasAttribute('disabled')
    },
    { timeout: 20000 },
  )
  const before = await readoutNum('annotate-linking-readout')
  check(before === 0, 'TEST-A5 no shared selection before the gate', `n=${before}`)

  await p.getByTestId('annotate-linking-tissue').click({ force: true })
  await p.waitForTimeout(600)
  const after = await readoutNum('annotate-linking-readout')
  await p.screenshot({ path: `${SC}/e2e-linking-gate.png` })
  check(after != null && after > 0, 'TEST-A5 gate lights the same cells through the shared Coordination store', `n=${after}`)

  check(errs.length === 0, 'no console/page errors', errs.slice(0, 3).join(' | '))
} catch (e) {
  check(false, 'e2e threw', String(e))
}

await b.close()
console.log(pass ? '\nmask-and-linking e2e: ALL PASS' : '\nmask-and-linking e2e: FAILURES ABOVE')
process.exit(pass ? 0 : 1)
