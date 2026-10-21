// selection-provenance.e2e.mjs — the acceptance drivers for selection provenance.
//
// TEST-1  (INV-1) capturing provenance did NOT turn the API into a filter.
// TEST-24 (INV-8) a CONTEXT-only change does ZERO containment work and keeps the ids array IDENTITY.
//
// Runnable: node tests/e2e/selection-provenance.e2e.mjs [baseUrl]
import { chromium } from 'playwright'
const BASE = process.argv[2] ?? 'http://localhost:1483'

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

try {
  await p.goto(`${BASE}/viz-showcase.html#plot-editing`, { waitUntil: 'commit' })
  await p.waitForSelector('[data-testid="viz-grid-workspace"]', { timeout: 30000 })
  await p.waitForTimeout(3500)

  // Engage the marquee tool, then drag a rect across most of the `cat` pane.
  await p.$eval('[data-testid="viz-tool-rail-tool-select"]', el => el.click()).catch(() => {})
  await p.waitForTimeout(400)
  const box = await p.$eval('[data-testid="viz-cell-grip-cat"]', el => {
    const pane = el.closest('[data-testid^="viz-pane-toolbar-"]')?.parentElement
    const r = (pane ?? el).getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  await p.mouse.move(box.x + box.w * 0.12, box.y + box.h * 0.35)
  await p.mouse.down()
  await p.mouse.move(box.x + box.w * 0.88, box.y + box.h * 0.92, { steps: 12 })
  await p.mouse.up()
  await p.waitForTimeout(1200)

  // ── TEST-13b / H1 — the PRODUCT registers the pane resolver with the controller ─────────────
  //
  // TEST-13 (unit) installs the resolver ITSELF, so it passes even when nothing in production ever
  // calls `registerSelectionPanes` — exactly the defect the blind audit found. This arm asserts the
  // wiring instead of simulating it: `getSelectionStaleness()` answers `'unknown'` iff no resolver
  // was ever registered, so deleting `onSelectionPanes` from `<Viz>` turns this red.
  const wiring = await p.evaluate(() => {
    const c = window.__VIZ_CONTROLLER__
    if (!c) return { present: false }
    return { present: true, staleness: c.getSelectionStaleness() }
  })
  check(wiring.present, 'TEST-13b the DEV controller seam is installed', JSON.stringify(wiring))
  check(
    wiring.present && wiring.staleness !== 'unknown',
    'TEST-13b the PRODUCT registered the pane resolver (staleness !== "unknown")',
    `staleness=${wiring.staleness}`,
  )

  // ── TEST-1 / INV-1 ─────────────────────────────────────────────────────────────────────────
  const before = await p.evaluate(() => {
    const prov = window.__VIZ_PROV__
    return {
      ids: (prov?.idsRef() ? Array.from(prov.idsRef()) : []).length,
      ops: (prov?.ops() ?? []).length,
      hasCtx: prov?.context() != null,
    }
  })
  check(before.ids > 0, 'TEST-1 a rect over the cat pane selects a non-empty set', `ids=${before.ids}`)
  check(before.ops > 0, 'TEST-1 the gesture recorded PROVENANCE (ops)', `ops=${before.ops}`)

  // Now hide a category + clamp a filter. Under INV-1 the raw ids must NOT move.
  const t1 = await p.evaluate(async () => {
    const idsOf = () => Array.from(window.__VIZ_PROV__.idsRef() ?? [])
    const idsBefore = idsOf()
    window.__VIZ_INCELL__.toggleCategory('cat', 4)
    await new Promise(r => setTimeout(r, 700))
    const dom = window.__VIZ_INCELL__.domains?.cont
    if (dom) {
      const lo = dom[0] + (dom[1] - dom[0]) * 0.45
      const hi = dom[0] + (dom[1] - dom[0]) * 0.55
      window.__VIZ_INCELL__.setRange('cont', [lo, hi])
    }
    await new Promise(r => setTimeout(r, 700))
    const idsAfter = idsOf()
    const ctx = window.__VIZ_PROV__.context() ?? {}
    return {
      same: idsBefore.length === idsAfter.length && idsBefore.every((v, i) => v === idsAfter[i]),
      n: idsAfter.length,
      hiddenCat: ctx.hidden?.cat ?? null,
      filterCont: ctx.filters?.cont ?? null,
    }
  })
  check(t1.same, 'TEST-1 [INV-1] hiding a category + clamping a filter leaves the ids BYTE-IDENTICAL', `n=${t1.n}`)
  // NEGATIVE CONTROL: the context provably MOVED, so the ids-unchanged assertion is not vacuous
  // (it cannot pass by capturing nothing at all).
  check(
    Array.isArray(t1.hiddenCat) && t1.hiddenCat.includes(4),
    'TEST-1 NEGATIVE CONTROL: context.hidden.cat DID capture the hidden category',
    `hidden=${JSON.stringify(t1.hiddenCat)}`,
  )
  check(
    Array.isArray(t1.filterCont) && t1.filterCont.length === 2,
    'TEST-1 NEGATIVE CONTROL: context.filters.cont DID capture the clamp',
    `filters=${JSON.stringify(t1.filterCont)}`,
  )

  // ── TEST-24 / INV-8 ────────────────────────────────────────────────────────────────────────
  // The whole probe runs IN-PAGE: reference identity cannot cross the serialization boundary, so
  // `idsRef() === idsBefore` is only meaningful evaluated inside the page.
  const t24 = await p.evaluate(async () => {
    const prov = window.__VIZ_PROV__
    const callsBefore = prov.containmentCalls
    const idsBefore = prov.idsRef() // the ARRAY INSTANCE, not a copy
    // A CONTEXT-only change: un-hide then re-hide a different category.
    window.__VIZ_INCELL__.toggleCategory('cat', 2)
    await new Promise(r => setTimeout(r, 900))
    return {
      delta: prov.containmentCalls - callsBefore,
      sameRef: prov.idsRef() === idsBefore, // IDENTITY, not equality
      cls: prov.lastClassification,
      hidden2: (prov.context()?.hidden?.cat ?? []).includes(2),
    }
  })
  check(t24.delta === 0, 'TEST-24 [INV-8] a CONTEXT change performs ZERO containment tests', `delta=${t24.delta}`)
  check(t24.sameRef, 'TEST-24 [INV-8] …and leaves `ids` the SAME ARRAY INSTANCE', `sameRef=${t24.sameRef}`)
  check(t24.cls === 'context', 'TEST-24 [INV-8] the gatekeeper classified it `context`', `cls=${t24.cls}`)
  // Not vacuously true: the context genuinely moved.
  check(t24.hidden2, 'TEST-24 the context DID move (so zero-work is not "nothing happened")')

  // ── TEST-24 DATA ARM (mandatory) ──────────────────────────────────────────────────────────
  // Without this an implementation that never re-derives at all would pass the context arm.
  //
  // Driven with Playwright's own click + waitForFunction rather than an in-page sleep: inside a long
  // `p.evaluate` the page's timers get throttled (a 250ms timer was measured taking >4s), so an
  // in-page wait never observes the re-seeded buffers landing. The identity reference is stashed on
  // `globalThis` so `idsRef() === before` is still compared IN-PAGE — reference identity cannot
  // cross the serialization boundary.
  const hadReseed = await p.$('[data-testid="viz-plot-editing-reseed"]') != null
  let t24d = { delta: 0, sameRef: true, cls: null, n: 0 }
  if (hadReseed) {
    await p.evaluate(() => {
      const prov = window.__VIZ_PROV__
      globalThis.__CALLS0__ = prov.containmentCalls
      globalThis.__IDS0__ = prov.idsRef()
    })
    // Direct DOM dispatch: Playwright's actionability check fails here (the selection overlay
    // covers the button), but the click itself is real. Crucially it is issued OUTSIDE a long
    // `evaluate`, so the page is not throttled while the re-seed lands.
    await p.$eval('[data-testid="viz-plot-editing-reseed"]', el => el.click())
    // Fails loudly if the re-derive never fires. The `.catch(() => {})` that used to sit here
    // SWALLOWED the timeout, so the comment claiming "not weakened" was false and a slow box spent
    // the full 15 s before falling through. Now a timeout is reported as the failure it is.
    let t24dWaited = true
    await p
      .waitForFunction(() => window.__VIZ_PROV__.lastClassification === 'data', null, { timeout: 15000 })
      .catch(() => {
        t24dWaited = false
      })
    check(t24dWaited, 'TEST-24 DATA arm: the re-derive actually fired within the timeout')
    t24d = await p.evaluate(() => {
      const prov = window.__VIZ_PROV__
      return {
        delta: prov.containmentCalls - globalThis.__CALLS0__,
        sameRef: prov.idsRef() === globalThis.__IDS0__,
        cls: prov.lastClassification,
        n: prov.idsRef()?.length ?? 0,
      }
    })
  }
  if (hadReseed) {
    check(t24d.delta > 0, 'TEST-24 DATA ARM: a DATA change DOES re-run the geometry', `delta=${t24d.delta}`)
    check(!t24d.sameRef, 'TEST-24 DATA ARM: …and produces a NEW ids array instance')
    check(t24d.cls === 'data', 'TEST-24 DATA ARM: classified `data`', `cls=${t24d.cls}`)
    // NON-EMPTY (DEC-9 / INV-7 hazard): a re-derive that runs before the pane buffers exist
    // hit-tests nothing and publishes an EMPTY selection, which would otherwise satisfy
    // "new array instance" and look like a working re-derive.
    check(t24d.n > 0, 'TEST-24 DATA ARM: …and the re-derived selection is NON-EMPTY', `n=${t24d.n}`)
  } else {
    check(false, 'TEST-24 DATA ARM: the story exposes no re-seed control — arm could not run')
  }

  check(errs.length === 0, 'no console/page errors', errs.slice(0, 2).join(' | '))
} catch (e) {
  check(false, 'spec threw', String(e).slice(0, 200))
}

await b.close()
console.log(pass ? '\nselection-provenance e2e: ALL PASS' : '\nselection-provenance e2e: FAILURES')
process.exit(pass ? 0 : 1)
