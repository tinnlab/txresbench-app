// canvasComposition.test — TEST-42 / TEST-43 / TEST-44
// [covers: visualize-pane ITEM-31, ITEM-31b, ITEM-31c]
//
// ── WHAT THIS FILE IS ABOUT ─────────────────────────────────────────────────────────────────────
//
// A stack of contributed blocks each keeps its OWN list of emitted plots, declares a `for_each`
// over that list, and the canvas COMPOSES what they all publish. ITEM-31 claimed that needs no new
// mechanism. Two thirds of that is true and asserted here (namespacing, close routing); the third
// is false and is what ITEM-31b/31c fix:
//
//   · ORDER. The fold used to iterate its contributions in FIRST-PUBLISH order, so canvas rows read
//     in the order hosts happened to mount — not the order the user arranged them in, and dragging
//     the arrangement afterwards moved nothing. A contribution now states its POSITION.
//   · SILENT MERGES. Two contributions landing on one pane, or both carrying canvas-LEVEL settings,
//     were merged with (at most) a generic console line. The defect is the SILENCE: a canvas that
//     looks composed and is not. Both are now REPORTED on `collisions`.
//
// ── WHY A MERGE AND NOT A REFUSAL ───────────────────────────────────────────────────────────────
//
// `setOption` is per-GRID. A refusal is therefore never confined to the offending pane — it takes
// every open contributor's plots down with it, which is exactly the failure the repo already paid
// for once ("a frame that loses its rows keeps its columns"). So composition stays TOTAL and states
// what it merged, and the assertions below are on that stated fact rather than on a throw.

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import type { VizOption, VizSeries } from '@ziee/viz'
import { composeCanvas, __resetCompositionWarningForTests, type CanvasContribution } from './canvasComposition'

/** One block's contribution: a plot per entry in ITS OWN list, exactly as a `for_each` resolves. */
function block(
  plots: readonly string[],
  over: Omit<Partial<CanvasContribution>, 'option'> & { option?: Record<string, unknown> } = {},
): CanvasContribution {
  const { option: optionOver, ...rest } = over
  return {
    option: {
      datasets: [{ id: 'frame' }],
      grid: plots.map((id, i) => ({ id, region: { row: i, col: 0 } })),
      series: plots.map(id => ({
        id: `s-${id}`,
        type: 'scatter',
        coordId: id,
        datasetId: 'frame',
        encode: { layout: 'primary' },
      })) as VizSeries[],
      ...optionOver,
    } as VizOption,
    resolver: () => ({}) as never,
    close: null,
    ...rest,
  }
}

/** The composed panes, top row first — what a reader actually sees down the canvas. */
function rowsTopDown(composed: ReturnType<typeof composeCanvas>): string[] {
  const owners = composed.paneOwners
  const at = (g: { region?: { row?: number; col?: number } }) => [g.region?.row ?? 0, g.region?.col ?? 0] as const
  return [...(composed.option?.grid ?? [])]
    .sort((a, b) => at(a)[0] - at(b)[0] || at(a)[1] - at(b)[1])
    .map(g => `${owners.get(g.id)?.viewId}/${owners.get(g.id)?.local}`)
}

beforeEach(() => {
  // The composite warning says itself ONCE per page. Re-armed per spec so one collision here
  // cannot silence the next one's — asserting an absence against a latched warner proves nothing.
  __resetCompositionWarningForTests()
})
afterEach(() => {
  vi.restoreAllMocks()
})

// ── TEST-42 (ITEM-31): three blocks, one canvas ─────────────────────────────────────────────────

describe('three contributed blocks compose into ONE canvas (TEST-42 / ITEM-31)', () => {
  const THREE = () =>
    composeCanvas(
      new Map([
        ['sec.alpha/v', block(['plot-0', 'plot-1'], { order: 0 })],
        ['sec.beta/v', block(['plot-0'], { order: 1 })],
        ['sec.gamma/v', block(['plot-0', 'plot-1'], { order: 2 })],
      ]),
    )

  it('every block keeps its own list — nothing is arbitrated away', () => {
    const composed = THREE()
    expect(composed.active).toBe(true)
    expect(composed.option?.series).toHaveLength(5)
    expect(new Set([...composed.paneOwners.values()].map(o => o.viewId)).size).toBe(3)
  })

  it('three blocks that all call their first plot `plot-0` stay THREE panes', () => {
    // The collision namespacing exists for exactly this: a block names its own plots and knows
    // nothing about its neighbours, so `plot-0` is the ordinary name for the first emitted plot in
    // every one of them. Merging them would put three unrelated pictures in one square.
    const composed = THREE()
    const panes = (composed.option?.series ?? []).map(s => s.coordId)
    expect(new Set(panes).size, 'no cross-block pane collision').toBe(5)
    expect(composed.collisions.sharedPanes, 'and none of it counts as a merge').toEqual([])
  })

  it('each pane still answers to the id ITS OWN block wrote', () => {
    const composed = THREE()
    const beta = [...composed.paneOwners].find(([, o]) => o.viewId === 'sec.beta/v')
    expect(beta?.[1].local).toBe('plot-0')
  })

  it('a close routes to the EMITTING block, in that block\'s own vocabulary', () => {
    const closedIn: Record<string, string[]> = { 'sec.alpha/v': [], 'sec.gamma/v': [] }
    const composed = composeCanvas(
      new Map([
        ['sec.alpha/v', block(['plot-0'], { order: 0, close: id => closedIn['sec.alpha/v'].push(id) })],
        ['sec.gamma/v', block(['plot-0'], { order: 1, close: id => closedIn['sec.gamma/v'].push(id) })],
      ]),
    )
    const gammaPane = [...composed.paneOwners].find(([, o]) => o.viewId === 'sec.gamma/v')?.[0] as string
    composed.close?.(gammaPane)
    expect(closedIn['sec.gamma/v'], 'the emitting block is told, in its own id').toEqual(['plot-0'])
    expect(closedIn['sec.alpha/v'], 'and nobody else is').toEqual([])
  })
})

// ── TEST-43 (ITEM-31b): rows read in the DECLARED order ─────────────────────────────────────────

describe('canvas rows follow the declared position, not first-publish order (TEST-43 / ITEM-31b)', () => {
  it('a block that publishes LAST but is positioned FIRST renders in row 0', () => {
    // This is the assertion that fails against a fold which iterates its map. `sec.gamma`
    // publishes third — it opened collapsed, or its availability resolved a tick later — and is
    // arranged first.
    const composed = composeCanvas(
      new Map([
        ['sec.alpha/v', block(['a'], { order: 1 })],
        ['sec.beta/v', block(['b'], { order: 2 })],
        ['sec.gamma/v', block(['c'], { order: 0 })],
      ]),
    )
    expect(rowsTopDown(composed)).toEqual(['sec.gamma/v/c', 'sec.alpha/v/a', 'sec.beta/v/b'])
  })

  it('re-arranging the blocks MOVES their rows — the same publish set, a different canvas', () => {
    // What a drag does: the same live contributions, re-stated positions. If rows did not move,
    // the arrangement and the canvas would disagree with no way to tell which was lying.
    const before = composeCanvas(
      new Map([
        ['sec.alpha/v', block(['a'], { order: 0 })],
        ['sec.beta/v', block(['b'], { order: 1 })],
      ]),
    )
    const after = composeCanvas(
      new Map([
        ['sec.alpha/v', block(['a'], { order: 1 })],
        ['sec.beta/v', block(['b'], { order: 0 })],
      ]),
    )
    expect(rowsTopDown(before)).toEqual(['sec.alpha/v/a', 'sec.beta/v/b'])
    expect(rowsTopDown(after)).toEqual(['sec.beta/v/b', 'sec.alpha/v/a'])
  })

  it('a MULTI-row block still occupies consecutive rows, offset by whatever precedes it', () => {
    const composed = composeCanvas(
      new Map([
        ['sec.alpha/v', block(['a0', 'a1'], { order: 1 })],
        ['sec.beta/v', block(['b0', 'b1'], { order: 0 })],
      ]),
    )
    expect(rowsTopDown(composed)).toEqual(['sec.beta/v/b0', 'sec.beta/v/b1', 'sec.alpha/v/a0', 'sec.alpha/v/a1'])
  })

  it('UNPOSITIONED contributions keep publish order — the additive half', () => {
    // The behaviour every contributor that states no position had before the field existed, and
    // still has. Without this the field would be a silent re-layout of every existing surface.
    const composed = composeCanvas(
      new Map([
        ['view.two/v', block(['x'])],
        ['view.one/v', block(['y'])],
      ]),
    )
    expect(rowsTopDown(composed)).toEqual(['view.two/v/x', 'view.one/v/y'])
  })

  it('an unpositioned contribution sorts AFTER every positioned one, whenever it published', () => {
    const composed = composeCanvas(
      new Map([
        ['view.legacy/v', block(['x'])],
        ['sec.alpha/v', block(['a'], { order: 0 })],
      ]),
    )
    expect(rowsTopDown(composed)).toEqual(['sec.alpha/v/a', 'view.legacy/v/x'])
  })
})

// ── TEST-44 (ITEM-31c): what composition MERGES is stated, never silent ─────────────────────────

describe('a merged pane is reported, not absorbed (TEST-44a / ITEM-31c)', () => {
  it('a block whose plots are keyed PER ITEM reports no merge', () => {
    // The obligation the emit model owes composition: derive the id from the entry's index or
    // content, so two emitted plots can never be the same pane by construction.
    const composed = composeCanvas(
      new Map([['sec.alpha/v', block(['plot-0', 'plot-1', 'plot-2'], { order: 0 })]]),
    )
    expect(composed.collisions.sharedPanes).toEqual([])
    expect(composed.option?.series).toHaveLength(3)
  })

  it('two plots of ONE block on one pane are still drawn — and the merge is NAMED', () => {
    const composed = composeCanvas(new Map([['sec.alpha/v', block(['plot-0', 'plot-0'], { order: 0 })]]))
    // Both series survive: a refusal would blank the whole grid, including every innocent
    // contributor, because `setOption` is per-GRID.
    expect(composed.option?.series, 'nothing is dropped').toHaveLength(2)
    expect(composed.collisions.sharedPanes).toHaveLength(1)
    const [shared] = composed.collisions.sharedPanes
    expect(shared.viewId).toBe('sec.alpha/v')
    expect(shared.local, 'named the way its author named it').toBe('plot-0')
    expect(shared.seriesIds, 'BOTH occupants, so the reader can see what merged').toHaveLength(2)
    // …and the pane really is one square, which is the fact being reported.
    expect(composed.option?.grid).toHaveLength(1)
  })

  it('the report is per PANE — a second merged pane is a second entry, not a flag', () => {
    const composed = composeCanvas(
      new Map([['sec.alpha/v', block(['p', 'p', 'q', 'q', 'r'], { order: 0 })]]),
    )
    expect(composed.collisions.sharedPanes.map(s => s.local)).toEqual(['p', 'q'])
  })
})

describe('canvas-LEVEL settings are last-writer-wins, and the loss is reported (TEST-44b / ITEM-31c)', () => {
  const withKeys = (over: Record<string, unknown>, order: number) => block(['p'], { order, option: over })

  it('three blocks where only ONE carries canvas-level settings compose cleanly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const composed = composeCanvas(
      new Map([
        ['sec.alpha/v', withKeys({ controls: { zoom: true } }, 0)],
        ['sec.beta/v', block(['p'], { order: 1 })],
        ['sec.gamma/v', block(['p'], { order: 2 })],
      ]),
    )
    // The state, not the console: an empty report is the assertion, and the absence of a warning
    // is only its corollary.
    expect(composed.collisions.optionKeys).toEqual([])
    expect((composed.option as { controls?: unknown }).controls).toEqual({ zoom: true })
    expect(warn).not.toHaveBeenCalled()
  })

  it('two blocks carrying the SAME canvas-level key: the later wins and the key is named', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const composed = composeCanvas(
      new Map([
        ['sec.alpha/v', withKeys({ controls: { zoom: true } }, 0)],
        ['sec.beta/v', withKeys({ controls: { zoom: false } }, 1)],
      ]),
    )
    expect(composed.collisions.optionKeys).toEqual(['controls'])
    expect(
      (composed.option as { controls?: { zoom?: boolean } }).controls?.zoom,
      'the LATER publish wins — stated, not silently chosen',
    ).toBe(false)
    // The console line names the key too, for the reader who is not running a test.
    expect(warn.mock.calls.at(0)?.[0]).toContain('controls')
  })

  it('a key only ONE block carries is composed, not counted as a collision', () => {
    // The negative control that stops the report degrading to "more than one block carried
    // anything at all" — which would fire on every ordinary multi-block canvas.
    const composed = composeCanvas(
      new Map([
        ['sec.alpha/v', withKeys({ controls: { zoom: true } }, 0)],
        ['sec.beta/v', withKeys({ selection: { mode: 'lasso' } }, 1)],
      ]),
    )
    expect(composed.collisions.optionKeys).toEqual([])
    expect((composed.option as { controls?: unknown }).controls).toEqual({ zoom: true })
    expect((composed.option as { selection?: unknown }).selection).toEqual({ mode: 'lasso' })
  })
})
