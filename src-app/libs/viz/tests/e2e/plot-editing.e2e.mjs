// plot-editing.e2e.mjs — the SHELL-REDESIGN surface: global tool rail + per-pane toolbars + WYSIWYG
// legend/title + the ✎ Edit form (right panel) + export split (grid vs pane). Drives each and asserts the
// edits round-trip through getOption() (the story's live `viz-plot-editing-emitted` readout) + a PNG export.
// Runnable: node tests/e2e/plot-editing.e2e.mjs [baseUrl]
import { chromium } from 'playwright'
const BASE = process.argv[2] ?? 'http://localhost:1483'
const SC = '/tmp/claude-1000/-data-pbya-ziee-ziee/b5b52393-63e9-49f1-8500-803873494642/scratchpad'

const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1560, height: 900 } })
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
const emitted = () => p.$eval('[data-testid="viz-plot-editing-emitted"]', el => el.textContent ?? '')
const domClick = sel => p.$eval(sel, el => el.click())
// Open the edit form for a cell (idempotent — the ✎ button TOGGLES, so click at most ONCE if it's not
// already open, then wait long; re-clicking would toggle it back closed). Multiple forms coexist.
const openForm = async cellId => {
  if (await p.$(`[data-testid="viz-edit-form-${cellId}"]`)) return true
  await domClick(`[data-testid="viz-cell-edit-${cellId}"]`).catch(() => {})
  try {
    await p.waitForSelector(`[data-testid="viz-edit-form-${cellId}"]`, { timeout: 8000, state: 'attached' })
    return true
  } catch {
    return false
  }
}
// Set a controlled input the way React notices (resolves to the inner <input> for kit wrappers).
// The form's text inputs commit on BLUR (not per keystroke), so set the value then blur to commit.
const setInput = (sel, value) =>
  p.$eval(sel, (root, v) => {
    const el = root.tagName === 'INPUT' ? root : root.querySelector('input')
    el.focus()
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    el.blur()
  }, value)

await p.goto(`${BASE}/viz-showcase.html#plot-editing`, { waitUntil: 'commit' })
await p.waitForSelector('[data-viz-cell]', { timeout: 20000 }).catch(() => {})
await p.waitForTimeout(5000)

try {
  // ── TEST-1: the global tool rail renders with the exclusive tools + toggles + grid export. ──
  // The camera tool's key is `pan` (registry entry `view.pan`), NOT `zoom`: annotate-tooling-ux's
  // ROOT-1 registry consolidation renamed it (DRIFT-1.4). NOTE the id below is ASSEMBLED from a
  // template literal, so grepping for the composed `viz-tool-rail-tool-zoom` does NOT find this
  // reference — a rename must grep the BARE key (`tool-zoom`) too. That miss is exactly why this
  // spec went stale unnoticed.
  await p.waitForSelector('[data-testid="viz-tool-rail"]', { timeout: 20000 })
  const railBits = await p.evaluate(() =>
    ['tool-select', 'tool-pan', 'toggle-cell-toolbars', 'toggle-link-zoom', 'export-grid'].map(
      s => document.querySelector(`[data-testid="viz-tool-rail-${s}"]`) != null,
    ),
  )
  check(railBits.every(Boolean), 'TEST-1 global tool rail renders (tools + toggles + export)', railBits.join(','))

  // ── TEST-2: each cell has an occupied-space pane toolbar with Edit + Export. ──
  const toolbars = await p.$$eval('[data-testid^="viz-pane-toolbar-"]', els => els.length)
  const hasEdit = (await p.$('[data-testid="viz-cell-edit-cat"]')) != null
  check(toolbars >= 4 && hasEdit, 'TEST-2 per-pane toolbars render (Edit/Export)', `toolbars=${toolbars} edit=${hasEdit}`)

  // ── TEST-3: ✎ Edit opens the right-panel form; editing the title round-trips through getOption(). ──
  const opened3 = await openForm('cat')
  const panel = opened3 && (await p.$('[data-testid="viz-edit-panel"]')) != null
  await setInput('[data-testid="viz-edit-title-cat"]', 'My cells')
  await p.waitForTimeout(500)
  const afterTitle = await emitted()
  check(panel && /title="My cells"/.test(afterTitle), 'TEST-3 edit form title round-trips', `panel=${panel} ${afterTitle.slice(0, 90)}`)

  // ── TEST-3d: LIVE legend interaction (not editing) — clicking a swatch on the plot's WYSIWYG legend
  //    show/hides that category and SYNCS to the edit form's per-category Switch (plot → form). ──
  {
    const toggleStates = () =>
      p.$$eval('[data-testid^="viz-edit-cat-toggle-cat-"]', els =>
        els.map(e => `${e.getAttribute('data-testid')}=${e.getAttribute('aria-checked')}`),
      )
    const before = await toggleStates()
    const lg = await p.$('[data-testid="viz-incell-legend"]')
    const bb = lg ? await lg.boundingBox() : null
    if (bb) await p.mouse.click(bb.x + 8, bb.y + 28) // row 0 swatch (title 20px + row 18px)
    await p.waitForTimeout(400)
    const after = await toggleStates()
    const flipped = before.length === after.length && before.filter((s, i) => s !== after[i]).length
    check(!!bb && flipped === 1, 'TEST-3d plot legend click syncs to the edit-form toggle', `flipped=${flipped} before=${before} after=${after}`)
    if (bb) await p.mouse.click(bb.x + 8, bb.y + 28) // restore (net-zero for TEST-4)
    await p.waitForTimeout(300)
  }

  // ── TEST-4: form legend — recolor a category + hide one → colorOverrides + hidden round-trip. ──
  await setInput('[data-testid="viz-edit-cat-color-cat-0"]', '#ff0000')
  await p.waitForTimeout(400)
  await domClick('[data-testid="viz-edit-cat-toggle-cat-1"]')
  await p.waitForTimeout(400)
  const afterLegend = await emitted()
  check(/colorOverrides=/.test(afterLegend), 'TEST-4 form legend recolor/hide round-trips', afterLegend.slice(0, 90))

  // ── TEST-5: form colormap on the continuous cell → getOption reflects it. ──
  await openForm('cont')
  await p.waitForSelector('[data-testid="viz-edit-colormap-cont"]', { timeout: 5000, state: 'attached' })
  await domClick('[data-testid="viz-edit-colormap-cont"]')
  await p.waitForTimeout(400)
  await domClick('[data-testid="viz-edit-colormap-cont-opt-magma"]').catch(() => {})
  await p.waitForTimeout(500)
  await p.keyboard.press('Escape').catch(() => {}) // ensure the Select dropdown portal closes
  await p.waitForTimeout(200)
  const afterCmap = await emitted()
  check(/cmap=magma/.test(afterCmap), 'TEST-5 form colormap round-trips', afterCmap.slice(0, 120))

  // ── TEST-5b: LIVE visual-map interaction (not editing) — dragging the continuous visual-map's HI handle
  //    down filters the value range and SYNCS to the edit form's range-hi input (plot → form). ──
  {
    const readHi = () => p.$eval('[data-testid="viz-edit-range-hi-cont"]', r => Number((r.querySelector('input') ?? r).value))
    const beforeHi = await readHi()
    const vm = await p.$('[data-testid="viz-cell-visualmap-cont"]')
    const bb = vm ? await vm.boundingBox() : null
    if (bb) {
      // hi handle sits at the bar TOP (VPAD=12) when unfiltered; drag it down to lower the max.
      await p.mouse.move(bb.x + bb.width / 2, bb.y + 12)
      await p.mouse.down()
      await p.mouse.move(bb.x + bb.width / 2, bb.y + 50, { steps: 8 })
      await p.mouse.up()
    }
    await p.waitForTimeout(400)
    const afterHi = await readHi()
    check(!!bb && afterHi < beforeHi, 'TEST-5b plot visual-map drag syncs to the edit-form range', `before=${beforeHi} after=${afterHi}`)
    await domClick('[data-testid="viz-edit-range-reset-cont"]').catch(() => {}) // restore full range
    await p.waitForTimeout(300)
  }

  // ── TEST-6: form marks (size) via the kit Slider → getOption reflects style.radius. ──
  await openForm('cat')
  await p.waitForSelector('[data-testid="viz-edit-size-cat"]', { timeout: 5000, state: 'attached' })
  const sizeInput = await p.$('[data-testid="viz-edit-size-cat"] input')
  if (sizeInput) { await sizeInput.scrollIntoViewIfNeeded().catch(() => {}); await sizeInput.focus(); await sizeInput.press('End') }
  await p.waitForTimeout(400)
  const afterMarks = await emitted()
  check(/"radius":12/.test(afterMarks), 'TEST-6 form marks size round-trips', afterMarks.slice(0, 160))

  // ── TEST-6b: MULTIPLE edit forms open at once (per-pane) — cat + cont forms coexist. ──
  await openForm('cat')
  await openForm('cont')
  const bothOpen =
    (await p.$('[data-testid="viz-edit-form-cat"]')) != null &&
    (await p.$('[data-testid="viz-edit-form-cont"]')) != null
  check(bothOpen, 'TEST-6b multiple edit forms open at once', `both=${bothOpen}`)
  // Close them (the ✎ toggles / the X closes) so the export tests aren't obscured.
  await domClick('[data-testid="viz-edit-form-close-cat"]').catch(() => {})
  await domClick('[data-testid="viz-edit-form-close-cont"]').catch(() => {})
  await p.waitForTimeout(300)

  // ── TEST-7: pane export (⤓ on a toolbar) → GridWorkspace-owned kit dialog opens (in the right panel),
  //    shows the plot title, and downloads a PNG whose name derives from the title. ──
  {
    await domClick('[data-testid="viz-cell-export-cont"]')
    await p.waitForTimeout(500)
    const opened = (await p.$('[data-testid="viz-export-dialog-cont"]')) != null
    const target = await p.$eval('[data-testid="export-target-title-cont"]', el => el.textContent ?? '').catch(() => '')
    const go = await p.$('[data-testid="export-button-cont"]')
    let file = ''
    if (go) {
      const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 10000 }).catch(() => null), go.click()])
      file = dl ? dl.suggestedFilename() : ''
    }
    check(opened && !!target && /\.png$/.test(file), 'TEST-7 per-pane export: owned dialog + title + PNG', `opened=${opened} title="${target}" file=${file}`)
    await domClick('[data-testid="viz-export-close-cont"]').catch(() => {})
    await p.waitForTimeout(200)
  }

  // ── TEST-8: grid export (⤓ on the tool rail) → owned dialog opens + downloads a PNG. ──
  {
    await domClick('[data-testid="viz-tool-rail-export-grid"]')
    await p.waitForTimeout(500)
    const opened = (await p.$('[data-testid="viz-export-dialog-grid"]')) != null
    const go = await p.$('[data-testid="export-button-grid"]')
    let file = ''
    if (go) {
      const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 10000 }).catch(() => null), go.click()])
      file = dl ? dl.suggestedFilename() : ''
    }
    check(opened && /\.png$/.test(file), 'TEST-8 whole-grid export: owned dialog + PNG', `opened=${opened} file=${file}`)
    await domClick('[data-testid="viz-export-close-grid"]').catch(() => {})
    await p.waitForTimeout(200)
  }

  // ── drag helpers: pick up a cell by its grip and drop it in a "+"-cross zone of a target cell. ──
  const box = sel => p.$eval(sel, el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, midX: r.x + r.width / 2, midY: r.y + r.height / 2 } })
  const zonePoint = (b, zone) =>
    zone === 'left' ? { x: b.x + b.w * 0.12, y: b.midY }
    : zone === 'right' ? { x: b.x + b.w * 0.88, y: b.midY }
    : zone === 'top' ? { x: b.midX, y: b.y + b.h * 0.12 }
    : zone === 'bottom' ? { x: b.midX, y: b.y + b.h * 0.88 }
    : { x: b.midX, y: b.midY } // center
  // Drag source→target zone; `beforeUp` runs while the button is still held (to inspect the live indicator).
  const dragCell = async (sourceId, targetId, zone, beforeUp) => {
    const g = await box(`[data-testid="viz-cell-grip-${sourceId}"]`)
    const t = await box(`[data-testid="viz-cell-view-${targetId}"]`)
    const pt = zonePoint(t, zone)
    await p.mouse.move(g.midX, g.midY)
    await p.mouse.down()
    await p.mouse.move(g.midX + 10, g.midY + 10, { steps: 3 }) // cross the 4px drag threshold
    await p.mouse.move(pt.x, pt.y, { steps: 14 })
    await p.mouse.move(pt.x, pt.y, { steps: 2 }) // settle on the zone
    if (beforeUp) await beforeUp()
    await p.mouse.up()
    await p.waitForTimeout(500)
  }

  // ── TEST-10: drop on a cell's CENTER → the two plots SWAP content (observed via data-cell-kind). ──
  {
    const before = await p.$eval('[data-testid="viz-cell-view-cat"]', el => el.getAttribute('data-cell-kind'))
    await dragCell('box', 'cat', 'center') // box (kind 'box') onto cat (kind 'scatter')
    const after = await p.$eval('[data-testid="viz-cell-view-cat"]', el => el.getAttribute('data-cell-kind'))
    check(before === 'scatter' && after === 'box', 'TEST-10 center drop swaps the two plots', `cat kind ${before}→${after}`)
  }

  // ── TEST-11: drop on a cell's TOP arm → the dragged plot REPOSITIONS above it (directional split),
  //    and the live "+"-cross indicator reports zone=top mid-drag. ──
  {
    let liveZone = ''
    await dragCell('violin', 'cont', 'top', async () => {
      liveZone = await p.$eval('[data-testid="viz-cell-droptarget-cont"]', el => el.getAttribute('data-drop-zone')).catch(() => '')
    })
    const v = await box('[data-testid="viz-cell-view-violin"]')
    const c = await box('[data-testid="viz-cell-view-cont"]')
    // violin now sits ABOVE cont (its vertical center is higher) and their columns overlap.
    const above = v.midY < c.midY && v.x < c.x + c.w && v.x + v.w > c.x
    check(liveZone === 'top' && above, 'TEST-11 top-arm drop repositions the plot above the target', `liveZone=${liveZone} violinMidY=${Math.round(v.midY)} contMidY=${Math.round(c.midY)}`)
  }

  await p.screenshot({ path: `${SC}/e2e-shell.png` })
  check(errs.length === 0, 'TEST-9 no console/page errors on the shell path', errs.slice(0, 3).join(' | '))
} catch (e) {
  check(false, 'e2e threw', String(e))
}

await b.close()
console.log(pass ? '\nALL PASS' : '\nSOME FAILED')
process.exit(pass ? 0 : 1)
