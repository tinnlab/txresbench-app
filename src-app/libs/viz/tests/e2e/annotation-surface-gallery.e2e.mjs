// annotation-surface-gallery.e2e.mjs — TEST-13 (covers ITEM-15). The `gate:ui` runtime-health analog
// for the whole annotation surface: load EACH of the 9 showcase stories at DESKTOP and again at ~390px
// (mobile), as isolated full reloads, and assert per cell — no console error, no page/nav error, no
// failed network request, and the story ROOT actually rendered. This is the exit-condition sweep: a
// story that crashes, throws, or fails a request in any state × width fails.
// Runnable: node tests/e2e/annotation-surface-gallery.e2e.mjs [baseUrl]   (default http://localhost:1471)
// Run `npx vite --port 1471 --strictPort` in the package first.
import { chromium } from 'playwright'
const BASE = process.argv[2] ?? 'http://localhost:1471'
const SC = '/tmp/claude-1000/-data-pbya-txresbench-txresbench/b5b52393-63e9-49f1-8500-803873494642/scratchpad'

// story id → its root data-testid (the "rendered" signal).
const STORIES = [
  ['annotate-image-render', 'viz-annotate-image-render'],
  ['annotate-channels', 'viz-annotate-channels'],
  ['annotate-draw', 'viz-annotate-draw'],
  ['annotate-brush', 'viz-annotate-brush'],
  ['annotate-geojson', 'viz-annotate-geojson'],
  ['processor-seam', 'viz-processor-seam'],
  ['mask-review', 'viz-mask-review'],
  ['mask-correct', 'viz-mask-correct'],
  ['annotate-linking', 'viz-annotate-linking'],
  ['annotate-workbench', 'viz-annotate-workbench'],
  ['in-grid-mask', 'viz-in-grid-mask'],
  ['shared-mask-panes', 'viz-shared-mask-panes'],
  ['hierarchy-tree', 'viz-hierarchy-tree-story'],
  ['propagate-linked', 'viz-propagate-linked'],
  // annotate-tooling-ux ITEM-19 / TEST-22: the POPULATED two-annotate + two-segment pane story —
  // the specific artifact that would have caught this feature's worth of per-pane defects.
  ['per-pane-editing', 'viz-per-pane-editing'],
]
const WIDTHS = [
  ['desktop', 1400],
  ['mobile-390', 390],
]

// deck.gl / luma / SwiftShader software-GL noise is not a surface defect (same filter the other specs use).
const IGNORE = /favicon|shader|luma|SwiftShader|assertion failed|SelectableScatterLayer|WebGL|Compilation error|fragment/i
// vite HMR ping + favicon are not surface requests.
const IGNORE_REQ = /favicon|@vite|@react-refresh|__vite_ping|\.map$/i

const b = await chromium.launch()
let pass = true
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) pass = false
}

const table = []
try {
  // Warm-up: the showcase entry eager-imports EVERY story module, so a cold vite dev server
  // compiles hundreds of modules on the first hit and a few on-demand transform requests can
  // transiently abort. Prime the module graph once so the measured loads are deterministic.
  const warm = await b.newPage({ viewport: { width: 1400, height: 900 } })
  await warm.goto(`${BASE}/viz-showcase.html#annotate-image-render`, { waitUntil: 'commit' }).catch(() => {})
  await warm.waitForSelector('[data-testid="showcase-stage"]', { timeout: 20000 }).catch(() => {})
  await warm.waitForTimeout(3000)
  await warm.close()

  for (const [id, rootTestId] of STORIES) {
    for (const [wname, width] of WIDTHS) {
      const p = await b.newPage({ viewport: { width, height: 900 } })
      const findings = []
      p.on('pageerror', e => findings.push('page-error:' + String(e).slice(0, 120)))
      p.on('console', m => {
        if (m.type() !== 'error') return
        const t = m.text()
        if (!IGNORE.test(t)) findings.push('console-error:' + t.slice(0, 120))
      })
      p.on('requestfailed', r => {
        const u = r.url()
        if (IGNORE_REQ.test(u)) return
        findings.push('request-failed:' + u.slice(0, 120))
      })

      let rendered = false
      try {
        await p.goto(`${BASE}/viz-showcase.html#${id}`, { waitUntil: 'commit' })
        await p.waitForSelector(`[data-testid="${rootTestId}"]`, { timeout: 20000 })
        rendered = true
        await p.waitForTimeout(2500) // let deck/layers settle so late errors surface
      } catch (e) {
        findings.push('no-render:' + String(e).slice(0, 100))
      }

      const cell = `${id} @ ${wname}`
      const ok = rendered && findings.length === 0
      table.push({ cell, ok, findings })
      check(ok, `TEST-13 ${cell}`, findings.slice(0, 2).join(' | '))
      if (!ok) await p.screenshot({ path: `${SC}/e2e-gallery-fail-${id}-${wname}.png` }).catch(() => {})
      await p.close()
    }
  }
} catch (e) {
  check(false, 'e2e threw', String(e))
}

await b.close()
const failed = table.filter(r => !r.ok).length
console.log(`\nTEST-13 annotation-surface gallery: ${table.length - failed}/${table.length} cells clean`)
console.log(pass ? 'annotation-surface-gallery e2e: ALL PASS' : 'annotation-surface-gallery e2e: FAILURES ABOVE')
process.exit(pass ? 0 : 1)
