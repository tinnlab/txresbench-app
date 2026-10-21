// render-perf-parity.spec.ts — the BEHAVIOURAL counterweight to the counter leg.
//
// WHY THIS FILE EXISTS. The counter leg (`render-perf.spec.ts`) proves the camera stopped
// re-rendering the pane chrome. It cannot prove the chrome still WORKS: a `memo` that skips a
// render on an `editOpen`/`dataOpen`/`annotateOpen`/`segmentOpen` transition, or a split that
// makes the parent read a child-owned camera one frame late, breaks the product while every
// counter goes green. PLAN_AUDIT rates both HIGH. This file is where the three invariants the
// counters are structurally blind to are asserted:
//
//   • INV-2 (TEST-P3) — change ONLY the camera; the chrome must not be re-created, and the
//     mutation must not schedule work beyond its own commit.
//   • INV-8 (TEST-12) — per-pane parity: four panes, four docks, each flipping ITS OWN pane's
//     state and no other; all open at once; closing one leaves the rest.
//   • INV-9 (TEST-13) — direct manipulation: a press-drag pans on the FIRST press with another
//     pane's editing surface open; unlinked panes stay put; linked panes follow; and a keyboard
//     pan round trip returns BIT-IDENTICAL pixels (a camera path that LOSES information cannot).
//
// TECHNIQUE PROVENANCE — none of this is invented here. Each clause is the standing form of a
// throwaway probe that was already run and already caught a real defect during the split wave
// (DECISIONS.md):
//   - the four-docks-at-once + per-pane pressed-state shape is DRIFT-22's INV-8 probe (which
//     went RED under the injected "resolve only the first open pane" defect) and Split-D's
//     six-surface probe;
//   - the bit-identical arrow-pan round trip is the Split-A verification record's direct camera
//     probe (`222a3447 → 8b954c7d → 222a3447`);
//   - the toolbar-fold fallback through the overflow panel is `annotate-tooling-ux.e2e.mjs`'s
//     H5c technique (a dock opening narrows every pane, which folds the sibling buttons).
//
// ANTI-VACUITY IS THE HOUSE RULE HERE, exactly as in `_renderPerf.ts`. Every gate below either
// establishes its own premise in-test or hard-fails: a camera drive that did not move the camera,
// a dock click that hit nothing, a signature read off a missing canvas — each is a NON-measurement
// and is refused, never reported as a comfortable pass. (The first draft of the Split-D probe
// silently matched nothing and reported ALL PASS; that is the failure mode being designed out.)

import { expect, test, type Page } from '@playwright/test'
import { installCommitCounter, installElementCounter, openPerfStory, paneCentre } from './_renderPerf'

/** The chrome INV-1/INV-2 forbid the camera from re-creating. Same list as the counter leg. */
const CHROME = ['PaneToolbar', 'CellView'] as const

/** `#per-pane-editing`'s four panes, in render order. Two annotate-capable, two segment-capable —
 *  which is what lets one drive assert FOUR different (pane, dock) pairs at once. */
const PPE = { annA: 'slide-a', annB: 'slide-b', segA: 'seg-a', segB: 'seg-b' } as const
/** `#plot-editing`'s 2x2. Carries the `data` (table) dock `#per-pane-editing` has no cell for, so
 *  between the two stories all four open-set flags PLAN_AUDIT names are exercised. */
const PE = { cat: 'cat', cont: 'cont' } as const

// ── shared micro-helpers ─────────────────────────────────────────────────────────────────────────

/** Per-cell camera, through the dev seam `GridDeckLayer` installs. THROWS when the seam is absent:
 *  every camera assertion below divides by it, and a `null` camera silently satisfies "unchanged". */
async function cameras(page: Page): Promise<Record<string, { zoom: number; x: number; y: number }>> {
  const raw = await page.evaluate(() => {
    const v = (
      window as unknown as {
        __VIZ_GRID_VIEW__?: { zoom?: Record<string, number>; target?: Record<string, number[]> }
      }
    ).__VIZ_GRID_VIEW__
    if (!v?.zoom || !v.target) return null
    return Object.fromEntries(
      Object.entries(v.zoom).map(([id, zoom]) => [
        id,
        { zoom, x: v.target?.[id]?.[0] ?? Number.NaN, y: v.target?.[id]?.[1] ?? Number.NaN },
      ]),
    )
  })
  if (!raw || Object.keys(raw).length === 0)
    throw new Error(
      'window.__VIZ_GRID_VIEW__ is absent or empty, so no camera assertion in this file can be ' +
        'honest — "unchanged" would be satisfied by a camera nobody could read. Refusing to run.',
    )
  return raw
}

/** FNV-1a over a strided RGBA sample of deck's SHARED canvas (`canvas#deckgl-overlay`).
 *
 *  `_pixelsig.ts` hashes "the Nth canvas" or "the first canvas inside a host"; neither addresses
 *  deck's canvas by identity, and a grid pane contains its own legend/colormap canvases, so an
 *  index- or host-based read here would hash a legend and report "no change" for every camera move.
 *  Hence the local, id-addressed variant. Returns '' when the canvas is missing or unreadable —
 *  and the caller REFUSES an empty signature rather than comparing two of them (two empties are
 *  equal, which would pass the round-trip clause on a page with no canvas at all). */
async function deckSignature(page: Page): Promise<string> {
  return page.evaluate(() => {
    const c = document.querySelector('canvas#deckgl-overlay') as HTMLCanvasElement | null
    if (!c) return ''
    const off = document.createElement('canvas')
    off.width = c.width
    off.height = c.height
    const ctx = off.getContext('2d')
    if (!ctx) return ''
    try {
      ctx.drawImage(c, 0, 0)
      const { data } = ctx.getImageData(0, 0, off.width, off.height)
      let h = 0x811c9dc5
      for (let i = 0; i < data.length; i += 4 * 101) {
        h ^= data[i]
        h = Math.imul(h, 0x01000193)
        h ^= data[i + 1]
        h = Math.imul(h, 0x01000193)
        h ^= data[i + 2]
        h = Math.imul(h, 0x01000193)
        h ^= data[i + 3]
        h = Math.imul(h, 0x01000193)
      }
      return (h >>> 0).toString(16)
    } catch {
      return ''
    }
  })
}

/**
 * Press a pane's toolbar tool, THROUGH THE OVERFLOW PANEL IF IT FOLDED.
 *
 * A dock opening steals ~300px from the grid, which narrows every pane and folds the sibling
 * buttons behind `viz-cell-overflow-<id>` — measured on `#per-pane-editing` at 1280x820: after the
 * edit form opened, `viz-cell-annotate-slide-b` was no longer in the DOM at its toolbar site. A
 * helper that only clicked the direct site would report a TIMEOUT on a working product (and, worse,
 * a `.catch(() => {})` version would report a silent no-op as a pass). So: direct site if it is
 * there, else open the overflow panel and click the SAME testid inside it, else hard-fail naming
 * what it looked for. Never a no-op.
 */
async function pressPaneTool(page: Page, cellId: string, key: string): Promise<void> {
  const direct = page.locator(`[data-testid="viz-cell-${key}-${cellId}"]`)
  if ((await direct.count()) > 0 && (await direct.first().isVisible())) {
    await direct.first().click({ timeout: 15_000 })
    await page.waitForTimeout(900)
    return
  }
  const trigger = page.locator(`[data-testid="viz-cell-overflow-${cellId}"]`)
  if ((await trigger.count()) === 0)
    throw new Error(
      `pane ${cellId} exposes neither viz-cell-${key}-${cellId} nor an overflow trigger, so the ` +
        `${key} dock cannot be opened at all. This is a broken fixture, not a passing test.`,
    )
  await trigger.first().click({ timeout: 15_000 })
  await page.waitForTimeout(450)
  const folded = page.locator(
    `[data-testid="viz-cell-overflow-panel-${cellId}"] [data-testid="viz-cell-${key}-${cellId}"]`,
  )
  if ((await folded.count()) === 0)
    throw new Error(
      `pane ${cellId}'s overflow panel does not contain viz-cell-${key}-${cellId}. The control is ` +
        `unreachable by mouse — the "present in the DOM, undrivable" class H5c exists for.`,
    )
  await folded.first().click({ timeout: 15_000 })
  await page.waitForTimeout(900)
}

/**
 * Every `aria-pressed` value carried by `viz-cell-<key>-<cellId>`, ACROSS ALL ITS SITES.
 *
 * The same testid is rendered at up to two sites (the toolbar strip and the overflow panel).
 * Asserting `toContain('true')` over that would be satisfied by any ONE surviving site — the
 * multi-site token trap. So this returns the full list, the caller asserts over the whole list,
 * and a missing button yields `['MISSING']` (an explicit value that fails a comparison) rather
 * than `[]` (which every "all sites agree" quantifier accepts vacuously).
 */
async function pressedStates(page: Page, cellId: string, key: string): Promise<string[]> {
  const values = await page.$$eval(`[data-testid="viz-cell-${key}-${cellId}"]`, els =>
    els.map(e => e.getAttribute('aria-pressed') ?? 'NO-ARIA-PRESSED'),
  )
  return values.length === 0 ? ['MISSING'] : values
}

/** Presence of a dock surface, keyed by its OWN pane id. One entry per (pane, dock) pair the
 *  INV-8 clause names, so a red prints the whole grid of docks rather than one boolean. */
async function dockMap(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(
    ids => {
      const q = (s: string) => document.querySelector(`[data-testid="${s}"]`) != null
      return {
        [`edit:${ids.annA}`]: q(`viz-edit-form-${ids.annA}`),
        [`edit:${ids.annB}`]: q(`viz-edit-form-${ids.annB}`),
        [`edit:${ids.segA}`]: q(`viz-edit-form-${ids.segA}`),
        [`edit:${ids.segB}`]: q(`viz-edit-form-${ids.segB}`),
        [`annotate:${ids.annA}`]: q(`viz-annotate-panel-${ids.annA}`),
        [`annotate:${ids.annB}`]: q(`viz-annotate-panel-${ids.annB}`),
        [`segment:${ids.segA}`]: q(`viz-mask-panel-${ids.segA}`),
        [`segment:${ids.segB}`]: q(`viz-mask-panel-${ids.segB}`),
      }
    },
    PPE as unknown as Record<string, string>,
  )
}

// ── TEST-26 helpers (the annotate overlay's instancing surface) ──────────────────────────────────

/** One mounted annotate draw overlay. `paneId` is '' when the node carries no per-pane testid —
 *  which is what a single GLOBAL sheet looks like, and is reported rather than filtered out. */
interface OverlayNode { paneId: string; testId: string; box: Box }

/**
 * EVERY mounted annotate draw overlay, found through the layer's own marker attribute
 * (`data-annotate-overlay="1"`) and NOT through a per-pane testid query.
 *
 * The difference is the whole point of the clause. `page.locator('[data-testid="…-slide-a"]')` can
 * only ever find overlays for panes the TEST already names, so it is blind to an overlay mounted
 * for a pane nobody opened, and blind to a global sheet with no pane id — the two shapes "renders
 * once per OPEN pane" forbids. Enumerating the marker sees all of them.
 */
async function annotateOverlays(page: Page): Promise<OverlayNode[]> {
  const PREFIX = 'viz-grid-annotate-overlay-'
  const nodes = await page.$$eval(
    '[data-annotate-overlay="1"]',
    (els, prefix) =>
      els.map(e => {
        const testId = e.getAttribute('data-testid') ?? ''
        const r = e.getBoundingClientRect()
        return {
          paneId: testId.startsWith(prefix) ? testId.slice(prefix.length) : '',
          testId,
          box: { x: r.x, y: r.y, width: r.width, height: r.height },
        }
      }),
    PREFIX,
  )
  return nodes
}

/** The pane ids whose annotate DOCK panel is mounted — the GREEN CONTROL surface. A different layer
 *  from the overlay, so it must be unmoved by any overlay-layer mutation. */
async function dockPanelIds(page: Page): Promise<string[]> {
  // `viz-annotate-panel-title-<id>` / `-close-<id>` / `-<id>-body` all share the prefix. Rather
  // than denylisting sub-part spellings (which a new one silently escapes), keep only the OUTERMOST
  // node of each prefix-matching subtree — the panel root — which is structural and cannot drift.
  return (
    await page.$$eval('[data-testid^="viz-annotate-panel-"]', els =>
      els
        .filter(e => e.parentElement?.closest('[data-testid^="viz-annotate-panel-"]') == null)
        .map(e => (e.getAttribute('data-testid') ?? '').slice('viz-annotate-panel-'.length))
        .filter(rest => rest.length > 0),
    )
  ).sort()
}

/** A point inside a pane's PLOT area (below its 32px toolbar strip), as viewport coordinates.
 *  Reads the box through `paneGeometry` rather than re-querying, so there is ONE reader of the
 *  pane-box attribute in this file. */
async function plotCentreOf(page: Page, paneId: string): Promise<{ x: number; y: number }> {
  const r = (await paneGeometry(page))[paneId]?.pane
  if (!r) throw new Error(`pane ${paneId} has no box — the fixture did not render it`)
  const TOOLBAR = 40
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + TOOLBAR + (r.height - TOOLBAR) / 2) }
}

/**
 * Which annotate overlay (if any) actually COVERS a pane's plot centre.
 *
 * The `elementFromPoint` form is `annotate-tooling-ux.e2e.mjs`'s H2 technique verbatim, and it is
 * used for the same reason: "the element exists in the DOM" and "the element receives this pane's
 * presses" are different claims, and only the second one is what a pointer surface is for.
 */
async function overlayAtPlotCentre(page: Page, paneId: string): Promise<string> {
  const p = await plotCentreOf(page, paneId)
  return page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y)
      if (!el) return 'none'
      return el.closest('[data-annotate-overlay="1"]')?.getAttribute('data-testid') ?? 'none'
    },
    { x: p.x, y: p.y },
  )
}

/** A pane's committed-annotation count, through the `__vizAnnotateStores` dev seam. THROWS when the
 *  pane has no store: a `-1` sentinel compared against `before + 1` would silently pass nothing. */
async function annotateCount(page: Page, paneId: string): Promise<number> {
  const n = await page.evaluate(
    id =>
      (window as unknown as { __vizAnnotateStores?: Map<string, { getState(): { ids: string[] } }> })
        .__vizAnnotateStores?.get(id)
        ?.getState().ids.length ?? -1,
    paneId,
  )
  if (n < 0)
    throw new Error(
      `pane ${paneId} publishes no annotate store on __vizAnnotateStores, so no "committed into ` +
        `its own pane" claim in this file is measurable. Refusing to run.`,
    )
  return n
}

/** The world `[x, y]` of a pane's MOST RECENTLY added annotation, when that annotation is a point.
 *  `null` for any other shape — which every caller asserts against rather than accepting. */
async function lastPointXY(page: Page, paneId: string): Promise<[number, number] | null> {
  return page.evaluate(id => {
    const st = (
      window as unknown as {
        __vizAnnotateStores?: Map<
          string,
          { getState(): { ids: string[]; byId: Record<string, { geometry: { kind: string; xy?: number[] } }> } }
        >
      }
    ).__vizAnnotateStores?.get(id)?.getState()
    if (!st || st.ids.length === 0) return null
    const g = st.byId[st.ids[st.ids.length - 1]]?.geometry
    return g && g.kind === 'point' && g.xy ? ([g.xy[0], g.xy[1]] as [number, number]) : null
  }, paneId)
}

/** Press once at the CENTRE OF A PANE'S OWN OVERLAY (the deck view's centre, hence its camera
 *  target in world space). Hard-fails when that pane has no overlay — a press aimed at a missing
 *  element would land on the pane beneath it and be reported as "nothing was committed", which is
 *  the right answer for the wrong reason. */
async function pressOverlayCentre(page: Page, paneId: string): Promise<{ x: number; y: number }> {
  const found = (await annotateOverlays(page)).find(o => o.paneId === paneId)
  if (!found)
    throw new Error(`pane ${paneId} has no annotate overlay to press — this is not a measurement`)
  const pt = { x: Math.round(found.box.x + found.box.width / 2), y: Math.round(found.box.y + found.box.height / 2) }
  await page.mouse.move(pt.x, pt.y)
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(600)
  return pt
}

// ── TEST-28 / TEST-15 shared geometry helpers ────────────────────────────────────────────────────

/** `#plot-editing`'s four cells. `cat` carries the CATEGORICAL in-cell legend, `cont` the CONTINUOUS
 *  visual map — the two chrome overlays Split D moved, side by side in one fixture. */
const PE4 = { cat: 'cat', cont: 'cont', box: 'box', violin: 'violin' } as const

/** `LEGEND_GUTTER_PAD - PAD` from `GridWorkspace.tsx`. The legend wrapper's width is
 *  `measuredLegendWidth + LEGEND_GUTTER_PAD - PAD` in BESIDE mode, for BOTH legend corners:
 *
 *    hSide 'left' : region.w = plot.x - ir.x - PAD                 = (measured + 10) - 8
 *    hSide 'right': region.w = (ir.x+ir.width) - (plot.x+plot.w) - PAD = (measured + 10) - 8
 *
 *  so the identity below is corner-independent and binds the WHOLE chain Split D had to preserve:
 *  `measureLegend` (measures the rendered block) -> `legendGutterFor` (turns it into a gutter) ->
 *  `plotInset` (shrinks the deck view by it) -> the rendered wrapper's `region`. If `measureLegend`
 *  stops measuring, `legendGutterFor` falls back to the hard-coded 72 and this identity breaks. */
const GUTTER_IDENTITY_PX = 2
/** Sub-pixel slack. `measureLegend` itself only re-commits on a >1px delta, so 1px is its own noise
 *  floor; anything looser would let the 72px fallback (a ~40px error) through. */
const GUTTER_EPS_PX = 1.5

interface Box { x: number; y: number; width: number; height: number }

/** Every leaf pane's own box AND the `viz-cell-view-<id>` box rendered inside it, in one read.
 *  These two must agree: `registerPane` hands the Panel element to `measure`, `measure` writes the
 *  rect, and `CellView` is positioned from that rect. A drift between them IS the rect path failing. */
async function paneGeometry(page: Page): Promise<Record<string, { pane: Box; view: Box | null }>> {
  return page.evaluate(() => {
    const rd = (el: Element | null): { x: number; y: number; width: number; height: number } | null => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }
    const out: Record<string, { pane: unknown; view: unknown }> = {}
    for (const el of Array.from(document.querySelectorAll('[data-viz-cell]'))) {
      const id = el.getAttribute('data-viz-cell') ?? ''
      if (!id) continue
      out[id] = { pane: rd(el), view: rd(document.querySelector(`[data-testid="viz-cell-view-${id}"]`)) }
    }
    return out
  }) as Promise<Record<string, { pane: Box; view: Box | null }>>
}

/** A cell's in-cell legend wrapper box + the box of the block `measureLegend` actually measures
 *  (`el.firstElementChild`). `null` when the cell renders no legend at all — which every caller
 *  below REFUSES rather than treating as "the geometry checked out". */
async function legendGeometry(
  page: Page,
  cellId: string,
): Promise<{ wrapper: Box; inner: Box; kind: string } | null> {
  return page.evaluate(id => {
    const wrap = document.querySelector(`[data-testid="viz-cell-legend-${id}"]`)
    const inner = wrap?.firstElementChild ?? null
    if (!wrap || !inner) return null
    const rd = (el: Element) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }
    // Which of the three chrome legend forms rendered — asserted by name so a test that expects a
    // blend legend cannot be satisfied by a categorical one that happens to sit in the same box.
    const kind = inner.querySelector('[data-testid="viz-blend-legend"]')
      ? 'blend'
      : inner.querySelector(`[data-testid="viz-cell-visualmap-${id}"]`)
        ? 'continuous'
        : inner.querySelector('[data-testid="viz-incell-legend"]')
          ? 'categorical'
          : 'unknown'
    return { wrapper: rd(wrap), inner: rd(inner), kind }
  }, cellId)
}

/** The per-cell hidden-code sets, through the grid's `__VIZ_INCELL__` dev seam (the same seam
 *  `render-perf-legend.spec.ts` reads). Serialized so a round trip is a string comparison. */
async function hiddenCodes(page: Page): Promise<string> {
  return page.evaluate(() => {
    const h = (window as unknown as { __VIZ_INCELL__?: { hidden?: Record<string, Set<number>> } })
      .__VIZ_INCELL__?.hidden
    return JSON.stringify(Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k, [...v].sort()])))
  })
}

/** Turn a cell's legend into BESIDE mode through its REAL edit-form switch (no store poke), leaving
 *  the form open. Hard-fails if the switch is missing — a silently-skipped toggle would make every
 *  gutter assertion below a statement about overlay mode. */
async function setLegendBeside(page: Page, cellId: string, on: boolean): Promise<void> {
  const sw = page.locator(`[data-testid="viz-edit-legend-beside-${cellId}"]`)
  if ((await sw.count()) === 0)
    throw new Error(`pane ${cellId}'s edit form has no legend-beside switch — the fixture cannot express the gutter`)
  const state = await sw.first().getAttribute('aria-checked')
  if ((state === 'true') !== on) {
    await sw.first().click({ timeout: 15_000 })
    await page.waitForTimeout(900)
  }
  expect(await sw.first().getAttribute('aria-checked'), `legend-beside on ${cellId} must be ${on}`).toBe(
    on ? 'true' : 'false',
  )
}

/** Open a pane's edit form IF it is not already open. `pressPaneTool` is a TOGGLE, so calling it on
 *  a pane whose form is already up CLOSES it — which reads downstream as "the control is missing"
 *  rather than as "the test double-pressed". Idempotent by construction, and it verifies the form
 *  is actually up afterwards rather than assuming the click landed. */
async function ensureEditOpen(page: Page, cellId: string): Promise<void> {
  const form = page.locator(`[data-testid="viz-edit-form-${cellId}"]`)
  if ((await form.count()) === 0) await pressPaneTool(page, cellId, 'edit')
  await expect(form, `pane ${cellId}'s edit form must be open`).toHaveCount(1)
}

/**
 * A cell's VISUAL state, as two independent signatures.
 *
 *  * `plot`   — FNV-1a over the SHARED deck canvas CROPPED to this pane's box. All four panes draw
 *               into one `canvas#deckgl-overlay`, so a whole-canvas hash cannot say WHICH pane
 *               changed — which is the only question an isolation claim asks. Cropping is what makes
 *               "pane B is untouched" a fact rather than "something, somewhere, is the same".
 *  * `legendSum` — the SUM of the legend canvas's RGB bytes, plus its opaque-pixel count.
 *
 * WHY THE LEGEND IS A MAGNITUDE AND NOT A HASH — MEASURED, not assumed. Every in-cell legend
 * (categorical AND the continuous visual map) is a CANVAS, and it re-rasterizes on an unrelated
 * pane's re-render with sub-pixel antialiasing jitter. Measured on this fixture, hiding one
 * category on `cat`:
 *     driven   cat : 512828 -> 499652   (delta 13176 = 2.57 %)
 *     untouched box: 512828 -> 512855   (delta    27 = 0.005 %)
 *     untouched cnt: 638739 -> 638751   (delta    12 = 0.002 %)
 * A bit-identity assertion on that canvas is therefore RED on AA noise, which would have to be
 * silenced — and silencing it is how a clause stops measuring. The claim made instead is the one
 * the numbers actually support and that a real leak violates by three orders of magnitude: an
 * untouched legend moves by < 0.2 %, the driven one by > 1 %, and the ratio between them is > 20x.
 * A leaked hidden-code REMOVES A SWATCH ROW, which is a whole-row delta, not a rounding one.
 *
 * The PLOT half stays a bit-exact hash: the deck crop WAS byte-stable across the same drive
 * (`cont` 1ab26d4a, `box` 5f5d3ac8, `violin` b9911d1a, unchanged), so nothing is being loosened
 * that did not need loosening.
 *
 * Returns `null`/`0` for anything unreadable, and every caller REFUSES that rather than comparing
 * two of them — two unreadable signatures are equal, which would satisfy every "unchanged" clause
 * on a page with nothing on it.
 */
async function cellVisualSig(
  page: Page,
  cellId: string,
): Promise<{ plot: string | null; legendSum: number; legendPixels: number }> {
  return page.evaluate(id => {
    const fnv = (bytes: Uint8Array | Uint8ClampedArray, stride: number): string => {
      let h = 0x811c9dc5
      for (let i = 0; i < bytes.length; i += stride) {
        h ^= bytes[i]
        h = Math.imul(h, 0x01000193)
      }
      return (h >>> 0).toString(16)
    }
    const hashString = (t: string): string => {
      let h = 0x811c9dc5
      for (let i = 0; i < t.length; i++) {
        h ^= t.charCodeAt(i) & 0xff
        h = Math.imul(h, 0x01000193)
      }
      return (h >>> 0).toString(16)
    }
    const cropOf = (canvas: HTMLCanvasElement, box: DOMRect, origin: DOMRect): string | null => {
      // The backing store may be devicePixelRatio-scaled relative to the CSS box.
      const sx = canvas.width / origin.width
      const sy = canvas.height / origin.height
      const x = Math.max(0, Math.round((box.x - origin.x) * sx))
      const y = Math.max(0, Math.round((box.y - origin.y) * sy))
      const w = Math.min(canvas.width - x, Math.round(box.width * sx))
      const h = Math.min(canvas.height - y, Math.round(box.height * sy))
      if (w <= 0 || h <= 0) return null
      const off = document.createElement('canvas')
      off.width = w
      off.height = h
      const ctx = off.getContext('2d')
      if (!ctx) return null
      try {
        ctx.drawImage(canvas, x, y, w, h, 0, 0, w, h)
        return fnv(ctx.getImageData(0, 0, w, h).data, 4 * 37)
      } catch {
        return null
      }
    }
    const pane = document.querySelector(`[data-viz-cell="${id}"]`)
    const deck = document.querySelector('canvas#deckgl-overlay') as HTMLCanvasElement | null
    const plot = pane && deck ? cropOf(deck, pane.getBoundingClientRect(), deck.getBoundingClientRect()) : null

    const wrap = document.querySelector(`[data-testid="viz-cell-legend-${id}"]`)
    let legendSum = 0
    let legendPixels = 0
    if (wrap) {
      const lc = wrap.querySelector('canvas') as HTMLCanvasElement | null
      if (lc) {
        try {
          const d = lc.getContext('2d')!.getImageData(0, 0, lc.width, lc.height).data
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] !== 0) legendPixels++
            legendSum += d[i] + d[i + 1] + d[i + 2]
          }
        } catch {
          legendSum = 0
          legendPixels = 0
        }
      } else {
        // A DOM-rendered legend has no rasterization noise; hash its markup and report it as a
        // magnitude so both forms flow through one comparison.
        legendSum = Number.parseInt(hashString(wrap.innerHTML), 16)
        legendPixels = wrap.innerHTML.length
      }
    }
    return { plot, legendSum, legendPixels }
  }, cellId)
}

test.describe('render-perf — behavioural parity leg', () => {
  // ── TEST-P3 (ITEM-1/ITEM-2, INV-2) [acceptance]: a CAMERA-ONLY mutation, observed at the chrome ──
  //
  // The cleanest possible statement of INV-2: change ONLY the camera, then look at the chrome.
  //
  // The mutation is the KEYBOARD camera path — `]` focuses a cell, then ArrowRight pans it. No
  // pointer is over a pane, no deck pick runs, no hover state changes; the keypress lands on the
  // workspace's a11y handler, which dispatches straight through `onViewStateChangeRef` into the
  // coordination store's `setGridViewState` (the same write the mouse uses, per `a11y-grid.spec.ts`).
  // That is exactly the "no pointer, no deck, no hover, so nothing but the camera changes" mutation
  // this clause asks for, and it needs no new product seam to obtain.
  //
  // NOT a tautology on the implementation: it goes RED under a `memo` whose comparator is defeated
  // by any ONE unstable prop, which is the failure `memo`-without-prop-stabilization produces and
  // which TEST-P1 can miss (TEST-P1 drives a wheel, and a prop that only churns on a wheel is a
  // different set from one that churns on any camera write).
  test('TEST-P3 a camera-only mutation creates zero chrome elements and schedules no extra commit', async ({
    page,
  }) => {
    test.setTimeout(300_000)
    const counter = await installElementCounter(page)
    const commits = await installCommitCounter(page)
    await openPerfStory(page, 'per-pane-editing', {}, { settleMs: 9000 })
    counter.assertApplied()
    await commits.assertInjected()

    // PREMISE 1 — the fixture really is the four-pane chrome-bearing grid this measures.
    await expect(page.locator('[data-viz-cell]')).toHaveCount(4)
    await expect(page.locator('[data-testid^="viz-pane-toolbar-"]')).toHaveCount(4)
    // PREMISE 2 — no dock is open, so the only thing the drive can change is the camera.
    const docksAtStart = await dockMap(page)
    expect(
      Object.entries(docksAtStart).filter(([, open]) => open),
      'TEST-P3 measures a CAMERA-ONLY mutation, so no dock may be open when it starts',
    ).toEqual([])

    const workspace = page.locator('[data-testid="viz-grid-workspace"]')
    await expect(workspace).toHaveAttribute('role', 'application')
    await workspace.focus()
    // Focus a cell and take ONE warm-up pan OUTSIDE the measured window — TEST-P5's discipline: the
    // first camera write of a session carries a one-off commit (the camera leaving its initial
    // state) which is a constant, not a rate, and including it would make the ratio a function of
    // the drive length rather than a property of the code.
    await page.keyboard.press(']')
    await page.waitForTimeout(600)
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(600)

    const KEYS = 8
    const before = await cameras(page)
    await counter.begin()
    await commits.begin()
    for (let i = 0; i < KEYS; i++) {
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(150)
    }
    await page.waitForTimeout(800)
    const elements = await counter.end()
    const committed = await commits.end()
    const after = await cameras(page)

    const movedIds = Object.keys(before).filter(id => after[id] && after[id].x !== before[id].x)
    console.log(
      `[TEST-P3] keys=${KEYS} moved=${JSON.stringify(movedIds)} elements=${elements.total} ` +
        `CellView=${elements.byComponent.CellView ?? 0} PaneToolbar=${elements.byComponent.PaneToolbar ?? 0} ` +
        `commits=${committed.commits}`,
    )
    console.log(
      '[TEST-P3] top components: ' +
        Object.entries(elements.byComponent)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([k, v]) => `${k}=${v}`)
          .join(' '),
    )

    // NON-VACUITY, asserted before the verdicts — each in its OWN clause so a red names one cause.
    expect(movedIds.length, 'the keyboard drive must actually have moved a camera').toBeGreaterThan(0)
    expect(
      elements.total,
      'the drive must have created SOME elements (the camera-driven deck layer), or the counter ' +
        'measured nothing and every zero below is a non-measurement',
    ).toBeGreaterThan(0)
    expect(committed.commits, 'the mutation must have committed at least once').toBeGreaterThan(0)

    // THE INVARIANT. One clause per component: a conjunction would let a red name the reader
    // instead of the defect.
    for (const name of CHROME) {
      expect(
        elements.byComponent[name] ?? 0,
        `${name} must not be re-created by a camera-only mutation`,
      ).toBe(0)
    }
    // …and no work beyond the one commit each mutation schedules for itself.
    expect(
      committed.commits,
      `a camera-only mutation must schedule no extra commit: ${committed.commits} commits for ${KEYS} keypresses`,
    ).toBeLessThanOrEqual(KEYS)
  })

  // ── TEST-12 (ITEM-1/2/12/17, INV-8) [acceptance]: per-pane dock parity ──────────────────────────
  //
  // Four panes, four docks, all at once — the shape DRIFT-22's probe measured and the shape the
  // pre-`annotate-tooling-ux` defect (resolve only the FIRST open pane) turned red. Red if `memo`
  // skips a render on an `editOpen`/`annotateOpen`/`segmentOpen` transition: the perf counters
  // report green on exactly that.
  //
  // THE CONTROL PANES ARE ACTIVE, NOT IDLE (the clause insists on it): every one of the four panes
  // has a dock of its own open, so "the others were unaffected" is a real observation about four
  // live docks rather than the trivial truth that three empty panes stayed empty.
  //
  // Viewport 1920x1040 rather than the config's 1280x820: four panes plus a 300px dock at 1280
  // folds the sibling toolbars, and `pressPaneTool` would then drive the test through the overflow
  // panel — which is a legitimate path but makes the SUBJECT the fold rather than the parity.
  test('TEST-12 four panes each hold their own dock, independently, at the same time', async ({ page }) => {
    test.setTimeout(300_000)
    await page.setViewportSize({ width: 1920, height: 1040 })
    await openPerfStory(page, 'per-pane-editing', {}, { settleMs: 9000 })
    await expect(page.locator('[data-viz-cell]')).toHaveCount(4)

    // PREMISE — nothing is pressed and nothing is open before the drive.
    for (const [cell, key] of [
      [PPE.annA, 'edit'],
      [PPE.annB, 'annotate'],
      [PPE.segA, 'segment'],
      [PPE.segB, 'edit'],
    ] as const) {
      expect(await pressedStates(page, cell, key), `${key} on ${cell} must start unpressed`).toEqual(['false'])
    }

    // FOUR (pane, dock) pairs: three distinct dock kinds, and `edit` on two DIFFERENT panes — which
    // is itself the "two of the same dock open at once" case (Split C's TEST-6b) rather than a
    // repetition.
    const OPENED = [
      { cell: PPE.annA, key: 'edit', dock: `edit:${PPE.annA}` },
      { cell: PPE.annB, key: 'annotate', dock: `annotate:${PPE.annB}` },
      { cell: PPE.segA, key: 'segment', dock: `segment:${PPE.segA}` },
      { cell: PPE.segB, key: 'edit', dock: `edit:${PPE.segB}` },
    ] as const
    for (const o of OPENED) await pressPaneTool(page, o.cell, o.key)
    await page.waitForTimeout(1500)

    const docks = await dockMap(page)
    console.log(`[TEST-12] docks after four opens: ${JSON.stringify(docks)}`)

    // (a) all four are open SIMULTANEOUSLY — asserted as the exact open set, so a fifth dock
    //     appearing (the "opens every capable pane at once" defect) is also a red.
    const openSet = Object.entries(docks)
      .filter(([, open]) => open)
      .map(([k]) => k)
      .sort()
    expect(openSet, 'exactly the four docks that were opened may be open').toEqual(
      OPENED.map(o => o.dock).sort(),
    )

    // (b) each toolbar button's pressed state tracks ITS OWN pane. Asserted over ALL EIGHT
    //     (pane, dock) buttons — the four that were opened and the four that were not — because
    //     "A is pressed" is only half of per-pane parity.
    const pressedTable: Record<string, string[]> = {}
    for (const [cell, key] of [
      [PPE.annA, 'edit'],
      [PPE.annB, 'edit'],
      [PPE.segA, 'edit'],
      [PPE.segB, 'edit'],
      [PPE.annA, 'annotate'],
      [PPE.annB, 'annotate'],
      [PPE.segA, 'segment'],
      [PPE.segB, 'segment'],
    ] as const) {
      pressedTable[`${key}:${cell}`] = await pressedStates(page, cell, key)
    }
    console.log(`[TEST-12] pressed: ${JSON.stringify(pressedTable)}`)
    const expectedPressed = new Set(OPENED.map(o => `${o.key}:${o.cell}`))
    for (const [label, values] of Object.entries(pressedTable)) {
      const want = expectedPressed.has(label) ? 'true' : 'false'
      // EVERY site of the testid must agree — the toolbar strip and the overflow panel both render
      // it, and a single stale site is a real per-pane-parity defect.
      expect(values, `${label} must read aria-pressed="${want}" at every site it renders`).toEqual(
        values.map(() => want),
      )
      expect(values.length, `${label} must render at least one site`).toBeGreaterThan(0)
      expect(values[0], `${label} must read aria-pressed="${want}"`).toBe(want)
    }

    // (c) independently OPERABLE, not merely present: each dock exposes its own controls and names
    //     its own pane. A stack of four docks that cannot say which dataset each edits is unusable,
    //     and four docks all reading the same pane is the exact single-active-pane defect.
    const internals = await page.evaluate(ids => {
      const q = (s: string) => document.querySelector(`[data-testid="${s}"]`) != null
      const txt = (s: string) => document.querySelector(`[data-testid="${s}"]`)?.textContent?.trim() ?? null
      return {
        editTitleAnnA: q(`viz-edit-title-${ids.annA}`),
        editTitleSegB: q(`viz-edit-title-${ids.segB}`),
        annotateToolAnnB: q(`annotate-controls-${ids.annB}-tool-polygon`),
        maskPickerSegA: q(`viz-mask-target-picker-${ids.segA}`),
        annotateTitleAnnB: txt(`viz-annotate-panel-title-${ids.annB}`),
        maskTitleSegA: txt(`viz-mask-panel-title-${ids.segA}`),
      }
    }, PPE as unknown as Record<string, string>)
    console.log(`[TEST-12] dock internals: ${JSON.stringify(internals)}`)
    expect(internals.editTitleAnnA, `${PPE.annA}'s edit form must expose its own title control`).toBe(true)
    expect(internals.editTitleSegB, `${PPE.segB}'s edit form must expose its own title control`).toBe(true)
    expect(internals.annotateToolAnnB, `${PPE.annB}'s annotate dock must expose its own tools`).toBe(true)
    expect(internals.maskPickerSegA, `${PPE.segA}'s segment dock must expose its own controls`).toBe(true)
    expect(internals.annotateTitleAnnB, 'the annotate dock must name its own pane').toBeTruthy()
    expect(internals.maskTitleSegA, 'the segment dock must name its own pane').toBeTruthy()
    expect(
      internals.annotateTitleAnnB,
      'the annotate and segment docks must not name the SAME pane',
    ).not.toBe(internals.maskTitleSegA)

    // (d) closing ONE leaves the other three open, and flips only its OWN button.
    await pressPaneTool(page, PPE.annB, 'annotate')
    await page.waitForTimeout(1200)
    const afterClose = await dockMap(page)
    console.log(`[TEST-12] docks after closing annotate:${PPE.annB}: ${JSON.stringify(afterClose)}`)
    const stillOpen = Object.entries(afterClose)
      .filter(([, open]) => open)
      .map(([k]) => k)
      .sort()
    expect(stillOpen, 'closing one dock must leave exactly the other three open').toEqual(
      OPENED.filter(o => o.dock !== `annotate:${PPE.annB}`)
        .map(o => o.dock)
        .sort(),
    )
    expect(await pressedStates(page, PPE.annB, 'annotate'), 'the closed dock\'s button must release').toEqual(
      ['false'],
    )
    expect(await pressedStates(page, PPE.annA, 'edit'), 'a sibling dock\'s button must stay pressed').toEqual([
      'true',
    ])
  })

  // ── TEST-12b (ITEM-17, INV-8): the `dataOpen` flag, on the story that has a table ───────────────
  // `#per-pane-editing` has no table-capable cell, so the fourth open-set flag PLAN_AUDIT names
  // (`dataOpen`) would be uncovered by TEST-12 alone. Same parity property, second story — which
  // is also how DRIFT-22's probe measured six surfaces (two stories), not four.
  test('TEST-12b a data table and an edit form live on different panes at once', async ({ page }) => {
    test.setTimeout(300_000)
    await page.setViewportSize({ width: 1920, height: 1040 })
    await openPerfStory(page, 'plot-editing', {}, { settleMs: 9000 })
    await expect(page.locator('[data-viz-cell]')).toHaveCount(4)

    expect(await pressedStates(page, PE.cont, 'data'), 'the table must start closed').toEqual(['false'])
    expect(await pressedStates(page, PE.cat, 'edit'), 'the edit form must start closed').toEqual(['false'])

    await pressPaneTool(page, PE.cont, 'data')
    await pressPaneTool(page, PE.cat, 'edit')
    await page.waitForTimeout(1200)

    const state = await page.evaluate(ids => {
      const q = (s: string) => document.querySelector(`[data-testid="${s}"]`) != null
      return {
        editCat: q(`viz-edit-form-${ids.cat}`),
        editCont: q(`viz-edit-form-${ids.cont}`),
      }
    }, PE as unknown as Record<string, string>)
    const pressed = {
      dataCont: await pressedStates(page, PE.cont, 'data'),
      dataCat: await pressedStates(page, PE.cat, 'data'),
      editCat: await pressedStates(page, PE.cat, 'edit'),
      editCont: await pressedStates(page, PE.cont, 'edit'),
    }
    console.log(`[TEST-12b] state=${JSON.stringify(state)} pressed=${JSON.stringify(pressed)}`)

    expect(pressed.dataCont, `the table opened on ${PE.cont}, so its own button is pressed`).toEqual(['true'])
    expect(pressed.dataCat, `${PE.cat}'s table button must NOT be pressed by ${PE.cont}'s table`).toEqual([
      'false',
    ])
    expect(pressed.editCat, `the edit form opened on ${PE.cat}`).toEqual(['true'])
    expect(pressed.editCont, `${PE.cont}'s edit button must NOT be pressed by its table`).toEqual(['false'])
    expect(state.editCat, `${PE.cat}'s edit form must be mounted`).toBe(true)
    expect(state.editCont, `${PE.cont} has no edit form open, so none may be mounted`).toBe(false)

    // Closing the table leaves the other pane's edit form alone (the transition `memo` can drop).
    await pressPaneTool(page, PE.cont, 'data')
    await page.waitForTimeout(1000)
    expect(await pressedStates(page, PE.cont, 'data'), 'the table button must release').toEqual(['false'])
    expect(
      await page.locator(`[data-testid="viz-edit-form-${PE.cat}"]`).count(),
      "closing one pane's table must not close another pane's edit form",
    ).toBe(1)
  })

  // ── TEST-13 (ITEM-5/6/16, INV-9) [acceptance]: direct manipulation across the split ─────────────
  //
  // Three clauses, each of which a one-frame-stale camera read or a consumed focus press breaks:
  //
  //  (a) FIRST PRESS. With an editing surface open on pane B, ONE press-drag inside pane A pans
  //      pane A — no press spent establishing focus. The pan is compared to the drag delta, not
  //      merely to zero: `world = px / 2^zoom`, and the MEASURED ratio on this fixture is 0.90
  //      (one of the ten 6px steps is consumed initiating the deck drag), so the bracket is
  //      [0.6, 1.15]. A stale read reports ~0 and a mis-scaled read leaves the bracket.
  //  (b) ISOLATION. With link-zoom OFF, pane B's camera is bit-unchanged. `#per-pane-editing`
  //      ships link-zoom ON, so this leg TOGGLES it and asserts the toggle actually flipped —
  //      an isolation claim measured with linking silently on would be a false green.
  //  (c) FAN-OUT + a BIT-IDENTICAL keyboard round trip. With link-zoom back ON the same drag moves
  //      every same-space pane; then ArrowRight x8 changes deck's pixels and ArrowLeft x8 restores
  //      the EXACT signature. That last part is the Split-A camera probe verbatim.
  //      WHAT IT ACTUALLY DETECTS, measured (DEC-41): a camera path that LOSES information — equal
  //      and opposite steps cannot land on the same pixels through a lossy or asymmetric read/write
  //      (proven: a 1px-short ArrowLeft turns it red). It does NOT detect a one-frame-stale
  //      `viewStateRef`: injected, the round trip stayed bit-identical, because at this keypress
  //      cadence the ref has caught up before the next read. DECISIONS.md's original claim that this
  //      probe speaks to a stale read is corrected there; the clause is kept for what it does catch.
  test('TEST-13 a press-drag pans on the first press, alone when unlinked, together when linked', async ({
    page,
  }) => {
    test.setTimeout(420_000)
    await openPerfStory(page, 'per-pane-editing', {}, { settleMs: 9000 })
    await expect(page.locator('[data-viz-cell]')).toHaveCount(4)

    // The editing surface on pane B — the whole point of the clause is that pane A is still
    // directly manipulable while ANOTHER pane is being edited.
    await pressPaneTool(page, PPE.annB, 'annotate')
    await expect(page.locator(`[data-testid="viz-annotate-panel-${PPE.annB}"]`)).toHaveCount(1)

    // Unlink, and PROVE the toggle flipped before relying on it.
    const linkToggle = page.locator('[data-testid="viz-tool-rail-toggle-link-zoom"]')
    const linkedAtStart = await linkToggle.getAttribute('aria-pressed')
    expect(linkedAtStart, 'this story ships with link-zoom ON — the isolation leg needs to turn it off').toBe(
      'true',
    )
    await linkToggle.click()
    await page.waitForTimeout(600)
    expect(await linkToggle.getAttribute('aria-pressed'), 'link-zoom must actually be OFF now').toBe('false')

    // ── (a) + (b): ONE press-drag inside pane A ────────────────────────────────────────────────
    const aim = await paneCentre(page, 0) // pane 0 == PPE.annA, verified to sit on deck's canvas
    const DX = 60
    const DY = 30
    const before = await cameras(page)
    await page.mouse.move(aim.x, aim.y)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(aim.x + (DX * i) / 10, aim.y + (DY * i) / 10)
      await page.waitForTimeout(30)
    }
    await page.mouse.up()
    await page.waitForTimeout(900)
    const afterDrag = await cameras(page)

    const camA = { before: before[PPE.annA], after: afterDrag[PPE.annA] }
    const camB = { before: before[PPE.annB], after: afterDrag[PPE.annB] }
    expect(camA.before, `pane ${PPE.annA} must publish a camera`).toBeTruthy()
    expect(camB.before, `pane ${PPE.annB} must publish a camera`).toBeTruthy()
    const scale = 2 ** camA.before.zoom
    const worldDx = camA.after.x - camA.before.x
    const worldDy = camA.after.y - camA.before.y
    const expectDx = DX / scale
    const expectDy = DY / scale
    console.log(
      `[TEST-13] unlinked drag px=(${DX},${DY}) zoom=${camA.before.zoom.toFixed(4)} ` +
        `world=(${worldDx.toFixed(2)},${worldDy.toFixed(2)}) expected≈(${(-expectDx).toFixed(2)},${expectDy.toFixed(2)}) ` +
        `paneB=(${camB.after.x - camB.before.x},${camB.after.y - camB.before.y})`,
    )

    // FIRST PRESS: the single drag moved pane A. Direction first (a pan opposes the drag in x and
    // follows it in y — world y points down in this space), then magnitude.
    expect(worldDx, 'a rightward drag must pan pane A left, on the FIRST press').toBeLessThan(0)
    expect(worldDy, 'a downward drag must move pane A\'s target down, on the FIRST press').toBeGreaterThan(0)
    expect(
      Math.abs(worldDx) / expectDx,
      `the x pan must match the drag delta (world ${worldDx.toFixed(2)} vs expected ${(-expectDx).toFixed(2)})`,
    ).toBeGreaterThan(0.6)
    expect(Math.abs(worldDx) / expectDx, 'the x pan must not overshoot the drag delta').toBeLessThan(1.15)
    expect(
      worldDy / expectDy,
      `the y pan must match the drag delta (world ${worldDy.toFixed(2)} vs expected ${expectDy.toFixed(2)})`,
    ).toBeGreaterThan(0.6)
    expect(worldDy / expectDy, 'the y pan must not overshoot the drag delta').toBeLessThan(1.15)

    // ISOLATION: unlinked, pane B did not move at all — and it is an ACTIVE pane (its annotate dock
    // is open), so this is a real observation.
    expect(camB.after.x, `unlinked, pane ${PPE.annB}'s target x must not move`).toBe(camB.before.x)
    expect(camB.after.y, `unlinked, pane ${PPE.annB}'s target y must not move`).toBe(camB.before.y)
    expect(camB.after.zoom, `unlinked, pane ${PPE.annB}'s zoom must not move`).toBe(camB.before.zoom)

    // ── (c) link-zoom back ON: the same drag moves every same-space pane ───────────────────────
    await linkToggle.click()
    await page.waitForTimeout(600)
    expect(await linkToggle.getAttribute('aria-pressed'), 'link-zoom must be back ON').toBe('true')
    const beforeLinked = await cameras(page)
    const aim2 = await paneCentre(page, 0)
    await page.mouse.move(aim2.x, aim2.y)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(aim2.x - (DX * i) / 10, aim2.y - (DY * i) / 10)
      await page.waitForTimeout(30)
    }
    await page.mouse.up()
    await page.waitForTimeout(900)
    const afterLinked = await cameras(page)
    const movedLinked = Object.keys(beforeLinked).filter(
      id => afterLinked[id] && afterLinked[id].x !== beforeLinked[id].x,
    )
    console.log(`[TEST-13] linked drag moved: ${JSON.stringify(movedLinked)}`)
    expect(
      movedLinked.sort(),
      'with link-zoom ON the drag must fan out to every same-space pane',
    ).toEqual(Object.keys(beforeLinked).sort())

    // ── (c2) the BIT-IDENTICAL keyboard pan round trip ─────────────────────────────────────────
    const workspace = page.locator('[data-testid="viz-grid-workspace"]')
    await workspace.focus()
    await page.keyboard.press(']')
    await page.waitForTimeout(500)
    const sig0 = await deckSignature(page)
    // An empty signature means the canvas was unreadable; comparing two empties would make the
    // round trip pass on a page with no canvas at all.
    expect(sig0, 'deck\'s canvas must produce a signature, or the round trip is unmeasurable').not.toBe('')
    const STEPS = 8
    for (let i = 0; i < STEPS; i++) {
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(120)
    }
    await page.waitForTimeout(700)
    const sigOut = await deckSignature(page)
    for (let i = 0; i < STEPS; i++) {
      await page.keyboard.press('ArrowLeft')
      await page.waitForTimeout(120)
    }
    await page.waitForTimeout(700)
    const sigBack = await deckSignature(page)
    console.log(`[TEST-13] pan round trip: ${sig0} -> ${sigOut} -> ${sigBack}`)
    expect(sigOut, 'ArrowRight must actually move the rendered image, or the round trip is vacuous').not.toBe(
      sig0,
    )
    expect(sigBack, 'an equal-and-opposite keyboard pan must restore BIT-IDENTICAL pixels').toBe(sig0)
  })

  // ── TEST-26 (ITEM-16, Split B): the annotate draw overlay is INSTANCED PER OPEN PANE ────────────
  //
  // THE ONE CLAUSE OF TEST-26 THAT NOTHING ELSE MAKES. TEST-26's row lists six parity clauses; five
  // are driven by enumerated specs re-run in TEST-17's sweep (DEC-51). The sixth — "the annotate
  // draw overlay renders once PER OPEN ANNOTATE PANE (not once globally) and draws to the correct
  // pane's geometry" — is an INSTANCING claim, and it is only PARTIALLY covered: `annotate-tooling-
  // ux.e2e.mjs`'s H2 block asserts, with EXACTLY ONE dock open, that the open pane's centre resolves
  // to its own overlay and that a closed / non-annotate pane's centre resolves to none. That catches
  // a collapse to one global sheet. It does NOT catch the second half, because with one dock open
  // "the only open pane" and "the first open pane" are the same pane:
  //
  //   *** two docks open, and EVERY overlay positioned at the FIRST open pane's rect ***
  //
  // passes H2's single-open geometry check, passes H2's two-open wheel-listener check (each element
  // is read at its OWN bounding rect, which is the same rect), passes every node-identity check in
  // the suite — and leaves the second annotating pane covered by nothing, i.e. unable to author at
  // all. That is the defect this test exists for, and it is exactly the singular-vs-plural class
  // the layer's own comment says the geometry fix was for.
  //
  // SO THE SUBJECT IS THE TWO-OPEN CASE, on both halves the clause names:
  //   (a) COUNT + IDENTITY — exactly two overlays; their pane ids are exactly the open set; no
  //       overlay for a closed annotate pane, none for a pane that cannot annotate, and none that
  //       carries no pane id at all (a global sheet). Read through `[data-annotate-overlay="1"]`,
  //       NOT through a per-pane testid query — a query that names the ids it expects cannot see an
  //       overlay for a pane nobody opened, which is half of what "once per open pane" forbids.
  //   (b) GEOMETRY — each overlay's box lies inside ITS OWN pane, the two boxes are DISJOINT, and
  //       `elementFromPoint` at each pane's plot centre resolves to that pane's own overlay.
  //   (c) COORDINATE SPACE, behaviourally — with link-zoom OFF and pane A panned so the two cameras
  //       genuinely differ, a point-tool click at each overlay's centre commits into THAT pane's
  //       store and lands at THAT pane's camera target. The overlay rect IS the deck view rect
  //       (`useGridDeckInputs.ts:181` builds the views from the same `denseRects.map(plotInset)`),
  //       so "the point dropped at the view centre is the camera target" is an identity, and the
  //       measured separation between the two targets is what makes it discriminating rather than a
  //       restatement. The test REFUSES to assert it if the pan did not separate the cameras.
  //   (d) CLOSING ONE leaves exactly one overlay, and it is the pane still open.
  //
  // THE GREEN CONTROL, asserted at every step: the annotate DOCK panels (`viz-annotate-panel-<id>`)
  // stay at two, then one. They are a DIFFERENT layer (the dock layer, TEST-12's subject), so a
  // mutation confined to the overlay layer must leave them untouched — which is what makes a red
  // here a statement about the overlay rather than about a fixture that failed to open two docks.
  //
  // Viewport 1920x1040 for the same reason as TEST-12: at 1280 a dock folds the sibling toolbars and
  // the subject becomes the fold.
  test('TEST-26 the annotate draw overlay is instanced per OPEN pane and routed to its own pane geometry', async ({
    page,
  }) => {
    test.setTimeout(420_000)
    await page.setViewportSize({ width: 1920, height: 1040 })
    await openPerfStory(page, 'per-pane-editing', {}, { settleMs: 9000 })
    expect(
      Object.keys(await paneGeometry(page)).sort(),
      'the fixture must render all four panes, or every per-pane claim below is about a subset',
    ).toEqual([PPE.annA, PPE.annB, PPE.segA, PPE.segB].sort())

    // PREMISE — no overlay exists before any dock opens. Without this a later count of two could be
    // a fixture constant rather than a consequence of the two opens.
    expect(
      await page.locator('[data-annotate-overlay="1"]').count(),
      'no annotate overlay may be mounted before any annotate dock is opened',
    ).toBe(0)

    // SEPARATE THE TWO CAMERAS FIRST, WHILE NO OVERLAY IS IN THE WAY. Clause (c) needs pane A's and
    // pane B's camera targets to differ, or "the point landed at ITS pane's target" is satisfied by
    // the other pane's target too and measures nothing. The pan is done HERE, before either dock
    // opens, for a mechanical reason: once a pane's annotate overlay is up it OWNS that pane's
    // pointer surface (that is the property under test), so `paneCentre` — which requires a point
    // resolving to `canvas#deckgl-overlay` — correctly refuses to aim there.
    const linkToggle = page.locator('[data-testid="viz-tool-rail-toggle-link-zoom"]')
    expect(
      await linkToggle.getAttribute('aria-pressed'),
      'this story ships with link-zoom ON — the coordinate-space leg needs it OFF',
    ).toBe('true')
    await linkToggle.click()
    await page.waitForTimeout(600)
    expect(await linkToggle.getAttribute('aria-pressed'), 'link-zoom must actually be OFF now').toBe('false')

    const aimA = await paneCentre(page, 0) // pane 0 == PPE.annA
    await page.mouse.move(aimA.x, aimA.y)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(aimA.x + 12 * i, aimA.y + 6 * i)
      await page.waitForTimeout(30)
    }
    await page.mouse.up()
    await page.waitForTimeout(900)

    await pressPaneTool(page, PPE.annA, 'annotate')
    await pressPaneTool(page, PPE.annB, 'annotate')
    await page.waitForTimeout(1200)

    // GREEN CONTROL (dock layer) — both docks are up. Every clause below is about the OVERLAY layer;
    // this is the neighbouring layer that a correct overlay mutation must not disturb.
    const docksOpen = await dockPanelIds(page)
    console.log(`[TEST-26] annotate dock panels open: ${JSON.stringify(docksOpen)}`)
    expect(docksOpen, 'GREEN CONTROL: both annotate docks must be open').toEqual(
      [PPE.annA, PPE.annB].sort(),
    )

    // ── (a) COUNT + IDENTITY ───────────────────────────────────────────────────────────────────
    const overlays = await annotateOverlays(page)
    console.log(
      `[TEST-26] overlays: ${JSON.stringify(overlays.map(o => ({ id: o.paneId, testid: o.testId, box: o.box })))}`,
    )
    expect(
      overlays.map(o => o.paneId).sort(),
      'exactly one annotate overlay per OPEN pane — the pane ids must equal the open set',
    ).toEqual([PPE.annA, PPE.annB].sort())
    expect(
      overlays.map(o => o.testId).sort(),
      'each overlay must be addressable by its OWN pane id (a global sheet carries none)',
    ).toEqual([`viz-grid-annotate-overlay-${PPE.annA}`, `viz-grid-annotate-overlay-${PPE.annB}`].sort())

    // ── (b) GEOMETRY ──────────────────────────────────────────────────────────────────────────
    const geom = await paneGeometry(page)
    for (const id of [PPE.annA, PPE.annB, PPE.segA, PPE.segB] as const)
      expect(geom[id]?.pane, `pane ${id} must publish a box, or no containment claim is measurable`).toBeTruthy()
    const byPane = new Map(overlays.map(o => [o.paneId, o.box]))
    for (const id of [PPE.annA, PPE.annB] as const) {
      const o = byPane.get(id)!
      const own = geom[id].pane
      // A ZERO-AREA overlay is contained in everything, so it would satisfy every containment
      // clause below while covering nothing. Refuse it rather than pass it.
      expect(o.width, `overlay ${id} must have real width`).toBeGreaterThan(50)
      expect(o.height, `overlay ${id} must have real height`).toBeGreaterThan(50)
      expect(o.x, `overlay ${id} must start inside pane ${id}`).toBeGreaterThanOrEqual(own.x - 1)
      expect(o.y, `overlay ${id} must start inside pane ${id}`).toBeGreaterThanOrEqual(own.y - 1)
      expect(o.x + o.width, `overlay ${id} must end inside pane ${id}`).toBeLessThanOrEqual(
        own.x + own.width + 1,
      )
      expect(o.y + o.height, `overlay ${id} must end inside pane ${id}`).toBeLessThanOrEqual(
        own.y + own.height + 1,
      )
    }
    // DISJOINT: two overlays routed to one pane's rect are identical, and identical rects overlap.
    const [oa, ob] = [byPane.get(PPE.annA)!, byPane.get(PPE.annB)!]
    const overlapX = Math.min(oa.x + oa.width, ob.x + ob.width) - Math.max(oa.x, ob.x)
    const overlapY = Math.min(oa.y + oa.height, ob.y + ob.height) - Math.max(oa.y, ob.y)
    console.log(`[TEST-26] overlay overlap: x=${overlapX.toFixed(1)} y=${overlapY.toFixed(1)}`)
    expect(
      Math.min(overlapX, overlapY),
      "the two panes' overlays must not overlap — a shared rect is the mis-routed-geometry defect",
    ).toBeLessThanOrEqual(0)

    // HIT-TEST with BOTH open — the case `annotate-tooling-ux`'s H2 never reaches.
    const hits: Record<string, string> = {}
    for (const id of [PPE.annA, PPE.annB, PPE.segA, PPE.segB] as const)
      hits[id] = await overlayAtPlotCentre(page, id)
    console.log(`[TEST-26] elementFromPoint at each pane's plot centre: ${JSON.stringify(hits)}`)
    expect(hits[PPE.annA], `pane ${PPE.annA} must be covered by its OWN overlay`).toBe(
      `viz-grid-annotate-overlay-${PPE.annA}`,
    )
    expect(hits[PPE.annB], `pane ${PPE.annB} must be covered by its OWN overlay`).toBe(
      `viz-grid-annotate-overlay-${PPE.annB}`,
    )
    expect(hits[PPE.segA], `pane ${PPE.segA} cannot annotate, so nothing may cover it`).toBe('none')
    expect(hits[PPE.segB], `pane ${PPE.segB} cannot annotate, so nothing may cover it`).toBe('none')

    // ── (c) COORDINATE SPACE, behaviourally ───────────────────────────────────────────────────
    // The cameras were separated before the docks opened (above). Re-read them HERE, with both
    // docks up, because opening a dock resizes every pane — the separation that matters is the one
    // in force at the moment the presses are made, not the one measured before the layout moved.
    const cams = await cameras(page)
    const tA = cams[PPE.annA]
    const tB = cams[PPE.annB]
    expect(tA, `pane ${PPE.annA} must publish a camera`).toBeTruthy()
    expect(tB, `pane ${PPE.annB} must publish a camera`).toBeTruthy()
    const sep = Math.hypot(tA.x - tB.x, tA.y - tB.y)
    console.log(
      `[TEST-26] cameras with both docks open: A=(${tA.x.toFixed(1)},${tA.y.toFixed(1)}) ` +
        `B=(${tB.x.toFixed(1)},${tB.y.toFixed(1)}) separation=${sep.toFixed(1)}`,
    )
    // NON-MEASUREMENT GUARD: without a real separation the two targets are interchangeable and the
    // clause below is a tautology. Refuse, never report a comfortable pass.
    if (!(sep > 20))
      throw new Error(
        `the unlinked pan separated the two cameras by only ${sep.toFixed(2)} world units. Below ` +
          `that the "landed at ITS pane's target" clause is satisfied by the OTHER pane's target ` +
          `too, so it would measure nothing. Refusing to assert it.`,
      )

    // Point tool in BOTH docks: one press commits one annotation at the unprojected world point.
    for (const id of [PPE.annA, PPE.annB] as const) {
      const tool = page.locator(`[data-testid="annotate-controls-${id}-tool-point"]`)
      await expect(tool, `pane ${id}'s dock must expose its own point tool`).toHaveCount(1)
      await tool.click({ timeout: 15_000 })
      await page.waitForTimeout(250)
    }

    const before = { a: await annotateCount(page, PPE.annA), b: await annotateCount(page, PPE.annB) }
    expect(before.a, `pane ${PPE.annA}'s annotate store must be readable`).toBeGreaterThanOrEqual(0)
    expect(before.b, `pane ${PPE.annB}'s annotate store must be readable`).toBeGreaterThanOrEqual(0)

    // Press at the CENTRE OF EACH OVERLAY (not of the pane) — the overlay rect is the deck view
    // rect, so its centre is the camera target in world space.
    const afterA = await pressOverlayCentre(page, PPE.annA)
    const midCounts = { a: await annotateCount(page, PPE.annA), b: await annotateCount(page, PPE.annB) }
    const afterB = await pressOverlayCentre(page, PPE.annB)
    const endCounts = { a: await annotateCount(page, PPE.annA), b: await annotateCount(page, PPE.annB) }
    const ptA = await lastPointXY(page, PPE.annA)
    const ptB = await lastPointXY(page, PPE.annB)
    console.log(
      `[TEST-26] counts ${JSON.stringify(before)} -> ${JSON.stringify(midCounts)} -> ` +
        `${JSON.stringify(endCounts)}; pressed A@${JSON.stringify(afterA)} B@${JSON.stringify(afterB)}; ` +
        `ptA=${JSON.stringify(ptA)} ptB=${JSON.stringify(ptB)}`,
    )

    expect(midCounts.a, `the press inside ${PPE.annA} must commit into ${PPE.annA}`).toBe(before.a + 1)
    expect(midCounts.b, `…and must NOT commit into ${PPE.annB}`).toBe(before.b)
    expect(endCounts.b, `the press inside ${PPE.annB} must commit into ${PPE.annB}`).toBe(before.b + 1)
    expect(endCounts.a, `…and must NOT add a second one to ${PPE.annA}`).toBe(before.a + 1)

    expect(ptA, `${PPE.annA}'s committed point must carry world coordinates`).toBeTruthy()
    expect(ptB, `${PPE.annB}'s committed point must carry world coordinates`).toBeTruthy()
    const dAown = Math.hypot(ptA![0] - tA.x, ptA![1] - tA.y)
    const dAother = Math.hypot(ptA![0] - tB.x, ptA![1] - tB.y)
    const dBown = Math.hypot(ptB![0] - tB.x, ptB![1] - tB.y)
    const dBother = Math.hypot(ptB![0] - tA.x, ptB![1] - tA.y)
    console.log(
      `[TEST-26] |pt-ownTarget| A=${dAown.toFixed(1)} B=${dBown.toFixed(1)} | ` +
        `|pt-otherTarget| A=${dAother.toFixed(1)} B=${dBother.toFixed(1)} | sep=${sep.toFixed(1)}`,
    )
    // The point dropped at a view's centre IS that view's camera target. Stated relative to the
    // MEASURED separation so the bracket cannot be tightened into flake or loosened into vacuity:
    // "much nearer its own target than the panes are apart".
    expect(
      dAown,
      `${PPE.annA}'s point was unprojected through the wrong pane's camera (own ${dAown.toFixed(1)} vs sep ${sep.toFixed(1)})`,
    ).toBeLessThan(sep * 0.4)
    expect(dBown, `${PPE.annB}'s point was unprojected through the wrong pane's camera`).toBeLessThan(
      sep * 0.4,
    )
    expect(dAown, `${PPE.annA}'s point must be nearer ITS OWN camera target than the other pane's`).toBeLessThan(
      dAother,
    )
    expect(dBown, `${PPE.annB}'s point must be nearer ITS OWN camera target than the other pane's`).toBeLessThan(
      dBother,
    )

    // ── (d) CLOSE ONE ─────────────────────────────────────────────────────────────────────────
    await pressPaneTool(page, PPE.annB, 'annotate')
    await page.waitForTimeout(1200)
    const survivors = await annotateOverlays(page)
    console.log(`[TEST-26] overlays after closing ${PPE.annB}: ${JSON.stringify(survivors.map(o => o.testId))}`)
    expect(
      survivors.map(o => o.paneId),
      `closing ${PPE.annB}'s dock must leave exactly ${PPE.annA}'s overlay`,
    ).toEqual([PPE.annA])
    expect(await overlayAtPlotCentre(page, PPE.annB), `${PPE.annB} is closed, so nothing may cover it`).toBe(
      'none',
    )
    expect(await overlayAtPlotCentre(page, PPE.annA), `${PPE.annA} is still open, so its own overlay covers it`).toBe(
      `viz-grid-annotate-overlay-${PPE.annA}`,
    )

    // GREEN CONTROL again — the dock layer tracked the close, and only the close.
    expect(await dockPanelIds(page), 'GREEN CONTROL: exactly the still-open pane keeps its dock').toEqual([
      PPE.annA,
    ])
  })

  // ── TEST-28 (ITEM-15): SPLIT D — the pane-chrome surface, end to end ────────────────────────────
  //
  // Split D moved the widest prop boundary in `GridWorkspace.tsx`: one `<CellView>` per measured
  // rect, the in-cell legend / visual-map overlay, the plot-title overlay, the per-cell link
  // affordances — and, with them, the three measurement bindings (`registerPane`, `measure`,
  // `measureLegend`) every one of those surfaces is positioned from. DEC-46 recorded ITEM-15's
  // ONLY surviving coverage as TEST-P8, which is STRUCTURAL (the module exists, declares these
  // names, imports no layer). Nothing anywhere asserted the surface still WORKS. This is that test.
  //
  // THE CENTRAL CLAUSE IS AN ARITHMETIC IDENTITY, NOT A "LOOKS PLACED" CHECK.
  //   wrapperWidth - measuredBlockWidth === LEGEND_GUTTER_PAD - PAD === 2 px
  // It is the whole measured chain in one equation: `measureLegend` writes the rendered block's
  // intrinsic width into `legendWidths`; `legendGutterFor` turns that into a gutter of
  // `measured + 10`; `plotInset` shrinks the deck view by exactly that; and the legend wrapper is
  // laid out into the freed strip minus an 8px pad. Break ANY link and the fallback (a hard-coded
  // 72px guess) takes over and the identity fails by tens of pixels. A "the legend is inside the
  // pane" assertion would pass on all of them.
  //
  // Every clause carries its own green control, because a red that fires on everything proves
  // nothing: the untouched pane's legend box is asserted UNCHANGED by its neighbour's toggle, the
  // untouched pane's title is asserted UNCHANGED by its neighbour's title edit, and the pane<->view
  // box agreement is asserted across the splitter drag that the gutter identity is re-checked after.
  test('TEST-28 the pane-chrome surface survives Split D — measured gutter, hide/show, title, rects, link tint', async ({
    page,
  }) => {
    test.setTimeout(300_000)
    await page.setViewportSize({ width: 1920, height: 1040 })
    await openPerfStory(page, 'plot-editing', {}, { settleMs: 9000 })

    // PREMISE — the fixture carries BOTH interactive legend forms, on named panes. Asserted by KIND
    // so a categorical legend cannot stand in for the visual map (or vice versa) in any clause below.
    await expect(page.locator('[data-viz-cell]')).toHaveCount(4)
    const catL0 = await legendGeometry(page, PE4.cat)
    const contL0 = await legendGeometry(page, PE4.cont)
    expect(catL0?.kind, `pane ${PE4.cat} must render the CATEGORICAL in-cell legend`).toBe('categorical')
    expect(contL0?.kind, `pane ${PE4.cont} must render the CONTINUOUS visual map`).toBe('continuous')

    // ── (a) THE MEASURED GUTTER, for both legend kinds ────────────────────────────────────────────
    await ensureEditOpen(page, PE4.cat)
    // Re-read AFTER the dock opened: a dock steals ~300px from the grid, so every pane (and every
    // overlay legend) moves. The control below must compare like with like.
    const catOverlay = (await legendGeometry(page, PE4.cat))!
    const contBeforeToggle = (await legendGeometry(page, PE4.cont))!

    await setLegendBeside(page, PE4.cat, true)
    const catBeside = (await legendGeometry(page, PE4.cat))!
    console.log(
      `[TEST-28] cat overlay w=${catOverlay.wrapper.width.toFixed(2)} inner=${catOverlay.inner.width.toFixed(2)} | ` +
        `beside w=${catBeside.wrapper.width.toFixed(2)} inner=${catBeside.inner.width.toFixed(2)} ` +
        `delta=${(catBeside.wrapper.width - catBeside.inner.width).toFixed(2)}`,
    )

    // NON-VACUITY — beside mode must actually have changed the layout. An overlay wrapper spans the
    // whole plot; if the toggle did nothing, the identity below would be a claim about overlay mode.
    expect(
      Math.abs(catBeside.wrapper.width - catOverlay.wrapper.width),
      'the beside toggle must have re-laid-out the legend wrapper, or the gutter clause is vacuous',
    ).toBeGreaterThan(20)
    // THE IDENTITY.
    expect(
      catBeside.wrapper.width - catBeside.inner.width,
      'the categorical legend gutter must equal the MEASURED block width + (LEGEND_GUTTER_PAD - PAD). ' +
        'A mismatch means the measure -> gutter -> plotInset -> wrapper chain is broken and the 72px ' +
        'fallback is positioning the chrome.',
    ).toBeCloseTo(GUTTER_IDENTITY_PX, 0)
    // GREEN CONTROL — the neighbouring pane's legend did not move because ITS neighbour toggled.
    const contAfterToggle = (await legendGeometry(page, PE4.cont))!
    expect(
      [contAfterToggle.wrapper.width, contAfterToggle.wrapper.x],
      `toggling ${PE4.cat}'s legend into the gutter must not move ${PE4.cont}'s legend`,
    ).toEqual([contBeforeToggle.wrapper.width, contBeforeToggle.wrapper.x])

    // The SAME identity for the CONTINUOUS visual map — the second of Split D's three legend forms.
    await ensureEditOpen(page, PE4.cont)
    await setLegendBeside(page, PE4.cont, true)
    const contBeside = (await legendGeometry(page, PE4.cont))!
    expect(contBeside.kind, 'the visual map must still be the continuous form in beside mode').toBe('continuous')
    console.log(
      `[TEST-28] cont beside w=${contBeside.wrapper.width.toFixed(2)} inner=${contBeside.inner.width.toFixed(2)} ` +
        `delta=${(contBeside.wrapper.width - contBeside.inner.width).toFixed(2)}`,
    )
    expect(
      contBeside.wrapper.width - contBeside.inner.width,
      'the continuous visual-map gutter must equal its MEASURED block width + (LEGEND_GUTTER_PAD - PAD)',
    ).toBeCloseTo(GUTTER_IDENTITY_PX, 0)

    // ── (b) the categorical legend ROUND-TRIPS a hide/show ────────────────────────────────────────
    // The in-cell legend is a CANVAS (hit-tested internally), so this is a real coordinate press
    // walked down the rows until the per-cell hidden set moves — the technique TEST-F5 established.
    const hid0 = await hiddenCodes(page)
    const canvas = await page.$(`[data-testid="viz-cell-legend-${PE4.cat}"] [data-testid="viz-incell-legend"]`)
    const cb = canvas && (await canvas.boundingBox())
    expect(cb, `pane ${PE4.cat}'s legend canvas must be hit-testable`).not.toBeNull()
    let aim: { x: number; y: number } | null = null
    for (let y = 12; cb && y < cb.height - 4 && !aim; y += 7) {
      await page.mouse.click(cb.x + 12, cb.y + y)
      await page.waitForTimeout(350)
      if ((await hiddenCodes(page)) !== hid0) aim = { x: cb.x + 12, y: cb.y + y }
    }
    expect(aim, `no swatch click changed a hidden set (still ${hid0}) — the hide half is unmeasurable`).not.toBeNull()
    const hid1 = await hiddenCodes(page)
    expect(hid1, 'hiding a category must change the per-cell hidden set').not.toBe(hid0)
    // ISOLATION, on the way past: only the CLICKED pane's entry moved.
    const parsed0 = JSON.parse(hid0) as Record<string, number[]>
    const parsed1 = JSON.parse(hid1) as Record<string, number[]>
    for (const other of [PE4.cont, PE4.box, PE4.violin]) {
      expect(
        JSON.stringify(parsed1[other] ?? []),
        `hiding a category on ${PE4.cat} must not touch ${other}'s hidden set`,
      ).toBe(JSON.stringify(parsed0[other] ?? []))
    }
    // …and BACK. Compared PER CELL, not as raw JSON: un-hiding leaves an EMPTY entry behind
    // (`{}` -> `{cat:[3]}` -> `{cat:[]}`), and an empty set is the same display state as no entry —
    // asserting on the serialized whole would fail on bookkeeping rather than on behaviour.
    await page.mouse.click(aim!.x, aim!.y)
    await page.waitForTimeout(900)
    const parsed2 = JSON.parse(await hiddenCodes(page)) as Record<string, number[]>
    for (const id of [PE4.cat, PE4.cont, PE4.box, PE4.violin]) {
      expect(
        JSON.stringify(parsed2[id] ?? []),
        `a second click on the same swatch must restore ${id}'s hidden set`,
      ).toBe(JSON.stringify(parsed0[id] ?? []))
    }
    // …and the restore is a REAL round trip, not a no-op click: the hide leg genuinely hid something.
    expect(
      JSON.stringify(parsed1[PE4.cat] ?? []),
      'the hide leg must have put at least one code into the clicked pane\'s hidden set',
    ).not.toBe(JSON.stringify(parsed0[PE4.cat] ?? []))

    // ── (c) the plot-title overlay follows a title edit ───────────────────────────────────────────
    const titleOf = (id: string) => page.locator(`[data-testid="viz-cell-title-${id}"]`)
    const contTitle0 = await titleOf(PE4.cont).textContent()
    const NEW_TITLE = 'Split D title probe'
    await ensureEditOpen(page, PE4.cat)
    const titleInput = page.locator(`[data-testid="viz-edit-title-${PE4.cat}"]`)
    await expect(titleInput).toBeVisible()
    await titleInput.fill(NEW_TITLE)
    await titleInput.blur()
    await page.waitForTimeout(900)
    await expect(
      titleOf(PE4.cat),
      'the WYSIWYG plot-title overlay must follow the edit form',
    ).toHaveText(NEW_TITLE)
    // GREEN CONTROL — the neighbour's title is untouched.
    expect(await titleOf(PE4.cont).textContent(), `${PE4.cont}'s title must not follow ${PE4.cat}'s edit`).toBe(
      contTitle0,
    )

    // ── (d) registerPane / measure / measureLegend survive a splitter drag ────────────────────────
    const geomBefore = await paneGeometry(page)
    const catInnerBefore = (await legendGeometry(page, PE4.cat))!.inner.width
    const sep = page.locator('[role="separator"]').first()
    const sepBox = await sep.boundingBox()
    expect(sepBox, 'the fixture must expose a draggable pane divider').not.toBeNull()
    const orientation = await sep.getAttribute('aria-orientation')
    const cx = sepBox!.x + sepBox!.width / 2
    const cy = sepBox!.y + sepBox!.height / 2
    const dx = orientation === 'horizontal' ? 0 : 60
    const dy = orientation === 'horizontal' ? 60 : 0
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + dx, cy + dy, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(1200)
    const geomAfter = await paneGeometry(page)

    // NON-VACUITY — the drag really moved a pane boundary.
    const moved = Object.keys(geomBefore).filter(
      id =>
        Math.abs(geomAfter[id].pane.x - geomBefore[id].pane.x) > 6 ||
        Math.abs(geomAfter[id].pane.width - geomBefore[id].pane.width) > 6 ||
        Math.abs(geomAfter[id].pane.y - geomBefore[id].pane.y) > 6 ||
        Math.abs(geomAfter[id].pane.height - geomBefore[id].pane.height) > 6,
    )
    console.log(`[TEST-28] splitter drag moved panes: ${JSON.stringify(moved)}`)
    expect(moved.length, 'the divider drag must have resized at least one pane').toBeGreaterThan(0)

    // registerPane -> measure -> CellView: every pane's rendered view box still IS its pane box.
    for (const [id, g] of Object.entries(geomAfter)) {
      expect(g.view, `pane ${id} lost its viz-cell-view-${id} after the drag`).not.toBeNull()
      expect(
        Math.abs(g.view!.x - g.pane.x),
        `pane ${id}: the measured CellView box drifted from the pane box on x after the drag`,
      ).toBeLessThanOrEqual(1.5)
      expect(
        Math.abs(g.view!.width - g.pane.width),
        `pane ${id}: the measured CellView box drifted from the pane box on width after the drag`,
      ).toBeLessThanOrEqual(1.5)
    }
    // measureLegend: the legend block's INTRINSIC width is independent of the plot size, so it must
    // be unchanged — and the gutter identity must still hold against it.
    const catAfterDrag = (await legendGeometry(page, PE4.cat))!
    expect(
      Math.abs(catAfterDrag.inner.width - catInnerBefore),
      'the legend block width is intrinsic and must not change with the pane size',
    ).toBeLessThanOrEqual(1.5)
    expect(
      catAfterDrag.wrapper.width - catAfterDrag.inner.width,
      'the measured gutter identity must survive a resize — this is the re-measure path',
    ).toBeCloseTo(GUTTER_IDENTITY_PX, 0)

    // ── (e) per-cell link colors tint the correct panes ───────────────────────────────────────────
    // Minted through the grid's own `__vizLinkCells` dev seam (the link-picking UX is a multi-step
    // manual gesture; the seam writes the same `linkGroups` state it produces).
    const barOf = (id: string) =>
      page.evaluate(cellId => {
        const btn = document.querySelector(`[data-testid="viz-cell-link-${cellId}"]`)
        const bar = btn?.parentElement?.querySelector('span[style*="position: absolute"]') ?? null
        return bar ? getComputedStyle(bar).backgroundColor : null
      }, id)
    expect(await barOf(PE4.cat), 'no link group exists yet, so no pane may carry a link tint').toBeNull()
    await page.evaluate(ids => {
      ;(window as unknown as { __vizLinkCells?: (c: string[]) => string }).__vizLinkCells?.(ids)
    }, [PE4.cat, PE4.cont])
    await page.waitForTimeout(1000)
    const barCat = await barOf(PE4.cat)
    const barCont = await barOf(PE4.cont)
    const barBox = await barOf(PE4.box)
    const barViolin = await barOf(PE4.violin)
    console.log(`[TEST-28] link tint: cat=${barCat} cont=${barCont} box=${barBox} violin=${barViolin}`)
    expect(barCat, `${PE4.cat} joined the link group and must carry its tint`).toBeTruthy()
    expect(barCont, `${PE4.cont} joined the link group and must carry its tint`).toBeTruthy()
    expect(barCont, 'both members of ONE link group must carry the SAME color').toBe(barCat)
    expect(barBox, `${PE4.box} is not in the link group and must carry no tint`).toBeNull()
    expect(barViolin, `${PE4.violin} is not in the link group and must carry no tint`).toBeNull()
  })


  // ── TEST-15 (ITEM-4): the rect guard's RENDER half — both directions ────────────────────────────
  //
  // `rectEquality.test.ts` (TEST-16) proves the PREDICATE is field-wise and order-sensitive. What it
  // cannot prove is that the predicate is WIRED INTO the resize path — in EITHER direction. Both
  // failure modes are silent and opposite:
  //
  //   * guard too strong / mis-wired  -> a REAL resize is swallowed and the panes freeze.
  //   * guard absent                  -> a measure pass that found nothing moved still hands every
  //                                      `CellView` a freshly-allocated but EQUAL rect, re-rendering
  //                                      every pane's chrome — re-entering, through the resize path,
  //                                      exactly the cost ITEM-1 removed.
  //
  // (a) is the first, driven through a REAL splitter drag and observed at DECK, not at the DOM: after
  // the drag, a press-drag at a point that lies inside pane A's NEW box and OUTSIDE its OLD one must
  // pan A. If the deck views had not followed the new rects, that point still belongs to the
  // neighbouring view and the WRONG camera moves — which no DOM-box comparison can see.
  //
  // (b) is the second. The clause as written asks for "an identical ResizeObserver notification,
  // forced via the story hook". No such hook exists, and it is not needed, because THE PRODUCTION
  // CODE RE-EMITS ONE ON ITS OWN: `measure` is `useCallback(…, [cells])`, and the RO effect is keyed
  // on `[measure]`, so ANY re-mint of `cells` disconnects and re-`observe`s the container — and
  // `observe()` delivers an initial notification for the CURRENT (unchanged) size. A title edit
  // re-mints `cells` without moving a single pane, so it re-emits exactly the identical notification
  // the clause names, through the real product path, on the real fixture. That is a faithful
  // realization rather than a substitute (the same move DEC-41 made for TEST-P3's "story test hook").
  test('TEST-15 the rect guard neither freezes a real resize nor churns rects on an identical re-measure', async ({
    page,
  }) => {
    test.setTimeout(300_000)
    await page.setViewportSize({ width: 1920, height: 1040 })
    const counter = await installElementCounter(page, { perCell: true })
    await openPerfStory(page, 'plot-editing', {}, { settleMs: 9000 })
    counter.assertApplied()
    await expect(page.locator('[data-viz-cell]')).toHaveCount(4)

    // Link-zoom OFF, and PROVEN off: an isolation claim measured with linking silently on is a
    // false green (TEST-13's rule, same rail toggle).
    const linkToggle = page.locator('[data-testid="viz-tool-rail-toggle-link-zoom"]')
    if ((await linkToggle.getAttribute('aria-pressed')) === 'true') {
      await linkToggle.click()
      await page.waitForTimeout(600)
    }
    expect(await linkToggle.getAttribute('aria-pressed'), 'link-zoom must be OFF for the deck-view leg').toBe(
      'false',
    )

    // ── (a) A REAL RESIZE IS NOT FROZEN — observed at the DECK VIEW ────────────────────────────────
    const geomBefore = await paneGeometry(page)
    const catBefore = geomBefore[PE4.cat].pane
    const sep = page.locator('[role="separator"]').first()
    const sepBox = await sep.boundingBox()
    expect(sepBox, 'the fixture must expose a draggable pane divider').not.toBeNull()
    expect(
      await sep.getAttribute('aria-orientation'),
      'this leg grows pane cat to the RIGHT, so the first divider must be the vertical one',
    ).toBe('vertical')
    const GROW = 80
    const cx = sepBox!.x + sepBox!.width / 2
    const cy = sepBox!.y + sepBox!.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + GROW, cy, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(1200)
    const geomAfter = await paneGeometry(page)
    const catAfter = geomAfter[PE4.cat].pane
    console.log(
      `[TEST-15] cat pane ${catBefore.width.toFixed(0)} -> ${catAfter.width.toFixed(0)} px ` +
        `(right edge ${(catBefore.x + catBefore.width).toFixed(0)} -> ${(catAfter.x + catAfter.width).toFixed(0)})`,
    )
    // NON-VACUITY — the drag really grew pane cat, and the DOM half followed.
    expect(catAfter.width - catBefore.width, 'the divider drag must have GROWN pane cat').toBeGreaterThan(20)
    expect(
      Math.abs(geomAfter[PE4.cat].view!.width - catAfter.width),
      'the CellView box must have followed the resized pane',
    ).toBeLessThanOrEqual(1.5)

    // The DECK half. This point is inside cat's NEW box and was inside CONT's box before the drag, so
    // a deck whose views did not re-measure routes the gesture to `cont` and cat never moves.
    const probeX = catBefore.x + catBefore.width + (catAfter.width - catBefore.width) / 2
    const probeY = catAfter.y + catAfter.height * 0.6
    expect(probeX, 'the probe point must lie beyond cat OLD right edge').toBeGreaterThan(catBefore.x + catBefore.width)
    expect(probeX, 'the probe point must lie inside cat NEW box').toBeLessThan(catAfter.x + catAfter.width)
    const onDeck = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x as number, y as number)
        return el ? `${el.tagName}${el.id ? '#' + el.id : ''}` : 'none'
      },
      [probeX, probeY],
    )
    expect(onDeck, `the probe point must sit on deck's canvas, not on an overlay (found ${onDeck})`).toBe(
      'CANVAS#deckgl-overlay',
    )

    const camBefore = await cameras(page)
    await page.mouse.move(probeX, probeY)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(probeX - (60 * i) / 10, probeY, { steps: 1 })
      await page.waitForTimeout(30)
    }
    await page.mouse.up()
    await page.waitForTimeout(900)
    const camAfter = await cameras(page)
    const catMoved = camAfter[PE4.cat].x !== camBefore[PE4.cat].x
    const contMoved = camAfter[PE4.cont].x !== camBefore[PE4.cont].x
    console.log(
      `[TEST-15] probe (${probeX.toFixed(0)},${probeY.toFixed(0)}) -> cat ${camBefore[PE4.cat].x.toFixed(2)}` +
        `->${camAfter[PE4.cat].x.toFixed(2)} | cont ${camBefore[PE4.cont].x.toFixed(2)}->${camAfter[PE4.cont].x.toFixed(2)}`,
    )
    expect(
      catMoved,
      'a drag in the area pane cat GREW INTO must pan CAT — if it does not, the deck views did not ' +
        'follow the new rects and the resize was frozen at the deck, whatever the DOM shows',
    ).toBe(true)
    expect(contMoved, 'unlinked, the neighbour pane cont must not have panned').toBe(false)

    // ── (b) AN IDENTICAL RE-MEASURE MUST NOT CHURN THE RECTS ──────────────────────────────────────
    // A title edit re-mints `cells` -> `measure` is re-created -> the layout effect re-runs it AND
    // the RO effect re-`observe`s the container, which delivers an identical notification. Nothing
    // moved, so the guard must return the PREVIOUS array and React must bail out of the update.
    // Without it, `rects` -> `denseRects` -> every `CellView`'s `rect` prop is a fresh object and
    // every pane's chrome rebuilds.
    await ensureEditOpen(page, PE4.cat)
    const titleInput = page.locator(`[data-testid="viz-edit-title-${PE4.cat}"]`)
    await expect(titleInput).toBeVisible()
    const geomPre = await paneGeometry(page)

    await counter.begin()
    await titleInput.fill('rect-guard probe')
    await titleInput.blur()
    await page.waitForTimeout(2_000)
    const r = await counter.end()
    const geomPost = await paneGeometry(page)

    console.log(
      `[TEST-15] identical re-measure: total=${r.total} ` +
        Object.entries(r.byComponent)
          .filter(([k]) => k.includes('#'))
          .sort()
          .map(([k, v]) => `${k}=${v}`)
          .join(' '),
    )

    // NON-VACUITY 1 — the edit landed, so a re-mint of `cells` really happened.
    await expect(page.locator(`[data-testid="viz-cell-title-${PE4.cat}"]`)).toHaveText('rect-guard probe')
    // NON-VACUITY 2 — and it moved NO pane, so the re-measure it triggered is genuinely IDENTICAL.
    for (const id of Object.keys(geomPre)) {
      expect(
        Math.abs(geomPost[id].pane.x - geomPre[id].pane.x) + Math.abs(geomPost[id].pane.width - geomPre[id].pane.width),
        `pane ${id} MOVED during the title edit, so the re-measure was not identical and clause (b) ` +
          'would be measuring a real layout change',
      ).toBeLessThanOrEqual(1.5)
    }
    // POSITIVE CONTROL — the EDITED pane did rebuild its chrome. A zero here means the drive or the
    // display-name pin is broken; it does not mean the guard held (FIX_ROUND-1 / C1).
    expect(
      r.byComponent[`CellView#${PE4.cat}`] ?? 0,
      'the edited pane must rebuild its own chrome',
    ).toBeGreaterThanOrEqual(1)

    // THE PROPERTY, per untouched pane.
    for (const id of [PE4.cont, PE4.box, PE4.violin]) {
      expect(
        r.byComponent[`GridPaneCell#${id}`] ?? 0,
        `pane ${id} was never offered to the memo boundary, so "its chrome did not rebuild" is vacuous`,
      ).toBeGreaterThanOrEqual(1)
      expect(
        r.byComponent[`CellView#${id}`] ?? 0,
        `an IDENTICAL re-measure rebuilt untouched pane ${id}'s chrome. \`measure()\` handed \`setRects\` ` +
          'a freshly-allocated but EQUAL rect set, so every pane\'s `rect` prop changed identity and ' +
          '`memo(CellView)` could not bail — ITEM-4\'s guard is not wired into the resize path.',
      ).toBe(0)
    }
  })


  // ── TEST-29 (ITEM-21): the display-store hoist is behaviourally INVISIBLE and cross-cell isolated ─
  //
  // Split 0b hoisted seven per-cell display keys out of `GridWorkspace`'s closure into a
  // per-WORKSPACE `CellDisplayStore`. `cellDisplayStore.test.ts` (TEST-22) proves the SLICE is
  // per-cell at the store's own boundary. What no test asserted is the thing a user would notice:
  // that a display change on ONE pane leaves the OTHER panes' PIXELS alone.
  //
  // WHAT THIS DOES THAT THE NEAREST NEIGHBOURS DO NOT:
  //   * `render-perf-legend.spec.ts` (TEST-F5) counts ELEMENTS on a legend click. It says nothing
  //     about what the untouched panes LOOK like, and its driver is only the legend.
  //   * `cell-display-isolation.e2e.mjs` compares whole-pane pixels on a legend click, but not the
  //     legend/visual-map surfaces and not the COLORMAP driver.
  //   * TEST-22 is a store test: a leak that happens BELOW the store (a shared render input) is
  //     invisible to it.
  // So this drives BOTH surfaces the clause names — a legend category hide AND a colormap change on
  // the edit form — and asserts the other three panes are BIT-IDENTICAL in plot and legend, with the
  // element counter on the colormap driver (the one TEST-F5 never runs).
  //
  // The signature is CROPPED to each pane's box, because all four panes share ONE deck canvas: a
  // whole-canvas hash can only say "something changed", which is not an isolation claim.
  test('TEST-29 a legend hide and a colormap change on one pane leave every other pane bit-identical', async ({
    page,
  }) => {
    test.setTimeout(300_000)
    await page.setViewportSize({ width: 1920, height: 1040 })
    const counter = await installElementCounter(page, { perCell: true })
    await openPerfStory(page, 'plot-editing', {}, { settleMs: 9000 })
    counter.assertApplied()
    await expect(page.locator('[data-viz-cell]')).toHaveCount(4)

    const ALL = [PE4.cat, PE4.cont, PE4.box, PE4.violin] as const
    const sigs0: Record<string, Awaited<ReturnType<typeof cellVisualSig>>> = {}
    for (const id of ALL) sigs0[id] = await cellVisualSig(page, id)
    /** Relative movement of a pane's legend raster between two readings. */
    const legendDrift = (
      a: Awaited<ReturnType<typeof cellVisualSig>>,
      b: Awaited<ReturnType<typeof cellVisualSig>>,
    ) => Math.abs(b.legendSum - a.legendSum) / Math.max(1, a.legendSum)
    console.log(
      `[TEST-29] baseline: ${ALL.map(id => `${id}{p=${sigs0[id].plot},lsum=${sigs0[id].legendSum}}`).join(' ')}`,
    )

    // NON-VACUITY — every signature must be READABLE. Two nulls compare equal, so an unreadable
    // canvas would satisfy every isolation clause below on a page showing nothing.
    for (const id of ALL) {
      expect(sigs0[id].plot, `pane ${id}'s plot region is unreadable — every "unchanged" below would be vacuous`).not.toBeNull()
      expect(
        sigs0[id].legendSum,
        `pane ${id}'s legend raster is empty/unreadable — its isolation clause would be vacuous`,
      ).toBeGreaterThan(0)
    }
    // …and the four panes must not all already look the SAME, or "B is unchanged" would hold under
    // a total-leak implementation too.
    expect(
      new Set(ALL.map(id => sigs0[id].plot)).size,
      'the four panes must render distinguishable plots, or cross-pane comparison proves nothing',
    ).toBeGreaterThan(1)

    // ── (a) a LEGEND CATEGORY HIDE on `cat` ───────────────────────────────────────────────────────
    const hid0 = await hiddenCodes(page)
    const canvas = await page.$(`[data-testid="viz-cell-legend-${PE4.cat}"] [data-testid="viz-incell-legend"]`)
    const cb = canvas && (await canvas.boundingBox())
    expect(cb, `pane ${PE4.cat}'s categorical legend must be hit-testable`).not.toBeNull()
    let hit = false
    for (let y = 12; cb && y < cb.height - 4 && !hit; y += 7) {
      await page.mouse.click(cb.x + 12, cb.y + y)
      await page.waitForTimeout(350)
      if ((await hiddenCodes(page)) !== hid0) hit = true
    }
    expect(hit, `no swatch click changed a hidden set (still ${hid0}) — the hide driver did nothing`).toBe(true)
    await page.waitForTimeout(1500)

    const sigsA: Record<string, Awaited<ReturnType<typeof cellVisualSig>>> = {}
    for (const id of ALL) sigsA[id] = await cellVisualSig(page, id)
    console.log(
      `[TEST-29] after hide: ` +
        ALL.map(id => `${id}{p=${sigsA[id].plot},drift=${(legendDrift(sigs0[id], sigsA[id]) * 100).toFixed(3)}%}`).join(' '),
    )

    // The DRIVEN pane changed — the positive control. Without it, a click that did nothing visible
    // would make all three isolation clauses pass.
    expect(sigsA[PE4.cat].plot, `hiding a category must change ${PE4.cat}'s OWN plot`).not.toBe(sigs0[PE4.cat].plot)
    expect(
      legendDrift(sigs0[PE4.cat], sigsA[PE4.cat]),
      `hiding a category must visibly change ${PE4.cat}'s OWN legend (a swatch row is struck through)`,
    ).toBeGreaterThan(0.01)
    // THE PROPERTY — every other pane is bit-identical, in BOTH surfaces.
    for (const id of [PE4.cont, PE4.box, PE4.violin]) {
      expect(sigsA[id].plot, `a legend hide on ${PE4.cat} changed pane ${id}'s PLOT — the per-cell display slice leaked`).toBe(
        sigs0[id].plot,
      )
      expect(
        legendDrift(sigs0[id], sigsA[id]),
        `a legend hide on ${PE4.cat} changed pane ${id}'s LEGEND/visual map by more than rasterization ` +
          'noise — the per-cell display slice leaked (a leak removes a whole swatch row)',
      ).toBeLessThan(0.002)
    }
    // The SEPARATION is the point: the driven pane must move by orders of magnitude more than the
    // untouched ones. A tolerance without this could be satisfied by nothing moving at all.
    const worstOther = Math.max(...[PE4.cont, PE4.box, PE4.violin].map(id => legendDrift(sigs0[id], sigsA[id])))
    expect(
      legendDrift(sigs0[PE4.cat], sigsA[PE4.cat]) / Math.max(worstOther, 1e-6),
      'the driven pane\'s legend must move at least 20x more than any untouched pane\'s, or the ' +
        'tolerance above is not separating signal from raster noise',
    ).toBeGreaterThan(20)

    // ── (b) a COLORMAP change on `cont`'s EDIT FORM, with the element counter on it ────────────────
    // A different write path from (a) — the edit form, not the in-cell legend — and the one
    // `render-perf-legend.spec.ts` never drives.
    await ensureEditOpen(page, PE4.cont)
    const colormap = page.locator(`[data-testid="viz-edit-colormap-${PE4.cont}"]`)
    await expect(colormap, `pane ${PE4.cont} must expose a colormap control`).toHaveCount(1)
    const sigsB0: Record<string, Awaited<ReturnType<typeof cellVisualSig>>> = {}
    for (const id of ALL) sigsB0[id] = await cellVisualSig(page, id)

    await counter.begin()
    await colormap.click()
    await page.waitForTimeout(600)
    // The picker is a listbox of named colormaps; take the first option that is not the current one.
    const options = page.locator('[role="option"]')
    const n = await options.count()
    expect(n, 'the colormap picker must offer options to choose from').toBeGreaterThan(1)
    let picked = ''
    for (let i = 0; i < n; i++) {
      const o = options.nth(i)
      if ((await o.getAttribute('aria-selected')) === 'true') continue
      picked = (await o.textContent()) ?? ''
      await o.click()
      break
    }
    expect(picked, 'no non-selected colormap option was clickable').not.toBe('')
    await page.waitForTimeout(2_500)
    const r = await counter.end()

    const sigsB: Record<string, Awaited<ReturnType<typeof cellVisualSig>>> = {}
    for (const id of ALL) sigsB[id] = await cellVisualSig(page, id)
    console.log(
      `[TEST-29] colormap -> "${picked.trim()}": ` +
        ALL.map(id => `${id}{p:${sigsB0[id].plot}->${sigsB[id].plot}}`).join(' ') +
        ' | ' +
        Object.entries(r.byComponent)
          .filter(([k]) => k.includes('#'))
          .sort()
          .map(([k, v]) => `${k}=${v}`)
          .join(' '),
    )

    // POSITIVE CONTROL — the driven pane's plot really changed.
    expect(sigsB[PE4.cont].plot, `the colormap change must repaint ${PE4.cont}'s own plot`).not.toBe(
      sigsB0[PE4.cont].plot,
    )
    // THE PROPERTY, visually…
    for (const id of [PE4.cat, PE4.box, PE4.violin]) {
      expect(sigsB[id].plot, `a colormap change on ${PE4.cont} repainted pane ${id}`).toBe(sigsB0[id].plot)
      expect(
        legendDrift(sigsB0[id], sigsB[id]),
        `a colormap change on ${PE4.cont} changed pane ${id}'s legend by more than rasterization noise`,
      ).toBeLessThan(0.002)
    }
    // …and at the memo boundary: the untouched panes' chrome was never rebuilt.
    expect(
      r.byComponent[`CellView#${PE4.cont}`] ?? 0,
      'the pane whose colormap changed must rebuild its own chrome — a 0 here means the drive or the name pin is broken',
    ).toBeGreaterThanOrEqual(1)
    for (const id of [PE4.cat, PE4.box, PE4.violin]) {
      expect(
        r.byComponent[`GridPaneCell#${id}`] ?? 0,
        `pane ${id} was never offered to the memo boundary, so "its chrome did not rebuild" is vacuous`,
      ).toBeGreaterThanOrEqual(1)
      expect(
        r.byComponent[`CellView#${id}`] ?? 0,
        `a colormap change on ${PE4.cont} rebuilt untouched pane ${id}'s chrome — the hoisted display ` +
          'slice is waking subscribers it does not belong to (INV-7)',
      ).toBe(0)
    }
  })

})
