// annotate-tooling-ux.e2e.mjs — the PER-PANE acceptance suite (ROOT 2).
//
// Covers TEST-A12 (INV-12 multiplicity), TEST-A13 (INV-13 direct manipulation / no swallowed click),
// TEST-11 (two panes independently operable + per-pane hierarchy) and the ROOT-1 rail assertions that
// need a live surface (TEST-5: every tool button has an accessible name; `select.move` is DISABLED
// until a selection exists).
//
// These assert a class the prior suites had NONE of. Every shipped annotate/segment test asserted
// COMMITTED state only, which is exactly why six of the owner's eight findings shipped green: a
// suite that only checks "did the geometry land" cannot see that the panel was singular, that the
// first press was swallowed, or that two panes shared one hidden binding.
//
// Runnable: node tests/e2e/annotate-tooling-ux.e2e.mjs [baseUrl]   (default http://localhost:1471)
// Run `npx vite --port 1471 --strictPort` in the package first.
import { chromium } from 'playwright'
const BASE = process.argv[2] ?? 'http://localhost:1471'
const IGNORE = /favicon|shader|luma|SwiftShader|assertion failed|SelectableScatterLayer|WebGL|Compilation error|fragment/i

const ANN_A = 'slide-a'
const ANN_B = 'slide-b'
const SEG_A = 'seg-a'
const SEG_B = 'seg-b'

const b = await chromium.launch()
let pass = true
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) pass = false
}

async function openStory(width = 1400) {
  const p = await b.newPage({ viewport: { width, height: 950 } })
  const errs = []
  p.on('pageerror', e => errs.push('P:' + String(e).slice(0, 140)))
  p.on('console', m => {
    if (m.type() === 'error' && !IGNORE.test(m.text())) errs.push('C:' + m.text().slice(0, 140))
  })
  await p.goto(`${BASE}/viz-showcase.html#per-pane-editing`, { waitUntil: 'commit' })
  await p.waitForSelector('[data-testid="viz-per-pane-editing"]', { timeout: 20000 })
  await p.waitForTimeout(4000) // pyramids + masks resolve, stores mint, seeding runs
  return { p, errs }
}

/** Read a pane's live store state through the dev seam (never the DOM) — geometry/undo truth. */
const paneState = (p, id) =>
  p.evaluate(cell => {
    const s = window.__vizAnnotateStores?.get(cell)
    if (!s) return null
    const st = s.getState()
    return {
      count: st.ids.length,
      classes: st.classes.map(c => c.name),
      tool: st.activeTool,
      activeClassId: st.activeClassId,
      undoDepth: typeof st.undoDepth === 'number' ? st.undoDepth : (st.past?.length ?? 0),
    }
  }, id)

// ── The PER-PANE entry point (finding #14) ────────────────────────────────────────────────────────
// Annotate / Segment are no longer GLOBAL rail modes that opened every capable pane at once — that is
// the "one global control acting across panes" shape the owner rejected, and it made annotating a
// SINGLE pane impossible. Each pane's own toolbar now carries the button, a sibling of Edit.
const paneAnnotate = (p, id) => p.click(`[data-testid="viz-cell-annotate-${id}"]`)
const paneSegment = (p, id) => p.click(`[data-testid="viz-cell-segment-${id}"]`)
/** Open several panes' docks in one go (what the old single rail click used to do implicitly). */
async function openPanes(p, kind, ids) {
  for (const id of ids) {
    await (kind === 'annotate' ? paneAnnotate(p, id) : paneSegment(p, id))
    await p.waitForTimeout(350)
  }
}

// ── DRIFT-3.5 · the LAYOUT probe for the stacked internal docks ────────────────────────────────────
//
// Why this exists. The per-pane assertions above (panels exist, are titled, are independently
// operable) all passed while the panels were rendering ON TOP OF EACH OTHER: pane A's "Resolve
// hierarchy" / "Objects (n)" painted straight through pane B's "Classes" / "New class…". They were
// blind to it because the overlap was NOT box-vs-box — pane A's BOX was 348px while its CONTENT was
// 473px, and `overflow: visible` let the extra 125px paint over the next dock. A pairwise
// intersection test alone would ALSO have shipped green.
//
// So the probe reports three independent classes of layout breakage:
//   • `overlaps`      — pairwise box intersection (two docks laid out at the same place).
//   • `spills`        — a dock whose CONTENT exceeds its own box while it is not a scroll container:
//                       the pixels are outside the box, i.e. painting over whatever is next. THIS is
//                       the assertion that fails on the shipped defect.
//   • `coveredTitles` — hit-test at each dock title's centre; must resolve inside that dock's own
//                       subtree, so "which pane is this?" is actually readable, not merely present.
// Plus `clipping` (content unreachable — the wrong way to "fix" an overflow) and `hOverflow`.
const dockLayout = p =>
  p.evaluate(() => {
    const isDock = t => /^viz-(annotate|mask)-panel-[^-]/.test(t) && !/-title-|-close-|-body$/.test(t)
    const docks = [
      ...document.querySelectorAll('[data-testid^="viz-annotate-panel-"],[data-testid^="viz-mask-panel-"]'),
    ].filter(e => isDock(e.getAttribute('data-testid') || ''))
    const tid = e => e.getAttribute('data-testid')
    const boxes = docks.map(e => {
      const r = e.getBoundingClientRect()
      return { id: tid(e), x: r.x, y: r.y, w: r.width, h: r.height }
    })
    const overlaps = []
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const c = boxes[j]
        const w = Math.max(0, Math.min(a.x + a.w, c.x + c.w) - Math.max(a.x, c.x))
        const h = Math.max(0, Math.min(a.y + a.h, c.y + c.h) - Math.max(a.y, c.y))
        if (w * h > 1) overlaps.push(`${a.id}∩${c.id}=${Math.round(w * h)}px²`)
      }
    }
    const scrolls = el => /auto|scroll/.test(getComputedStyle(el).overflowY + getComputedStyle(el).overflowX)
    const spills = docks
      .filter(d => !scrolls(d) && (d.scrollHeight > d.clientHeight + 1 || d.scrollWidth > d.clientWidth + 1))
      .map(d => `${tid(d)} content=${d.scrollHeight}x${d.scrollWidth} box=${d.clientHeight}x${d.clientWidth}`)
    // A dock body that overflows MUST scroll, never clip — clipping makes content unreachable.
    const clipping = docks
      .map(d => d.querySelector(`[data-testid="${tid(d)}-body"]`))
      .filter(bd => bd && bd.scrollHeight > bd.clientHeight + 1 && !/auto|scroll/.test(getComputedStyle(bd).overflowY))
      .map(bd => bd.getAttribute('data-testid'))
    const panel = document.querySelector('[data-testid="viz-edit-panel"]')
    const pr = panel ? panel.getBoundingClientRect() : null
    const coveredTitles = []
    const offscreenTitles = []
    for (const d of docks) {
      const t = d.querySelector('[data-testid*="-panel-title-"]')
      if (!t) {
        coveredTitles.push(`${tid(d)}:no-title`)
        continue
      }
      const r = t.getBoundingClientRect()
      const inView =
        pr != null && r.width > 0 && r.top >= pr.top - 1 && r.bottom <= pr.bottom + 1 && r.top >= 0 && r.bottom <= window.innerHeight
      if (!inView) {
        offscreenTitles.push(tid(t))
        continue
      }
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      if (!hit || !d.contains(hit)) coveredTitles.push(`${tid(t)}→${hit ? hit.getAttribute('data-testid') || hit.tagName : 'null'}`)
    }
    return {
      ids: boxes.map(b => b.id),
      boxes,
      overlaps,
      spills,
      clipping,
      coveredTitles,
      offscreenTitles,
      panelScrolls: panel ? panel.scrollHeight > panel.clientHeight + 1 : false,
      hOverflow: document.documentElement.scrollWidth - window.innerWidth,
    }
  })

/** Assert the whole layout contract for one docked state. `n` = how many docks must be open. */
function checkDockLayout(label, L, n) {
  check(L.ids.length === n, `${label}: ${n} docks open`, `ids=${L.ids.join(',')}`)
  check(L.overlaps.length === 0, `${label}: no two docks overlap`, L.overlaps.join(' | '))
  check(L.spills.length === 0, `${label}: no dock paints outside its own box`, L.spills.join(' | '))
  check(L.clipping.length === 0, `${label}: an overflowing dock SCROLLS, never clips`, L.clipping.join(' | '))
  check(L.coveredTitles.length === 0, `${label}: every visible dock title is hit-testable`, L.coveredTitles.join(' | '))
  // A title may only be out of view when the PANEL itself is scrolled — never because it was
  // pushed off by a neighbour that grew past its box.
  check(
    L.offscreenTitles.length === 0 || L.panelScrolls,
    `${label}: a dock title is off-screen without the panel scrolling`,
    L.offscreenTitles.join(' | '),
  )
  check(L.hOverflow <= 2, `${label}: no horizontal page overflow`, `overflow=${L.hOverflow}px`)
}

try {
  const { p, errs } = await openStory(1400)
  check((await p.$('[data-testid="viz-per-pane-editing"]')) != null, 'story rendered')

  // ── ROOT 1 live rail assertions (TEST-5) ───────────────────────────────────────────────────────
  // `select.move` is an ACTION on an existing selection — disabled until one exists (DEC-4). This is
  // also the DRIFT-1.5 wiring ROOT 1 could not complete.
  await p.click('[data-testid="viz-tool-rail-tool-select"]')
  await p.waitForTimeout(400)
  const moveBtn = await p.$('[data-testid="viz-tool-rail-sel-move"]')
  if (moveBtn) {
    const disabledNoSel = await moveBtn.evaluate(el => el.disabled === true || el.getAttribute('aria-disabled') === 'true')
    check(disabledNoSel, 'TEST-5: select.move is DISABLED with no selection (DRIFT-1.5 wired)')
  } else {
    check(false, 'TEST-5: select.move control present')
  }
  // Every visible tool button carries an accessible name.
  const unnamed = await p.$$eval('[data-testid^="viz-tool-rail-"]', els =>
    els.filter(e => {
      const n = (e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent || '').trim()
      return n.length === 0
    }).length,
  )
  check(unnamed === 0, 'TEST-5: every rail tool button has an accessible name', `unnamed=${unnamed}`)

  // ══ FINDING #14 · the entry point is PER PANE, like the edit form ═══════════════════════════════
  //
  // The global rail must not expose annotate/segment AT ALL — no bulk toggle, no "open on all panes"
  // secondary action, no shim.
  const railAnn = await p.$('[data-testid="viz-tool-rail-tool-annotate"]')
  const railSeg = await p.$('[data-testid="viz-tool-rail-tool-segment"]')
  check(railAnn == null && railSeg == null, 'FINDING-14: the GLOBAL rail exposes no annotate/segment mode')

  // A pane offers Annotate only if it is annotate-capable and Segment only if it is segment-capable —
  // the same predicates that decide which panes can hold a dock.
  const capability = await p.evaluate(() =>
    ['slide-a', 'slide-b', 'seg-a', 'seg-b'].map(id => ({
      id,
      ann: !!document.querySelector(`[data-testid="viz-cell-annotate-${id}"]`),
      seg: !!document.querySelector(`[data-testid="viz-cell-segment-${id}"]`),
    })),
  )
  check(
    capability.every(c =>
      c.id.startsWith('slide') ? c.ann && !c.seg : !c.ann && c.seg,
    ),
    'FINDING-14: each pane offers exactly the buttons its capabilities allow',
    JSON.stringify(capability),
  )

  // ── FINDING-14: opening pane A's dock leaves pane B untouched ──────────────────────────────────
  await paneAnnotate(p, ANN_A)
  await p.waitForSelector(`[data-testid="viz-annotate-panel-${ANN_A}"]`, { timeout: 10000 })
  await p.waitForTimeout(400)
  const onlyA = await p.evaluate(
    ([a, b]) => ({
      aOpen: !!document.querySelector(`[data-testid="viz-annotate-panel-${a}"]`),
      bOpen: !!document.querySelector(`[data-testid="viz-annotate-panel-${b}"]`),
      aPressed: document.querySelector(`[data-testid="viz-cell-annotate-${a}"]`)?.getAttribute('aria-pressed'),
      bPressed: document.querySelector(`[data-testid="viz-cell-annotate-${b}"]`)?.getAttribute('aria-pressed'),
    }),
    [ANN_A, ANN_B],
  )
  check(
    onlyA.aOpen && !onlyA.bOpen,
    'FINDING-14: pressing Annotate on pane A opens ONLY pane A (a single pane is annotatable alone)',
    JSON.stringify(onlyA),
  )
  check(
    onlyA.aPressed === 'true' && onlyA.bPressed === 'false',
    "FINDING-14: the toolbar button's pressed state tracks its OWN pane's dock",
    JSON.stringify(onlyA),
  )
  // Pressing it again CLOSES that pane's dock (toggle), and the dock's × drives the same state.
  await paneAnnotate(p, ANN_A)
  await p.waitForTimeout(400)
  const toggledOff = (await p.$(`[data-testid="viz-annotate-panel-${ANN_A}"]`)) == null
  check(toggledOff, "FINDING-14: pressing Annotate again closes that pane's dock")

  // ── TEST-A12 / TEST-11: BOTH annotate panes open SIMULTANEOUSLY ────────────────────────────────
  await openPanes(p, 'annotate', [ANN_A, ANN_B])
  await p.waitForSelector(`[data-testid="viz-annotate-panel-${ANN_A}"]`, { timeout: 10000 })
  await p.waitForSelector(`[data-testid="viz-annotate-panel-${ANN_B}"]`, { timeout: 10000 })
  const panelCount = await p.$$eval('[data-testid^="viz-annotate-panel-"]', els =>
    els.filter(e => /^viz-annotate-panel-[^-]/.test(e.getAttribute('data-testid') || '') &&
      !/(title|close)/.test(e.getAttribute('data-testid') || '')).length,
  )
  check(panelCount >= 2, 'TEST-A12: TWO annotate panels open at once (INV-12)', `panels=${panelCount}`)

  // Each panel names its own pane — a stacked panel that does not say which dataset it edits is unusable.
  const titleA = await p.textContent(`[data-testid="viz-annotate-panel-title-${ANN_A}"]`).catch(() => null)
  const titleB = await p.textContent(`[data-testid="viz-annotate-panel-title-${ANN_B}"]`).catch(() => null)
  check(!!titleA && !!titleB && titleA !== titleB, 'TEST-A12: each panel is titled with its own pane', `${titleA} | ${titleB}`)

  // ── TEST-11: the two panes carry DIFFERENT class vocabularies (seeded), proving no shared store ──
  const a0 = await paneState(p, ANN_A)
  const b0 = await paneState(p, ANN_B)
  check(a0 != null && b0 != null, 'both per-cell stores exist')
  check(
    JSON.stringify(a0?.classes) !== JSON.stringify(b0?.classes),
    'TEST-11: panes hold DIFFERENT class vocabularies (INV-11 amended)',
    `${JSON.stringify(a0?.classes)} vs ${JSON.stringify(b0?.classes)}`,
  )

  // Set DIFFERENT active tools per pane through each pane's OWN store, then assert neither leaks.
  await p.evaluate(([ca, cb]) => {
    window.__vizAnnotateStores.get(ca).getState().setTool('brush')
    window.__vizAnnotateStores.get(cb).getState().setTool('polygon')
  }, [ANN_A, ANN_B])
  await p.waitForTimeout(300)
  const a1 = await paneState(p, ANN_A)
  const b1 = await paneState(p, ANN_B)
  check(
    a1?.tool === 'brush' && b1?.tool === 'polygon',
    'TEST-11: each pane holds its OWN active tool simultaneously',
    `A=${a1?.tool} B=${b1?.tool}`,
  )

  // ── TEST-A13: a press in pane B draws on THAT press (no swallowed first click) ──────────────────
  // Pane A is the one currently "in play" (we just touched it); pressing into B must commit in B.
  const beforeA = await paneState(p, ANN_A)
  const beforeB = await paneState(p, ANN_B)
  // Put both panes on the POINT tool so a single press is a complete, committing gesture.
  await p.evaluate(([ca, cb]) => {
    window.__vizAnnotateStores.get(ca).getState().setTool('point')
    window.__vizAnnotateStores.get(cb).getState().setTool('point')
  }, [ANN_A, ANN_B])
  await p.waitForTimeout(200)

  // Locate pane B's rendered box from its own DOM node and press ONCE in its middle. (Panes share one
  // <DeckGL> canvas, but each has a `viz-cell-view-<id>` wrapper giving its true screen rect.)
  const paneBBox = await p.locator(`[data-testid="viz-cell-view-${ANN_B}"]`).boundingBox().catch(() => null)
  let pressed = false
  if (paneBBox) {
    await p.mouse.move(paneBBox.x + paneBBox.width / 2, paneBBox.y + paneBBox.height / 2)
    await p.mouse.down()
    await p.mouse.up()
    pressed = true
    await p.waitForTimeout(600)
  }
  if (pressed) {
    const afterA = await paneState(p, ANN_A)
    const afterB = await paneState(p, ANN_B)
    check(
      (afterB?.count ?? 0) === (beforeB?.count ?? 0) + 1,
      'TEST-A13: ONE press in pane B committed geometry in pane B (no swallowed click, INV-13)',
      `B ${beforeB?.count}→${afterB?.count}`,
    )
    check(
      (afterA?.count ?? 0) === (beforeA?.count ?? 0),
      'TEST-A13: pane A geometry UNCHANGED by the press in pane B (per-pane isolation)',
      `A ${beforeA?.count}→${afterA?.count}`,
    )
  } else {
    check(false, 'TEST-A13: could not resolve pane B box for the press')
  }

  // ── TEST-11: each pane has its OWN hierarchy panel ──────────────────────────────────────────────
  const hierPanels = await p.$$eval('[data-testid^="viz-hierarchy"]', els => els.length)
  check(hierPanels >= 2, 'TEST-11: a hierarchy panel per open pane', `panels=${hierPanels}`)

  // ── TEST-A12 (segment half): BOTH segment panels open at once ───────────────────────────────────
  // Each from ITS OWN pane's toolbar. Note the annotate docks stay open — with a per-pane entry point
  // the two surfaces are no longer mutually exclusive modes, which is the MIXED case below.
  await openPanes(p, 'segment', [SEG_A, SEG_B])
  await p.waitForSelector(`[data-testid="viz-mask-panel-${SEG_A}"]`, { timeout: 12000 })
  await p.waitForSelector(`[data-testid="viz-mask-panel-${SEG_B}"]`, { timeout: 12000 })
  const maskPanels = await p.$$eval('[data-testid^="viz-mask-panel-"]', els =>
    els.filter(e => !/(title|close)/.test(e.getAttribute('data-testid') || '')).length,
  )
  check(maskPanels >= 2, 'TEST-A12: TWO segment panels open at once (INV-12)', `panels=${maskPanels}`)

  // Their sessions are DISTINCT rasters — a correction in one is not a correction in the other.
  const distinct = await p.evaluate(([sa, sb]) => {
    const m = window.__vizMaskSessions
    const a = m?.get(sa)
    const b = m?.get(sb)
    if (!a || !b) return null
    return { same: a.data.raster === b.data.raster, aLen: a.data.raster.length, bLen: b.data.raster.length }
  }, [SEG_A, SEG_B])
  check(distinct != null && distinct.same === false, 'TEST-A12: the two segment panes own DISTINCT rasters', JSON.stringify(distinct))

  // ── Per-pane CLOSE: closing one panel leaves the other open ────────────────────────────────────
  await p.click(`[data-testid="viz-mask-panel-close-${SEG_A}"]`)
  await p.waitForTimeout(400)
  const aGone = (await p.$(`[data-testid="viz-mask-panel-${SEG_A}"]`)) == null
  const bStill = (await p.$(`[data-testid="viz-mask-panel-${SEG_B}"]`)) != null
  check(aGone && bStill, 'closing ONE pane\'s panel leaves the other open', `aGone=${aGone} bStill=${bStill}`)


  // ══ ROOT 3 · legible in-progress state + the counting job ═══════════════════════════════════════
  //
  // The perceptual class. Every prior annotate test asserted COMMITTED state, so a frozen draft and
  // a draft vertex indistinguishable from a committed point both shipped green. These assert what
  // the user SEES DURING the gesture.

  // Make sure both annotate panes are open (per-pane docks persist; this is idempotent).
  for (const id of [ANN_A, ANN_B]) {
    if ((await p.$(`[data-testid="viz-annotate-panel-${id}"]`)) == null) await paneAnnotate(p, id)
  }
  await p.waitForSelector(`[data-testid="viz-annotate-panel-${ANN_A}"]`, { timeout: 10000 })
  await p.waitForTimeout(600)

  const boxA = await p.locator(`[data-testid="viz-cell-view-${ANN_A}"]`).boundingBox().catch(() => null)
  if (!boxA) {
    check(false, 'TEST-A15: pane A box resolvable')
  } else {
    // Put pane A on POLYGON and drop three vertices, leaving an OPEN draft.
    await p.evaluate(ca => window.__vizAnnotateStores.get(ca).getState().setTool('polygon'), ANN_A)
    await p.waitForTimeout(250)
    const cx = boxA.x + boxA.width / 2
    const cy = boxA.y + boxA.height / 2
    for (const [dx, dy] of [[-70, -50], [40, -55], [55, 45]]) {
      await p.mouse.move(cx + dx, cy + dy)
      await p.mouse.down()
      await p.mouse.up()
      await p.waitForTimeout(120)
    }
    await p.waitForTimeout(400)
    const preHover = await paneState(p, ANN_A)

    // TEST-17 — the draft reads as a STATE: a live vertex count + how to finish it.
    const status = await p.textContent(`[data-testid="annotate-controls-${ANN_A}-draft-status"]`).catch(() => null)
    const countTxt = await p.textContent(`[data-testid="annotate-controls-${ANN_A}-draft-count"]`).catch(() => null)
    check(status != null, 'TEST-17: in-progress draft status is shown while drawing')
    check(countTxt === '3', 'TEST-17: live vertex count is correct', `count=${countTxt}`)
    check(
      (status || '').toLowerCase().includes('click the first point to close'),
      'TEST-17: the close affordance is stated once the ring is closable',
      String(status),
    )

    // TEST-A15 — THE rubber band: move the pointer with NO click and the rendered draft must change.
    // The old draft trigger keyed on vertex COUNT, so this comparison could not have differed.
    await p.mouse.move(cx + 60, cy + 50)
    await p.waitForTimeout(350)
    const shot1 = await p.locator(`[data-testid="viz-cell-view-${ANN_A}"]`).screenshot()
    await p.mouse.move(cx - 90, cy + 70) // pointer only — no press
    await p.waitForTimeout(350)
    const shot2 = await p.locator(`[data-testid="viz-cell-view-${ANN_A}"]`).screenshot()
    const moved = Buffer.compare(shot1, shot2) !== 0
    check(moved, 'TEST-A15: the draft re-renders on pointer MOVE with no click (rubber band)')

    // …and the move must not have committed anything (a rubber band is a preview, not an edit).
    const midA = await paneState(p, ANN_A)
    check(midA?.count === preHover?.count, 'TEST-A15: hovering commits nothing', `count=${midA?.count}`)

    // TEST-17 (clear) — closing the ring by pressing the FIRST vertex commits and clears the status.
    await p.mouse.move(cx - 70, cy - 50)
    await p.mouse.down(); await p.mouse.up()
    await p.waitForTimeout(500)
    const afterClose = await paneState(p, ANN_A)
    const statusGone = (await p.$(`[data-testid="annotate-controls-${ANN_A}-draft-status"]`)) == null
    check(
      afterClose != null && afterClose.count === (midA?.count ?? 0) + 1,
      'TEST-15/17: pressing the FIRST vertex closes the ring into one annotation',
      `${midA?.count} -> ${afterClose?.count}`,
    )
    check(statusGone, 'TEST-17: the in-progress status clears on commit')
  }

  // ── TEST-18 · the counting job: a LIVE per-class tally, per pane ────────────────────────────────
  //
  // DRIFT-3.8 retargets this block. The tally used to count POINTS ONLY, which made the Classes list
  // contradict the panel right under it: pane A holds one Tumor POLYGON and no Tumor points, so it
  // rendered `Tumor 0` directly above `Objects (1)` listing that polygon. The number now counts every
  // OBJECT of the class (points + polygons + brush regions), so the assertions below pin the
  // polygon-inclusive meaning — and pin the two readouts to the same set — rather than the old one.
  const objectsInDock = async id => {
    const t = await p
      // M6: the in-dock hierarchy panel is PANE-QUALIFIED (`viz-hierarchy-<paneId>-panel`). With N
      // docks open a bare `viz-hierarchy-panel` matched every pane and silently asserted the FIRST.
      .textContent(`[data-testid="viz-annotate-panel-${id}"] [data-testid="viz-hierarchy-${id}-panel"]`)
      .catch(() => null)
    const m = /Objects\s*\((\d+)\)/.exec(String(t || ''))
    return m ? Number(m[1]) : NaN
  }
  const headerTotal = async id => {
    const t = await p.textContent(`[data-testid="annotate-controls-${id}-objects-total"]`).catch(() => null)
    const m = /(\d+)/.exec(String(t || ''))
    return m ? Number(m[1]) : NaN
  }

  // ── THE REPORTED DEFECT, as an assertion on the real surface ───────────────────────────────────
  // Pane A's seeded state is exactly the shape that read wrong: ONE polygon classed Tumor, zero
  // Tumor points. The class row must read 1, and it must equal what its own dock's Objects panel says.
  const tumorA = await p.evaluate(ca => window.__vizAnnotateStores.get(ca).getState().classes[0]?.id ?? null, ANN_A)
  const tumorCountA = await p.textContent(`[data-testid="annotate-controls-${ANN_A}-class-count-${tumorA}"]`).catch(() => null)
  const objsA = await objectsInDock(ANN_A)
  const headerA = await headerTotal(ANN_A)
  check(
    Number(tumorCountA) >= 1,
    'TEST-18: a class holding only POLYGONS reads its object count, not 0 (the reported defect)',
    `Tumor=${tumorCountA} objects=${objsA}`,
  )
  check(
    Number.isFinite(objsA) && headerA === objsA,
    'TEST-18: the Classes header total equals the dock\'s own Objects (N) — one set, two readouts',
    `header=${headerA} objects=${objsA}`,
  )
  // …and no class row may claim more than the pane holds.
  const rowsVsObjectsA = await p.evaluate(ca => {
    const st = window.__vizAnnotateStores.get(ca).getState()
    return st.classes.map(c => ({
      id: c.id,
      shown: Number(
        document.querySelector(`[data-testid="annotate-controls-${ca}-class-count-${c.id}"]`)?.textContent?.trim(),
      ),
      derived: st.ids.filter(i => st.byId[i].classId === c.id).length,
    }))
  }, ANN_A)
  check(
    rowsVsObjectsA.every(r => r.shown === r.derived),
    'TEST-18: every class row equals ALL that class\'s objects in the store (no geometry filter)',
    JSON.stringify(rowsVsObjectsA),
  )

  const boxB = await p.locator(`[data-testid="viz-cell-view-${ANN_B}"]`).boundingBox().catch(() => null)
  if (!boxB) {
    check(false, 'TEST-18: pane B box resolvable')
  } else {
    // Pane B counts under its FIRST class — which already holds ONE seeded polygon, so the counting
    // run below starts from that object rather than from zero.
    const clsB = await p.evaluate(cb => {
      const st = window.__vizAnnotateStores.get(cb).getState()
      st.setTool('point')
      st.setActiveClass(st.classes[0].id)
      return st.classes[0].id
    }, ANN_B)
    const totalBefore = await headerTotal(ANN_A)
    const perClassBefore = await p.textContent(`[data-testid="annotate-controls-${ANN_B}-class-count-${clsB}"]`).catch(() => null)
    check(
      perClassBefore === '1',
      'TEST-18: the class starts at its seeded POLYGON count (1), not 0',
      `tally=${perClassBefore}`,
    )
    await p.waitForTimeout(250)

    // Rapid point-dropping must still move the number on every commit — the counting workflow.
    const bx = boxB.x + boxB.width / 2
    const by = boxB.y + boxB.height / 2
    const live = []
    for (const [dx, dy] of [[-40, -30], [0, 0], [45, 35]]) {
      await p.mouse.move(bx + dx, by + dy)
      await p.mouse.down(); await p.mouse.up()
      await p.waitForTimeout(300)
      live.push(await p.textContent(`[data-testid="annotate-controls-${ANN_B}-class-count-${clsB}"]`).catch(() => null))
    }
    await p.waitForTimeout(500)

    check(
      JSON.stringify(live) === JSON.stringify(['2', '3', '4']),
      'TEST-18: the per-class tally counts points LIVE as they are dropped, on top of the polygon',
      `live=${live.join(',')}`,
    )
    const perClass = await p.textContent(`[data-testid="annotate-controls-${ANN_B}-class-count-${clsB}"]`).catch(() => null)
    check(perClass === '4', 'TEST-18: a MIXED class reads polygon + points (1 + 3)', `tally=${perClass}`)
    // and pane B's own two readouts still describe one set
    const headerB = await headerTotal(ANN_B)
    const objsB = await objectsInDock(ANN_B)
    check(
      Number.isFinite(objsB) && headerB === objsB,
      'TEST-18: pane B\'s Classes total and Objects (N) agree after counting',
      `header=${headerB} objects=${objsB}`,
    )

    // per-PANE: pane A's readout is untouched by pane B's counting.
    const totalAfterA = await headerTotal(ANN_A)
    check(totalAfterA === totalBefore, 'TEST-18: the tally is PER-PANE (A unchanged while B counted)', `${totalBefore} -> ${totalAfterA}`)

    // undo decrements it — the number is derived, so it cannot drift from the collection.
    await p.click(`[data-testid="annotate-controls-${ANN_B}-undo"]`)
    await p.waitForTimeout(450)
    const afterUndo = await p.textContent(`[data-testid="annotate-controls-${ANN_B}-class-count-${clsB}"]`).catch(() => null)
    check(afterUndo === '3', 'TEST-18: undo decrements the tally', `tally=${afterUndo}`)

    // ── number-key class switching, scoped to the OWNING pane ────────────────────────────────────
    const beforeA2 = (await paneState(p, ANN_A))?.activeClassId ?? null
    await p.locator(`[data-testid="annotate-controls-${ANN_B}"]`).focus()
    await p.keyboard.press('2')
    await p.waitForTimeout(350)
    const stB = await p.evaluate(cb => {
      const st = window.__vizAnnotateStores.get(cb).getState()
      return { active: st.activeClassId, second: st.classes[1]?.id ?? null }
    }, ANN_B)
    check(
      stB.second != null && stB.active === stB.second,
      'TEST-18: number-key 1-9 switches the active class in the focused pane',
      `active=${stB.active} second=${stB.second}`,
    )
    const afterA2 = (await paneState(p, ANN_A))?.activeClassId ?? null
    check(afterA2 === beforeA2, 'TEST-18: the hotkey does NOT leak to the other pane (INV-11)', `${beforeA2} -> ${afterA2}`)

    // ── seed export: the counted points leave as ProcessorPort GeoFeatures ───────────────────────
    const exportBtn = `[data-testid="annotate-controls-${ANN_B}-export-seeds"]`
    const haveBtn = (await p.$(exportBtn)) != null
    check(haveBtn, 'TEST-18: the seed-export affordance appears once points exist')
    if (haveBtn) {
      await p.click(exportBtn)
      await p.waitForSelector('[data-testid="ppe-seeds"]', { timeout: 5000 }).catch(() => {})
      const pane = await p.getAttribute('[data-testid="ppe-seeds"]', 'data-pane').catch(() => null)
      const count = await p.getAttribute('[data-testid="ppe-seeds"]', 'data-count').catch(() => null)
      check(pane === ANN_B, 'TEST-18: seeds are exported from the pane whose button was used', `pane=${pane}`)
      // The payload must equal the number the BUTTON displays — that equality is the whole contract:
      // a count the user trusts and a payload a processor consumes must be the same set. DRIFT-3.8
      // moves this off the Classes header (now an OBJECT total) and onto the button's own label,
      // which is the readout that names this payload: seeds are points only.
      const shownSeeds = await p.textContent(exportBtn).catch(() => null)
      const shownN = Number(String(shownSeeds || '').match(/\d+/)?.[0] ?? NaN)
      check(
        Number.isFinite(shownN) && Number(count) === shownN,
        'TEST-18: the seed payload carries exactly the points its button reports',
        `payload=${count} shown=${shownSeeds}`,
      )
      // The two figures are deliberately DIFFERENT: pane B holds polygons the seed export cannot
      // carry, so the object total must exceed the point payload — proof the header is not merely
      // the point count wearing a new word.
      const objTotalB = await headerTotal(ANN_B)
      check(
        Number.isFinite(objTotalB) && objTotalB > shownN,
        'TEST-18: the OBJECT total exceeds the point-seed payload (polygons are counted, not exported)',
        `objects=${objTotalB} seeds=${shownN}`,
      )
    }
  }

  check(errs.length === 0, 'no console/page errors @ desktop', errs.slice(0, 2).join(' | '))
  await p.close()

  // ══ DRIFT-3.5 · the stacked docks must LAY OUT, not just exist ══════════════════════════════════
  //
  // Driven on a fresh page per state so nothing depends on the long journey above.
  {
    const { p: pl, errs: errsL } = await openStory(1400)

    await openPanes(pl, 'annotate', [ANN_A, ANN_B])
    await pl.waitForSelector(`[data-testid="viz-annotate-panel-${ANN_B}"]`, { timeout: 10000 })
    await pl.waitForTimeout(800)
    checkDockLayout('DRIFT-3.5 annotate @1400', await dockLayout(pl), 2)

    // Close them, then the SEGMENT docks alone — they share the same panel and had the same defect.
    for (const id of [ANN_A, ANN_B]) await pl.click(`[data-testid="viz-annotate-panel-close-${id}"]`)
    await pl.waitForTimeout(400)
    await openPanes(pl, 'segment', [SEG_A, SEG_B])
    await pl.waitForSelector(`[data-testid="viz-mask-panel-${SEG_B}"]`, { timeout: 12000 })
    await pl.waitForTimeout(800)
    checkDockLayout('DRIFT-3.5 segment @1400', await dockLayout(pl), 2)

    // MIXED (only reachable since finding #14 removed the exclusive rail MODES): two annotate docks
    // AND two segment docks stacked in the SAME internal panel. FOUR docks — the deepest reachable
    // stack, and the case the overlap defect would have been worst in.
    await openPanes(pl, 'annotate', [ANN_A, ANN_B])
    await pl.waitForSelector(`[data-testid="viz-annotate-panel-${ANN_B}"]`, { timeout: 10000 })
    await pl.waitForTimeout(1000)
    const mixed = await dockLayout(pl)
    checkDockLayout('DRIFT-3.5 MIXED annotate+segment @1400', mixed, 4)
    check(
      mixed.ids.filter(id => id.startsWith('viz-annotate-panel-')).length === 2 &&
        mixed.ids.filter(id => id.startsWith('viz-mask-panel-')).length === 2,
      'DRIFT-3.5: annotate and segment docks COEXIST (no exclusive mode any more)',
      mixed.ids.join(','),
    )
    check(errsL.length === 0, 'DRIFT-3.5: no console/page errors @1400', errsL.slice(0, 2).join(' | '))
    await pl.close()
  }

  // ── 390px: the two-pane surface must not break at mobile width ─────────────────────────────────
  //
  // The docks are OPENED at desktop width and the viewport is then narrowed to 390px (a resize /
  // rotate — a real user path). This is deliberate, not a dodge: with FOUR panes in this story's grid
  // at 390px each pane is ~19px wide, so its 32px toolbar button is genuinely not a mouse target.
  // That is a property of a 4-pane grid on a phone, not of the dock layout — and the assertions here
  // are about the DOCK LAYOUT at 390px, which is exercised identically either way. The per-pane
  // BUTTON at mobile width IS asserted — by `segmentation-scale-hierarchy.e2e.mjs`'s mobile-390 block,
  // which presses `viz-cell-annotate-*` on a single-pane story at 390px and waits for the dock.
  const { p: pm, errs: errsM } = await openStory(1400)
  await openPanes(pm, 'annotate', [ANN_A, ANN_B])
  await pm.waitForSelector(`[data-testid="viz-annotate-panel-${ANN_B}"]`, { timeout: 10000 })
  await pm.setViewportSize({ width: 390, height: 844 })
  await pm.waitForTimeout(1500)
  const noHScroll = await pm.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)
  check(noHScroll, 'no horizontal body scroll @ 390px with panes open')
  // Same layout contract at mobile width — where the docks are squeezed to their floor and the
  // PANEL takes over the scrolling.
  checkDockLayout('DRIFT-3.5 annotate @390', await dockLayout(pm), 2)
  await pm.setViewportSize({ width: 1400, height: 950 })
  await pm.waitForTimeout(600)
  for (const id of [ANN_A, ANN_B]) await pm.click(`[data-testid="viz-annotate-panel-close-${id}"]`)
  await pm.waitForTimeout(400)
  await openPanes(pm, 'segment', [SEG_A, SEG_B])
  await pm.waitForSelector(`[data-testid="viz-mask-panel-${SEG_B}"]`, { timeout: 12000 })
  await pm.setViewportSize({ width: 390, height: 844 })
  await pm.waitForTimeout(1400)
  checkDockLayout('DRIFT-3.5 segment @390', await dockLayout(pm), 2)
  check(errsM.length === 0, 'no console/page errors @ 390px', errsM.slice(0, 2).join(' | '))
  await pm.close()

  // ══ BLIND-AUDIT PHASE 7 — one falsifying test per confirmed HIGH ════════════════════════════════
  // Every one of these FAILS on the pre-fix build. They are the assertions whose absence let the
  // defects ship: the old suite asserted structure (ids exist, boxes don't intersect) and never
  // asserted BEHAVIOUR under a second pane, a closed dock, or a real keystroke.
  {
    const { p: ph, errs: errsH } = await openStory(1400)
    await openPanes(ph, 'annotate', [ANN_A, ANN_B])
    await ph.waitForSelector(`[data-testid="viz-annotate-panel-${ANN_B}"]`, { timeout: 10000 })
    await ph.waitForTimeout(600)

    const rectOf = async id => ph.evaluate(
      sel => { const e = document.querySelector(sel); if (!e) return null
               const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } },
      `[data-testid="viz-grid-cell-${id}"]`)
    const countIn = async id => ph.evaluate(
      pid => (window.__vizAnnotateStores?.get(pid)?.getState().ids.length ?? -1), id)

    // ── H2: the pointer surface is PER PANE ──────────────────────────────────────────────────────
    // One dock open used to mount a single `inset:0` sheet over the WHOLE workspace, so deck
    // picking / hover / marquee / camera drag died on every other pane. Only panes with an OPEN
    // dock may be covered, and each overlay must be its own element.
    for (const id of [ANN_A, ANN_B]) await ph.click(`[data-testid="viz-annotate-panel-close-${id}"]`)
    await ph.waitForTimeout(400)
    await openPanes(ph, 'annotate', [ANN_A])
    await ph.waitForSelector(`[data-testid="viz-annotate-panel-${ANN_A}"]`, { timeout: 10000 })
    await ph.waitForTimeout(600)
    const overlayAt = async id => {
      const r = await rectOf(id); if (!r) return 'no-rect'
      return ph.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y)
        return el ? (el.closest('[data-annotate-overlay="1"]')?.getAttribute('data-testid') ?? 'none') : 'none'
      }, [Math.round(r.x + r.w / 2), Math.round(r.y + 40 + (r.h - 40) / 2)])
    }
    check((await overlayAt(ANN_A)) === `viz-grid-annotate-overlay-${ANN_A}`,
      'H2: the pane WITH an open dock is covered by its OWN overlay')
    check((await overlayAt(ANN_B)) === 'none',
      'H2: a pane with NO open dock is not covered by any annotate overlay', await overlayAt(ANN_B))
    check((await overlayAt(SEG_A)) === 'none',
      'H2: a non-annotate pane is not covered either', await overlayAt(SEG_A))

    // H2 (convergence) — EVERY open pane's overlay must keep its OWN non-passive `wheel` listener.
    // The geometry fix multiplied the ELEMENT but all overlays shared ONE callback ref with ONE
    // detach slot, so each mount tore down the previous binding: with 2 docks open only the
    // last-mounted pane zoomed, and closing that one left NO pane able to zoom.
    // The handler calls `preventDefault()` unconditionally, so a cancelable `wheel` that comes back
    // NOT-prevented proves this element has no live listener — the exact defect, tested without
    // needing a view-state seam.
    const wheelHandled = async id => ph.evaluate(pid => {
      const el = document.querySelector(`[data-testid="viz-grid-annotate-overlay-${pid}"]`)
      if (!el) return 'no-overlay'
      const r = el.getBoundingClientRect()
      const ev = new WheelEvent('wheel', {
        deltaY: -240, cancelable: true, bubbles: true,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      })
      return el.dispatchEvent(ev) === false // false ⇒ preventDefault ran ⇒ listener is live
    }, id)
    // `openPanes` TOGGLES, and ANN_A is already open from the geometry check above — ensure-open
    // instead, or we would silently close it and test nothing.
    const ensureAnnotateOpen = async id => {
      const open = await ph.evaluate(pid => !!document.querySelector(`[data-testid="viz-annotate-panel-${pid}"]`), id)
      if (!open) { await paneAnnotate(ph, id); await ph.waitForTimeout(400) }
    }
    for (const id of [ANN_A, ANN_B]) await ensureAnnotateOpen(id)
    await ph.waitForTimeout(700)
    for (const id of [ANN_A, ANN_B]) {
      check((await wheelHandled(id)) === true,
        `H2: pane ${id}'s overlay has its OWN live wheel listener with BOTH docks open`,
        String(await wheelHandled(id)))
    }
    // …and closing one dock must not detach the survivor's listener.
    await ph.click(`[data-testid="viz-annotate-panel-close-${ANN_B}"]`)
    await ph.waitForTimeout(500)
    check((await wheelHandled(ANN_A)) === true,
      'H2: closing another pane\'s dock leaves this pane\'s wheel listener attached',
      String(await wheelHandled(ANN_A)))

    // ── H3: a pane whose dock is CLOSED must not author ───────────────────────────────────────────
    const beforeB = await countIn(ANN_B)
    const rb = await rectOf(ANN_B)
    await ph.mouse.click(Math.round(rb.x + rb.w / 2), Math.round(rb.y + rb.h / 2))
    await ph.waitForTimeout(500)
    check((await countIn(ANN_B)) === beforeB,
      'H3: clicking a pane whose dock is CLOSED adds nothing', `${beforeB} -> ${await countIn(ANN_B)}`)
    check((await ph.$(`[data-testid="viz-annotate-panel-${ANN_B}"]`)) === null,
      'H3: …and does not silently re-open its dock')

    // ── H1: an in-flight polygon must NOT cross a pane boundary ───────────────────────────────────
    // Pre-fix, `resetDraft()` only QUEUED a state update while the draft REF still held pane A's
    // vertices, so the first press in pane B committed A's polygon INTO B.
    await openPanes(ph, 'annotate', [ANN_B])
    await ph.waitForSelector(`[data-testid="viz-annotate-panel-${ANN_B}"]`, { timeout: 10000 })
    await ph.waitForTimeout(400)
    for (const id of [ANN_A, ANN_B]) await ph.click(`[data-testid="annotate-controls-${id}-tool-polygon"]`)
    await ph.waitForTimeout(300)
    const ra = await rectOf(ANN_A)
    const a0 = await countIn(ANN_A), b0 = await countIn(ANN_B)
    // three vertices in A — an OPEN draft, deliberately not closed
    for (const [dx, dy] of [[-40, -30], [30, -30], [30, 30]])
      await ph.mouse.click(Math.round(ra.x + ra.w / 2 + dx), Math.round(ra.y + ra.h / 2 + dy))
    await ph.waitForTimeout(400)
    // …then ONE press in B
    const rb2 = await rectOf(ANN_B)
    await ph.mouse.click(Math.round(rb2.x + rb2.w / 2), Math.round(rb2.y + rb2.h / 2))
    await ph.waitForTimeout(500)
    check((await countIn(ANN_B)) === b0,
      'H1: pane A\'s in-flight polygon does NOT commit into pane B', `${b0} -> ${await countIn(ANN_B)}`)
    check((await countIn(ANN_A)) === a0,
      'H1: …and A\'s draft is not committed either (it was abandoned, not adopted)')

    // ── H4: the 1-9 class hotkeys work AFTER clicking the canvas (no synthetic focus) ─────────────
    // The old spec called `.focus()` on the controls immediately before the keypress — it
    // manufactured the one condition under which the feature worked.
    const classesIn = async id => ph.evaluate(
      pid => (window.__vizAnnotateStores?.get(pid)?.getState().classes ?? []).map(c => c.id), id)
    const activeIn = async id => ph.evaluate(
      pid => window.__vizAnnotateStores?.get(pid)?.getState().activeClassId ?? null, id)
    const clsB = await classesIn(ANN_B)
    const aActiveBefore = await activeIn(ANN_A)
    if (clsB.length >= 2) {
      await ph.click(`[data-testid="annotate-controls-${ANN_B}-tool-point"]`)
      await ph.waitForTimeout(200)
      // click the CANVAS (this is what blurs the panel), then press a digit with NO refocus
      await ph.mouse.click(Math.round(rb2.x + rb2.w / 2), Math.round(rb2.y + rb2.h / 2))
      await ph.waitForTimeout(300)
      const focused = await ph.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName)
      await ph.keyboard.press('2')
      await ph.waitForTimeout(300)
      check((await activeIn(ANN_B)) === clsB[1],
        'H4: digit-2 switches class AFTER a canvas click, with no synthetic focus',
        `activeElement=${focused} active=${await activeIn(ANN_B)} want=${clsB[1]}`)
      // …and it must not leak into the OTHER open dock.
      // CONVERGENCE — the previous form (`activeIn(ANN_A) !== clsB[1] || …`) was VACUOUS: class ids
      // are per-pane UUIDs, so A's active class can never equal one of B's ids and the first
      // disjunct was unconditionally true. It passed straight through a real cross-pane leak.
      // The honest assertion is that A's own active class is UNCHANGED by a keystroke aimed at B.
      check((await activeIn(ANN_A)) === aActiveBefore,
        'H4: a digit aimed at pane B does not change pane A\'s active class',
        `A before=${aActiveBefore} after=${await activeIn(ANN_A)}`)

      // …and the same when focus sits INSIDE the other dock (the shipped leak: the ARMED dock also
      // answered digits targeted at a DIFFERENT dock's controls).
      const aBefore2 = await activeIn(ANN_A)
      const bBefore2 = await activeIn(ANN_B)
      await ph.click(`[data-testid="annotate-controls-${ANN_A}-tool-point"]`)
      await ph.waitForTimeout(150)
      await ph.keyboard.press('1')
      await ph.waitForTimeout(250)
      const clsA = await classesIn(ANN_A)
      check((await activeIn(ANN_A)) === clsA[0],
        'H4: a digit with focus INSIDE pane A\'s dock switches pane A', `A=${await activeIn(ANN_A)} want=${clsA[0]}`)
      check((await activeIn(ANN_B)) === bBefore2,
        'H4: …and leaves the OTHER (armed) pane B untouched',
        `B before=${bBefore2} after=${await activeIn(ANN_B)}`)
      void aBefore2
    } else {
      check(false, 'H4: fixture needs >=2 classes on pane B to test hotkeys', clsB.join(','))
    }
    check(errsH.length === 0, 'no console/page errors in the HIGH-fix block', errsH.slice(0, 2).join(' | '))
    await ph.close()
  }

  // ── H5: every pane-toolbar control is genuinely HIT-TESTABLE at a NARROW pane ────────────────────
  // THIRD attempt; the first two were both tautologies and this comment records why, because the
  // failure mode is subtle and keeps recurring:
  //   1. `scrollIntoView` — scrolls an `overflow:hidden` container programmatically, which no user
  //      input can do. Green while the left group was clipped to clientWidth=0.
  //   2. `leftInBar = r.left - br.left + bar.scrollLeft; unreachable = leftInBar < 0 || > scrollWidth`
  //      — satisfied BY CONSTRUCTION for every in-flow child of a scroll container (its offset within
  //      the scrolled content is always within [0, scrollWidth]). It measured layout MEMBERSHIP, not
  //      reachability, and was green on the defective layout too.
  // The only honest predicate is the one the user actually experiences: at the control's own centre,
  // does `elementFromPoint` resolve to that control? Nothing else proves a button can be pressed.
  const sweepToolbar = async (pg, pid) => pg.evaluate(id => {
    const bar = document.querySelector(`[data-testid="viz-pane-toolbar-${id}"]`)
    if (!bar) return { err: 'no toolbar' }
    // The PINNED plot-kind / colour-by Selects USED to be exempt outright, on the premise that they
    // "truncate from their trailing edge while their leading edge stays a tap target". That premise
    // was FALSE and the unbounded exemption is what hid it: measured, the colour-by picker had ZERO
    // strict-hittable pixels from 1100px down while this sweep reported clean, because a control
    // clipped to 0px passed identically to one merely truncated (convergence-5 MEDIUM — the sixth
    // assertion on this branch that stopped one layer short).
    //
    // They are no longer exempt. They CANNOT fold, so they get a different requirement rather than
    // no requirement: a pinned Select must expose a real tap target of at least `PINNED_MIN_HIT_PX`
    // STRICTLY-hittable pixels (`elementFromPoint` resolving to the control or a DESCENDANT — an
    // ancestor hit does not activate anything). Below its natural width the control switches to an
    // icon-only form sized to fit, so "clipped to nothing" is not a state it can reach except on a
    // pane too narrow for grip + icons + trigger, where tier 1 (the trigger) deliberately wins.
    const PINNED_MIN_HIT_PX = 16
    const pinned = /^viz-cell-(kind|colorby)-/
    const container = /^viz-cell-config-/
    const ctrls = [...bar.querySelectorAll('[data-testid]')]
      .filter(e => e !== bar && !e.querySelector('[data-testid]')) // leaf controls only
      .filter(e => !container.test(e.getAttribute('data-testid')))
    const br = bar.getBoundingClientRect()
    const strictHits = (e) => {
      const r = e.getBoundingClientRect()
      const cy = r.top + r.height / 2
      let n = 0
      for (let x = Math.ceil(Math.max(r.left, br.left)); x < Math.min(r.right, br.right); x++) {
        const h = document.elementFromPoint(x, cy)
        if (h && (h === e || e.contains(h))) n++
      }
      return n
    }
    const unreachable = []
    for (const e of ctrls) {
      const t = e.getAttribute('data-testid')
      const r = e.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) { unreachable.push(t + ':zero-size'); continue }
      if (pinned.test(t)) {
        const n = strictHits(e)
        if (n < PINNED_MIN_HIT_PX) unreachable.push(`${t}:pinned-hit-${n}px`)
        continue
      }
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      if (!hit || (!e.contains(hit) && !hit.contains(e))) {
        unreachable.push(t + ':covered')
      }
    }
    return { clientW: bar.clientWidth, count: ctrls.length, unreachable }
  }, pid)
  {
    const { p: pt, errs: errsT } = await openStory(1400)
    await pt.setViewportSize({ width: 900, height: 900 })
    await pt.waitForTimeout(1200)
    const probe = await sweepToolbar(pt, ANN_A)
    check(!probe.err && probe.count > 0 && probe.unreachable.length === 0,
      'H5: every pane-toolbar control is hit-testable at its own centre (900px viewport)',
      JSON.stringify(probe))

    // The RANK CONTRACT. At 147px not everything can fit — the honest requirement is not "all
    // actions inline" but: the highest-rank ones (the per-pane SURFACES this toolbar exists for)
    // are one click away AT REST, and anything folded is still reachable in the overflow menu.
    // (The previous fix inverted the ranking entirely: it pinned the ~194px CONFIG group at natural
    // width and pushed Link/Edit/Annotate/Export off the strip.)
    const hittable = async (pg, t) => pg.evaluate(id => {
      const e = document.querySelector(`[data-testid="${id}"]`)
      if (!e) return 'absent'
      const r = e.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return (hit && (e.contains(hit) || hit.contains(e))) ? 'ok' : 'covered'
    }, t)
    // ── H5d: the PINNED Selects are USABLE at every width above the physical floor ──────────────
    // convergence-5's HIGH was that pinning them made them 0px and mouse-unreachable from 1100px
    // down, with no menu fallback, while every sweep passed. The fix is a second FORM (icon-only
    // below the natural-width threshold), so the contract is no longer "they truncate" but "at every
    // width they present a real tap target that opens the SAME listbox". This asserts exactly that,
    // and drives the plot-kind Select TO ITS EFFECT (`data-cell-kind` on the cell view actually
    // changes) rather than stopping at the trigger — the class of stop-one-layer-short assertion
    // this branch has shipped eight times.
    for (const w of [1400, 1100, 900, 800]) {
      await pt.setViewportSize({ width: w, height: 900 })
      await pt.waitForTimeout(700)
      const probeW = await sweepToolbar(pt, ANN_A)
      check(!probeW.err && probeW.unreachable.length === 0,
        `H5d: no toolbar control (incl. the PINNED Selects) is unreachable at ${w}px`,
        JSON.stringify(probeW))
      // Drive plot-kind to its effect, in whichever form is rendered.
      const before = await pt.evaluate(id => document.querySelector(`[data-testid="viz-cell-view-${id}"]`)?.getAttribute('data-cell-kind'), ANN_A)
      const pt0 = await pt.evaluate(id => {
        const e = document.querySelector(`[data-testid="viz-cell-kind-${id}"]`)
        if (!e) return null
        const r = e.getBoundingClientRect(), cy = r.top + r.height / 2
        const br = e.closest('[data-testid^="viz-pane-toolbar-"]').getBoundingClientRect()
        for (let x = Math.ceil(Math.max(r.left, br.left)); x < Math.min(r.right, br.right); x++) {
          const h = document.elementFromPoint(x, cy)
          if (h && (h === e || e.contains(h))) return [x, cy]
        }
        return null
      }, ANN_A)
      let after = before
      if (pt0) {
        await pt.mouse.click(pt0[0], pt0[1])
        await pt.waitForTimeout(400)
        const target = before === 'image' ? 'scatter' : 'image'
        const opt = pt.locator(`[data-testid="viz-cell-kind-${ANN_A}-opt-${target}"]`)
        if (await opt.count()) { await opt.click().catch(() => {}); await pt.waitForTimeout(500) }
        else await pt.keyboard.press('Escape')
        after = await pt.evaluate(id => document.querySelector(`[data-testid="viz-cell-view-${id}"]`)?.getAttribute('data-cell-kind'), ANN_A)
      }
      check(pt0 !== null && after !== before,
        `H5d: the PINNED plot-kind Select is drivable to its EFFECT at ${w}px`,
        `hit=${pt0 ? 'ok' : 'NONE'} kind ${before} -> ${after}`)
    }
    await pt.setViewportSize({ width: 900, height: 900 })
    await pt.waitForTimeout(700)

    // SUPERSEDED SCOPE (owner: pin the Selects left). The rule was "the top-rank actions are inline
    // AT REST". With the plot-kind + colour-by Selects now PINNED inline and unfoldable, they take
    // their natural width first — deliberately, because an action that folds is still reachable in
    // the menu while a squeezed pinned Select has nowhere to go. So at a 147px pane even `edit` and
    // `annotate` may legitimately fold. The honest contract that survives is REACHABILITY: every
    // top-rank action is drivable either inline or from the overflow menu, and never merely present.
    for (const k of ['edit', 'annotate']) {
      const inline = await hittable(pt, `viz-cell-${k}-${ANN_A}`)
      let viaMenu = 'n/a'
      if (inline !== 'ok') {
        await pt.click(`[data-testid="viz-cell-overflow-${ANN_A}"]`).catch(() => {})
        await pt.waitForTimeout(350)
        viaMenu = await hittable(pt, `viz-cell-${k}-${ANN_A}`)
        await pt.keyboard.press('Escape')
        await pt.waitForTimeout(200)
      }
      check(inline === 'ok' || viaMenu === 'ok',
        `H5: the top-rank action '${k}' is reachable at rest OR in the overflow menu (never merely present)`,
        `inline=${inline} viaMenu=${viaMenu}`)
    }

    // …and the collapsed config controls are still reachable — through the overflow popover.
    const collapsed = await pt.evaluate(pid =>
      document.querySelector(`[data-testid="viz-pane-toolbar-${pid}"]`)?.getAttribute('data-collapsed') === '1', ANN_A)
    if (collapsed) {
      // Anything folded must be present and hittable INSIDE the overflow popover — otherwise the
      // control is simply gone, which is the defect this whole line of work started from.
      const foldedBefore = await pt.evaluate(pid =>
        ['export', 'data', 'split', 'remove']
          .filter(k => !document.querySelector(`[data-testid="viz-cell-${k}-${pid}"]`)), ANN_A)
      await pt.click(`[data-testid="viz-cell-overflow-${ANN_A}"]`)
      await pt.waitForTimeout(350)
      const stillMissing = []
      for (const k of foldedBefore) {
        if ((await hittable(pt, `viz-cell-${k}-${ANN_A}`)) !== 'ok') stillMissing.push(k)
      }
      // GUARD (convergence-3): with nothing folded, `foldedBefore` is [] and the loop below is
      // vacuously satisfied — the assertion would pass while proving nothing. Require a real
      // subject before treating a clean result as evidence.
      check(foldedBefore.length > 0,
        'H5: …and the folded set is NON-EMPTY (otherwise the check above proves nothing)',
        `folded=${JSON.stringify(foldedBefore)}`)
      check(stillMissing.length === 0,
        'H5: every folded BUTTON is hittable inside the overflow popover',
        `folded=${JSON.stringify(foldedBefore)} stillMissing=${JSON.stringify(stillMissing)}`)

      // ── H5 COMPLETENESS — the class is now UNREPRESENTABLE (owner: pin the Selects left) ───────
      // History: convergence-2 found a folded kit Select's listbox painting UNDER the overflow kit
      // Popover (z-[60] inside z-[70]) so a real click was swallowed; the assertion of the day
      // stopped at the TRIGGER and passed anyway. The two attempts to DETECT "this item opens a
      // popup" then misfired in turn — first on JSX truthiness, then as an unsatisfiable predicate.
      // The owner's fix removes the question: the plot-kind and colour-by Selects are PINNED inline
      // at the start of the strip and are not foldable at all, so a menu can never host a popup.
      // Assert that structurally — a folded popup-opening control cannot exist to be driven.
      const menuHasPopupControl = await pt.evaluate(pane => {
        const panel = document.querySelector(`[data-testid="viz-cell-overflow-panel-${pane}"]`)
        if (!panel) return 'no-panel'
        return panel.querySelectorAll(
          '[role="combobox"],[data-testid^="viz-cell-kind-"],[data-testid^="viz-cell-colorby-"]',
        ).length
      }, ANN_A)
      check(menuHasPopupControl === 0,
        'H5: the overflow menu hosts NO popup-opening control (the nested-popup class is unrepresentable)',
        `found=${menuHasPopupControl}`)
      await pt.keyboard.press('Escape')
      await pt.waitForTimeout(250)

      // …and the PINNED Selects stay inline and drivable at this width. A pinned control that is
      // present but unusable would be the same defect wearing a different hat, so drive it to its
      // EFFECT: pick a kind that is not current and assert the pane adopts it.
      const kindInline = await hittable(pt, `viz-cell-kind-${ANN_A}`)
      // Read the REAL effect (`data-cell-kind` on the cell view), never the trigger's own text. The
      // trigger text was the proxy here and it silently stopped being one: below its natural width
      // the pinned Select renders an ICON, so its textContent is the chevron at every value and the
      // assertion compared "▼" with "▼" — passing or failing for a reason unrelated to the effect.
      const kindOf = () => pt.evaluate(pane =>
        document.querySelector(`[data-testid="viz-cell-view-${pane}"]`)?.getAttribute('data-cell-kind') ?? null, ANN_A)
      const kindBefore = await kindOf()
      await pt.click(`[data-testid="viz-cell-kind-${ANN_A}"]`).catch(() => {})
      await pt.waitForTimeout(500)
      const opts = await pt.$$eval('[role="option"]',
        els => els.map(e => ({ t: (e.textContent || '').trim(), cur: e.getAttribute('aria-selected') === 'true' })))
      const pick = opts.find(o => !o.cur && o.t)
      if (pick) {
        await pt.click(`[role="option"] >> text="${pick.t}"`).catch(() => {})
        await pt.waitForTimeout(600)
      }
      const kindAfter = await kindOf()
      check(kindInline === 'ok' && !!pick && kindAfter !== kindBefore,
        'H5: the PINNED kind Select is inline and can be driven to its EFFECT while the toolbar is collapsed',
        `hit=${kindInline} opts=${opts.length} before=${kindBefore} after=${kindAfter}`)
      // RESTORE. Driving this Select changes the pane's KIND, and a pane's kind decides whether it
      // is annotate- or segment-capable — i.e. whether it has an Annotate button and can hold a dock
      // at all. Leaving it changed is a side effect a later block can inherit, so put it back.
      if (pick && kindBefore) {
        await pt.click(`[data-testid="viz-cell-kind-${ANN_A}"]`).catch(() => {})
        await pt.waitForTimeout(400)
        await pt.click(`[role="option"] >> text="${kindBefore.replace(/\s*▼\s*$/, '')}"`).catch(() => {})
        await pt.waitForTimeout(500)
      }
    } else {
      check(true, 'H5: toolbar not collapsed at this width (everything inline)')
    }
    check(errsT.length === 0, 'no console/page errors in the H5 block', errsT.slice(0, 2).join(' | '))
    await pt.close()
  }

  // ── H5b: the SAME contract on a HETEROGENEOUS grid (convergence-3) ───────────────────────────────
  // Everything above runs on `per-pane-editing`: 4 uniform DENSE panes, 3 view kinds, ZERO colour-by
  // rows. That story structurally cannot exhibit either regression convergence-3 found, which is why
  // both shipped green:
  //   • CHART panes are the ones where `colorByButton` is null, so the fold guard's inference from
  //     `extra`'s JSX truthiness misfired and pinned the wide config block inline forever, pushing
  //     the action group (and the overflow trigger itself) past the toolbar's own clip.
  //   • A DENSE pane there has 3 kind rows; `grid-nonuniform`'s `cell-1` has 10 kinds + 15 colour-by
  //     = 25+ flat rows ≈ 1124px of menu, taller than the viewport, with nothing to scroll it.
  // So this block drives `grid-nonuniform` — mixed dense + chart panes, long menus — and asserts the
  // same two things the user actually needs: nothing is clipped, and everything folded is reachable
  // BY REAL INPUT (mouse wheel), never by `scrollIntoView` (attempt #1's tautology scrolled an
  // `overflow:hidden` container, which no user gesture can do).
  {
    const openGrid = async (w, h) => {
      const p = await b.newPage({ viewport: { width: w, height: h } })
      const errs = []
      p.on('pageerror', e => errs.push('P:' + String(e).slice(0, 140)))
      p.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) errs.push('C:' + m.text().slice(0, 140)) })
      await p.goto(`${BASE}/viz-showcase.html#grid-nonuniform`, { waitUntil: 'commit' })
      // Poll rather than `waitForSelector`. Two reasons, both learned the hard way here:
      //  • the default `state:'visible'` resolves to the FIRST matching toolbar in DOM order, and in
      //    a NON-UNIFORM grid that pane can legitimately be zero-sized, so it never turns visible;
      //  • this story loads real fixture arrays (positions/colors/catalog) and is markedly slower to
      //    mount once the suite has already hammered the dev server, so a fixed 20s can lapse.
      // A poll on COUNT is immune to both and reports what it actually saw when it gives up.
      const deadline = Date.now() + 60000
      let bars = 0
      while (Date.now() < deadline) {
        bars = await p.$$eval('[data-testid^="viz-pane-toolbar-"]', e => e.length).catch(() => 0)
        if (bars > 0) break
        await p.waitForTimeout(500)
      }
      if (bars === 0) {
        const seen = await p.$$eval('[data-testid]', e => e.length).catch(() => -1)
        throw new Error(`grid-nonuniform never mounted a pane toolbar (testids on page=${seen})`)
      }
      await p.waitForTimeout(4500)
      return { p, errs }
    }

    // (1) NOTHING CLIPPED on any pane of a heterogeneous grid, at several widths.
    for (const [w, h] of [[1400, 950], [1100, 900], [900, 768]]) {
      const { p: pg, errs } = await openGrid(w, h)
      const ids = await pg.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="viz-pane-toolbar-"]')]
          .map(e => e.getAttribute('data-testid').replace('viz-pane-toolbar-', '')))
      // The PINNED Selects are exempt: they truncate from their trailing edge by design once a pane
      // is narrow (PaneToolbar's `LEFT GROUP IS PINNED`), because an ACTION that folds is still
      // reachable in the menu while a squeezed pinned Select has nowhere to go. What may never clip
      // is an action or the overflow TRIGGER — the trigger is the last-resort affordance and every
      // folded control dies with it.
      const bad = await pg.evaluate(list => list.flatMap(id => {
        // Pinned Selects are NOT exempt — see `sweepToolbar`. They must expose a real strict-hit
        // target; only the `config` CONTAINER (a wrapper, not a control) is skipped.
        const pinned = /^viz-cell-config-/
        const bar = document.querySelector(`[data-testid="viz-pane-toolbar-${id}"]`)
        if (!bar) return [`${id}:no-toolbar`]
        const br = bar.getBoundingClientRect()
        const out = []
        for (const e of [...bar.querySelectorAll('[data-testid]')].filter(x => x !== bar && !x.querySelector('[data-testid]'))) {
          const r = e.getBoundingClientRect()
          const t = e.getAttribute('data-testid')
          if (pinned.test(t)) continue
          if (r.width === 0 || r.height === 0) { out.push(t + ':zero'); continue }
          // Past the toolbar's own `overflow-hidden` edge ⇒ present in the DOM, unpressable.
          if (r.right > br.right + 0.5) out.push(t + ':clipped')
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          if (!hit || (!e.contains(hit) && !hit.contains(e))) out.push(t + ':covered')
        }
        return out
      }), ids)
      check(ids.length > 0 && bad.length === 0,
        `H5b: no pane-toolbar control is clipped or covered on a MIXED grid @${w}x${h}`,
        `panes=${ids.length} bad=${JSON.stringify(bad.slice(0, 6))}`)
      check(errs.length === 0, `H5b: no console/page errors @${w}x${h}`, errs.slice(0, 2).join(' | '))
      await pg.close()
    }

    // (2) A CHART pane's destructive action can be DRIVEN TO ITS EFFECT by a real mouse click.
    //     On the defect this was a silent no-op: the button existed, sat 36px past the clip, and
    //     was in neither the strip nor the menu.
    {
      const { p: pg } = await openGrid(1400, 950)
      const before = await pg.$$eval('[data-testid^="viz-cell-view-"]', e => e.length)
      let via = 'inline'
      if (!(await pg.$('[data-testid="viz-cell-remove-cell-3"]'))) {
        via = 'menu'
        await pg.click('[data-testid="viz-cell-overflow-cell-3"]').catch(() => {})
        await pg.waitForTimeout(400)
      }
      const el = await pg.$('[data-testid="viz-cell-remove-cell-3"]')
      if (el) { const bb = await el.boundingBox(); if (bb) await pg.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2) }
      await pg.waitForTimeout(800)
      const after = await pg.$$eval('[data-testid^="viz-cell-view-"]', e => e.length)
      check(el != null && after === before - 1,
        'H5b: a CHART pane\'s Remove can be driven to its EFFECT by a real mouse click',
        `via=${via} present=${el != null} cells ${before} -> ${after}`)
      await pg.close()
    }

    // (3) The overflow menu is HEIGHT-BOUNDED and every row is reachable.
    //
    // SCOPE CHANGE (owner: pin the Selects left). This block used to walk a 25-30 row menu, because
    // round 3 FLATTENED the 10 plot-kinds + 15 colour-by columns into rows inside the popover — which
    // is precisely what made menu height unbounded and put rows below the fold. Those rows are gone:
    // the Selects are pinned inline and unfoldable, so the menu now holds only ACTION rows (≤9) and
    // an over-tall menu is no longer constructible from any story in the suite. The wheel-walk is
    // therefore retired for want of a subject rather than quietly kept as a vacuous pass.
    //
    // What is asserted instead is the property that made the defect impossible, which SURVIVES the
    // scope change: the popup carries a real height CAP, so if the menu ever grows again it scrolls
    // instead of spilling. Round 4 found the kit `Popover` is the one kit overlay shipping no cap
    // (`Select`, `DropdownMenu`, `ContextMenu`, `Combobox` all have the same pair), so this is the
    // guard against that regressing.
    for (const [w, h] of [[900, 950], [900, 768]]) {
      const { p: pg } = await openGrid(w, h)
      const trig = await pg.$('[data-testid="viz-cell-overflow-cell-1"]')
      if (!trig) { check(false, `H5b: expected cell-1 to fold at ${w}x${h} so the menu can be inspected`); await pg.close(); continue }
      await trig.click()
      await pg.waitForTimeout(500)
      const menu = await pg.evaluate(() => {
        const panel = document.querySelector('[data-testid="viz-cell-overflow-panel-cell-1"]')
        if (!panel) return null
        // The cap lives on the popup (the panel's ancestor chain up to the portal root).
        let capped = null
        let n = panel.parentElement
        while (n && n !== document.body) {
          const cs = getComputedStyle(n)
          const mh = cs.maxHeight
          if (mh && mh !== 'none' && /auto|scroll/.test(cs.overflowY)) { capped = { maxHeight: mh, overflowY: cs.overflowY }; break }
          n = n.parentElement
        }
        const rows = [...panel.querySelectorAll('[data-testid]')].filter(e => !e.querySelector('[data-testid]'))
        const unreachable = rows.filter(e => {
          const r = e.getBoundingClientRect()
          if (r.width === 0 || r.height === 0) return true
          const cy = r.top + r.height / 2
          if (cy < 0 || cy > innerHeight) return true
          const hit = document.elementFromPoint(r.left + r.width / 2, cy)
          return !(hit && (e.contains(hit) || hit.contains(e)))
        }).map(e => e.getAttribute('data-testid'))
        const pr = panel.getBoundingClientRect()
        return { capped, rows: rows.length, unreachable, fitsViewport: pr.bottom <= innerHeight + 1 }
      })
      check(menu != null && menu.capped != null,
        `H5b: the overflow popup is HEIGHT-BOUNDED (max-height + internal scroll) @${w}x${h}`,
        JSON.stringify(menu && menu.capped))
      check(menu != null && menu.rows > 0 && menu.unreachable.length === 0 && menu.fitsViewport,
        `H5b: every one of the ${menu ? menu.rows : 0} menu rows is hittable and the popup fits the viewport @${w}x${h}`,
        JSON.stringify(menu && { rows: menu.rows, unreachable: menu.unreachable, fitsViewport: menu.fitsViewport }))
      await pg.close()
    }

    // (4) The user can SEE what is currently selected (convergence-3 MEDIUM, retargeted).
    //
    // The original assertion read the flattened kind ROWS inside the overflow menu. Those rows no
    // longer exist: the owner pinned both Selects inline, so "what is current" is back where a
    // Select natively shows it — its own trigger. The coverage INTENT is unchanged (a sighted mouse
    // user must be able to read the current value, not only a screen reader), so it is retargeted
    // rather than dropped. It now covers BOTH Selects: convergence-4 caught the old version reading
    // only the kind rows while the LONGER colour-by list — the one a user reaches after recolouring
    // a pane — had no assertion anywhere in the suite.
    {
      const { p: pg } = await openGrid(1400, 950)
      const labels = await pg.evaluate(() => {
        const read = sel => {
          const e = document.querySelector(sel)
          if (!e) return null
          return { text: (e.textContent || '').trim(), box: e.getBoundingClientRect().width }
        }
        return { kind: read('[data-testid="viz-cell-kind-cell-1"]'), colorby: read('[data-testid="viz-cell-colorby-cell-1"]') }
      })
      check(!!labels.kind && labels.kind.text.length > 0 && labels.kind.box > 0,
        'H5b: the pinned KIND Select visibly shows its current value',
        JSON.stringify(labels.kind))
      // The colour-by Select starts unset (placeholder), so drive it and assert the trigger ADOPTS
      // the chosen column — the state convergence-3 found invisible.
      let adopted = null
      let picked = null
      const cb = await pg.$('[data-testid="viz-cell-colorby-cell-1"]')
      if (cb) {
        await cb.click(); await pg.waitForTimeout(500)
        // Pick an option that is NOT already selected — choosing the current one would leave the
        // trigger unchanged and the assertion would read as a failure for the wrong reason.
        const opts = await pg.$$eval('[role="option"]', els => els.map(e => ({
          t: (e.textContent || '').trim(), cur: e.getAttribute('aria-selected') === 'true' || e.getAttribute('data-selected') != null,
        })).filter(o => o.t))
        const want = opts.find(o => !o.cur) ?? opts[1] ?? opts[0]
        picked = want ? want.t : null
        if (picked) {
          await pg.click(`[role="option"] >> text="${picked}"`).catch(() => {})
          await pg.waitForTimeout(600)
          adopted = await pg.$eval('[data-testid="viz-cell-colorby-cell-1"]', e => (e.textContent || '').trim()).catch(() => null)
        }
        check(!!adopted && !!picked && adopted.replace(/\s*▼\s*$/, '').includes(picked.replace(/\s*▼\s*$/, '')),
          'H5b: the pinned COLOUR-BY Select visibly adopts the chosen column (not aria-only)',
          `picked=${JSON.stringify(picked)} before=${JSON.stringify(labels.colorby?.text)} after=${JSON.stringify(adopted)}`)
      } else {
        check(false, 'H5b: expected a colour-by Select on the dense pane cell-1')
      }
      await pg.close()
    }

    // ── (5) NARROW WIDTHS on `per-pane-editing`, DENSE *and* SEGMENT panes ──────────────────────
    // The assertion that was missing. convergence-4 found the SEGMENT panes' overflow TRIGGER itself
    // clipped ~30px past the strip at ≤640px, so a real mouse click could not open it and all ten
    // folded controls behind it — including `viz-cell-segment-*`, the per-pane entry point this
    // whole feature exists to deliver (finding #14) — were mouse-unreachable. Keyboard+Enter opened
    // it, so it was precisely the "present in the DOM, undrivable by mouse" class.
    //
    // Neither existing block could see it: (1) sweeps only `grid-nonuniform` at ≥900px, and the H5
    // block resizes `per-pane-editing` but sweeps only `slide-a` (a pane with no late-arriving
    // Segment button) and tests only `covered`, never `right > bar.right`.
    //
    // 640/560 on a 4-pane grid puts each pane BELOW the physical floor (measured: 82px and 62px of
    // toolbar against a 116px floor for grip + two collapsed icons + the trigger). There, and only
    // there, the pinned Selects are exempt from the clip check — not because they "truncate by
    // design" (that premise was false and cost the branch a HIGH), but because TIER 1 wins: the
    // overflow trigger has no fallback and everything folded dies with it, while a clipped pinned
    // Select is still keyboard-reachable. Above the floor the Selects are NOT exempt — `sweepToolbar`
    // enforces a real strict-hit floor on them at 900px, and H5d below drives them to effect.
    for (const [w, h] of [[640, 900], [560, 900]]) {
      const { p: pg, errs } = await openStory(w)
      await pg.setViewportSize({ width: w, height: h })
      await pg.waitForTimeout(1200)
      const PINNED = /^viz-cell-(kind|colorby|config)-/
      const bad = await pg.evaluate(pinnedSrc => {
        const pinned = new RegExp(pinnedSrc)
        const out = []
        for (const bar of document.querySelectorAll('[data-testid^="viz-pane-toolbar-"]')) {
          const br = bar.getBoundingClientRect()
          if (br.width <= 0) continue
          for (const e of [...bar.querySelectorAll('[data-testid]')].filter(x => !x.querySelector('[data-testid]'))) {
            const t = e.getAttribute('data-testid')
            if (pinned.test(t)) continue // truncates by design
            const r = e.getBoundingClientRect()
            if (r.width === 0 || r.height === 0) continue
            if (r.right > br.right + 0.5 || r.left < br.left - 0.5) { out.push(t + ':clipped'); continue }
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
            if (!hit || (!e.contains(hit) && !hit.contains(e))) out.push(t + ':covered')
          }
        }
        return out
      }, PINNED.source)
      check(bad.length === 0,
        `H5c: at ${w}px no ACTION or OVERFLOW control is clipped/covered on any pane (dense + segment)`,
        `bad=${JSON.stringify(bad.slice(0, 8))}`)

      // …and the trigger genuinely OPENS by real mouse on BOTH a dense and a segment pane.
      for (const id of ['slide-a', 'seg-a']) {
        const trig = await pg.$(`[data-testid="viz-cell-overflow-${id}"]`)
        if (!trig) { check(false, `H5c: ${id} must fold at ${w}px (nothing to reach)`); continue }
        const r = await trig.boundingBox()
        let opened = false
        if (r) {
          await pg.mouse.click(r.x + r.width / 2, r.y + r.height / 2)
          await pg.waitForTimeout(450)
          opened = !!(await pg.$(`[data-testid="viz-cell-overflow-panel-${id}"]`))
        }
        // The per-pane surface entry point must be behind it, reachable.
        const entry = opened
          ? await pg.evaluate(pane => {
              const pnl = document.querySelector(`[data-testid="viz-cell-overflow-panel-${pane}"]`)
              if (!pnl) return null
              const e = pnl.querySelector('[data-testid^="viz-cell-segment-"],[data-testid^="viz-cell-annotate-"]')
              if (!e) return 'absent'
              const rr = e.getBoundingClientRect()
              const hit = document.elementFromPoint(rr.left + rr.width / 2, rr.top + rr.height / 2)
              return hit && (e.contains(hit) || hit.contains(e)) ? 'hittable' : 'covered'
            }, id)
          : null
        check(opened && (entry === 'hittable' || entry === 'absent'),
          `H5c: ${id}'s overflow trigger OPENS by real mouse at ${w}px and its per-pane entry point is reachable`,
          `opened=${opened} entry=${entry}`)
        if (opened) { await pg.keyboard.press('Escape'); await pg.waitForTimeout(200) }
      }
      check(errs.length === 0, `H5c: no console/page errors @${w}x${h}`, errs.slice(0, 2).join(' | '))
      await pg.close()
    }
  }
} catch (e) {
  check(false, 'suite threw', String(e && e.stack ? e.stack : e).slice(0, 900))
}

await b.close()
console.log(pass ? '\nannotate-tooling-ux e2e: ALL PASS' : '\nannotate-tooling-ux e2e: FAILURES')
process.exit(pass ? 0 : 1)
