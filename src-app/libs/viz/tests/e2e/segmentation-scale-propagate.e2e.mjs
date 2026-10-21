// segmentation-scale-propagate.e2e.mjs — TEST-17 (ITEM-14).
// "apply contrast + palette to group" applies directly to a clean linked cell, and shows a CONFIRM
// listing a cell that already has overrides before overwriting it (ESC-1).
// The former Part 1 (shared-authoring-state) is GONE: DEC-17 deleted the workspace-shared authoring
// store outright, so the behaviour it asserted no longer exists. The invariant it partly covered
// (INV-11 per-cell isolation) is re-pinned, in a STRICTLY STRONGER form, by TEST-A11 in
// `Annotate.store.test.ts` (DEC-19/DEC-21) — it was re-pointed, not dropped.
// Offline; clean at desktop + 390px.
// Runnable: node tests/e2e/segmentation-scale-propagate.e2e.mjs [baseUrl]  (default http://localhost:1471)
// Run `npx vite --port 1471 --strictPort` in the package first.
import { chromium } from 'playwright'
const BASE = process.argv[2] ?? 'http://localhost:1471'
const IGNORE = /favicon|shader|luma|SwiftShader|assertion failed|SelectableScatterLayer|WebGL|Compilation error|fragment/i

const b = await chromium.launch()
let pass = true
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) pass = false
}

async function openStory(hash, rootTestId, width) {
  const p = await b.newPage({ viewport: { width, height: 900 } })
  const errs = []
  p.on('pageerror', e => errs.push('P:' + String(e).slice(0, 140)))
  p.on('console', m => {
    if (m.type() === 'error' && !IGNORE.test(m.text())) errs.push('C:' + m.text().slice(0, 140))
  })
  await p.goto(`${BASE}/viz-showcase.html#${hash}`, { waitUntil: 'commit' })
  await p.waitForSelector(`[data-testid="${rootTestId}"]`, { timeout: 20000 })
  await p.waitForTimeout(3000)
  return { p, errs }
}

try {
  // ── propagate display to linked cells (ITEM-14 / TEST-17) ──
  {
    const { p, errs } = await openStory('propagate-linked', 'viz-propagate-linked', 1400)
    const segBtns = await p.$$('[data-testid^="viz-cell-segment-"]')
    check(segBtns.length >= 2, 'a per-pane Segment button on each segment-capable pane', `n=${segBtns.length}`)
    for (const btn of segBtns) {
      await btn.click()
      await p.waitForTimeout(300)
    }
    await p.waitForTimeout(500)

    // DIRECT path: link the two cores WITHOUT seeding an override, then apply — no confirm (B is clean).
    await p.evaluate(() => window.__vizLinkCells(['montA', 'montB']))
    await p.waitForTimeout(300)
    await p.evaluate(() => window.__vizApplyDisplayToGroup('montA'))
    await p.waitForTimeout(200)
    const dialogAfterDirect = await p.$('[data-testid="viz-propagate-confirm"]')
    check(dialogAfterDirect == null, 'a CLEAN target is applied directly — no confirm dialog')

    // CONFIRM path: give B its OWN display override, then applying must confirm before overwriting it.
    await p.evaluate(() => window.__vizSeedCellDisplay('montB', { colormap: 'magma' }))
    await p.waitForTimeout(250)
    await p.evaluate(() => window.__vizApplyDisplayToGroup('montA'))
    await p.waitForTimeout(200)
    const dialog = await p.$('[data-testid="viz-propagate-confirm"]')
    check(dialog != null, 'a target WITH overrides triggers the confirm dialog (ESC-1)')
    const listText = dialog ? await p.textContent('[data-testid="viz-propagate-confirm-list"]') : ''
    check(/Core B/.test(listText || ''), 'the confirm lists the overwritten cell by name', JSON.stringify(listText))
    // accept → applies + closes.
    await p.click('[data-testid="viz-propagate-confirm-apply"]')
    await p.waitForTimeout(200)
    const dialogGone = await p.$('[data-testid="viz-propagate-confirm"]')
    check(dialogGone == null, 'accepting the confirm applies + closes the dialog')

    check(errs.length === 0, 'propagate: no console/page errors', errs.slice(0, 3).join(' | '))
    await p.close()
  }

  // ── 390px smoke: the story renders clean at mobile width ──
  for (const [hash, root] of [['propagate-linked', 'viz-propagate-linked']]) {
    const { p, errs } = await openStory(hash, root, 390)
    check((await p.$(`[data-testid="${root}"]`)) != null, `mobile-390: ${hash} rendered`)
    check(errs.length === 0, `mobile-390: ${hash} no console/page errors`, errs.slice(0, 3).join(' | '))
    await p.close()
  }
} catch (e) {
  check(false, 'threw', String(e).slice(0, 200))
}

await b.close()
console.log(pass ? 'segmentation-scale-propagate e2e: ALL PASS' : 'segmentation-scale-propagate e2e: FAIL')
process.exit(pass ? 0 : 1)
