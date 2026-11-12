import { beforeEach, describe, expect, it } from 'vitest'
import { cellSpaceKey, installBuiltinSchemas, parseOption, type DatasetCatalog } from '@txresbench/viz'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { __resetCoordinateIdsForTests, resolveDeclarativeCanvas } from './canvasFeed'
import { declarativeCanvas } from './declarativeCanvasFeed.store'

const CANVAS_SPEC = {
  id: 'view.beta',
  title: 'QC',
  canvas: {
    datasets: [{ id: 'obs' }],
    series: [
      { id: 's_total', type: 'violin', coordId: 'v_total', datasetId: 'obs', encode: { valueKey: 'total_counts' } },
      { id: 's_mito', type: 'violin', coordId: 'v_mito', datasetId: 'obs', encode: { valueKey: 'pct_mito' } },
    ],
    grid: [
      { id: 'v_total', region: { row: 0, col: 0 } },
      { id: 'v_mito', region: { row: 0, col: 1 } },
    ],
  },
} as unknown as ViewSpec

describe('resolveDeclarativeCanvas (ITEM-10)', () => {
  it('resolves the declared canvas into an option + a DatasetResolver over $data.obs', async () => {
    const obs = { total_counts: [10, 20, 30], pct_mito: [1, 2, 3] }
    const feed = resolveDeclarativeCanvas(CANVAS_SPEC, {
      data: { obs },
      scope: { state: {}, derived: {}, const: {}, data: { obs } },
    })
    expect(feed).not.toBeNull()
    expect(feed!.option.series).toHaveLength(2)
    // The resolver maps the logical `obs` id onto a source whose catalog lists the obs columns.
    const source = await feed!.resolver('obs')
    const catalog = await source.catalog()
    expect(catalog.pointCount).toBe(3)
    expect(catalog.valueColumns).toContain('total_counts')
    expect(catalog.valueColumns).toContain('pct_mito')
  })

  // C8: the keep-mask is a DECLARED expression on the canvas block (`mask`), resolved against
  // the view's own scope. Core used to read `$derived.keptMask` by that literal name, so a
  // processor spelling its mask anything else silently got unmasked `.kept` panes.
  it('applies the DECLARED keep-mask expression on the .kept variant', async () => {
    const obs = { total_counts: [10, 20, 30] }
    const masked = { ...CANVAS_SPEC, canvas: { ...(CANVAS_SPEC.canvas as object), mask: '$derived.myMask' } } as ViewSpec
    const feed = resolveDeclarativeCanvas(masked, {
      data: { obs },
      scope: { state: {}, derived: { myMask: [true, false, true] }, const: {}, data: { obs } },
    })
    const kept = await feed!.resolver('obs.kept')
    expect((await kept.catalog()).pointCount).toBe(2)
    // The app-only `mask` binding is stripped before the option reaches viz.
    expect((feed!.option as { mask?: unknown }).mask).toBeUndefined()
  })

  it('an UNDECLARED mask leaves the .kept variant unmasked', async () => {
    const obs = { total_counts: [10, 20, 30] }
    const feed = resolveDeclarativeCanvas(CANVAS_SPEC, {
      data: { obs },
      scope: { state: {}, derived: { keptMask: [true, false, true] }, const: {}, data: { obs } },
    })
    const kept = await feed!.resolver('obs.kept')
    expect((await kept.catalog()).pointCount).toBe(3)
  })

  // Regression (C1): QC's canvas is STATIC — four violins binding `<modality>:<metric>` columns
  // that only exist once a QC run has produced `/obs`. Before this guard the host handed viz an
  // option binding absent columns, viz's `validateBindings` threw for the WHOLE option, and
  // `CanvasView` console-errored on every render of every workbench surface.
  it('returns null when NO declared binding resolves against the current data (no run yet)', () => {
    expect(
      resolveDeclarativeCanvas(CANVAS_SPEC, {
        data: {}, // `$data.obs` absent — the analysis has not produced /obs
        scope: { state: {}, derived: {}, const: {}, data: {} },
      }),
    ).toBeNull()
    expect(
      resolveDeclarativeCanvas(CANVAS_SPEC, {
        data: { obs: {} }, // present but empty
        scope: { state: {}, derived: {}, const: {}, data: { obs: {} } },
      }),
    ).toBeNull()
  })

  it('drops only the series whose column is missing, keeping the ones that resolve', () => {
    const obs = { total_counts: [10, 20, 30] } // no `pct_mito` (metric removed by the user)
    const feed = resolveDeclarativeCanvas(CANVAS_SPEC, {
      data: { obs },
      scope: { state: {}, derived: {}, const: {}, data: { obs } },
    })
    expect(feed).not.toBeNull()
    expect(feed!.option.series.map(s => s.id)).toEqual(['s_total'])
  })

  it('rejects a binding of the wrong KIND (a categorical groupKey over a numeric column)', () => {
    const spec = {
      id: 'g',
      title: 'g',
      canvas: {
        datasets: [{ id: 'obs' }],
        series: [
          {
            id: 's',
            type: 'violin',
            coordId: 'v',
            datasetId: 'obs',
            encode: { valueKey: 'total_counts', groupKey: 'total_counts' },
          },
        ],
        grid: [{ id: 'v', region: { row: 0, col: 0 } }],
      },
    } as unknown as ViewSpec
    const obs = { total_counts: [10, 20, 30] }
    expect(
      resolveDeclarativeCanvas(spec, {
        data: { obs },
        scope: { state: {}, derived: {}, const: {}, data: { obs } },
      }),
    ).toBeNull()
  })

  it('keeps a series that binds NO dataset column (an image underlay)', () => {
    const spec = {
      id: 'img',
      title: 'img',
      canvas: {
        datasets: [{ id: 'obs' }],
        series: [{ id: 's_img', type: 'image', coordId: 'v', datasetId: 'obs' }],
        grid: [{ id: 'v', region: { row: 0, col: 0 } }],
      },
    } as unknown as ViewSpec
    const feed = resolveDeclarativeCanvas(spec, {
      data: { obs: {} },
      scope: { state: {}, derived: {}, const: {}, data: { obs: {} } },
    })
    expect(feed).not.toBeNull()
    expect(feed!.option.series.map(s => s.id)).toEqual(['s_img'])
  })

  it('returns null for a view with no canvas / no series', () => {
    expect(resolveDeclarativeCanvas({ id: 'x', title: 'x' } as ViewSpec, { data: {}, scope: {} })).toBeNull()
    expect(
      resolveDeclarativeCanvas({ id: 'x', title: 'x', canvas: { series: [] } } as unknown as ViewSpec, {
        data: {},
        scope: {},
      }),
    ).toBeNull()
  })

  // ── r3canvas: the DEFAULT dataset id comes from the DECLARATION, not from core ──────────────
  // This line used to be `resolved.datasets[0]?.id ?? 'obs'` — it already computed the
  // declaration's own default and then discarded it for a literal. The full parity proof lives in
  // `core/spec/obsLanguage.test.ts`; these two pin the feed-level consequences.

  it('a series with NO datasetId falls back to the declaration\'s OWN default slice', async () => {
    const spec = {
      id: 'defaulted',
      title: 'defaulted',
      canvas: {
        // the default slice is named `frame` — nothing here is called `obs`
        datasets: [{ id: 'frame' }],
        series: [{ id: 's', type: 'violin', coordId: 'v', encode: { valueKey: 'total' } }],
        grid: [{ id: 'v', region: { row: 0, col: 0 } }],
      },
    } as unknown as ViewSpec
    const data = { frame: { total: [1, 2, 3] } }
    const feed = resolveDeclarativeCanvas(spec, { data, scope: { state: {}, derived: {}, const: {}, data } })
    // The series resolves against `frame` (the declared default). Before r3canvas it would have
    // been checked against a slice called `obs`, found nothing, and been dropped ⇒ null feed.
    expect(feed, 'the undeclared-datasetId series must bind the declared default').not.toBeNull()
    expect((await (await feed!.resolver('frame')).catalog()).pointCount).toBe(3)
  })

  it('a canvas that declares NO datasets invents no default (undeclared series bind nothing)', () => {
    const spec = {
      id: 'no-datasets',
      title: 'no datasets',
      canvas: {
        series: [{ id: 's', type: 'violin', coordId: 'v', encode: { valueKey: 'total' } }],
        grid: [{ id: 'v', region: { row: 0, col: 0 } }],
      },
    } as unknown as ViewSpec
    // `obs` is present in the data and the series binds a column that EXISTS in it — so a core
    // that still defaulted to `obs` would happily plot. It must not: nothing declared it.
    const data = { obs: { total: [1, 2, 3] } }
    expect(
      resolveDeclarativeCanvas(spec, { data, scope: { state: {}, derived: {}, const: {}, data } }),
    ).toBeNull()
  })
})

describe('declarativeCanvasFeed.store', () => {
  const seriesOf = (coordId: string) =>
    ({ series: [{ id: coordId, type: 'violin', coordId }] }) as never
  const resolver = ((_id: string) => ({}) as never) as never

  beforeEach(() => {
    for (const viewId of [...declarativeCanvas.get().contributions.keys()]) declarativeCanvas.clear(viewId)
  })

  it('composes every contributing view onto the one canvas', () => {
    declarativeCanvas.setFeed('view-A', seriesOf('a1'), resolver)
    declarativeCanvas.setFeed('view-B', seriesOf('b1'), resolver)
    expect(declarativeCanvas.get().active).toBe(true)
    expect(
      [...declarativeCanvas.get().paneOwners.values()].map(o => `${o.viewId}/${o.local}`),
      'a second view ADDS to the shared canvas; it does not evict the first',
    ).toEqual(['view-A/a1', 'view-B/b1'])
  })

  it('clear retires ONE view and leaves the rest of the canvas standing', () => {
    declarativeCanvas.setFeed('view-A', seriesOf('a1'), resolver)
    declarativeCanvas.setFeed('view-B', seriesOf('b1'), resolver)
    // a view that never contributed cannot disturb anything
    declarativeCanvas.clear('view-C')
    expect(declarativeCanvas.get().option?.series).toHaveLength(2)

    declarativeCanvas.clear('view-B')
    expect([...declarativeCanvas.get().paneOwners.values()].map(o => o.local)).toEqual(['a1'])
    declarativeCanvas.clear('view-A')
    expect(declarativeCanvas.get().active).toBe(false)
    expect(declarativeCanvas.get().option).toBeNull()
  })

  // Composition RENAMES every dataset id (`<view>::<declared>`) so two declarations cannot collide
  // on the shared grid. The content token `canvasFeed` publishes alongside the id has to survive
  // that rename, and there is no type that makes it: a rebuild of the composed entry that names its
  // fields instead of spreading them would drop `rev` silently, and the only symptom would be the
  // defect this whole path exists to fix — a pane frozen on the first content it ever resolved.
  it('namespacing a dataset renames it and carries its content revision through', () => {
    const withRev = (rev: string) =>
      ({
        datasets: [{ id: 'frame', rev }],
        series: [{ id: 's', type: 'violin', coordId: 'p', datasetId: 'frame' }],
      }) as never
    declarativeCanvas.setFeed('view-A', withRev('r1'), resolver)
    const first = declarativeCanvas.get().option!
    expect(first.datasets, 'the id is namespaced; the revision rides along').toEqual([
      { id: 'view-A::frame', rev: 'r1' },
    ])
    expect(first.series[0].datasetId, 'the series follows the renamed dataset').toBe('view-A::frame')

    // A re-publish at NEW content: the composed id must hold still and only the revision move.
    declarativeCanvas.setFeed('view-A', withRev('r2'), resolver)
    expect(declarativeCanvas.get().option!.datasets).toEqual([{ id: 'view-A::frame', rev: 'r2' }])
  })

  it('two views naming a pane the same thing stay distinct on the shared grid', () => {
    // Independently-authored declarations have no way to coordinate ids. A collision here would
    // silently merge two unrelated plots into one pane.
    declarativeCanvas.setFeed('view-A', seriesOf('same'), resolver)
    declarativeCanvas.setFeed('view-B', seriesOf('same'), resolver)
    const grid = declarativeCanvas.get().option!.grid!
    expect(new Set(grid.map(g => g.id)).size, 'two panes, two grid entries').toBe(2)
    expect(grid.map(g => g.region?.row), 'the second view stacks BELOW the first').toEqual([0, 1])
  })
})

// ── dynamic for_each canvas + controlled cell-close (Slice 4, ITEM-9/17) ────────
const DYNAMIC_SPEC = {
  id: 'plot.filter',
  title: 'Plot filter',
  canvas: {
    datasets: [{ id: 'obs' }, { id: 'obs.kept' }],
    grid: [],
    series: [
      {
        id: 's-before-violin-$i',
        for_each: '$state.criteria as $c, $i',
        when: '$derived.controlByColumn[$c.column] == range',
        type: 'violin',
        coordId: 'before-violin-$i',
        datasetId: 'obs',
        controlled: true,
        encode: { valueKey: '$c.column', groupKey: '$state.groupBy' },
        close: { action: 'vb.removeItem', args: { index: '$i' } },
      },
      {
        id: 's-after-violin-$i',
        for_each: '$state.criteria as $c, $i',
        when: '$derived.controlByColumn[$c.column] == range',
        type: 'violin',
        coordId: 'after-violin-$i',
        datasetId: 'obs.kept',
        controlled: true,
        encode: { valueKey: '$c.column', groupKey: '$state.groupBy' },
        close: { action: 'vb.removeItem', args: { index: '$i' } },
      },
    ],
  },
} as unknown as ViewSpec

describe('resolveDeclarativeCanvas — dynamic for_each + controlled cell-close (Slice 4)', () => {
  const obs = { pct_mito: [5, 20, 8], groupBy: ['a', 'b', 'a'] }
  const scope = {
    state: { criteria: [{ column: 'pct_mito', control: 'range' }, { column: '', control: '' }], groupBy: '' },
    derived: { controlByColumn: { pct_mito: 'range' } },
    const: {},
    data: { obs },
  }

  it('expands one before/after pair per PICKED-column criterion; an empty-column criterion does not plot (when)', () => {
    const feed = resolveDeclarativeCanvas(DYNAMIC_SPEC, { data: { obs }, scope })!
    expect(feed).not.toBeNull()
    const ids = (feed.option.series ?? []).map(s => s.coordId).sort()
    // only the criterion whose column is picked (index 0) plots — before + after; the blank
    // criterion (index 1) is when-gated out.
    expect(ids).toEqual(['after-violin-0', 'before-violin-0'])
    // the wire series carry `controlled` (the seam viz reads) but NOT the app-only `close`/`when`.
    for (const s of feed.option.series ?? []) {
      expect((s as { controlled?: boolean }).controlled).toBe(true)
      expect((s as { close?: unknown }).close).toBeUndefined()
      expect((s as { when?: unknown }).when).toBeUndefined()
      expect((s as { for_each?: unknown }).for_each).toBeUndefined()
    }
    // An unset group-by reaches viz as `''` — viz's own spelling of "bind no column" — and NOT as
    // an absent channel. This assertion used to read `toBeUndefined()`, and that is the shape of
    // the bug the owner reported: dropping the channel makes it indistinguishable from one the
    // view never mentioned, so `resolveBinding` fills it from the catalog and the violin groups by
    // whichever categorical column happens to be first. The test passed the whole time.
    expect((feed.option.series?.[0] as { encode?: Record<string, unknown> }).encode?.groupKey).toBe('')
  })

  it('returns null when the dynamic content expands to ZERO series (no criteria yet → empty hero)', () => {
    // No picked criteria → every `for_each` series is when-gated out → zero concrete series → the
    // canvas is NOT active (the center shows `workbench-canvas-empty` until a column is picked).
    const emptyScope = {
      state: { criteria: [], groupBy: '' },
      derived: { controlByColumn: {} },
      const: {},
      data: { obs },
    }
    expect(resolveDeclarativeCanvas(DYNAMIC_SPEC, { data: { obs }, scope: emptyScope })).toBeNull()
    // A blank-only criterion (column '' → when-gated out) is likewise not plottable → null.
    const blankScope = {
      state: { criteria: [{ column: '', control: '' }], groupBy: '' },
      derived: { controlByColumn: {} },
      const: {},
      data: { obs },
    }
    expect(resolveDeclarativeCanvas(DYNAMIC_SPEC, { data: { obs }, scope: blankScope })).toBeNull()
  })

  it('builds a { coordId → {action, params} } close-action map from the per-series close binding', () => {
    const feed = resolveDeclarativeCanvas(DYNAMIC_SPEC, { data: { obs }, scope })!
    expect(feed.closeActions['before-violin-0']).toEqual({ action: 'vb.removeItem', params: { index: 0 } })
    expect(feed.closeActions['after-violin-0']).toEqual({ action: 'vb.removeItem', params: { index: 0 } })
    // the blank criterion never plotted, so it contributes no close action.
    expect(Object.keys(feed.closeActions).sort()).toEqual(['after-violin-0', 'before-violin-0'])
  })
})

// Slice-6 INV-16: a spatial image under `$data.image` (or `$data.<base>.image`) resolves into
// the canvas feed's DatasetResolver as an ImageUnderlay, so cell-filter's declared `showSpatial`
// before/after `image` series PAINTS on the general canvas (no viz change).
describe('resolveDeclarativeCanvas — spatial image underlay (Slice 6, INV-16)', () => {
  const IMAGE = {
    data: new Uint8Array(4 * 2 * 2),
    width: 2,
    height: 2,
    channels: 4,
    affine: [0.5, 0, 0, 0, 0.5, 0],
  }

  it('wires a $data.image spatial underlay into the resolver for the obs base', async () => {
    const obs = { total_counts: [10, 20, 30], pct_mito: [1, 2, 3] }
    const feed = resolveDeclarativeCanvas(CANVAS_SPEC, {
      data: { obs, image: IMAGE },
      scope: { state: {}, derived: {}, const: {}, data: { obs, image: IMAGE } },
    })!
    const source = await feed.resolver('obs')
    expect((await source.catalog()).hasImage).toBe(true)
    const underlay = await source.imageUnderlay()
    expect(underlay.affine).toEqual([0.5, 0, 0, 0, 0.5, 0])
    expect(underlay.width).toBe(2)
  })

  it('a rejected payload without an affine is not treated as an underlay', async () => {
    const obs = { total_counts: [10, 20, 30] }
    const feed = resolveDeclarativeCanvas(CANVAS_SPEC, {
      data: { obs, image: { data: new Uint8Array(4), width: 1, height: 1 } },
      scope: { state: {}, derived: {}, const: {}, data: { obs } },
    })!
    const source = await feed.resolver('obs')
    expect((await source.catalog()).hasImage).toBe(false)
  })

  it('no image ⇒ metric-only source (unchanged behavior)', async () => {
    const obs = { total_counts: [10] }
    const feed = resolveDeclarativeCanvas(CANVAS_SPEC, {
      data: { obs },
      scope: { state: {}, derived: {}, const: {}, data: { obs } },
    })!
    expect((await (await feed.resolver('obs')).catalog()).hasImage).toBe(false)
  })
})

// ── one unservable binding must not blank the WHOLE canvas (G3) ─────────────────────────────
// The feed drops a series whose declared columns the current frame cannot serve, because viz
// validates encode-explicit bindings against the catalog and throws for the ENTIRE option. The
// drop is only as good as the predicate behind it: a grouping bound to a per-row key is refused
// by the catalog but used to pass the pre-filter, so the option reached viz and every pane went
// with it.
describe('a series the frame cannot serve is dropped, not handed to viz (G3)', () => {
  const FRAME = {
    depth: [10, 20, 30, 40],
    key: ['r1', 'r2', 'r3', 'r4'],
  }
  const SPEC = {
    id: 'view.mixed',
    title: 'Mixed',
    canvas: {
      datasets: [{ id: 'frame' }],
      grid: [],
      series: [
        { id: 's-ok', type: 'violin', coordId: 'ok', datasetId: 'frame', encode: { valueKey: 'depth' } },
        {
          id: 's-bad',
          type: 'violin',
          coordId: 'bad',
          datasetId: 'frame',
          encode: { valueKey: 'depth', groupKey: 'key' },
        },
      ],
    },
  } as unknown as ViewSpec

  it('keeps the servable pane and drops the other, so viz accepts the option', async () => {
    installBuiltinSchemas()
    const data = { frame: FRAME }
    const feed = resolveDeclarativeCanvas(SPEC, {
      data,
      scope: { params: {}, state: {}, derived: {}, const: {}, data },
    })
    expect(feed, 'the servable series keeps the canvas alive').not.toBeNull()
    expect(feed!.option.series.map(s => s.id)).toEqual(['s-ok'])

    const catalogs: Record<string, DatasetCatalog> = {}
    for (const d of feed!.option.datasets ?? []) catalogs[d.id] = await (await feed!.resolver(d.id)).catalog()
    // The whole point: viz ACCEPTS what the feed hands over. Before the pre-filter agreed with the
    // catalog, this threw and the canvas painted nothing at all.
    expect(() => parseOption(feed!.option, catalogs)).not.toThrow()
  })
})

// ITEM-29 — THE `coords` CANVAS KEY. A base drawn in the coordinates the block DECLARED,
// rather than in whichever plottable-xy artifact the project happened to list first.
//
// Asserted through `source.positions()`, which is where the pixels come from: the declaration
// resolving is not the property that matters — the property that matters is that the base's
// DataSource serves those coordinates and not the fallback's.
describe('declared coords (ITEM-29)', () => {
  const points = (xs: number[]): { positions: Float32Array; length: number } => ({
    positions: Float32Array.from(xs),
    length: xs.length / 2,
  })
  const DECLARED = points([1, 1, 2, 2, 3, 3])
  const FALLBACK = points([9, 9, 9, 9, 9, 9])

  /** The feed's SOLE declared dataset entry. Each `coordsSpec` below declares exactly one, so
   *  the index is the whole collection rather than a position within it — read once, here, so
   *  the sole-element access is one documented spot instead of six. */
  const soleDataset = (feed: ReturnType<typeof resolveDeclarativeCanvas>) => feed!.option.datasets?.[0]

  const coordsSpec = (artifact: string) =>
    ({
      id: 'view.coords',
      title: 'T',
      canvas: {
        datasets: [{ id: 'base', coords: { artifact } }],
        series: [{ id: 's', type: 'scatter', coordId: 'p', datasetId: 'base', encode: { colorBy: 'g' } }],
      },
    }) as unknown as ViewSpec

  const inputs = (over: Record<string, unknown> = {}) => {
    const base = { g: ['a', 'b', 'c'] }
    return {
      data: { base },
      positions: FALLBACK,
      scope: { state: { chosen: 'art-1' }, derived: {}, const: {}, data: { base } },
      ...over,
    }
  }

  it('draws the base in the DECLARED artifact\'s positions, not the project fallback', async () => {
    const feed = resolveDeclarativeCanvas(coordsSpec('$state.chosen'), {
      ...inputs(),
      positionsByArtifact: new Map([['art-1', DECLARED]]),
    })
    const source = await feed!.resolver('base')
    expect([...(await source.positions('ignored')).positions]).toEqual([1, 1, 2, 2, 3, 3])
  })

  // ── THE REVISION MUST MOVE WHEN THE COORDINATES ARRIVE (ledger #21) ────────────────────
  //
  // `rev` is the ONLY thing that tells viz a dataset it already resolved has changed; without a
  // change it reuses the source it built the first time. The declared coordinates are read
  // asynchronously, so an emitted bare frame publishes TWICE — once with no positions, once
  // with them — and both publishes used to compute a byte-identical `rev` out of a data slice
  // that never moved. Viz kept the empty source and the plot rendered zero points forever:
  // the owner's *"right now I saw nothing plot"*.
  //
  // A bare frame is the case that makes this total rather than rare — it binds no column, so
  // its slice is empty BY DESIGN and its positions are the only content it has.
  it('the dataset revision CHANGES when the declared positions land', () => {
    const pending = resolveDeclarativeCanvas(coordsSpec('$state.chosen'), {
      ...inputs(),
      positionsByArtifact: new Map(),
    })
    const landed = resolveDeclarativeCanvas(coordsSpec('$state.chosen'), {
      ...inputs(),
      positionsByArtifact: new Map([['art-1', DECLARED]]),
    })
    const revOf = (f: typeof pending): unknown => soleDataset(f)?.rev
    expect(revOf(pending)).not.toEqual(revOf(landed))
  })

  it('…and when the declaration names a DIFFERENT artifact', () => {
    // The other half of "the coordinates are content": two plots drawn from two coordinate sets
    // over the same (empty) slice are two different pictures, so they may not share a revision.
    const a = resolveDeclarativeCanvas(coordsSpec('$state.chosen'), {
      ...inputs(),
      positionsByArtifact: new Map([['art-1', DECLARED]]),
    })
    const b = resolveDeclarativeCanvas(coordsSpec('$state.other'), {
      ...inputs({
        scope: { state: { chosen: 'art-1', other: 'art-2' }, derived: {}, const: {}, data: { base: { g: ['a', 'b', 'c'] } } },
      }),
      positionsByArtifact: new Map([['art-2', DECLARED]]),
    })
    expect(soleDataset(a)?.rev).not.toEqual(soleDataset(b)?.rev)
  })

  it('a base that declares NO coords keeps its revision unchanged by any of this', () => {
    // The regression guard: every existing canvas takes its revision from its slice alone, and
    // this change must be invisible to them.
    const bare = {
      id: 'view.bare',
      title: 'T',
      canvas: {
        datasets: [{ id: 'base' }],
        series: [{ id: 's', type: 'scatter', coordId: 'p', datasetId: 'base', encode: { colorBy: 'g' } }],
      },
    } as unknown as ViewSpec
    const one = resolveDeclarativeCanvas(bare, { ...inputs(), positionsByArtifact: new Map() })
    const two = resolveDeclarativeCanvas(bare, { ...inputs(), positionsByArtifact: new Map([['art-1', DECLARED]]) })
    expect(soleDataset(one)?.rev).toEqual(soleDataset(two)?.rev)
  })

  it('never puts `coords` on the wire option — it is an APP key, like `mask`', () => {
    const feed = resolveDeclarativeCanvas(coordsSpec('$state.chosen'), {
      ...inputs(),
      positionsByArtifact: new Map([['art-1', DECLARED]]),
    })
    expect(soleDataset(feed)).not.toHaveProperty('coords')
  })

  it('does NOT throw while the declared artifact has not resolved — and serves no coordinates', async () => {
    const feed = resolveDeclarativeCanvas(coordsSpec('$state.chosen'), { ...inputs(), positionsByArtifact: new Map() })
    const source = await feed!.resolver('base')
    // ── REWRITTEN by ITEM-7 ────────────────────────────────────────────────────────────────
    // This asserted `positions.length > 0`, reasoning that "a plot that blanked in the
    // meantime would be a worse answer than one drawn from the fallback for a frame". But
    // this frame is `{ g: ['a','b','c'] }` — it has ZERO numeric columns, so what it was
    // actually measuring was the old fallback's `new Float32Array(n * 2)`: three points at
    // (0,0). Not a fallback at all — a fabricated coordinate space stacking every point on
    // the origin, which reads as a real, if odd, plot. `positions.length > 0` was true of it
    // for the same reason it is true of nonsense.
    //
    // The surviving intent is the one in the title, and it still holds: an unresolved `coords`
    // must not throw. What it now serves is the honest zero, and the late arrival re-publishes.
    const p = await source.positions('ignored')
    expect(p.length, 'a frame with no coordinates paints nothing rather than a pile at the origin').toBe(0)
    expect(p.positions.length).toBe(0)
  })

  it('leaves a block that declares NO coords byte-identical to before', async () => {
    const spec = {
      id: 'view.plain',
      title: 'T',
      canvas: {
        datasets: [{ id: 'base' }],
        series: [{ id: 's', type: 'scatter', coordId: 'p', datasetId: 'base', encode: { colorBy: 'g' } }],
      },
    } as unknown as ViewSpec
    const feed = resolveDeclarativeCanvas(spec, { ...inputs(), positionsByArtifact: new Map([['art-1', DECLARED]]) })
    const source = await feed!.resolver('base')
    expect([...(await source.positions('ignored')).positions]).toEqual([9, 9, 9, 9, 9, 9])
  })

  it('gives a `.kept` variant the SAME declared coordinates as its base', async () => {
    const spec = {
      id: 'view.kept',
      title: 'T',
      canvas: {
        mask: '$derived.keep',
        datasets: [{ id: 'base', coords: { artifact: 'art-1' } }, { id: 'base.kept' }],
        series: [{ id: 's', type: 'scatter', coordId: 'p', datasetId: 'base.kept', encode: { colorBy: 'g' } }],
      },
    } as unknown as ViewSpec
    const base = { g: ['a', 'b', 'c'] }
    const feed = resolveDeclarativeCanvas(spec, {
      data: { base },
      positions: FALLBACK,
      positionsByArtifact: new Map([['art-1', DECLARED]]),
      scope: { state: {}, derived: { keep: [true, false, true] }, const: {}, data: { base } },
    })
    const source = await feed!.resolver('base.kept')
    // The mask filters the DECLARED coordinates rather than sending the variant to the
    // project-wide fallback.
    expect([...(await source.positions('ignored')).positions]).toEqual([1, 1, 3, 3])
  })
})

// ── THE EMIT MODEL'S BASES (visualize-pane ITEM-31 / ITEM-36 / ITEM-43) ───────────────────────
//
// An emitted plot needs its OWN dataset base: two plots may sit on different row spaces (whose
// columns are different LENGTHS), a canvas dataset is also an identity SPACE (so a shared base
// would make two plots brush each other), and DEC-9's second click puts two entries on one
// artifact. A `data:` block's keys are literals an author wrote, so a base per plot cannot be a
// slice — it is a PATH INTO one.
describe('a dataset base may name a PATH into $data (the emit model’s per-plot bases)', () => {
  const emitSpec = (n: number): ViewSpec =>
    ({
      id: 'view.emit',
      title: 'Emit',
      canvas: {
        grid: [],
        datasets: Array.from({ length: n }, (_, i) => ({ id: `plotted.${i}` })),
        series: Array.from({ length: n }, (_, i) => ({
          id: `s-${i}`,
          type: 'violin',
          coordId: `cell-${i}`,
          datasetId: `plotted.${i}`,
          encode: { valueKey: 'value' },
        })),
      },
    }) as unknown as ViewSpec

  it('resolves each plot against its OWN nested frame', () => {
    const data = { plotted: { '0': { value: [1, 2, 3] }, '1': { value: [4, 5] } } }
    const feed = resolveDeclarativeCanvas(emitSpec(2), {
      data,
      scope: { state: {}, derived: {}, const: {}, data },
    })
    expect(feed).not.toBeNull()
    expect(feed!.option.series.map(s => s.datasetId)).toEqual(['plotted.0', 'plotted.1'])
    // Two DIFFERENT contents under two ids ⇒ two revisions, so viz re-resolves each in place
    // rather than reusing the first for both.
    const revs = (feed!.option.datasets ?? []).map(d => d.rev)
    expect(new Set(revs).size).toBe(2)
  })

  it('a base that resolves to NOTHING drops its own series and no other', () => {
    // The honest degradation: an artifact deleted under one open plot takes that plot off the
    // canvas, not the whole grid.
    const data = { plotted: { '1': { value: [4, 5] } } }
    const feed = resolveDeclarativeCanvas(emitSpec(2), {
      data,
      scope: { state: {}, derived: {}, const: {}, data },
    })
    expect(feed!.option.series.map(s => s.coordId)).toEqual(['cell-1'])
  })

  it('a TOP-LEVEL slice whose own key contains a dot still resolves whole', () => {
    // The path walk is a fallback, never a reinterpretation: the literal key is tried first.
    const data = { 'plotted.0': { value: [7] } }
    const feed = resolveDeclarativeCanvas(emitSpec(1), {
      data,
      scope: { state: {}, derived: {}, const: {}, data },
    })
    expect(feed!.option.series).toHaveLength(1)
  })
})

describe('a base that DECLARED coordinates and binds no column still has points (ITEM-43)', () => {
  it('takes its length from the declared positions — the BARE frame', async () => {
    // *"Without it an uncoloured coordinate set is unreachable in a pane where only colour-by rows
    // emit."* Before this, such a base reported zero points and the ▶ drew nothing at all — a
    // live control that does nothing, which is the class of defect this round removes.
    const spec = {
      id: 'view.frame',
      title: 'Frame',
      canvas: {
        grid: [],
        datasets: [{ id: 'frame-0', coords: { artifact: 'pos-1' } }],
        series: [{ id: 's-0', type: 'scatter', coordId: 'frame-0', datasetId: 'frame-0' }],
      },
    } as unknown as ViewSpec
    const feed = resolveDeclarativeCanvas(spec, {
      data: {},
      positionsByArtifact: new Map([['pos-1', { positions: new Float32Array([0, 0, 1, 1, 2, 2]), length: 3 }]]),
      scope: { state: {}, derived: {}, const: {}, data: {} },
    })
    expect(feed).not.toBeNull()
    const catalog = await (await feed!.resolver('frame-0')).catalog()
    expect(catalog.pointCount).toBe(3)
  })

  it('a base with NO positions and no columns is still empty — nothing is invented', () => {
    const spec = {
      id: 'view.frame',
      title: 'Frame',
      canvas: {
        grid: [],
        datasets: [{ id: 'frame-0' }],
        series: [{ id: 's-0', type: 'scatter', coordId: 'frame-0', datasetId: 'frame-0' }],
      },
    } as unknown as ViewSpec
    const feed = resolveDeclarativeCanvas(spec, { data: {}, scope: { state: {}, derived: {}, const: {}, data: {} } })
    return Promise.resolve(feed!.resolver('frame-0'))
      .then(src => src.catalog())
      .then((c: { pointCount: number }) => expect(c.pointCount).toBe(0))
  })
})

// ── LINK SPACE FOLLOWS THE DECLARED COORDINATE ARTIFACT (ledger #34) ─────────────────────────
//
// The owner's rule: *"it has to do with the input data series coordinate, only same coordinate
// can be linked."* Viz scopes link-zoom by `cellSpaceKey`, which composes the pane's `layoutId`;
// a pane declares that to viz through `encode.layout`. The app declared its coordinates through
// `coords` / `positionsByArtifact` and never translated, so viz answered out of the catalog —
// and this file's frame source declares ONE layout under the fixed id `'metric'` for every base.
// Measured through viz's own resolution before the fix, every pane on the real projection shape
// came back with that id: the coordinate a pane was drawn in appeared NOWHERE in the key that
// decides what may share a camera.
//
// These assert the WIRE — the channel the boundary owns and this change writes. What viz then
// RESOLVES out of it (`layoutId`, and the composed space key) is asserted on the running app in
// `tests/e2e/15-visualize/link-space.spec.ts`, which reads viz's own answer off the grid rather
// than recomputing it from the declaration.
describe('the declared coordinate artifact reaches viz as encode.layout (ledger #34)', () => {
  const pts = (n: number) => ({ positions: Float32Array.from({ length: n * 2 }, (_, i) => i), length: n })
  const ART_A = 'artifact-alpha'
  const ART_B = 'artifact-beta'

  /** The pane's real projection shape (the shipped viz package's `ui/colour-by.yaml`): one dataset
   *  base and one scatter PER EMITTED PANE, each declaring the coordinates captured at emit. */
  const emittedSpec = () =>
    ({
      id: 'view.emitted',
      title: 'Emitted',
      canvas: {
        grid: [],
        datasets: [{ id: 'plotted.$i', for_each: '$state.plots as $c, $i', coords: { artifact: '$c.coordinate' } }],
        series: [
          {
            id: 's-plot-$i',
            for_each: '$state.plots as $c, $i',
            type: 'scatter',
            coordId: 'plot-$i',
            datasetId: 'plotted.$i',
            encode: { colorBy: { mode: 'categorical', key: 'grouping' } },
          },
        ],
      },
    }) as unknown as ViewSpec

  const layoutsFor = (plots: { coordinate: string }[]) => {
    const frame = { grouping: ['a', 'b', 'a', 'b'] }
    const data = { plotted: Object.fromEntries(plots.map((_, i) => [String(i), frame])) }
    const feed = resolveDeclarativeCanvas(emittedSpec(), {
      data,
      scope: { params: {}, state: { plots }, derived: {}, const: {}, data },
      positionsByArtifact: new Map([
        [ART_A, pts(4)],
        [ART_B, pts(4)],
      ]),
    })
    return feed!.option.series.map(s => (s.encode as { layout?: string } | undefined)?.layout)
  }

  it('two panes emitted from the SAME artifact declare the SAME layout', () => {
    expect(layoutsFor([{ coordinate: ART_A }, { coordinate: ART_A }])).toEqual([ART_A, ART_A])
  })

  // THE NEGATIVE CONTROL — the direction that rots silently, because "nothing links" looks the
  // same whether the scoping is right or absent. Before the fix these two resolved to ONE
  // `layoutId`, so a camera would fan across two unrelated coordinate sets the moment anything
  // made the other half of the key agree.
  it('two panes emitted from DIFFERENT artifacts declare DIFFERENT layouts', () => {
    const [a, b] = layoutsFor([{ coordinate: ART_A }, { coordinate: ART_B }])
    expect([a, b]).toEqual([ART_A, ART_B])
    expect(a).not.toBe(b)
  })

  it('a `.kept` variant of a declared base is drawn in the SAME coordinates as the base', () => {
    const frame = { grouping: ['a', 'b', 'a', 'b'] }
    const data = { base: frame }
    const spec = {
      id: 'view.kept',
      title: 'T',
      canvas: {
        grid: [],
        mask: '$derived.keep',
        datasets: [{ id: 'base', coords: { artifact: '$const.art' } }, { id: 'base.kept' }],
        series: [
          { id: 's-all', type: 'scatter', coordId: 'p-all', datasetId: 'base' },
          { id: 's-kept', type: 'scatter', coordId: 'p-kept', datasetId: 'base.kept' },
        ],
      },
    } as unknown as ViewSpec
    const feed = resolveDeclarativeCanvas(spec, {
      data,
      scope: { params: {}, state: {}, derived: { keep: [true, false, true, true] }, const: { art: ART_A }, data },
      positionsByArtifact: new Map([[ART_A, pts(4)]]),
    })
    // Same points, filtered — so the same space, which is what `declaredCoords` keying by the
    // parsed BASE (not by the declared id) already guarantees for `positionsFor`.
    expect(feed!.option.series.map(s => (s.encode as { layout?: string } | undefined)?.layout)).toEqual([
      ART_A,
      ART_A,
    ])
  })

  it('an AUTHOR-declared encode.layout is never overruled by the translation', () => {
    const frame = { grouping: ['a', 'b', 'a', 'b'] }
    const data = { base: frame }
    const spec = {
      id: 'view.explicit',
      title: 'T',
      canvas: {
        grid: [],
        datasets: [{ id: 'base', coords: { artifact: '$const.art' } }],
        series: [{ id: 's', type: 'scatter', coordId: 'p', datasetId: 'base', encode: { layout: 'authored' } }],
      },
    } as unknown as ViewSpec
    const feed = resolveDeclarativeCanvas(spec, {
      data,
      scope: { params: {}, state: {}, derived: {}, const: { art: ART_A }, data },
      positionsByArtifact: new Map([[ART_A, pts(4)]]),
    })
    expect((feed!.option.series[0].encode as { layout?: string }).layout).toBe('authored')
  })

  it('a base that declares NO coords goes onto the wire untouched', () => {
    const frame = { total: [10, 20, 30] }
    const spec = {
      id: 'view.plain',
      title: 'T',
      canvas: {
        grid: [],
        datasets: [{ id: 'base' }],
        series: [{ id: 's', type: 'violin', coordId: 'p', datasetId: 'base', encode: { valueKey: 'total' } }],
      },
    } as unknown as ViewSpec
    const feed = resolveDeclarativeCanvas(spec, {
      data: { base: frame },
      scope: { params: {}, state: {}, derived: {}, const: {}, data: { base: frame } },
    })
    expect((feed!.option.series[0].encode as { layout?: unknown }).layout).toBeUndefined()
  })

  // The declared layout must SURVIVE viz's own validation — an artifact id is not a catalog
  // column, and a declaration viz rejected would blank the whole grid rather than mis-scope it.
  it('viz accepts an option carrying the declared artifact as its layout', async () => {
    installBuiltinSchemas()
    const frame = { grouping: ['a', 'b', 'a', 'b'] }
    const data = { plotted: { 0: frame } }
    const feed = resolveDeclarativeCanvas(emittedSpec(), {
      data,
      scope: { params: {}, state: { plots: [{ coordinate: ART_A }] }, derived: {}, const: {}, data },
      positionsByArtifact: new Map([[ART_A, pts(4)]]),
    })
    const catalogs: Record<string, DatasetCatalog> = {}
    for (const d of feed!.option.datasets ?? []) catalogs[d.id] = await (await feed!.resolver(d.id)).catalog()
    expect(() => parseOption(feed!.option, catalogs)).not.toThrow()
  })
})

// ── ONE BASE PER COORDINATE ARTIFACT (ledger #34, the DATASET half) ──────────────────────────
//
// `cellSpaceKey` is `${datasetId}:<space-kind>:${layoutId}`. The block above closed the layout
// half. This one closes the dataset half: every section minted one base PER EMITTED PANE
// (`frame-$i` / `plotted.$i`), so two panes drawn in ONE coordinate set still landed in two
// spaces and still could not link — and, being the same rows twice, also held a second copy of
// the positions and the columns.
//
// ITEM-10's per-pane isolation is NOT deleted, it is scoped back to what it was written for: a
// brush in one DATASET must not bleed into another. That case is asserted here as the negative
// control, in the two ways it can fail — a shared space key, and canonical ids that overlap.
describe('panes drawn in one coordinate artifact share ONE dataset base (ledger #34)', () => {
  const pts = (n: number) => ({ positions: Float32Array.from({ length: n * 2 }, (_, i) => i), length: n })
  const ART_A = 'artifact-alpha'
  const ART_B = 'artifact-beta'
  const N = 4

  beforeEach(() => {
    // The canonical-id ranges are allocated per session and shared by every view; reset them so
    // one spec's allocation cannot shift the next one's.
    __resetCoordinateIdsForTests()
  })

  /** The pane's real projection shape: one dataset base + one scatter per emitted pane, each
   *  declaring the coordinates captured at emit, each colouring by its own column. */
  const emittedSpec = (viewId = 'view.emitted') =>
    ({
      id: viewId,
      title: 'Emitted',
      canvas: {
        grid: [],
        datasets: [{ id: 'plotted.$i', for_each: '$state.plots as $c, $i', coords: { artifact: '$c.coordinate' } }],
        series: [
          {
            id: 's-plot-$i',
            for_each: '$state.plots as $c, $i',
            type: 'scatter',
            coordId: 'plot-$i',
            datasetId: 'plotted.$i',
            encode: { colorBy: { mode: 'continuous', key: '$c.column' } },
          },
        ],
      },
    }) as unknown as ViewSpec

  /** Resolve the projection for a list of emitted panes. Each pane's own frame carries ONLY its
   *  own column — which is what makes the merge load-bearing rather than incidental. */
  const feedFor = (plots: { coordinate: string; column: string }[], viewId?: string) => {
    const data = {
      plotted: Object.fromEntries(plots.map((p, i) => [String(i), { [p.column]: [1, 2, 3, 4] }])),
    }
    return resolveDeclarativeCanvas(emittedSpec(viewId), {
      data,
      scope: { params: {}, state: { plots }, derived: {}, const: {}, data },
      positionsByArtifact: new Map([
        [ART_A, pts(N)],
        [ART_B, pts(N)],
      ]),
    })!
  }

  /** Viz's OWN space key for a resolved series, taken from viz rather than restated here. */
  const spaceKeys = (feed: { option: { series: readonly { datasetId?: string; encode?: unknown }[] } }) =>
    feed.option.series.map(s =>
      cellSpaceKey({
        kind: 'scatter',
        layoutId: (s.encode as { layout?: string } | undefined)?.layout ?? '',
        datasetId: s.datasetId,
      } as Parameters<typeof cellSpaceKey>[0]),
    )

  it('two panes on the SAME artifact are ONE dataset entry, and share a space key', () => {
    const feed = feedFor([
      { coordinate: ART_A, column: 'alpha' },
      { coordinate: ART_A, column: 'beta' },
    ])
    expect(feed.option.datasets).toHaveLength(1)
    const [a, b] = feed.option.series
    expect(a.datasetId).toBe(b.datasetId)
    const [ka, kb] = spaceKeys(feed)
    expect(ka).toBe(kb)
  })

  // THE OWNER'S SECOND REASON, pinned rather than assumed: the panes are the same rows twice, so
  // a base per pane duplicated the positions and the columns, and that cost grew with every plot
  // the user emitted. ONE entry for N panes is the assertion that says it does not.
  it('N panes on one artifact resolve ONE dataset entry, not N', () => {
    const feed = feedFor([
      { coordinate: ART_A, column: 'alpha' },
      { coordinate: ART_A, column: 'beta' },
      { coordinate: ART_A, column: 'gamma' },
      { coordinate: ART_A, column: 'delta' },
    ])
    expect(feed.option.series).toHaveLength(4)
    expect(feed.option.datasets).toHaveLength(1)
    expect(new Set(feed.option.series.map(s => s.datasetId)).size).toBe(1)
  })

  it('the shared base serves EVERY member pane its own column', async () => {
    const feed = feedFor([
      { coordinate: ART_A, column: 'alpha' },
      { coordinate: ART_A, column: 'beta' },
    ])
    const catalog = await (await feed.resolver(feed.option.datasets![0].id)).catalog()
    // Each pane's column lived in a frame of its own; the shared base is their union, so both
    // panes' declared bindings still resolve — a merge that dropped one would blank that pane.
    expect(catalog.valueColumns).toContain('alpha')
    expect(catalog.valueColumns).toContain('beta')
    expect(catalog.pointCount).toBe(N)
  })

  // ── THE NEGATIVE CONTROLS ─────────────────────────────────────────────────────────────────
  // "Nothing links" looks identical whether the scoping is right or absent, so the direction
  // that must NOT link is asserted explicitly, in both channels that decide it.
  it('panes on DIFFERENT artifacts keep separate bases and separate space keys', () => {
    const feed = feedFor([
      { coordinate: ART_A, column: 'alpha' },
      { coordinate: ART_B, column: 'beta' },
    ])
    expect(feed.option.datasets).toHaveLength(2)
    const [a, b] = feed.option.series
    expect(a.datasetId).not.toBe(b.datasetId)
    const [ka, kb] = spaceKeys(feed)
    expect(ka).not.toBe(kb)
  })

  it('a base that declares NO coordinates is untouched — its declared id, and no canonical ids', async () => {
    const frame = { total: [1, 2, 3] }
    const spec = {
      id: 'view.plain',
      title: 'T',
      canvas: {
        grid: [],
        datasets: [{ id: 'plain' }, { id: 'plain.kept' }],
        series: [
          { id: 's', type: 'violin', coordId: 'p', datasetId: 'plain', encode: { valueKey: 'total' } },
          { id: 's2', type: 'violin', coordId: 'p2', datasetId: 'plain.kept', encode: { valueKey: 'total' } },
        ],
      },
    } as unknown as ViewSpec
    const feed = resolveDeclarativeCanvas(spec, {
      data: { plain: frame },
      scope: { params: {}, state: {}, derived: {}, const: {}, data: { plain: frame } },
    })!
    // Byte-identical to before #34: every canvas that predates `coords` (the shipped before/
    // after pair) keeps its declared ids AND its per-base isolation.
    expect(feed.option.datasets!.map(d => d.id)).toEqual(['plain', 'plain.kept'])
    expect(feed.option.series.map(s => s.datasetId)).toEqual(['plain', 'plain.kept'])
    const src = await feed.resolver('plain')
    expect((src as { pointIds?: unknown }).pointIds).toBeUndefined()
  })

  // ── CANONICAL ROW IDS — the selection behaviour, asserted rather than inferred ─────────────
  //
  // Sharing a base changes WHICH space a pane publishes into: a base carrying `pointIds` routes
  // to viz's canonical selection space. Viz maps a selection through `mapRowsToIds` on the
  // producing view and `buildIdToRow` on the consuming one (`selectionSync.ts`), so two views
  // cross-select exactly to the extent their published ids INTERSECT — neither function is
  // exported from the package, so the ids themselves are what is asserted here, and the live
  // fan is asserted on the running app in `tests/e2e/15-visualize/link-space.spec.ts`.
  const idsOf = async (feed: { resolver: (id: string) => unknown }, datasetId: string) => {
    const src = (await feed.resolver(datasetId)) as { pointIds?: () => Promise<Uint32Array> }
    return src.pointIds ? [...(await src.pointIds())] : null
  }

  it('a shared base publishes canonical ids, and TWO VIEWS over one artifact publish the SAME ids', async () => {
    // Two SECTIONS drawing the same coordinates: composition namespaces dataset ids per
    // contributing view, so those panes cannot share a base — the canonical ids are the only
    // channel that reaches across, and this is the assertion that they do.
    const one = feedFor([{ coordinate: ART_A, column: 'alpha' }], 'view.one')
    const two = feedFor([{ coordinate: ART_A, column: 'beta' }], 'view.two')
    const a = await idsOf(one, one.option.datasets![0].id)
    const b = await idsOf(two, two.option.datasets![0].id)
    expect(a).not.toBeNull()
    expect(a).toHaveLength(N)
    expect(b).toEqual(a)
  })

  it('panes over DIFFERENT artifacts publish DISJOINT ids — a selection in one cannot land in the other', async () => {
    const feed = feedFor([
      { coordinate: ART_A, column: 'alpha' },
      { coordinate: ART_B, column: 'beta' },
    ])
    const [dsA, dsB] = feed.option.datasets!.map(d => d.id)
    const a = (await idsOf(feed, dsA))!
    const b = (await idsOf(feed, dsB))!
    expect(a).toHaveLength(N)
    expect(b).toHaveLength(N)
    // Disjoint, not merely unequal: viz's consuming side looks a selected id up in its OWN id
    // map, so an overlap of even one id is a row highlighted in a set of rows it does not belong
    // to. This is ITEM-10's real case, preserved.
    expect(a.filter(id => b.includes(id))).toEqual([])
  })

  it('the `.kept` variant publishes the ids of the rows that SURVIVED', async () => {
    const frame = { alpha: [1, 2, 3, 4] }
    const data = { base: frame }
    const spec = {
      id: 'view.kept',
      title: 'T',
      canvas: {
        grid: [],
        mask: '$derived.keep',
        datasets: [{ id: 'base', coords: { artifact: '$const.art' } }, { id: 'base.kept' }],
        series: [
          { id: 's-all', type: 'scatter', coordId: 'p-all', datasetId: 'base' },
          { id: 's-kept', type: 'scatter', coordId: 'p-kept', datasetId: 'base.kept' },
        ],
      },
    } as unknown as ViewSpec
    const feed = resolveDeclarativeCanvas(spec, {
      data,
      scope: { params: {}, state: {}, derived: { keep: [true, false, true, true] }, const: { art: ART_A }, data },
      positionsByArtifact: new Map([[ART_A, pts(N)]]),
    })!
    const all = (await idsOf(feed, feed.option.series[0].datasetId!))!
    const kept = (await idsOf(feed, feed.option.series[1].datasetId!))!
    // A filter in the unfiltered pane must land on the RIGHT rows of the filtered one, which is
    // only true if the surviving rows keep the ids they had before the mask.
    expect(kept).toEqual([all[0], all[2], all[3]])
  })

  it('an artifact with no resolved positions publishes no ids — it stays its own space', async () => {
    const data = { plotted: { 0: { alpha: [1, 2, 3, 4] } } }
    const feed = resolveDeclarativeCanvas(emittedSpec(), {
      data,
      scope: { params: {}, state: { plots: [{ coordinate: ART_A, column: 'alpha' }] }, derived: {}, const: {}, data },
      // The declared artifact has not been read yet — the ordinary first publish.
      positionsByArtifact: new Map(),
    })!
    // Nothing is identified before there are rows to identify: inventing ids here would put this
    // pane in the canonical space carrying ids it would later contradict.
    expect(await idsOf(feed, feed.option.datasets![0].id)).toBeNull()
  })

  it('viz accepts the shared option', async () => {
    installBuiltinSchemas()
    const feed = feedFor([
      { coordinate: ART_A, column: 'alpha' },
      { coordinate: ART_A, column: 'beta' },
    ])
    const catalogs: Record<string, DatasetCatalog> = {}
    for (const d of feed.option.datasets ?? []) catalogs[d.id] = await (await feed.resolver(d.id)).catalog()
    expect(() => parseOption(feed.option, catalogs)).not.toThrow()
  })
})

// ── TEST-26 [ITEM-20/22] — the dataset revision must MOVE when the data does ────────────────
//
// The assertion this file did not have, and the only thing that catches the worst failure of the
// typed migration. `sliceRevision` guards each column with a column predicate and SKIPS what it
// does not recognise. Under `Array.isArray` a typed column is not recognised — the guard
// `continue`s, the column contributes nothing, and the digest collapses to a function of the
// column NAMES alone. It is then CONSTANT across every content change: viz sees an unchanged
// `rev`, reuses the dataset it resolved first, and the canvas FREEZES. Sliders move, the mask
// re-derives, the plot never updates, and nothing is logged.
//
// A rendered-output test cannot see this — the pane renders, just with stale data — which is why
// the rev has to be asserted directly, and why it must be asserted as CHANGING rather than merely
// existing.
describe('dataset revision tracks CONTENT, for boxed and typed columns alike (TEST-26)', () => {
  // Its OWN spec with GENERIC column names — this module is domain-free by construction and a
  // revision digest has nothing to do with what a column measures.
  const SPEC = {
    id: 'rev.probe',
    canvas: {
      datasets: [{ id: 'frame' }],
      series: [
        { id: 's_a', type: 'violin', coordId: 'v_a', datasetId: 'frame', encode: { valueKey: 'metric_a' } },
      ],
      grid: [{ id: 'v_a', region: { row: 0, col: 0 } }],
    },
  } as unknown as ViewSpec

  const revOf = (frame: Record<string, unknown>): string => {
    const feed = resolveDeclarativeCanvas(SPEC, {
      data: { frame },
      scope: { state: {}, derived: {}, const: {}, data: { frame } },
    })
    const ds = feed!.option.datasets ?? []
    return String((ds[0] as { rev?: unknown })?.rev ?? '')
  }

  it('BOXED: a content change moves the revision', () => {
    // The control — this is what already worked, and what the typed case must match.
    const a = revOf({ metric_a: [10, 20, 30], metric_b: [1, 2, 3] })
    const b = revOf({ metric_a: [10, 20, 31], metric_b: [1, 2, 3] })
    expect(a).not.toBe(b)
  })

  it('TYPED: a content change moves the revision — the freeze this converts prevents', () => {
    const a = revOf({
      metric_a: new Float32Array([10, 20, 30]),
      metric_b: new Float32Array([1, 2, 3]),
    })
    const b = revOf({
      metric_a: new Float32Array([10, 20, 31]),
      metric_b: new Float32Array([1, 2, 3]),
    })
    // Under the pre-conversion guard BOTH of these are the same constant digest, and this is the
    // single assertion that goes red for it.
    expect(a, 'a typed column that does not reach the digest freezes the canvas').not.toBe(b)
  })

  it('TYPED: the revision reflects LENGTH as well as values', () => {
    const a = revOf({ metric_a: new Float32Array([10, 20, 30]), metric_b: new Float32Array([1, 2, 3]) })
    const b = revOf({ metric_a: new Float32Array([10, 20]), metric_b: new Float32Array([1, 2]) })
    expect(a).not.toBe(b)
  })

  it('TYPED: identical content yields the SAME revision — it is a digest, not a counter', () => {
    // The other half: if the rev changed on every resolve, viz would re-resolve the dataset on
    // every render and the identity (a selection space) would be retired each time.
    const a = revOf({ metric_a: new Float32Array([10, 20, 30]), metric_b: new Float32Array([1, 2, 3]) })
    const b = revOf({ metric_a: new Float32Array([10, 20, 30]), metric_b: new Float32Array([1, 2, 3]) })
    expect(a).toBe(b)
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════
// incremental-landing (#29) — the slice revision under an incremental landing (ITEM-5/6/8)
// ════════════════════════════════════════════════════════════════════════════════════════════

import { readFileSync as readFileSyncIL } from 'node:fs'
import { fileURLToPath as fileURLToPathIL } from 'node:url'
import { join as joinIL } from 'node:path'
import { CanvasObsSource } from './canvasBinding'
import { FrameDepthMismatchError } from '@/modules/workbench/core/runtime/frameDepth'

describe('incremental-landing — slice revision + alignment-premise reconciliation', () => {
  const revSpec = {
    id: 'view.il',
    title: 'IL',
    canvas: {
      datasets: [{ id: 'base' }],
      series: [{ id: 's', type: 'scatter', coordId: 'p', datasetId: 'base', encode: { colorBy: 'g' } }],
    },
  } as unknown as ViewSpec
  const soleRev = (data: Record<string, unknown>): unknown => {
    const feed = resolveDeclarativeCanvas(revSpec, {
      data,
      scope: { state: {}, derived: {}, const: {}, data },
    })
    return feed!.option.datasets?.[0]?.rev
  }

  it('TEST-12: REPLACING the slice object with new content changes the rev; content-equal is one rev; MUTATING in place freezes it', () => {
    // Incremental landing REPLACES the slice object each chunk, so a content change moves the rev.
    const revA = soleRev({ base: { g: ['a', 'b', 'c'] } })
    const revB = soleRev({ base: { g: ['a', 'b', 'c', 'd'] } })
    expect(revB).not.toEqual(revA)
    // Content-based, not an identity counter: a NEW object with the SAME content is ONE revision.
    const revC = soleRev({ base: { g: ['a', 'b', 'c'] } })
    expect(revC).toEqual(revA)

    // The canvas-freeze failure ITEM-5 avoids: MUTATING one slice object in place leaves the
    // identity-keyed digest memo STALE, so the rev does NOT move even though content changed.
    const shared = { base: { g: ['a', 'b', 'c'] } }
    const before = soleRev(shared)
    ;(shared.base.g as string[]).push('d') // mutate the SAME object in place
    const after = soleRev(shared)
    expect(after, 'a mutated-in-place slice returns the stale digest — the freeze').toEqual(before)
    // …which is exactly why the landing REPLACES (revB above moved) rather than mutating.
  })

  it('TEST-16: the alignment-premise STATEMENT matches the shipped behaviour (mixed depths → common global prefix, not independent filtering)', async () => {
    // The statement in `canvasBinding.ts` no longer claims the col buffer lands COMPLETE beside
    // positions; it names the cross-source handling at the keep-mask (DEC-37 — common global prefix).
    // Read it, then EXERCISE the behaviour it describes — not a string-presence check.
    const src = readFileSyncIL(
      joinIL(fileURLToPathIL(new URL('.', import.meta.url)), 'canvasBinding.ts'),
      'utf8',
    )
    expect(src).toMatch(/common global prefix/i)
    expect(src).not.toMatch(/col COMPLETE|col buffer lands COMPLETE/i)

    // BEHAVIOUR: a keep-mask spanning columns of DIFFERING depth (positions depth 3, col depth 2)
    // filters the COMMON PREFIX [0,2) — NOT each buffer independently. mask keeps global rows 0,2;
    // row 2 is beyond the col depth, so only row 0 is served, addressed on BOTH buffers.
    const slice = { col: [1, 2] } // value column landed 2 rows
    const positions = { positions: new Float32Array([0, 0, 1, 1, 2, 2]), length: 3 } // positions 3 rows
    const keepMask = [true, false, true]
    const src2 = new CanvasObsSource('src', slice, keepMask, undefined as never, positions as never)
    const values = await src2.continuous('col')
    const pos = await src2.positions('metric')
    // Aligned + globally addressed: a local-offset (independent) impl would serve value(1) vs
    // positions(2) — mismatched — and paint the wrong colours.
    expect(values.length).toBe(pos.length)
    expect(Array.from(values.value)).toEqual([1])
    expect(Array.from(pos.positions)).toEqual([0, 0])

    // Positive control: EQUAL depths (col 3, positions 3) keeps global rows 0 and 2 on both.
    const even = new CanvasObsSource('src', { col: [1, 2, 3] }, keepMask, undefined as never, positions as never)
    expect(Array.from((await even.continuous('col')).value)).toEqual([1, 3])
    expect((await even.positions('metric')).length).toBe(2)
  })
})
