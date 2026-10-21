// segmentation-scale-shared-mask.e2e.mjs — TEST-8 (covers ITEM-7, Track A). The `shared-mask-panes`
// story shows TWO segment tiles of one slide. Linking them + sharing promotes both to ONE world-space
// label raster (INV-8): a brush centered ON the pane seam paints a run of shared texels crossing it in
// BOTH panes, ONE undo reverts the whole edit (one shared stack), and detach reverts each tile to its
// own per-cell mask. Offline; clean at desktop + 390px.
// Runnable: node tests/e2e/segmentation-scale-shared-mask.e2e.mjs [baseUrl]  (default http://localhost:1471)
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

async function openStory(width) {
  const p = await b.newPage({ viewport: { width, height: 900 } })
  const errs = []
  p.on('pageerror', e => errs.push('P:' + String(e).slice(0, 140)))
  p.on('console', m => {
    if (m.type() === 'error' && !IGNORE.test(m.text())) errs.push('C:' + m.text().slice(0, 140))
  })
  await p.goto(`${BASE}/viz-showcase.html#shared-mask-panes`, { waitUntil: 'commit' })
  await p.waitForSelector('[data-testid="viz-shared-mask-panes"]', { timeout: 20000 })
  await p.waitForTimeout(3500) // let both tile masks resolve + deck settle
  return { p, errs }
}

try {
  const { p, errs } = await openStory(1400)
  check((await p.$('[data-testid="viz-shared-mask-panes"]')) != null, 'story rendered')

  // Open EACH segment pane's own dock from ITS OWN toolbar (finding #14 — there is no global Segment
  // rail mode any more), so the panel + hooks are live and both per-cell masks are resolved.
  const segBtns = await p.$$('[data-testid^="viz-cell-segment-"]')
  check(segBtns.length >= 2, 'a per-pane Segment button on each segment-capable pane', `n=${segBtns.length}`)
  for (const btn of segBtns) {
    await btn.click()
    await p.waitForTimeout(300)
  }
  await p.waitForTimeout(500)

  // Link the two tiles (creates the link group in the store) — separate tick so React re-renders and the
  // `__vizShareMaskAcrossGroup` hook rebinds against the NOW-populated link group before we share.
  const gid = await p.evaluate(() => window.__vizLinkCells(['tileA', 'tileB']))
  await p.waitForTimeout(400)
  // SHARE a mask across the group — the explicit ESC-3 action, via the live hook.
  const shared = await p.evaluate(g => {
    const w = window
    w.__vizShareMaskAcrossGroup(g)
    const s = w.__vizSharedMasks.get(g)
    if (!s) return { gid: g, ok: false }
    return {
      gid: g,
      ok: true,
      width: s.mask.width,
      height: s.mask.height,
      rasterLen: s.mask.raster.length,
      isU32: s.mask.raster instanceof Uint32Array,
      views: [...s.mask.views.keys()].sort(),
    }
  }, gid)
  check(shared.ok, 'a shared mask was created for the group')
  // union of two 384-wide tiles at world x[0..384] and [384..768] ⇒ 768×384, ONE Uint32 raster
  check(shared.width === 768 && shared.height === 384 && shared.rasterLen === 768 * 384 && shared.isU32,
    'ONE 768×384 Uint32 shared raster spans both tiles', JSON.stringify({ w: shared.width, h: shared.height }))
  check(JSON.stringify(shared.views) === JSON.stringify(['tileA', 'tileB']), 'both tiles registered as views', JSON.stringify(shared.views))

  // ── Seam-crossing stroke: ONE brush disk centered on the world seam (x=384) paints texels on BOTH
  //    sides continuously; ONE undo reverts the whole edit (one shared stack, INV-8). ──
  const seam = await p.evaluate(gid => {
    const s = window.__vizSharedMasks.get(gid)
    const { mask, controller } = s
    const W = mask.width
    const row = 192 // mid-height world y == pixel y (1:1)
    const readRow = () => {
      const left = [], right = []
      for (let x = 0; x < W; x++) {
        if (mask.raster[row * W + x] === 7) (x < 384 ? left : right).push(x)
      }
      return { left, right }
    }
    const before = readRow()
    // world seam at x=384; a disk r=10 world units crosses it (1 world unit / pixel here).
    controller.brushWorld({ wx: 384, wy: row, rWorld: 10, id: 7 })
    const afterEdit = readRow()
    const canUndo = controller.canUndo
    const depth = controller.historyDepth
    controller.undo()
    const afterUndo = readRow()
    // contiguity across the seam: the union of painted x's on the row is one gap-free run.
    const all = [...afterEdit.left, ...afterEdit.right].sort((a, b) => a - b)
    const contiguous = all.length > 0 && all[all.length - 1] - all[0] + 1 === all.length
    return {
      beforeCount: before.left.length + before.right.length,
      leftCount: afterEdit.left.length,
      rightCount: afterEdit.right.length,
      crossesSeam: afterEdit.left.length > 0 && afterEdit.right.length > 0,
      contiguous,
      canUndo,
      depth,
      afterUndoCount: afterUndo.left.length + afterUndo.right.length,
    }
  }, shared.gid)
  check(seam.beforeCount === 0, 'row started with no label-7 texels', JSON.stringify({ n: seam.beforeCount }))
  check(seam.crossesSeam, 'the stroke painted texels on BOTH sides of the seam (continuous across panes)',
    JSON.stringify({ left: seam.leftCount, right: seam.rightCount }))
  check(seam.contiguous, 'the painted run is gap-free across the seam (no boundary hole/duplication)')
  check(seam.canUndo && seam.depth === 1, 'the whole stroke is ONE undo atom (single shared stack)', JSON.stringify({ depth: seam.depth }))
  check(seam.afterUndoCount === 0, 'one undo reverts the entire seam-crossing stroke')

  // ── Detach: the group reverts to per-cell masks; the shared raster is dropped. ──
  const detached = await p.evaluate(gid => {
    window.__vizDetachSharedMask(gid)
    return { stillShared: window.__vizSharedMasks.has(gid) }
  }, shared.gid)
  check(detached.stillShared === false, 'detach drops the shared mask (cells revert to per-cell)')

  check(errs.length === 0, 'desktop: no console/page errors', errs.slice(0, 3).join(' | '))
  await p.close()

  // ── 390px: renders clean at mobile width ──
  const { p: pm, errs: em } = await openStory(390)
  check((await pm.$('[data-testid="viz-shared-mask-panes"]')) != null, 'mobile-390: story rendered')
  check(em.length === 0, 'mobile-390: no console/page errors', em.slice(0, 3).join(' | '))
  await pm.close()
} catch (e) {
  check(false, 'threw', String(e).slice(0, 200))
}

await b.close()
console.log(pass ? 'segmentation-scale-shared-mask e2e: ALL PASS' : 'segmentation-scale-shared-mask e2e: FAIL')
process.exit(pass ? 0 : 1)
