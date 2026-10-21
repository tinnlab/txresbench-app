// canvasCloseAffordance.test.ts — a declared plot whose close this app cannot route must be
// DECLARED unremovable, with the reason travelling all the way to the pane chrome.
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────────
// `controlled: true` tells viz "do not remove yourself — hand the gesture back and let the app
// mutate the state you are derived from". That is the reopen-loop guard, and it is a promise about
// who acts. Nothing checked that anyone would: the router's first line is `if (!binding) return`,
// and it is `null` outright for a declaration that binds no closes at all. So a plot declared
// `controlled` with no `close:` had an X that was live, styled, hoverable and INERT — the user
// clicked, nothing happened, nothing said anything.
//
// The fix is stated where the truth is known: this feed holds BOTH the resolved plots and the
// resolved close routing, so it is the only place that can tell "no route" apart from "not yet
// resolved". A plot with no route goes onto the wire carrying `removeBlockedReason`, and viz renders
// its close as unavailable-with-a-reason instead of live-and-dead.
//
// ── WHAT IS ASSERTED, AND WHERE THE REST OF THE CHAIN IS ────────────────────────────────────────
// Here: the DECISION (which plots are blocked, and — the part a fixture can fake — that it agrees
// with the routing map rather than merely coinciding with it on this fixture), both negative cases,
// and survival through COMPOSITION, which re-keys every id and rebuilds every plot.
// The rest of the chain — the wire field surviving `parseOption` onto the pane model, and that model
// rendering a close the user cannot press but CAN read — is asserted in
// `libs/viz/src/viz-core/grid/paneRemoveBlocked.test.ts`, on the rendered DOM. Split by layer,
// not duplicated: this side owns "who is blocked and why", that side owns "what the user gets".

import { describe, expect, it } from 'vitest'
import type { VizSeries } from '@ziee/viz'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { resolveDeclarativeCanvas } from './canvasFeed'
import { composeCanvas } from './canvasComposition'

/** One numeric column, enough for a violin's `valueKey` to resolve. */
const DATA = { main: { v: [1, 2, 3] } }
const SCOPE = { params: {}, state: {}, derived: {}, const: {}, data: DATA }

/**
 * Three plots that differ ONLY in how their close is declared:
 *   `routed`   — controlled, WITH a `close` action  ⇒ removable (the app can act)
 *   `stranded` — controlled, with NO `close` action ⇒ blocked   (the app cannot)
 *   `plain`    — not controlled                     ⇒ removable (viz removes it itself)
 */
const SPEC = {
  id: 'view.affordance',
  title: 'Affordance',
  canvas: {
    datasets: [{ id: 'main' }],
    series: [
      {
        id: 's-routed',
        type: 'violin',
        coordId: 'routed',
        datasetId: 'main',
        encode: { valueKey: 'v' },
        region: { row: 0 },
        controlled: true,
        close: { action: 'x.drop' },
      },
      {
        id: 's-stranded',
        type: 'violin',
        coordId: 'stranded',
        datasetId: 'main',
        encode: { valueKey: 'v' },
        region: { row: 0 },
        controlled: true,
      },
      {
        id: 's-plain',
        type: 'violin',
        coordId: 'plain',
        datasetId: 'main',
        encode: { valueKey: 'v' },
        region: { row: 0 },
      },
    ],
  },
} as unknown as ViewSpec

function resolve() {
  const feed = resolveDeclarativeCanvas(SPEC, { data: DATA, scope: SCOPE })
  expect(feed, 'the fixture must resolve, or every assertion below is vacuous').not.toBeNull()
  return feed!
}

function byId(series: readonly VizSeries[], coordId: string): VizSeries {
  const found = series.find(s => s.coordId === coordId)
  expect(found, `no plot with coordId "${coordId}" — the fixture drifted`).toBeDefined()
  return found!
}

const blockedReason = (s: VizSeries): string | undefined =>
  (s as { removeBlockedReason?: string }).removeBlockedReason

describe('a declared plot with no close route is declared unremovable', () => {
  it('the stranded plot carries a NON-EMPTY reason', () => {
    const reason = blockedReason(byId(resolve().option.series ?? [], 'stranded'))
    expect(reason, 'a controlled plot with no route must not keep a live-but-dead close').toBeTruthy()
    // Blank would read as REMOVABLE downstream (viz normalizes it away), so "blocked with nothing
    // to say" must not be what this produces.
    expect(reason!.trim().length).toBeGreaterThan(0)
  })

  it('a plot the app CAN route is untouched — the working path is not collateral damage', () => {
    expect(blockedReason(byId(resolve().option.series ?? [], 'routed'))).toBeUndefined()
  })

  it('an UNCONTROLLED plot is untouched — viz removes those itself, and should keep doing so', () => {
    expect(blockedReason(byId(resolve().option.series ?? [], 'plain'))).toBeUndefined()
  })

  it('the routing map and the block agree — exactly the plots with no entry are blocked', () => {
    // The two are computed from the same resolution, so this pins them to ONE decision rather than
    // two that happen to coincide on this fixture.
    const feed = resolve()
    for (const s of feed.option.series ?? []) {
      const routed = Boolean(feed.closeActions[s.coordId])
      const blocked = blockedReason(s) !== undefined
      const controlled = (s as { controlled?: boolean }).controlled === true
      expect(blocked, `plot "${s.coordId}"`).toBe(controlled && !routed)
    }
  })
})

describe('the reason survives composition onto the shared canvas', () => {
  // Composition namespaces every id and rebuilds every plot with a spread. A field the fold did not
  // know about is exactly what a spread carries silently and a hand-listed rebuild would drop — and
  // the drop would be invisible, because the plot would still be there, still plotting, with a live
  // close again.
  it('a re-keyed plot keeps its block, and its neighbours keep their absence of one', () => {
    const feed = resolve()
    const composed = composeCanvas(
      new Map([['view.affordance', { option: feed.option, resolver: feed.resolver, close: null }]]),
    )
    const series = composed.option?.series ?? []
    expect(series.length, 'the composed canvas lost plots').toBe((feed.option.series ?? []).length)
    const localOf = (s: VizSeries) => composed.paneOwners.get(s.coordId)?.local ?? s.coordId
    // Namespacing must have actually happened, or this proves nothing about surviving it.
    expect(series.some(s => s.coordId !== localOf(s)), 'no id was re-keyed — the fold was a no-op').toBe(true)
    for (const s of series) {
      const expected = localOf(s) === 'stranded'
      expect(blockedReason(s) !== undefined, `plot "${localOf(s)}" after composition`).toBe(expected)
    }
  })
})
