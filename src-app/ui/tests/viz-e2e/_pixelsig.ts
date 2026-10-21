// _pixelsig.ts — pixel-digest helpers OWNED SOLELY by the hardened viz specs
// (linked-panels / grid-workspace / selection-sync / controls / context-loss /
// lasso-select). Kept OUT of the shared `_helpers.ts` to avoid clobbering a
// concurrent edit there. These turn "a canvas changed" into a machine-checkable
// downstream assertion: capture a stable digest of a canvas's pixels before an
// interaction and after, then assert equal / not-equal.
//
// Reads a WebGL/2D canvas by drawing it into an offscreen 2D canvas (same trick as
// `_helpers.canvasNonBlank`, which already works under headless swiftshader) and
// hashing a strided sample of the RGBA bytes. A software-WebGL redraw of the SAME
// scene is byte-identical, so an equal digest means "did not visually change" and a
// differing digest means "visually changed" — exactly what these specs need to prove
// a real downstream effect (filter fade, highlight band, linked view move).

import { expect, type Page } from '@playwright/test'

/** FNV-1a over a strided RGBA sample of the Nth canvas → a hex digest string.
 *  Returns '' when the canvas is absent / untainted-read fails (so a caller that
 *  compares two signatures sees them as equal and the assertion stays honest —
 *  a missing canvas is not a "change"). */
export async function canvasPixelSignature(page: Page, nth = 0): Promise<string> {
  // NOTE: the digest logic is INLINED inside the evaluate callback — a Node-scope helper
  // is not serialized into the browser (that would throw `ReferenceError` at runtime).
  return page.evaluate((n) => {
    const c = document.querySelectorAll('canvas')[n] as HTMLCanvasElement | undefined
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
      // Stride across the buffer (prime step) so we sample the whole frame cheaply.
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
  }, nth)
}

/**
 * Digest of the shared GRID DECK canvas CROPPED to the on-screen rect of ONE grid pane.
 *
 * WHY THIS EXISTS RATHER THAN `canvasPixelSignatureInSelector`. In the heterogeneous grid the
 * "shared-deck charts" refactor moved `heatmap`/`violin`/`box`/`bar`/`dotplot`/`histogram`/
 * `volcano` onto the ONE workspace `<DeckGL>` canvas as extra VIEWS (see
 * `multiView.ts::SHARED_DECK_CHART_KINDS`). That canvas is a SIBLING of the pane tree, never a
 * descendant of a pane's own view element — so pointing
 * `canvasPixelSignatureInSelector` at a pane does not return its plot at all. It returns the
 * FIRST descendant canvas, which for a heatmap pane is its 16x141 dataZoom RAIL
 * (`viz-heatmap-datazoom-rows`) — a canvas no cross-plot selection ever repaints. Measured on
 * `882d8bfd`: the rail digest is `b53ff007` before AND after a real lasso, while the deck region
 * under the same pane moves `f0d5067a` -> `bc979ca6`. A spec digesting the rail therefore reports
 * "the chart did not repaint" no matter what the chart does.
 *
 * The crop maps the pane's client rect into deck backing-store pixels, so the digest covers
 * exactly that pane's deck view and nothing else (a neighbouring pane's repaint cannot satisfy
 * it). Returns '' when the workspace / deck canvas is absent (same "a missing canvas is not a
 * change" contract as the two helpers above). PAINTEDNESS is deliberately NOT folded in here —
 * a caller that needs "this region has actually rendered" asserts it with
 * `deckRegionPaintedPixels` below, which is a real measurement instead of a sentinel a spec
 * could satisfy vacuously.
 */
export async function deckRegionPixelSignature(page: Page, paneViewSelector: string): Promise<string> {
  // NOTE: the crop + digest are INLINED inside the evaluate callback for the reason stated on
  // `canvasPixelSignature` above — a Node-scope helper is not serialized into the browser.
  return page.evaluate((sel) => {
    const host = document.querySelector(sel)
    // The shared deck canvas is documented to be FIRST in the workspace DOM — `GridDeckLayer`
    // keeps it there so `useCanvasRecovery`'s `querySelector('canvas')` grabs it.
    const deck = document.querySelector(
      '[data-testid="viz-grid-workspace"] canvas',
    ) as HTMLCanvasElement | null
    if (!host || !deck || deck.width === 0 || deck.height === 0) return ''
    const hr = host.getBoundingClientRect()
    const dr = deck.getBoundingClientRect()
    if (dr.width === 0 || dr.height === 0) return ''
    const sx = Math.max(0, Math.round(((hr.left - dr.left) / dr.width) * deck.width))
    const sy = Math.max(0, Math.round(((hr.top - dr.top) / dr.height) * deck.height))
    const sw = Math.max(1, Math.min(deck.width - sx, Math.round((hr.width / dr.width) * deck.width)))
    const sh = Math.max(1, Math.min(deck.height - sy, Math.round((hr.height / dr.height) * deck.height)))
    const off = document.createElement('canvas')
    off.width = sw
    off.height = sh
    const ctx = off.getContext('2d')
    if (!ctx) return ''
    try {
      ctx.drawImage(deck, sx, sy, sw, sh, 0, 0, sw, sh)
      const { data } = ctx.getImageData(0, 0, sw, sh)
      let h = 0x811c9dc5
      for (let i = 0; i < data.length; i += 4) {
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
  }, paneViewSelector)
}

/** Count of NON-TRANSPARENT pixels in the same shared-deck region — "has this pane's deck view
 *  actually rendered?" as a number a spec asserts `> 0` on, rather than a `!== ''` sentinel that
 *  an all-transparent region would also satisfy. Returns 0 when the region is absent. */
export async function deckRegionPaintedPixels(page: Page, paneViewSelector: string): Promise<number> {
  return page.evaluate((sel) => {
    const host = document.querySelector(sel)
    const deck = document.querySelector(
      '[data-testid="viz-grid-workspace"] canvas',
    ) as HTMLCanvasElement | null
    if (!host || !deck || deck.width === 0 || deck.height === 0) return 0
    const hr = host.getBoundingClientRect()
    const dr = deck.getBoundingClientRect()
    if (dr.width === 0 || dr.height === 0) return 0
    const sx = Math.max(0, Math.round(((hr.left - dr.left) / dr.width) * deck.width))
    const sy = Math.max(0, Math.round(((hr.top - dr.top) / dr.height) * deck.height))
    const sw = Math.max(1, Math.min(deck.width - sx, Math.round((hr.width / dr.width) * deck.width)))
    const sh = Math.max(1, Math.min(deck.height - sy, Math.round((hr.height / dr.height) * deck.height)))
    const off = document.createElement('canvas')
    off.width = sw
    off.height = sh
    const ctx = off.getContext('2d')
    if (!ctx) return 0
    try {
      ctx.drawImage(deck, sx, sy, sw, sh, 0, 0, sw, sh)
      const { data } = ctx.getImageData(0, 0, sw, sh)
      let painted = 0
      for (let i = 3; i < data.length; i += 4) if (data[i] > 10) painted++
      return painted
    } catch {
      return 0
    }
  }, paneViewSelector)
}

/** Same digest, but for the FIRST <canvas> nested inside the element matching
 *  `selector` (used to target ONE cell's ChartCanvas in the heterogeneous grid,
 *  where many canvases are mounted). Returns '' when no such canvas exists.
 *
 *  PREFER `panePlotSignature` BELOW for a GRID PANE. "First descendant canvas" is a DOM-order
 *  question, not a "where does this pane's plot paint?" question, and the two diverge silently in
 *  three ways (rail / collision / vacuity) documented on the pane-plot family. This helper remains
 *  for callers whose target genuinely is "the one canvas inside this element". */
export async function canvasPixelSignatureInSelector(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel) => {
    const host = document.querySelector(sel)
    const c = host?.querySelector('canvas') as HTMLCanvasElement | undefined
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
  }, selector)
}

// ── the PANE-PLOT pair: measure a pane where its plot actually paints ─────────────────────────
//
// WHY A THIRD FAMILY. `canvasPixelSignatureInSelector` above answers "digest the FIRST DESCENDANT
// canvas of this element" — which is a DOM-order question, not a "where does this pane's plot
// paint?" question. Those two coincide today for a standalone chart (`AxisDataZoom` renders its
// `children` — the plot — before either dataZoom rail), and they DIVERGE in three ways, each of
// which a spec built on the first-descendant idiom absorbs SILENTLY:
//
//   1. RAIL. A `MatrixHeatmapView` pane holds three canvases: the 489x338 plot, a 16x338 rows rail
//      and a 490x16 cols rail. Move the plot onto the shared workspace deck (`multiView.ts::
//      SHARED_DECK_CHART_KINDS` does exactly this for heatmap/violin/box/bar/dotplot/histogram/
//      volcano inside the grid) and the pane's first descendant canvas becomes a RAIL. A rail
//      repaints on a dataZoom drag, so a zoom-sync assertion keeps passing while measuring a
//      control instead of a chart. That is TEST-35b, measured on 882d8bfd.
//   2. COLLISION. Point two pane selectors at one ancestor (a typo, or a refactor that nests both
//      panes) and BOTH resolve to the SAME canvas. Every "A repainted" / "B repainted" assertion
//      still passes — on one canvas that repaints for either reason. Nothing in the first-descendant
//      idiom can tell those apart.
//   3. VACUITY. A pane that VANISHES mid-test yields '' , and `expect(sig).not.toBe(before)` is
//      SATISFIED by '' . So "the chart repainted" passes loudest exactly when the chart is gone.
//
// `panePlotTarget` answers the real question and RETURNS ITS EVIDENCE, so a spec asserts on the
// measurement instead of trusting it: which canvas was chosen, how much of the pane it covers, and
// whether the pane's plot lives on the shared deck instead. `panePlotSignature` /
// `panePlotPaintedPixels` are the digest + paintedness over that same target — the standalone twin
// of `deckRegionPixelSignature` / `deckRegionPaintedPixels`, and they DELEGATE to those when the
// pane's plot is a shared-deck view, so one call site is correct in both worlds.

/** Where a pane's plot actually paints, plus the evidence for that choice. */
export interface PanePlotTarget {
  /** `own` — a canvas inside the pane. `deck` — a view on the shared workspace deck (the pane's
   *  own canvases are all rails). `none` — nothing measurable (pane absent / no canvas). */
  kind: 'own' | 'deck' | 'none'
  /** Index into `document.querySelectorAll('canvas')` — a stable identity WITHIN one page, so two
   *  panes resolving to the same canvas is detectable by comparing this. `-1` for `deck`/`none`. */
  index: number
  /** Backing-store dimensions of the chosen canvas (0 when `kind` is not `own`). */
  width: number
  height: number
  /** Chosen canvas' on-screen area as a FRACTION of the pane's own on-screen area. THIS is the
   *  rail test, and it is geometric rather than name- or pixel-count-based: a dataZoom rail is a
   *  thin strip (~0.03 of its pane here) whatever its testid is called and whatever the device
   *  pixel ratio is, while a plot fills its pane (~0.9). 0 when `kind` is not `own`. */
  coverage: number
  /** `data-testid` chain from the chosen canvas up to `<body>`, nearest first — so a failure names
   *  the thing that was measured instead of an index. Empty when `kind` is not `own`. */
  chain: string
  /** How many canvases the pane contains (a pane with only rails is the shared-deck signature). */
  canvasCount: number
}

/**
 * Resolve WHERE a pane's plot paints, with the evidence for the choice. Never throws.
 *
 * The resolver is INLINED in the `evaluate` callback (a Node-scope helper is not serialized into
 * the browser), and the two digest helpers below re-use its RESULT rather than re-running it, so
 * there is exactly one copy of the choice rule.
 */
export async function panePlotTarget(page: Page, paneSelector: string): Promise<PanePlotTarget> {
  return page.evaluate((sel): PanePlotTarget => {
    const host = document.querySelector(sel)
    const none: PanePlotTarget = {
      kind: 'none', index: -1, width: 0, height: 0, coverage: 0, chain: '', canvasCount: 0,
    }
    if (!host) return none
    const own = Array.from(host.querySelectorAll('canvas')) as HTMLCanvasElement[]
    const hr = host.getBoundingClientRect()
    const paneArea = Math.max(1, hr.width * hr.height)
    let best: HTMLCanvasElement | null = null
    let bestArea = -1
    for (const c of own) {
      const r = c.getBoundingClientRect()
      const a = r.width * r.height
      if (a > bestArea) {
        bestArea = a
        best = c
      }
    }
    const coverage = best ? bestArea / paneArea : 0
    // A pane whose largest own canvas still covers almost none of it holds only chrome (dataZoom
    // rails). Its plot, if it has one, is a view on the shared workspace deck.
    if (!best || coverage < 0.25) {
      const deck = document.querySelector('[data-testid="viz-grid-workspace"] canvas')
      if (deck) {
        return { kind: 'deck', index: -1, width: 0, height: 0, coverage: 0, chain: '', canvasCount: own.length }
      }
      return { ...none, coverage, canvasCount: own.length }
    }
    const all = Array.from(document.querySelectorAll('canvas'))
    const chain: string[] = []
    let el = best.parentElement
    while (el && el !== document.body) {
      const t = el.getAttribute('data-testid')
      if (t) chain.push(t)
      el = el.parentElement
    }
    return {
      kind: 'own',
      index: all.indexOf(best),
      width: best.width,
      height: best.height,
      coverage,
      chain: chain.join(' < '),
      canvasCount: own.length,
    }
  }, paneSelector)
}

/** Read the canvas a resolved `own` target names, VERIFYING its identity first: the index is only
 *  meaningful against the canvas list that produced it, so a canvas added/removed between the
 *  resolve and the read must degrade to "not measurable" rather than digest a different chart. */
async function readOwnCanvas<T>(
  page: Page,
  t: PanePlotTarget,
  reducer: 'digest' | 'painted',
  fallback: T,
): Promise<T> {
  return page.evaluate(
    ([index, width, height, mode]) => {
      const c = document.querySelectorAll('canvas')[index as number] as HTMLCanvasElement | undefined
      if (!c || c.width !== width || c.height !== height) return mode === 'digest' ? '' : 0
      const off = document.createElement('canvas')
      off.width = c.width
      off.height = c.height
      const ctx = off.getContext('2d')
      if (!ctx) return mode === 'digest' ? '' : 0
      try {
        ctx.drawImage(c, 0, 0)
        const { data } = ctx.getImageData(0, 0, off.width, off.height)
        if (mode === 'painted') {
          let painted = 0
          for (let i = 3; i < data.length; i += 4) if (data[i] > 10) painted++
          return painted
        }
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
        return mode === 'digest' ? '' : 0
      }
    },
    [t.index, t.width, t.height, reducer] as const,
  ) as Promise<T>
}

/**
 * Digest of a pane's PLOT — its own plot canvas, or the shared-deck region under it when the pane
 * holds only chrome. Returns '' when nothing is measurable, the same "a missing canvas is not a
 * change" contract the two helpers above carry. A caller asserting "it repainted" must ALSO assert
 * `panePlotPaintedPixels > 0`, or a vanished pane satisfies the change assertion with ''.
 */
export async function panePlotSignature(page: Page, paneSelector: string): Promise<string> {
  const t = await panePlotTarget(page, paneSelector)
  if (t.kind === 'deck') return deckRegionPixelSignature(page, paneSelector)
  if (t.kind === 'none') return ''
  return readOwnCanvas<string>(page, t, 'digest', '')
}

/** Non-transparent pixel count over the SAME target — "this pane's plot has actually rendered" as
 *  a number, not a `!== ''` sentinel an all-transparent (or absent) region would also satisfy. */
export async function panePlotPaintedPixels(page: Page, paneSelector: string): Promise<number> {
  const t = await panePlotTarget(page, paneSelector)
  if (t.kind === 'deck') return deckRegionPaintedPixels(page, paneSelector)
  if (t.kind === 'none') return 0
  return readOwnCanvas<number>(page, t, 'painted', 0)
}

// ── the two CONTROLS + the non-vacuous repaint assertion ──────────────────────────────────────
//
// These ship WITH the pane-plot helpers rather than being left to each spec, because the three
// failure modes above are only caught if EVERY caller applies the same checks — and two specs
// drifting apart on which checks they apply is the failure this whole family exists to stop.

/**
 * PANE-SPECIFICITY + RAIL-REJECTION control. Resolves every named pane, prints the evidence, and
 * asserts:
 *   • each pane is measurable at all (`kind !== 'none'`),
 *   • no two panes resolve to the SAME canvas (else "A repainted" and "B repainted" are one
 *     assertion wearing two names),
 *   • an `own` target COVERS its pane (≥ 25%), i.e. it is the plot and not a dataZoom rail,
 *   • it has actually painted (a transparent region is not a rendered chart).
 * Returns the targets so a spec can log/inspect them.
 */
export async function expectDistinctPanePlots(
  page: Page,
  panes: Record<string, string>,
  timeout = 30_000,
): Promise<Record<string, PanePlotTarget>> {
  // BOTH CHECKS ARE POLLED, not sampled once: a software-WebGL first frame can land after the
  // navigation settles, and a control that raced it would fail for timing rather than for the
  // property it exists to check. Measurability is polled FIRST so a pane that resolves to nothing
  // fails with its own evidence rather than as a downstream "0 painted pixels".
  const describe = async (sel: string) => JSON.stringify(await panePlotTarget(page, sel))
  for (const [name, sel] of Object.entries(panes)) {
    await expect
      .poll(() => panePlotTarget(page, sel).then(t => t.kind), {
        message: `pane ${name} resolves to a plot canvas (or a shared-deck region) — last: ${await describe(sel)}`,
        timeout,
      })
      .not.toBe('none')
    await expect
      .poll(() => panePlotPaintedPixels(page, sel), { message: `pane ${name} renders`, timeout })
      .toBeGreaterThan(0)
  }
  const out: Record<string, PanePlotTarget> = {}
  for (const [name, sel] of Object.entries(panes)) out[name] = await panePlotTarget(page, sel)
  const evidence = Object.entries(out)
    .map(([n, t]) => `${n}: kind=${t.kind} idx=${t.index} ${t.width}x${t.height} cov=${t.coverage.toFixed(3)} canvases=${t.canvasCount} [${t.chain}]`)
    .join('\n  ')
  for (const [name, t] of Object.entries(out)) {
    if (t.kind === 'own') {
      expect(
        t.coverage,
        `pane ${name} measures its PLOT, not a dataZoom rail — the chosen canvas must cover the pane\n  ${evidence}`,
      ).toBeGreaterThan(0.25)
    }
  }
  const owned = Object.entries(out).filter(([, t]) => t.kind === 'own')
  for (let i = 0; i < owned.length; i++) {
    for (let j = i + 1; j < owned.length; j++) {
      expect(
        owned[i][1].index,
        `panes ${owned[i][0]} and ${owned[j][0]} must measure DIFFERENT canvases\n  ${evidence}`,
      ).not.toBe(owned[j][1].index)
    }
  }
  return out
}

/**
 * ABSENT-PANE negative control. Proves the "no measurement" sentinel is reachable and is what an
 * absent pane yields — so the vacuity hazard is a demonstrated property of the harness rather than
 * an assumption, and `expectPaneRepainted`'s paintedness clause is doing real work.
 */
export async function expectAbsentPaneMeasuresNothing(page: Page, absentSelector: string) {
  const t = await panePlotTarget(page, absentSelector)
  expect(t.kind, `absent pane ${absentSelector} resolves to no measurement`).toBe('none')
  expect(await panePlotSignature(page, absentSelector), 'absent pane digests to the sentinel').toBe('')
  expect(await panePlotPaintedPixels(page, absentSelector), 'absent pane has no painted pixels').toBe(0)
}

/**
 * "This pane's plot repainted" — NON-VACUOUSLY. Polls until the digest differs from `before`, then
 * asserts the pane STILL paints. Without the second clause a pane that unmounted mid-test satisfies
 * the first: its digest becomes '' , and '' !== before.
 */
export async function expectPaneRepainted(
  page: Page,
  paneSelector: string,
  before: string,
  message: string,
  timeout = 30_000,
) {
  // MEASURABILITY FIRST, and it is not an optimisation. If the pane vanished (or its plot moved out
  // of it onto a shared deck) the digest is '' , which SATISFIES `.not.toBe(before)` — so polling
  // first would report "it repainted" loudest exactly when there is nothing left to repaint. Asserting
  // measurability up front turns that into an immediate, correctly-attributed failure instead of a
  // 30s timeout or, worse, a pass.
  const entry = await panePlotTarget(page, paneSelector)
  expect(
    entry.kind,
    `${message} — the pane must still be MEASURABLE at this point (it resolved to no plot canvas ` +
      `and no shared-deck region: ${JSON.stringify(entry)}). A '' digest would otherwise satisfy the ` +
      `change assertion below.`,
  ).not.toBe('none')
  await expect
    .poll(() => panePlotSignature(page, paneSelector), { message, timeout })
    .not.toBe(before)
  const sig = await panePlotSignature(page, paneSelector)
  expect(sig, `${message} — and the pane is still measurable (not '' from a vanished pane)`).not.toBe('')
  expect(
    await panePlotPaintedPixels(page, paneSelector),
    `${message} — and the pane still paints (a vanished/blank pane is not a repaint)`,
  ).toBeGreaterThan(0)
}
