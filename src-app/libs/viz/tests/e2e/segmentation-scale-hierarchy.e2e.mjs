// segmentation-scale-hierarchy.e2e.mjs — TEST-13 (covers ITEM-11). The QuPath-grade object hierarchy
// is LIVE in the grid: the `hierarchy-tree` story seeds a 3-level tissue→region→cell forest; engaging
// the Annotate tool docks the `AnnotateHierarchyPanel`; the tree renders populated + level-grouped; the
// level picker + show-only-this-level filter work; collapsing a subtree hides its descendants; selecting
// a node highlights it (aria-pressed) — the tree↔canvas selection binding; and "Resolve hierarchy" runs
// the containment resolve with a determinate "resolved N of M" readout. Offline; clean at desktop + 390px.
// Runnable: node tests/e2e/segmentation-scale-hierarchy.e2e.mjs [baseUrl]   (default http://localhost:1471)
import { chromium } from 'playwright'
const BASE = process.argv[2] ?? 'http://localhost:1471'
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
  await p.goto(`${BASE}/viz-showcase.html#hierarchy-tree`, { waitUntil: 'commit' })
  await p.waitForSelector('[data-testid="viz-hierarchy-tree-story"]', { timeout: 20000 })
  await p.waitForTimeout(3500) // let the fixture resolve + the tree seed into the AnnotateStore
  return { p, errs }
}

try {
  // ── Desktop ─────────────────────────────────────────────────────────────────────────────────────
  const { p, errs } = await openStory(1400)
  check((await p.$('[data-testid="viz-hierarchy-tree-story"]')) != null, 'story rendered')

  // Press Annotate on the PANE's own toolbar (finding #14) → that pane's hierarchy panel docks.
  const annBtns = await p.$$('[data-testid^="viz-cell-annotate-"]')
  check(annBtns.length >= 1, 'per-pane Annotate button present', `n=${annBtns.length}`)
  for (const btn of annBtns) await btn.click()
  // BLIND-AUDIT M6 — the in-dock hierarchy panel is now PANE-QUALIFIED
  // (`viz-hierarchy-<paneId>-…`). One panel renders per OPEN dock, so the old bare
  // `viz-hierarchy-panel` matched every pane at once and silently asserted the FIRST — the
  // single-pane blind spot this feature exists to remove. Derive the prefix from the pane whose
  // Annotate button we pressed.
  const HPANE = (await annBtns[0].getAttribute('data-testid')).replace('viz-cell-annotate-', '')
  const H = `viz-hierarchy-${HPANE}`
  await p.waitForSelector(`[data-testid="${H}-panel"]`, { timeout: 10000 })
  check(true, "hierarchy panel docks on the pane's Annotate button")

  // Populated tree: 1 tissue + 3 regions + 12 cells = 16 objects seeded.
  const nodeCount = await p.$$eval(`[data-testid^="${H}-node-"]`, els => els.length)
  check(nodeCount >= 16, `tree renders the populated forest (≥16 nodes)`, `nodes=${nodeCount}`)

  // Level filter: show only "cell" → the 12 cell rows remain, tissue/region rows drop out.
  await p.click(`[data-testid="${H}-level-cell"]`)
  await p.waitForTimeout(200)
  const cellOnly = await p.$$eval(`[data-testid^="${H}-node-"]`, els => els.map(e => e.getAttribute('data-testid')))
  const cellRows = cellOnly.filter(t => t.includes('-node-cell-')).length
  const nonCellRows = cellOnly.filter(t => !t.includes('-node-cell-')).length
  check(cellRows === 12 && nonCellRows === 0, 'level filter "cell" shows only the cell objects', `cell=${cellRows} other=${nonCellRows}`)
  await p.click(`[data-testid="${H}-level-all"]`)
  await p.waitForTimeout(150)

  // Collapse the tissue subtree → its descendant region/cell rows disappear.
  const toggle = await p.$(`[data-testid="${H}-toggle-tissue-1"]`)
  check(toggle != null, 'tissue node has an expand/collapse toggle (has children)')
  await toggle.click()
  await p.waitForTimeout(200)
  const afterCollapse = await p.$$eval(`[data-testid^="${H}-node-"]`, els => els.length)
  check(afterCollapse === 1, 'collapsing tissue hides its descendants (only the root row remains)', `rows=${afterCollapse}`)
  await toggle.click() // re-expand
  await p.waitForTimeout(150)

  // Select a node in the tree → it becomes selected (aria-pressed) — the tree↔canvas binding.
  await p.click(`[data-testid="${H}-node-region-1"]`)
  await p.waitForTimeout(150)
  const pressed = await p.getAttribute(`[data-testid="${H}-node-region-1"]`, 'aria-pressed')
  check(pressed === 'true', 'selecting a tree node marks it selected (tree→canvas)')
  const storeSel = await p.evaluate(() => {
    const s = window.__vizAnnotateStores && window.__vizAnnotateStores.get('slide')
    return s ? [...s.getState().selection] : null
  })
  check(Array.isArray(storeSel) && storeSel.includes('region-1'), 'the store selection reflects the tree click', JSON.stringify(storeSel))

  // Resolve hierarchy → determinate readout appears.
  await p.click(`[data-testid="${H}-resolve"]`)
  await p.waitForSelector(`[data-testid="${H}-resolve-readout"]`, { timeout: 5000 })
  const readout = await p.textContent(`[data-testid="${H}-resolve-readout"]`)
  check(/resolved \d+ of \d+/.test(readout ?? ''), 'Resolve hierarchy shows a determinate "resolved N of M" readout', readout ?? '')

  check(errs.length === 0, 'desktop: no console/page errors', errs.slice(0, 3).join(' | '))
  await p.close()

  // ── 390px ─────────────────────────────────────────────────────────────────────────────────────
  const { p: pm, errs: em } = await openStory(390)
  check((await pm.$('[data-testid="viz-hierarchy-tree-story"]')) != null, 'mobile-390: story rendered')
  const atm = await pm.$$('[data-testid^="viz-cell-annotate-"]')
  if (atm.length > 0) {
    for (const btn of atm) await btn.click()
    await pm.waitForSelector(`[data-testid^="viz-hierarchy-"][data-testid$="-panel"]`, { timeout: 10000 })
    check(true, 'mobile-390: hierarchy panel docks')
  }
  check(em.length === 0, 'mobile-390: no console/page errors', em.slice(0, 3).join(' | '))
  await pm.close()
} catch (e) {
  check(false, 'threw', String(e).slice(0, 200))
}

await b.close()
console.log(pass ? 'segmentation-scale-hierarchy e2e: ALL PASS' : 'segmentation-scale-hierarchy e2e: FAIL')
process.exit(pass ? 0 : 1)
