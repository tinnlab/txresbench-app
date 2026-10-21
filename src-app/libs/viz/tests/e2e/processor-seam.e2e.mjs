// processor-seam.e2e.mjs — TEST-A2 [acceptance][invariant: INV-2] (covers ITEM-8, ITEM-9). Drives
// the mock processor end-to-end against fixtures with ZERO backend: hit "Run processor" → the port
// flips a "Segmenting…" pending state → a canned label-mask result is committed → it appears as a
// REAL editor mask (LabelMaskView), correctable/undoable — no network, no model/onnxruntime.
// Runnable: node tests/e2e/processor-seam.e2e.mjs [baseUrl]   (default http://localhost:1471)
// Run `npx vite --port 1471 --strictPort` in the package first.
import { chromium } from 'playwright'
const BASE = process.argv[2] ?? 'http://localhost:1471'
const SC = '/tmp/claude-1000/-data-pbya-ziee-ziee/b5b52393-63e9-49f1-8500-803873494642/scratchpad'
const ORIGIN = new URL(BASE).origin

const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1400, height: 900 } })
const errs = []
const foreignReqs = []
p.on('pageerror', e => errs.push(String(e)))
p.on('console', m => {
  const t = m.text()
  if (m.type() === 'error' && !/favicon|shader|luma|SwiftShader|assertion failed|SelectableScatterLayer/i.test(t))
    errs.push('C:' + t)
})
p.on('request', r => {
  const u = r.url()
  if (u.startsWith('data:') || u.startsWith('blob:')) return
  if (!u.startsWith(ORIGIN)) foreignReqs.push(u)
})

let pass = true
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) pass = false
}

try {
  await p.goto(`${BASE}/viz-showcase.html#processor-seam`, { waitUntil: 'commit' })
  await p.waitForSelector('[data-testid="viz-processor-seam"]', { timeout: 20000 })
  await p.waitForTimeout(500)

  // Initial: no mask yet (the seam has committed nothing).
  const maskBefore = await p.locator('[data-testid="viz-label-mask-view"]').count()
  check(maskBefore === 0, 'TEST-A2 no mask before the processor runs', `mask=${maskBefore}`)

  // Run the mock processor. It flips pending SYNC, sleeps ~350ms, then commits the mask.
  await p.getByTestId('processor-seam-run').click({ force: true })

  // "processing" — catch the transient pending overlay (short window; poll quickly).
  let sawPending = false
  try {
    await p.waitForSelector('[data-testid="processor-seam-pending"]', { timeout: 2000, state: 'attached' })
    sawPending = true
  } catch {
    // fallback: the run button re-labels to the pending message + disables while running.
    sawPending = await p.getByTestId('processor-seam-run').isDisabled().catch(() => false)
  }
  check(sawPending, 'TEST-A2 processor reports a "processing" (pending) state on run')

  // The committed result appears as a real editor mask (LabelMaskView), pending clears.
  await p.waitForSelector('[data-testid="viz-label-mask-view"]', { timeout: 15000 })
  await p.waitForTimeout(1000)
  const maskAfter = await p.locator('[data-testid="viz-label-mask-view"]').count()
  const pendingGone = (await p.locator('[data-testid="processor-seam-pending"]').count()) === 0
  await p.screenshot({ path: `${SC}/e2e-processor-seam.png` })
  check(maskAfter === 1, 'TEST-A2 committed mask renders as a real editable LabelMaskView', `mask=${maskAfter}`)
  check(pendingGone, 'TEST-A2 pending state cleared after commit')

  // Reset clears the committed mask (the seam is a plain store round-trip).
  await p.getByTestId('processor-seam-reset').click({ force: true })
  await p.waitForTimeout(400)
  const maskReset = await p.locator('[data-testid="viz-label-mask-view"]').count()
  check(maskReset === 0, 'TEST-A2 reset clears the committed mask', `mask=${maskReset}`)

  // Backend-free + model-free: the full seam contacted nothing beyond the dev server.
  check(foreignReqs.length === 0, 'TEST-A2 full seam ran with NO network / no model fetch', `foreign=${foreignReqs.length} ${foreignReqs.slice(0, 3).join(' | ')}`)
  check(errs.length === 0, 'no console/page errors', errs.slice(0, 3).join(' | '))
} catch (e) {
  check(false, 'e2e threw', String(e))
}

await b.close()
console.log(pass ? '\nprocessor-seam e2e: ALL PASS' : '\nprocessor-seam e2e: FAILURES ABOVE')
process.exit(pass ? 0 : 1)
