// linking.e2e.mjs — TEST-12 (covers ITEM-13). Image↔data linking through the shared Coordination
// store in BOTH directions, plus cross-dataset identity-space isolation:
//   • region→scatter — a gate on the tissue publishes a selection → the shared readout goes non-zero.
//   • scatter→tissue — a selection ORIGINATED on the embedding leg → the shared readout goes non-zero.
//   • isolation — publishing into dataset-B's identity space leaves the DEFAULT-space selection at 0
//     (a B-space selection must NOT bleed into the A/default views).
// A headless gallery can't lasso, so the story exposes deterministic gate buttons that publish
// through the SAME store path a real lasso would.
// Runnable: node tests/e2e/linking.e2e.mjs [baseUrl]   (default http://localhost:1471)
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
const readout = async () => {
  const t = (await p.getByTestId('annotate-linking-readout').textContent().catch(() => '')) ?? ''
  const m = t.replace(/,/g, '').match(/(\d+)/)
  return m ? Number(m[1]) : null
}
const clear = async () => {
  await p.getByTestId('annotate-linking-clear').click({ force: true })
  await p.waitForTimeout(400)
}

try {
  await p.goto(`${BASE}/viz-showcase.html#annotate-linking`, { waitUntil: 'commit' })
  await p.waitForSelector('[data-testid="viz-annotate-linking"]', { timeout: 20000 })
  // All three linked views mount.
  for (const id of ['annotate-linking-tissue-a', 'annotate-linking-embedding-view', 'annotate-linking-tissue-b']) {
    check((await p.locator(`[data-testid="${id}"]`).count()) === 1, `TEST-12 linked view present: ${id}`)
  }
  // Fixture loaded → gates enable.
  await p.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="annotate-linking-tissue"]')
      return el && !el.hasAttribute('disabled')
    },
    { timeout: 20000 },
  )
  await p.waitForTimeout(500)

  check((await readout()) === 0, 'TEST-12 no shared selection at start')

  // ── LEG 1: region→scatter. Tissue gate publishes on the default space → both legs see it. ──
  await p.getByTestId('annotate-linking-tissue').click({ force: true })
  await p.waitForTimeout(600)
  const legRegion = await readout()
  check(legRegion != null && legRegion > 0, 'TEST-12 region→scatter lights the shared selection', `n=${legRegion}`)
  await clear()
  check((await readout()) === 0, 'TEST-12 clear resets the shared selection')

  // ── LEG 2: scatter→tissue. Embedding-origin gate publishes on the default space → tissue lights. ──
  await p.getByTestId('annotate-linking-embedding').click({ force: true })
  await p.waitForTimeout(600)
  const legScatter = await readout()
  check(legScatter != null && legScatter > 0, 'TEST-12 scatter→tissue lights the shared selection (return leg)', `n=${legScatter}`)
  await clear()

  // ── ISOLATION: publish into dataset-B's identity space → the DEFAULT-space selection stays 0. ──
  await p.getByTestId('annotate-linking-spaceb').click({ force: true })
  await p.waitForTimeout(600)
  const isoDefault = await readout()
  await p.screenshot({ path: `${SC}/e2e-linking.png` })
  check(isoDefault === 0, 'TEST-12 dataset-B selection does NOT bleed into the default space (identity isolation)', `n=${isoDefault}`)
  await clear()

  check(errs.length === 0, 'no console/page errors', errs.slice(0, 3).join(' | '))
} catch (e) {
  check(false, 'e2e threw', String(e))
}

await b.close()
console.log(pass ? '\nlinking e2e: ALL PASS' : '\nlinking e2e: FAILURES ABOVE')
process.exit(pass ? 0 : 1)
