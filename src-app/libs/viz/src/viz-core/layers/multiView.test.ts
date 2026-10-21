import { describe, it, expect } from 'vitest'
import {
  buildViews,
  buildViewStates,
  makeLayerFilter,
  routeGridHover,
  cellLayerId,
  cellOfLayer,
  layerBelongsToCell,
  localLayerName,
  DEFAULT_CELL_VIEW_STATE,
  type PaneRect,
  type CellViewState,
} from './multiView'

const PANES: PaneRect[] = [
  { id: 'A', x: 0, y: 0, width: 100, height: 200 },
  { id: 'B', x: 100, y: 0, width: 150, height: 200 },
  { id: 'C', x: 0, y: 200, width: 250, height: 80 },
]

describe('buildViews — one OrthographicView per pane (TEST-22)', () => {
  it('produces exactly one view per pane', () => {
    const views = buildViews(PANES)
    expect(views).toHaveLength(3)
  })

  it('uses the pane id as the view id and keeps them unique', () => {
    const views = buildViews(PANES)
    const ids = views.map(v => v.id)
    expect(ids).toEqual(['A', 'B', 'C'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('positions each view with the pane pixel rect and flipY:false', () => {
    const views = buildViews(PANES)
    expect(views[0].props.x).toBe(0)
    expect(views[0].props.y).toBe(0)
    expect(views[0].props.width).toBe(100)
    expect(views[0].props.height).toBe(200)
    expect(views[1].props.x).toBe(100)
    expect(views[1].props.width).toBe(150)
    expect(views[2].props.y).toBe(200)
    expect(views[2].props.height).toBe(80)
    for (const v of views) expect(v.props.flipY).toBe(false)
  })

  it('handles an empty pane list', () => {
    expect(buildViews([])).toEqual([])
  })

  it('gives EACH view its own controller by default (per-view zoom)', () => {
    // Regression guard: without a per-view controller, a single top-level
    // <Deck controller> only drives ONE viewport, so side-by-side panes leave
    // just one plot interactive. Every view must carry controller:true.
    const views = buildViews(PANES)
    for (const v of views) expect(v.props.controller).toBe(true)
  })

  it('opts out of per-view controllers when controller:false (FacetGrid shared domain)', () => {
    const views = buildViews(PANES, { controller: false })
    for (const v of views) expect(v.props.controller).toBe(false)
  })

  it('defaults dense panes to flipY:false + controller (byte-identical for embedding cells)', () => {
    const views = buildViews(PANES)
    for (const v of views) {
      expect(v.props.flipY).toBe(false)
      expect(v.props.controller).toBe(true)
    }
  })

  it('honors PER-PANE flipY + controller (heterogeneous regimes on one deck)', () => {
    const mixed: PaneRect[] = [
      { id: 'scatter', x: 0, y: 0, width: 100, height: 100 }, // dense: defaults
      { id: 'heatmap', x: 100, y: 0, width: 100, height: 100, flipY: true, controller: false }, // matrix
      { id: 'volcano', x: 0, y: 100, width: 100, height: 100, controller: true }, // free-camera chart
    ]
    const [scatter, heatmap, volcano] = buildViews(mixed)
    expect(scatter.props.flipY).toBe(false)
    expect(scatter.props.controller).toBe(true)
    expect(heatmap.props.flipY).toBe(true) // matrix rows top-down
    expect(heatmap.props.controller).toBe(false) // window-framed
    expect(volcano.props.controller).toBe(true)
  })

  it('per-pane controller overrides the deck-wide default', () => {
    const panes: PaneRect[] = [
      { id: 'a', x: 0, y: 0, width: 50, height: 50 }, // inherits default
      { id: 'b', x: 50, y: 0, width: 50, height: 50, controller: true }, // overrides
    ]
    const [a, b] = buildViews(panes, { controller: false })
    expect(a.props.controller).toBe(false)
    expect(b.props.controller).toBe(true)
  })
})

describe('buildViewStates — fills defaults + honors provided states (TEST-22)', () => {
  it('gives every pane an entry, defaulting missing ones to target[0,0,0]/zoom0', () => {
    const states: Record<string, CellViewState> = {
      B: { target: [5, 7], zoom: 3 },
    }
    const vs = buildViewStates(PANES, states)
    expect(Object.keys(vs).sort()).toEqual(['A', 'B', 'C'])
    // defaulted
    expect(vs.A).toEqual({
      target: [DEFAULT_CELL_VIEW_STATE.target[0], DEFAULT_CELL_VIEW_STATE.target[1], 0],
      zoom: DEFAULT_CELL_VIEW_STATE.zoom,
    })
    expect(vs.C).toEqual({ target: [0, 0, 0], zoom: 0 })
    // provided, promoted to a 3-tuple target
    expect(vs.B).toEqual({ target: [5, 7, 0], zoom: 3 })
  })

  it('ignores state keys with no matching pane', () => {
    const vs = buildViewStates(PANES, { Z: { target: [9, 9], zoom: 9 } })
    expect(vs.Z).toBeUndefined()
    expect(Object.keys(vs)).toHaveLength(3)
  })

  it('handles an empty pane list', () => {
    expect(buildViewStates([], {})).toEqual({})
  })
})

describe('cellLayerId / cellOfLayer — prefix convention', () => {
  it('round-trips a cell id through the layer id prefix', () => {
    const id = cellLayerId('A', 'scatter')
    expect(id).toBe('A::scatter')
    expect(cellOfLayer(id)).toBe('A')
  })

  it('parses only the first separator (layer names may contain ::)', () => {
    expect(cellOfLayer('A::group::edges')).toBe('A')
  })

  it('returns empty owner for an unprefixed id', () => {
    expect(cellOfLayer('globalOverlay')).toBe('')
  })
})

describe('makeLayerFilter — routes layers to their owning viewport (TEST-22)', () => {
  it("draws cell A's layer in view A but NOT in view B", () => {
    const filter = makeLayerFilter({})
    const layer = { id: cellLayerId('A', 'scatter') }
    expect(filter({ layer, viewport: { id: 'A' } })).toBe(true)
    expect(filter({ layer, viewport: { id: 'B' } })).toBe(false)
  })

  it('prefers the explicit layerCellMap over the id prefix', () => {
    // layer id says A, but the map assigns it to B
    const filter = makeLayerFilter({ 'A::scatter': 'B' })
    const layer = { id: 'A::scatter' }
    expect(filter({ layer, viewport: { id: 'B' } })).toBe(true)
    expect(filter({ layer, viewport: { id: 'A' } })).toBe(false)
  })

  it('a map entry naming NO cell is treated as no entry (falls through to the id prefix)', () => {
    // `undefined` and `''` are one concept — the map claims nothing for this layer — so the
    // layer is resolved from its own `<cellId>::` prefix exactly as an unmapped one is.
    const filter = makeLayerFilter({ 'A::scatter': '' })
    const layer = { id: 'A::scatter' }
    expect(filter({ layer, viewport: { id: 'A' } })).toBe(true)
    expect(filter({ layer, viewport: { id: 'B' } })).toBe(false)
  })

  it('draws an unknown/unprefixed layer in every view (shared overlay default)', () => {
    const filter = makeLayerFilter({})
    const layer = { id: 'sharedGrid' }
    expect(filter({ layer, viewport: { id: 'A' } })).toBe(true)
    expect(filter({ layer, viewport: { id: 'B' } })).toBe(true)
  })

  it('routes multiple cells independently', () => {
    const filter = makeLayerFilter({})
    const a = { id: cellLayerId('A', 'points') }
    const c = { id: cellLayerId('C', 'points') }
    expect(filter({ layer: a, viewport: { id: 'A' } })).toBe(true)
    expect(filter({ layer: a, viewport: { id: 'C' } })).toBe(false)
    expect(filter({ layer: c, viewport: { id: 'C' } })).toBe(true)
    expect(filter({ layer: c, viewport: { id: 'A' } })).toBe(false)
  })

  // ── A CELL ID MAY ITSELF CONTAIN THE SEPARATOR ────────────────────────────────────────────
  // A COMPOSING host (the workbench folds every contributing view's canvas onto ONE grid) mints
  // pane ids as `<viewId>::<paneId>` so two declarations cannot collide on the shared surface.
  // That id is a viewport id here, and every layer a chart in that pane publishes is
  // `<viewId>::<paneId>::<layerName>`. Resolving the owner by parsing to the FIRST separator
  // yields `<viewId>` — which is no viewport at all — so the layer was drawn in NO view: the pane
  // rendered its chrome and its plot painted nothing. That is the empty violin the cell-filter
  // surface shipped.
  //
  // These assert OWNERSHIP against the viewport rather than against a parse, which is the only
  // reading that survives a separator inside either half of the id.
  it("draws a COMPOSED cell's layer in its own view (a cell id containing the separator)", () => {
    const filter = makeLayerFilter({})
    const pane = 'cell.filter::before-violin-0'
    const other = 'cell.filter::after-violin-0'
    const layer = { id: cellLayerId(pane, 'violin-kde') }
    expect(filter({ layer, viewport: { id: pane } })).toBe(true)
    expect(filter({ layer, viewport: { id: other } })).toBe(false)
  })

  it("keeps a composed cell's layer OUT of a sibling contribution's view", () => {
    const filter = makeLayerFilter({})
    const mine = { id: cellLayerId('qc::violin-0', 'violin-box') }
    expect(filter({ layer: mine, viewport: { id: 'qc::violin-0' } })).toBe(true)
    // A different contribution's pane of the SAME name.
    expect(filter({ layer: mine, viewport: { id: 'cell.filter::violin-0' } })).toBe(false)
    // A sibling pane of the same contribution.
    expect(filter({ layer: mine, viewport: { id: 'qc::violin-1' } })).toBe(false)
  })

  // THE SEPARATOR IS PART OF THE MATCH, not decoration. Pane ids that are string-prefixes of one
  // another are ordinary — a `for_each` over 11 criteria places `…-violin-1` beside `…-violin-10`
  // — so claiming a layer whose id merely STARTS WITH the viewport id would draw the 11th
  // criterion's plot into the 2nd criterion's pane as well.
  it('requires the separator, so a viewport id that is a bare string-prefix does not claim the layer', () => {
    const filter = makeLayerFilter({})
    const tenth = { id: cellLayerId('cf::violin-10', 'violin-kde') }
    expect(filter({ layer: tenth, viewport: { id: 'cf::violin-10' } })).toBe(true)
    expect(filter({ layer: tenth, viewport: { id: 'cf::violin-1' } })).toBe(false)
  })

  // THE ONE RESIDUAL AMBIGUITY, PINNED SO IT IS A DECISION AND NOT AN ACCIDENT. `<cellId>::<name>`
  // is a flat join, so a viewport whose id is a STRICT `::`-prefix of another viewport's id also
  // matches — `qc::violin-0::violin-box` starts with both `qc::` and `qc::violin-0::`. That shape
  // needs a grid holding a pane literally named `qc` ALONGSIDE panes named `qc::…`, which a
  // composing host cannot produce (it namespaces EVERY pane it places, so composed and un-composed
  // panes never share a grid). Left as an OVER-draw rather than closed with a second guess about
  // where the boundary is: a layer drawn in one view too many is visible and diagnosable, and a
  // layer drawn in none — the bug this filter just stopped shipping — is neither.
  it('a nested-prefix viewport also claims the layer (deliberate over-draw, not a silent drop)', () => {
    const filter = makeLayerFilter({})
    const layer = { id: cellLayerId('qc::violin-0', 'violin-box') }
    expect(filter({ layer, viewport: { id: 'qc' } })).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `layerBelongsToCell` — the ONE definition of ownership, now shared by the two routers.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('layerBelongsToCell — ownership is a question you ask, not a boundary you parse', () => {
  it('claims a layer whose id is prefixed by the cell, and nothing else', () => {
    expect(layerBelongsToCell(cellLayerId('A', 'scatter'), 'A')).toBe(true)
    expect(layerBelongsToCell(cellLayerId('A', 'scatter'), 'B')).toBe(false)
  })

  it('survives a separator in EITHER half of the join', () => {
    // …in the layer name (asserted since this module was written) …
    expect(layerBelongsToCell(cellLayerId('A', 'group::edges'), 'A')).toBe(true)
    // …and in the CELL id, which is what a composing host mints.
    const pane = 'cell.filter::before-violin-0'
    expect(layerBelongsToCell(cellLayerId(pane, 'violin-kde'), pane)).toBe(true)
    expect(layerBelongsToCell(cellLayerId(pane, 'violin-kde'), 'cell.filter::after-violin-0')).toBe(false)
  })

  // THE ONE RESIDUAL AMBIGUITY, carried over unchanged from `makeLayerFilter`'s own pinning
  // rather than closed differently here — two routers that disagree about ownership are worse
  // than one that over-claims. `<cellId>::<name>` is a flat join, so a candidate that is a
  // STRICT `::`-prefix of the real owner also matches. Producing it needs a grid holding a pane
  // literally named `qc` ALONGSIDE panes named `qc::…`, which a composing host cannot make (it
  // namespaces EVERY pane it places). For the hover router the candidate is a VIEWPORT deck
  // reports, so the shape is doubly unreachable: it would have to be a real pane on screen.
  it('a nested-prefix candidate also claims the layer (the same deliberate over-claim as the filter)', () => {
    expect(layerBelongsToCell(cellLayerId('qc::violin-0', 'violin-box'), 'qc')).toBe(true)
  })

  it('requires the SEPARATOR, so a bare string-prefix claims nothing', () => {
    // `…-violin-1` beside `…-violin-10` is ordinary: a `for_each` over 11 criteria makes it.
    expect(layerBelongsToCell(cellLayerId('cf::violin-10', 'violin-kde'), 'cf::violin-1')).toBe(false)
    expect(layerBelongsToCell(cellLayerId('cf::violin-10', 'violin-kde'), 'cf::violin-10')).toBe(true)
  })

  it('an empty candidate owns nothing (a `::`-leading id must not be claimed by "no cell")', () => {
    expect(layerBelongsToCell('::orphan', '')).toBe(false)
    expect(layerBelongsToCell('sharedGrid', '')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `localLayerName` — the INVERSE, and the third site that used to decide ownership on its own.
//
// `ChartCanvas.onGridHoverRef` un-prefixes a picked layer id before handing the hover to a chart
// handler that matches on the id it BUILT. It did that with its own `startsWith(cellId + '::')`
// + `slice`, i.e. a private re-statement of the ownership rule — the same shape that let the
// parse defect survive being fixed twice. These pin the rule now that it has one home.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('localLayerName — the inverse of cellLayerId', () => {
  it('round-trips: composing then un-composing gives the layer name back', () => {
    expect(localLayerName(cellLayerId('qc::violin-0', 'violin-kde'), 'qc::violin-0')).toBe('violin-kde')
  })

  it('a layer NAME carrying the separator survives (only the cell prefix is removed)', () => {
    // The join is flat and BOTH halves may hold `::`; only the first `<cellId>::` is the prefix.
    expect(localLayerName(cellLayerId('A', 'group::edges'), 'A')).toBe('group::edges')
  })

  it("returns the id UNCHANGED when it is not this cell's — an unshared chart publishes unprefixed", () => {
    expect(localLayerName('viz-heatmap', 'qc::violin-0')).toBe('viz-heatmap')
    expect(localLayerName(cellLayerId('other', 'viz-heatmap'), 'qc::violin-0')).toBe('other::viz-heatmap')
  })

  // THE PREFIX TRAP, on the inverse. A `slice(cellId.length + 2)` guarded by a bare
  // `startsWith(cellId)` would answer `0::violin-kde` here — a chart handler comparing that to the
  // id it built matches NOTHING, so the 11th criterion's chart silently stops recognising its own
  // picks. The separator anchoring is what makes the two panes distinguishable.
  it('a bare string-prefix cell does not get to un-prefix another pane\'s layer', () => {
    const tenth = cellLayerId('cf::violin-10', 'violin-kde')
    expect(localLayerName(tenth, 'cf::violin-1')).toBe(tenth)
    expect(localLayerName(tenth, 'cf::violin-10')).toBe('violin-kde')
  })

  it('an empty cell id un-prefixes nothing (it owns nothing)', () => {
    expect(localLayerName('::orphan', '')).toBe('::orphan')
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `routeGridHover` — REPORTED as two different symptoms with one cause.
//
// `GridOverlayLayer.onDeckHover` recovered the hovered cell from the picked layer id, parsed to
// the FIRST `::`. On a COMPOSED canvas (`<viewId>::<paneId>` panes) that names no cell, so:
//   · a shared-deck CHART pane got no hover at all — no crosshair, no texel tooltip — because the
//     wrong-but-truthy parse short-circuited past the `|| info.viewport?.id` fallback that was
//     there for exactly this case;
//   · a DENSE scatter pick resolved to a cell the grid does not hold, so its point tooltip and the
//     cross-plot highlight were dropped, with no fallback to mask it.
// These assert the ROUTE, against the viewport deck actually reports.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const SCATTER = 'scatter'
const CHARTS = (...ids: string[]) => new Set(ids)

describe('routeGridHover — a hover goes to the cell the pointer is IN', () => {
  it("routes a COMPOSED chart pane's hover to that chart (the empty-violin bug, in the hover path)", () => {
    const pane = 'cell.filter::before-violin-0'
    const route = routeGridHover(
      { layer: { id: cellLayerId(pane, 'violin-kde') }, index: 3, viewport: { id: pane } },
      CHARTS(pane, 'cell.filter::after-violin-0'),
      SCATTER,
    )
    expect(route.chartCellId).toBe(pane)
    expect(route.scatterCellId, 'a chart pane owns the whole hover').toBe('')
  })

  it('routes an UN-COMPOSED chart pane exactly as before (no behaviour moved for the common case)', () => {
    const route = routeGridHover(
      { layer: { id: cellLayerId('heat-0', 'viz-heatmap') }, index: 7, viewport: { id: 'heat-0' } },
      CHARTS('heat-0'),
      SCATTER,
    )
    expect(route.chartCellId).toBe('heat-0')
  })

  it("follows the pointer across a chart's EMPTY background, where there is no layer to parse", () => {
    // The crosshair case: deck reports the viewport with `layer: null`, `index: -1`.
    const route = routeGridHover({ layer: null, index: -1, viewport: { id: 'heat-0' } }, CHARTS('heat-0'), SCATTER)
    expect(route.chartCellId).toBe('heat-0')
  })

  it("routes a COMPOSED dense pane's scatter pick to that pane (the dropped point tooltip)", () => {
    const pane = 'panel.alpha::left'
    const route = routeGridHover(
      { layer: { id: cellLayerId(pane, SCATTER) }, index: 42, viewport: { id: pane } },
      CHARTS('panel.beta::right'),
      SCATTER,
    )
    expect(route.scatterCellId).toBe(pane)
    expect(route.chartCellId).toBe(null)
  })

  it('keeps a composed pane out of a SIBLING contribution that named its pane the same thing', () => {
    const mine = 'qc::violin-0'
    const route = routeGridHover(
      { layer: { id: cellLayerId(mine, 'violin-box') }, index: 1, viewport: { id: mine } },
      CHARTS('cell.filter::violin-0', mine),
      SCATTER,
    )
    expect(route.chartCellId).toBe(mine)
  })

  it('a pane id that is a bare string-prefix of the hovered one claims nothing', () => {
    // 11+ criteria put `…-violin-1` beside `…-violin-10`; the separator is what tells them apart.
    const route = routeGridHover(
      { layer: { id: cellLayerId('cf::violin-10', SCATTER) }, index: 5, viewport: { id: 'cf::violin-10' } },
      CHARTS('cf::violin-1'),
      SCATTER,
    )
    expect(route.chartCellId, 'the 2nd criterion does not claim the 11th criterion\'s hover').toBe(null)
    expect(route.scatterCellId).toBe('cf::violin-10')
  })

  it('drops a hover that is over NO pane (deck reports no viewport between panes)', () => {
    expect(routeGridHover({ layer: null, index: -1, viewport: null }, CHARTS('A'), SCATTER)).toEqual({
      chartCellId: null,
      scatterCellId: '',
    })
    expect(routeGridHover(null, CHARTS('A'), SCATTER)).toEqual({ chartCellId: null, scatterCellId: '' })
  })

  // WITH NO CANDIDATE, THE ROUTER INVENTS NONE. Deck cannot actually produce this pair — it derives
  // `viewport` from the same list the pick ran against, so a layer is only ever picked INSIDE a
  // viewport — which is precisely why it needs pinning here: no live fixture can hold the state, so
  // without this assertion, re-adding `|| cellOfLayer(layerId)` as a harmless-looking fallback
  // restores the exact parse this router exists to remove and every other test stays green. (Mutation
  // M11 survived the first pass on exactly that edit.)
  it('does not reach for the layer id when there is no viewport to attribute the hover to', () => {
    expect(
      routeGridHover({ layer: { id: cellLayerId('A', SCATTER) }, index: 0, viewport: null }, CHARTS('A'), SCATTER),
    ).toEqual({ chartCellId: null, scatterCellId: '' })
  })

  it('a non-scatter pick in a DENSE pane is no point tooltip (the index is not into that buffer)', () => {
    const route = routeGridHover(
      { layer: { id: cellLayerId('A', 'graph-edges') }, index: 2, viewport: { id: 'A' } },
      CHARTS(),
      SCATTER,
    )
    expect(route.scatterCellId).toBe('')
  })

  it('a scatter LAYER with no pick is no point tooltip (index -1 is "nothing under the cursor")', () => {
    const route = routeGridHover(
      { layer: { id: cellLayerId('A', SCATTER) }, index: -1, viewport: { id: 'A' } },
      CHARTS(),
      SCATTER,
    )
    expect(route.scatterCellId).toBe('')
  })

  it('a scatter layer belonging to ANOTHER cell is not read as this pane\'s point', () => {
    // The picked index is an offset into the OWNING cell's buffer, so reading it against this
    // pane's columns would label the point with another cell's row. `makeLayerFilter` makes this
    // unreachable through deck today; the route refuses it rather than trusting that it stays so.
    const route = routeGridHover(
      { layer: { id: cellLayerId('B', SCATTER) }, index: 9, viewport: { id: 'A' } },
      CHARTS(),
      SCATTER,
    )
    expect(route.scatterCellId).toBe('')
  })

  it('a shared overlay pick (no `<cellId>::` prefix at all) is not a point tooltip', () => {
    const route = routeGridHover({ layer: { id: 'sharedGrid' }, index: 0, viewport: { id: 'A' } }, CHARTS(), SCATTER)
    expect(route.scatterCellId).toBe('')
  })
})
